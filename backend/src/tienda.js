'use strict';

/**
 * La tienda, del pago a la imprenta.
 *
 * No hay servidor que reciba el webhook de Stripe (la web es estatica y el
 * worker corre en GitHub Actions), asi que el worker hace de webhook al reves:
 * en cada ejecucion PREGUNTA a Stripe por las sesiones de pago completadas
 * desde la ultima vez. Para cada una:
 *
 *   1. Busca el pedido borrador por `client_reference_id` (lo pone la web en el
 *      enlace de pago) y comprueba que lo cobrado es lo que vale el producto.
 *   2. Saca los datos que se imprimen de la BASE DE DATOS (perfil, clan,
 *      trayecto, puesto), nunca de lo que mando el navegador.
 *   3. Pinta el diseño con assets/js/tienda-diseno.js —el mismo de la vista
 *      previa—, lo pasa a PNG con sharp y lo sube a Cloudinary.
 *   4. Crea el pedido en Printful con la direccion que recogio Stripe.
 *
 * Es idempotente: el pedido de Printful lleva el id del nuestro como
 * `external_id`, y antes de crearlo se pregunta si ya existe. Una ejecucion
 * cortada a medias se retoma sin duplicar nada.
 *
 * Coste en Firestore: dos lecturas por ejecucion (la configuracion y por donde
 * va leyendo) y, por pedido pagado, las cinco o seis de sus datos. Sin las
 * claves de Stripe no lee nada.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const PEDIDO_ID = /^[A-Za-z0-9]{1,128}_\d{1,6}_[0-4]$/;
const INTENTOS_MAX = 3;

/** Las claves, de las variables de entorno (secretos del repositorio). */
function configuracion(env = process.env) {
  const cfg = {
    stripe: env.STRIPE_SECRET_KEY || '',
    printful: env.PRINTFUL_TOKEN || '',
    printfulTienda: env.PRINTFUL_STORE_ID || '',
    cloudinary: {
      nube: env.CLOUDINARY_CLOUD || '',
      clave: env.CLOUDINARY_API_KEY || '',
      secreto: env.CLOUDINARY_API_SECRET || '',
    },
    // Por defecto el pedido llega a Printful como BORRADOR y se confirma a mano
    // desde su panel. Con TIENDA_CONFIRMAR=si sale directo a produccion.
    confirmar: String(env.TIENDA_CONFIRMAR || '').toLowerCase() === 'si',
  };
  cfg.lista = Boolean(cfg.stripe && cfg.printful && cfg.cloudinary.nube && cfg.cloudinary.clave && cfg.cloudinary.secreto);
  return cfg;
}

// --- Los modulos de la web ------------------------------------------------------

let modulos = null;
/** El diseño y los emblemas, los mismos ficheros que usa el navegador. */
async function cargarModulos() {
  if (modulos) return modulos;
  const cargar = (rel) => import(`data:text/javascript;base64,${
    Buffer.from(fs.readFileSync(path.join(RAIZ, rel), 'utf8')).toString('base64')}`);
  const [diseno, emblemas] = await Promise.all([
    cargar('assets/js/tienda-diseno.js'),
    cargar('assets/data/emblemas-clan.js'),
  ]);
  modulos = { ...diseno, EMBLEMAS: emblemas.EMBLEMAS };
  return modulos;
}

// --- Piezas puras (probadas en test/tienda.test.js) -----------------------------

/** "12:29" o "62:09", exactamente como `formatearTiempo` de assets/js/ui.js. */
function formatearTiempo(segundos) {
  const m = Math.floor(segundos / 60);
  const s = segundos % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const siglasDe = (clan) => clan.siglas
  || String(clan.nombre || '').split(/\s+/).map((p) => [...p][0] || '').join('').slice(0, 3).toUpperCase();

/**
 * Lo que se imprime. Misma forma que `datosDiseno` de assets/js/paginas/tienda.js:
 * si las dos no dicen lo mismo, la camiseta no seria la de la vista previa.
 */
function datosDiseno({ perfil, clan, viaje, puesto, total, nombreEstacion, emblemas }) {
  const [o, d] = String(viaje?.ruta || '').split('-');
  return {
    nombre: perfil?.username || 'Piloto',
    clan: clan ? {
      nombre: clan.nombre, color: clan.color, emblemaD: emblemas?.[clan.emblema]?.d || null, texto: siglasDe(clan),
    } : null,
    tiempo: viaje ? formatearTiempo(viaje.tiempoSegundos) : null,
    origen: viaje ? nombreEstacion(o) || o : null,
    destino: viaje ? nombreEstacion(d) || d : null,
    puesto: puesto || null,
    total: total || null,
  };
}

/**
 * ¿Lo cobrado es lo que vale? Devuelve el motivo si no, o null si cuadra.
 * El precio lo fija el enlace de pago, que esta en Stripe y no se puede tocar
 * desde la web; esto pilla un enlace mal configurado o cambiado de producto.
 */
function comprobarCobro(sesion, producto) {
  if (!producto) return 'el producto del pedido ya no esta en la tienda';
  if (sesion.payment_status !== 'paid') return `el pago esta "${sesion.payment_status}"`;
  if (String(sesion.currency || '').toLowerCase() !== 'eur') return `moneda ${sesion.currency}`;
  const esperado = Math.round(Number(producto.precio) * 100);
  // Lo cobrado puede llevar envio o impuestos encima, nunca menos que el precio.
  const cobrado = Number(sesion.amount_subtotal ?? sesion.amount_total);
  if (!Number.isFinite(cobrado) || cobrado < esperado) return `se han cobrado ${cobrado} centimos y el producto vale ${esperado}`;
  return null;
}

/**
 * La direccion de envio que recogio Stripe, en el formato de Printful.
 * Segun la version del API viene en `collected_information.shipping_details`
 * (2025 en adelante) o en `shipping_details`.
 */
function destinatario(sesion) {
  const envio = sesion.collected_information?.shipping_details || sesion.shipping_details || null;
  const dir = envio?.address;
  if (!dir?.line1 || !dir?.country || !dir?.postal_code || !dir?.city) return null;
  return {
    name: String(envio.name || sesion.customer_details?.name || '').slice(0, 100),
    address1: dir.line1,
    ...(dir.line2 ? { address2: dir.line2 } : {}),
    city: dir.city,
    ...(dir.state ? { state_code: dir.state } : {}),
    country_code: dir.country,
    zip: dir.postal_code,
    ...(sesion.customer_details?.email ? { email: sesion.customer_details.email } : {}),
    ...(sesion.customer_details?.phone ? { phone: sesion.customer_details.phone } : {}),
  };
}

/** El cuerpo del pedido para el API de Printful (v1, POST /orders). */
function cuerpoPrintful({ pedidoId, recipient, varianteId, urlImagen, producto, precio }) {
  return {
    external_id: pedidoId,
    shipping: 'STANDARD',
    recipient,
    items: [{
      variant_id: Number(varianteId),
      quantity: 1,
      retail_price: Number(precio).toFixed(2),
      name: producto === 'taza' ? 'Taza BiciFastness' : 'Camiseta BiciFastness',
      // En la camiseta va delante; la taza tiene una sola zona.
      files: [{ type: producto === 'taza' ? 'default' : 'front', url: urlImagen }],
    }],
  };
}

/** Firma de una subida a Cloudinary: sha1 de los parametros ordenados + secreto. */
function firmaCloudinary(params, secreto) {
  const cadena = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(cadena + secreto).digest('hex');
}

// --- Llamadas a los servicios -------------------------------------------------

async function pedirJson(fetchFn, url, opciones = {}) {
  const res = await fetchFn(url, opciones);
  const texto = await res.text();
  let cuerpo = null;
  try { cuerpo = texto ? JSON.parse(texto) : null; } catch { cuerpo = { texto }; }
  return { ok: res.ok, status: res.status, cuerpo };
}

/** Sesiones de pago completadas desde `desde` (segundos), con paginacion. */
async function listarSesiones(fetchFn, clave, desde) {
  const todas = [];
  let despues = null;
  for (let pagina = 0; pagina < 10; pagina++) {
    const q = new URLSearchParams({ status: 'complete', limit: '100', 'created[gte]': String(desde) });
    if (despues) q.set('starting_after', despues);
    const r = await pedirJson(fetchFn, `https://api.stripe.com/v1/checkout/sessions?${q}`, {
      headers: { Authorization: `Bearer ${clave}` },
    });
    if (!r.ok) throw new Error(`Stripe ${r.status}: ${r.cuerpo?.error?.message || 'sin detalle'}`);
    todas.push(...(r.cuerpo.data || []));
    if (!r.cuerpo.has_more || !r.cuerpo.data?.length) break;
    despues = r.cuerpo.data[r.cuerpo.data.length - 1].id;
  }
  return todas;
}

async function subirCloudinary(fetchFn, cfg, png, publicId) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { overwrite: 'true', public_id: publicId, timestamp };
  const form = new FormData();
  form.set('file', `data:image/png;base64,${png.toString('base64')}`);
  for (const [k, v] of Object.entries(params)) form.set(k, String(v));
  form.set('api_key', cfg.clave);
  form.set('signature', firmaCloudinary(params, cfg.secreto));
  const r = await pedirJson(fetchFn, `https://api.cloudinary.com/v1_1/${cfg.nube}/image/upload`, { method: 'POST', body: form });
  if (!r.ok || !r.cuerpo?.secure_url) throw new Error(`Cloudinary ${r.status}: ${r.cuerpo?.error?.message || 'sin url'}`);
  return r.cuerpo.secure_url;
}

/** Crea el pedido en Printful, o devuelve el que ya hubiera con ese id. */
async function pedidoEnPrintful(fetchFn, cfg, cuerpo) {
  const cabeceras = {
    Authorization: `Bearer ${cfg.printful}`,
    'Content-Type': 'application/json',
    ...(cfg.printfulTienda ? { 'X-PF-Store-Id': cfg.printfulTienda } : {}),
  };
  const ya = await pedirJson(fetchFn, `https://api.printful.com/orders/@${encodeURIComponent(cuerpo.external_id)}`, { headers: cabeceras });
  if (ya.ok && ya.cuerpo?.result?.id) return { id: ya.cuerpo.result.id, estado: ya.cuerpo.result.status, nuevo: false };
  const r = await pedirJson(fetchFn, `https://api.printful.com/orders${cfg.confirmar ? '?confirm=1' : ''}`, {
    method: 'POST', headers: cabeceras, body: JSON.stringify(cuerpo),
  });
  if (!r.ok || !r.cuerpo?.result?.id) throw new Error(`Printful ${r.status}: ${r.cuerpo?.error?.message || r.cuerpo?.result || 'sin detalle'}`);
  return { id: r.cuerpo.result.id, estado: r.cuerpo.result.status, nuevo: true };
}

// --- El trabajo de cada ejecucion -------------------------------------------------

/**
 * @param {object} ctx
 * @param {FirebaseFirestore.Firestore} ctx.db
 * @param {object} ctx.admin           firebase-admin, para Timestamp y FieldValue
 * @param {Function} [ctx.fetchFn]
 * @param {object} [ctx.env]
 * @param {Function} ctx.aPng           (svg: string) => Promise<Buffer>
 * @param {Function} ctx.nombreEstacion (codigo) => nombre | null
 * @param {Function} ctx.avisarAdmin    (asunto, cuerpo) => Promise
 * @param {boolean} [ctx.simular]
 * @returns {Promise<number>} pedidos mandados a la imprenta
 */
async function procesarTienda(ctx) {
  const { db, admin, fetchFn = fetch, env = process.env, aPng, nombreEstacion, avisarAdmin, simular = false } = ctx;
  const cfg = configuracion(env);
  if (!cfg.stripe) return 0;
  if (!cfg.lista) {
    console.warn('::warning::Tienda: hay clave de Stripe pero faltan las de Printful o Cloudinary. No se procesa nada.');
    return 0;
  }

  const [tiendaSnap, cursorSnap] = await Promise.all([
    db.doc('config/tienda').get(),
    db.doc('tienda_interno/stripe').get(),
  ]);
  const tienda = tiendaSnap.exists ? tiendaSnap.data() : {};
  const cursor = cursorSnap.exists ? cursorSnap.data() : {};
  const ahora = Math.floor(Date.now() / 1000);
  // Una hora de solape: una sesion que se completa justo al leer no se pierde.
  const desde = Math.max(0, (cursor.desde || ahora - 3 * 86400) - 3600);
  const vistas = new Set(cursor.vistas || []);

  const sesiones = (await listarSesiones(fetchFn, cfg.stripe, desde))
    .filter((s) => !vistas.has(s.id))
    .sort((a, b) => a.created - b.created);
  if (!sesiones.length) {
    if (!cursorSnap.exists && !simular) await db.doc('tienda_interno/stripe').set({ desde: ahora, vistas: [] });
    return 0;
  }

  let mandados = 0;
  let pendienteMasViejo = null;
  for (const sesion of sesiones) {
    const resultado = await procesarSesion({ ...ctx, cfg, tienda, sesion, fetchFn, aPng, nombreEstacion, avisarAdmin, simular, db, admin });
    if (resultado === 'reintentar') {
      pendienteMasViejo = pendienteMasViejo ?? sesion.created;
      continue;
    }
    vistas.add(sesion.id);
    if (resultado === 'mandado') mandados += 1;
  }

  if (!simular) {
    const ultima = Math.max(...sesiones.map((s) => s.created));
    await db.doc('tienda_interno/stripe').set({
      // Lo que haya que reintentar sigue dentro de la ventana.
      desde: pendienteMasViejo ? Math.min(pendienteMasViejo, ultima) : ultima,
      vistas: [...vistas].slice(-300),
    });
  }
  console.log(`Tienda: ${sesiones.length} pago(s) nuevo(s), ${mandados} pedido(s) a la imprenta.`);
  return mandados;
}

/** Un pago. Devuelve 'mandado', 'revisar', 'ignorado' o 'reintentar'. */
async function procesarSesion({ db, admin, cfg, tienda, sesion, fetchFn, aPng, nombreEstacion, avisarAdmin, simular }) {
  const pedidoId = sesion.client_reference_id;
  if (!pedidoId || !PEDIDO_ID.test(pedidoId)) {
    // Alguien ha pagado con el enlace sin pasar por la web: no sabemos que
    // imprimir. Lo resuelve una persona (o se devuelve desde Stripe).
    await avisarAdmin('Tienda: pago sin pedido', `La sesion ${sesion.id} de Stripe no trae un pedido de la web. Hay que resolverla a mano.`);
    return 'revisar';
  }
  const ref = db.doc(`pedidos_tienda/${pedidoId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    await avisarAdmin('Tienda: pago de un pedido que no existe', `Sesion ${sesion.id}, pedido ${pedidoId}.`);
    return 'revisar';
  }
  const pedido = snap.data();
  if (!['borrador', 'pagado'].includes(pedido.estado)) return 'ignorado';

  const producto = tienda.productos?.[pedido.producto];
  const marcarRevisar = async (motivo) => {
    console.warn(`  [tienda ${pedidoId}] a revisar: ${motivo}`);
    if (!simular) {
      await ref.update({
        estado: 'revisar', mensajeError: motivo.slice(0, 300), stripeSesion: sesion.id,
        importe: sesion.amount_total ?? null, pagadoEn: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await avisarAdmin('Tienda: pedido pagado que hay que revisar', `Pedido ${pedidoId} (sesion ${sesion.id}): ${motivo}.`);
    return 'revisar';
  };

  const cobro = comprobarCobro(sesion, producto);
  if (cobro) return marcarRevisar(cobro);
  const varianteId = producto.variantes?.[pedido.variante];
  if (!varianteId) return marcarRevisar(`no hay variante del proveedor para "${pedido.variante}"`);
  const recipient = destinatario(sesion);
  if (!recipient) return marcarRevisar('Stripe no ha recogido una direccion de envio completa (¿el enlace pide la direccion?)');

  if (!simular && pedido.estado === 'borrador') {
    await ref.update({
      estado: 'pagado', stripeSesion: sesion.id, importe: sesion.amount_total ?? null,
      moneda: sesion.currency || null, pagadoEn: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  try {
    const { disenoSVG, EMBLEMAS } = await cargarModulos();
    const datos = await reunirDatos(db, pedido, nombreEstacion, EMBLEMAS);
    const png = await aPng(disenoSVG(pedido.producto, datos));
    if (simular) {
      console.log(`  [tienda ${pedidoId}] se mandaria: ${pedido.producto} ${pedido.variante} (${png.length} bytes)`);
      return 'mandado';
    }
    const urlImagen = await subirCloudinary(fetchFn, cfg.cloudinary, png, `bicifastness/pedidos/${pedidoId}`);
    const enviado = await pedidoEnPrintful(fetchFn, cfg, cuerpoPrintful({
      pedidoId, recipient, varianteId, urlImagen, producto: pedido.producto, precio: producto.precio,
    }));
    await ref.update({
      estado: cfg.confirmar ? 'en_produccion' : 'en_proveedor',
      printfulId: enviado.id, imagenUrl: urlImagen, mensajeError: admin.firestore.FieldValue.delete(),
    });
    if (enviado.nuevo) {
      await avisarAdmin(
        cfg.confirmar ? 'Tienda: pedido nuevo en produccion' : 'Tienda: pedido nuevo para confirmar',
        `${pedido.producto} ${pedido.variante} de ${datos.nombre}. Printful #${enviado.id}`
          + (cfg.confirmar ? '.' : ': esta como borrador, confirmalo en el panel de Printful.'),
      );
    }
    return 'mandado';
  } catch (error) {
    // Un fallo de red o de un servicio: se reintenta en la siguiente ejecucion,
    // hasta tres veces. Despues, a una persona.
    const intentos = (pedido.intentos || 0) + 1;
    console.warn(`  [tienda ${pedidoId}] intento ${intentos} fallido: ${error.message}`);
    if (!simular) {
      await ref.update({
        intentos, mensajeError: String(error.message).slice(0, 300),
        ...(intentos >= INTENTOS_MAX ? { estado: 'error' } : {}),
      });
    }
    if (intentos >= INTENTOS_MAX) {
      await avisarAdmin('Tienda: un pedido pagado no ha podido salir', `Pedido ${pedidoId}: ${error.message}`);
      return 'revisar';
    }
    return 'reintentar';
  }
}

/** Perfil, clan, trayecto y puesto de quien compra, leidos aqui y no del navegador. */
async function reunirDatos(db, pedido, nombreEstacion, emblemas) {
  const perfilSnap = await db.doc(`usuarios/${pedido.uid}`).get();
  const perfil = perfilSnap.exists ? perfilSnap.data() : {};
  const [clanSnap, viajeSnap, ranking] = await Promise.all([
    perfil.clanId ? db.doc(`clanes/${perfil.clanId}`).get() : null,
    pedido.viajeId ? db.doc(`tiempos_viaje/${pedido.viajeId}`).get() : null,
    db.doc('agregados/ranking-general').get(),
  ]);
  // El trayecto tiene que ser suyo y estar verificado: si no, se imprime sin tiempo.
  const viaje = viajeSnap?.exists && viajeSnap.data().uid === pedido.uid && viajeSnap.data().verificado === true
    ? viajeSnap.data() : null;
  const filas = ranking.exists ? ranking.data().filas || [] : [];
  const fila = filas.find((f) => f.nombre === perfil.username);
  return datosDiseno({
    perfil,
    clan: clanSnap?.exists ? clanSnap.data() : null,
    viaje,
    puesto: fila?.pos || null,
    total: fila ? ranking.data().total ?? filas.length : null,
    nombreEstacion,
    emblemas,
  });
}

module.exports = {
  procesarTienda,
  configuracion,
  datosDiseno,
  comprobarCobro,
  destinatario,
  cuerpoPrintful,
  firmaCloudinary,
  formatearTiempo,
  listarSesiones,
  cargarModulos,
};
