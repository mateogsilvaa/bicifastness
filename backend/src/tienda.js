'use strict';

/**
 * La tienda, del pago al envio. Conector propio entre Polar y la imprenta.
 *
 * POR QUE ASI. Casi ninguna pasarela deja vender articulos fisicos a un
 * proyecto como este, asi que en Polar se venden ARTICULOS DIGITALES (un pack
 * de apoyo, un paquete de gemas) y el regalo fisico va aparte. Polar no sabe
 * nada de direcciones ni de tallas, y la imprenta no sabe nada de Polar: el
 * puente es esto.
 *
 *   1. La web crea un pedido borrador `pedidos_tienda/{id}` con producto,
 *      talla, que trayecto imprimir y la DIRECCION DE ENVIO (la recogemos
 *      nosotros: Polar no lo hace). Lo lee solo su dueño y la administracion.
 *   2. Lleva al enlace de pago de Polar con `customer_external_id` = su uid y
 *      el id del pedido en `reference_id` y en `metadata`.
 *   3. El worker, en cada ejecucion, PREGUNTA a Polar por los pedidos nuevos
 *      (no hay servidor que reciba un webhook) y casa cada uno con el nuestro:
 *      por el id que lleve, y si no lo trae, por cliente + producto + el
 *      borrador mas reciente de esa persona.
 *   4. Comprueba que lo cobrado es lo que vale. Y segun lo comprado:
 *        - gemas: las suma al perfil, en una transaccion (una sola vez);
 *        - camiseta o taza: saca los datos que se imprimen de la BASE DE DATOS
 *          (nunca del navegador), pinta el diseño, lo sube a Cloudinary y crea
 *          el pedido en Printful con la direccion del paso 1. Sin claves de la
 *          imprenta, el pedido queda "para enviar a mano" y te llega un correo
 *          con todo lo necesario.
 *
 * Es idempotente: cada pedido de Polar se apunta como visto, el de Printful
 * lleva nuestro id como `external_id` y antes de crearlo se pregunta si ya
 * existe, y las gemas se suman en la misma transaccion que cierra el pedido.
 *
 * Coste en Firestore: dos lecturas por ejecucion (la configuracion y por donde
 * va leyendo). Sin `POLAR_ACCESS_TOKEN` no lee nada.
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
    polar: env.POLAR_ACCESS_TOKEN || '',
    organizacion: env.POLAR_ORGANIZATION_ID || '',
    // Con POLAR_SANDBOX=si se habla con el entorno de pruebas de Polar.
    api: String(env.POLAR_SANDBOX || '').toLowerCase() === 'si' ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh',
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
  cfg.lista = Boolean(cfg.polar);
  // Sin imprenta configurada, lo fisico se envia a mano.
  cfg.imprenta = Boolean(cfg.printful && cfg.cloudinary.nube && cfg.cloudinary.clave && cfg.cloudinary.secreto);
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

/** ¿Esta pagado? Polar lo dice con `paid` o con `status`. */
const estaPagado = (orden) => orden?.paid === true || orden?.status === 'paid';

/**
 * ¿Lo cobrado es lo que vale? Devuelve el motivo si no, o null si cuadra.
 * El precio lo fija el producto en Polar y no se puede tocar desde la web;
 * esto pilla un enlace mal configurado o cambiado de producto.
 */
function comprobarCobro(orden, precio) {
  if (precio === undefined || precio === null) return 'el producto del pedido ya no esta en la tienda';
  if (!estaPagado(orden)) return `el pago esta "${orden.status}"`;
  if (String(orden.currency || '').toLowerCase() !== 'eur') return `moneda ${orden.currency}`;
  const esperado = Math.round(Number(precio) * 100);
  // Lo cobrado puede llevar impuestos encima, nunca menos que el precio.
  const cobrado = Number(orden.subtotal_amount ?? orden.amount ?? orden.total_amount);
  if (!Number.isFinite(cobrado) || cobrado < esperado) return `se han cobrado ${cobrado} centimos y el producto vale ${esperado}`;
  return null;
}

const PAIS = /^[A-Z]{2}$/;

/**
 * La direccion que dejo la persona en NUESTRO formulario, en el formato de
 * Printful. null si esta incompleta.
 */
function destinatario(envio, email = null) {
  if (!envio || typeof envio !== 'object') return null;
  const t = (v, max) => String(v || '').trim().slice(0, max);
  const pais = String(envio.pais || '').trim().toUpperCase();
  if (!t(envio.nombre, 100) || !t(envio.direccion, 120) || !t(envio.ciudad, 60) || !t(envio.cp, 12) || !PAIS.test(pais)) return null;
  return {
    name: t(envio.nombre, 100),
    address1: t(envio.direccion, 120),
    ...(t(envio.direccion2, 120) ? { address2: t(envio.direccion2, 120) } : {}),
    city: t(envio.ciudad, 60),
    ...(t(envio.provincia, 60) ? { state_code: t(envio.provincia, 60) } : {}),
    country_code: pais,
    zip: t(envio.cp, 12),
    ...(email ? { email: t(email, 120) } : {}),
    ...(t(envio.telefono, 20) ? { phone: t(envio.telefono, 20) } : {}),
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

/**
 * Los pedidos de Polar desde `desde` (ms), del mas nuevo al mas viejo, con
 * paginacion. `GET /v1/orders/`, con un token de organizacion de solo lectura
 * de pedidos.
 */
async function listarPedidosPolar(fetchFn, cfg, desde) {
  const todos = [];
  for (let pagina = 1; pagina <= 10; pagina++) {
    const q = new URLSearchParams({ limit: '100', page: String(pagina), sorting: '-created_at' });
    if (cfg.organizacion) q.set('organization_id', cfg.organizacion);
    const r = await pedirJson(fetchFn, `${cfg.api}/v1/orders/?${q}`, {
      headers: { Authorization: `Bearer ${cfg.polar}`, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`Polar ${r.status}: ${r.cuerpo?.detail || r.cuerpo?.error || 'sin detalle'}`);
    const items = r.cuerpo?.items || [];
    let viejo = false;
    for (const o of items) {
      if (Date.parse(o.created_at) < desde) { viejo = true; break; }
      todos.push(o);
    }
    const max = r.cuerpo?.pagination?.max_page || 1;
    if (viejo || !items.length || pagina >= max) break;
  }
  return todos;
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

// --- Casar un pedido de Polar con el nuestro ---------------------------------------

/** El id de nuestro pedido, si Polar lo ha traido de vuelta. */
function pedidoDeOrden(orden) {
  const candidatos = [orden?.metadata?.pedido, orden?.metadata?.reference_id, orden?.reference_id, orden?.checkout?.metadata?.pedido];
  return candidatos.find((c) => typeof c === 'string' && PEDIDO_ID.test(c)) || null;
}

/** Que se compro, segun el producto de Polar: `{ tipo, clave, precio, ... }` o null. */
function productoDeOrden(tienda, orden) {
  const pid = orden?.product_id || orden?.product?.id;
  if (!pid) return null;
  for (const [clave, p] of Object.entries(tienda.productos || {})) {
    if (p?.polarProducto === pid) return { tipo: 'fisico', clave, ...p };
  }
  for (const [clave, p] of Object.entries(tienda.gemas?.packs || {})) {
    if (p?.polarProducto === pid) return { tipo: 'gemas', clave, ...p };
  }
  return null;
}

/**
 * El borrador al que corresponde un pago. Primero por el id que traiga; si no
 * lo trae, el borrador mas reciente de ese cliente (su uid, que Polar guarda
 * como `external_id`) para ese mismo producto.
 */
async function buscarPedido(db, orden, comprado) {
  const explicito = pedidoDeOrden(orden);
  if (explicito) {
    const snap = await db.doc(`pedidos_tienda/${explicito}`).get();
    if (snap.exists) return snap;
  }
  const uid = orden?.customer?.external_id || orden?.customer_external_id || null;
  if (!uid || !comprado) return null;
  const snap = await db.collection('pedidos_tienda').where('uid', '==', uid).where('estado', '==', 'borrador').get();
  const encaja = (d) => (comprado.tipo === 'gemas'
    ? d.data().producto === 'gemas' && d.data().variante === comprado.clave
    : d.data().producto === comprado.clave);
  const tiempo = (d) => d.data().creado?.toMillis?.() ?? 0;
  return snap.docs.filter(encaja).sort((x, y) => tiempo(y) - tiempo(x))[0] || null;
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
 * @returns {Promise<number>} pedidos resueltos (enviados a la imprenta, a mano o gemas entregadas)
 */
async function procesarTienda(ctx) {
  const { db, fetchFn = fetch, env = process.env, simular = false } = ctx;
  const cfg = configuracion(env);
  if (!cfg.lista) return 0;

  const [tiendaSnap, cursorSnap] = await Promise.all([
    db.doc('config/tienda').get(),
    db.doc('tienda_interno/polar').get(),
  ]);
  const tienda = tiendaSnap.exists ? tiendaSnap.data() : {};
  const cursor = cursorSnap.exists ? cursorSnap.data() : {};
  const ahora = Date.now();
  // Una hora de solape: un pedido que se paga justo al leer no se pierde.
  const desde = Math.max(0, (cursor.desde || ahora - 3 * 864e5) - 3600e3);
  const vistas = new Set(cursor.vistas || []);

  const ordenes = (await listarPedidosPolar(fetchFn, cfg, desde))
    .filter((o) => !vistas.has(o.id))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  if (!ordenes.length) {
    if (!cursorSnap.exists && !simular) await db.doc('tienda_interno/polar').set({ desde: ahora, vistas: [] });
    return 0;
  }

  let hechos = 0;
  let pendienteMasViejo = null;
  for (const orden of ordenes) {
    const resultado = await procesarOrden({ ...ctx, cfg, tienda, orden, fetchFn });
    if (resultado === 'reintentar') {
      pendienteMasViejo = pendienteMasViejo ?? Date.parse(orden.created_at);
      continue;
    }
    vistas.add(orden.id);
    if (resultado === 'hecho') hechos += 1;
  }

  if (!simular) {
    const ultima = Math.max(...ordenes.map((o) => Date.parse(o.created_at)));
    await db.doc('tienda_interno/polar').set({
      // Lo que haya que reintentar sigue dentro de la ventana.
      desde: pendienteMasViejo ? Math.min(pendienteMasViejo, ultima) : ultima,
      vistas: [...vistas].slice(-300),
    });
  }
  console.log(`Tienda: ${ordenes.length} pedido(s) nuevo(s) de Polar, ${hechos} resuelto(s).`);
  return hechos;
}

/** Un pago de Polar. Devuelve 'hecho', 'revisar', 'ignorado' o 'reintentar'. */
async function procesarOrden(ctx) {
  const { db, admin, tienda, orden, avisarAdmin, simular } = ctx;
  // Aun sin cobrar: se vuelve a mirar en la siguiente ejecucion.
  if (orden.status === 'pending') return 'reintentar';
  if (!estaPagado(orden)) return 'ignorado';

  const comprado = productoDeOrden(tienda, orden);
  const snap = await buscarPedido(db, orden, comprado);
  if (!snap) {
    // Alguien ha pagado sin pasar por la web: no sabemos a quien ni a donde.
    await avisarAdmin('Tienda: pago sin pedido', `El pedido ${orden.id} de Polar (${orden.customer?.email || 'sin correo'}) no casa con ningun pedido de la web. Hay que resolverlo a mano.`);
    return 'revisar';
  }
  const ref = snap.ref;
  const pedido = snap.data();
  const pedidoId = snap.id;
  if (!['borrador', 'pagado'].includes(pedido.estado)) return 'ignorado';

  const precio = pedido.producto === 'gemas'
    ? tienda.gemas?.packs?.[pedido.variante]?.precio
    : tienda.productos?.[pedido.producto]?.precio;
  const marcarRevisar = async (motivo) => {
    console.warn(`  [tienda ${pedidoId}] a revisar: ${motivo}`);
    if (!simular) {
      await ref.update({
        estado: 'revisar', mensajeError: motivo.slice(0, 300), polarPedido: orden.id,
        importe: orden.total_amount ?? null, pagadoEn: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await avisarAdmin('Tienda: pedido pagado que hay que revisar', `Pedido ${pedidoId} (Polar ${orden.id}): ${motivo}.`);
    return 'revisar';
  };
  const cobro = comprobarCobro(orden, precio);
  if (cobro) return marcarRevisar(cobro);

  if (pedido.producto === 'gemas') return entregarGemas({ ...ctx, ref, pedido, pedidoId });
  return mandarFisico({ ...ctx, ref, pedido, pedidoId, marcarRevisar });
}

/** Suma las gemas del pack al perfil y cierra el pedido, en la misma transaccion. */
async function entregarGemas({ db, admin, tienda, orden, ref, pedido, pedidoId, simular }) {
  const gemas = Number(tienda.gemas?.packs?.[pedido.variante]?.gemas) || 0;
  if (gemas <= 0 || gemas > 100000) return 'revisar';
  if (simular) { console.log(`  [tienda ${pedidoId}] se darian ${gemas} gemas`); return 'hecho'; }
  await db.runTransaction(async (t) => {
    const actual = await t.get(ref);
    if (!actual.exists || !['borrador', 'pagado'].includes(actual.data().estado)) return;
    t.update(ref, {
      estado: 'entregado', gemas, polarPedido: orden.id, importe: orden.total_amount ?? null,
      pagadoEn: admin.firestore.FieldValue.serverTimestamp(),
    });
    t.update(db.doc(`usuarios/${pedido.uid}`), { gemas: admin.firestore.FieldValue.increment(gemas) });
  });
  console.log(`  [tienda ${pedidoId}] +${gemas} gemas`);
  return 'hecho';
}

/** Camiseta o taza: a Printful si esta configurado; si no, a mano. */
async function mandarFisico({ db, admin, cfg, tienda, orden, ref, pedido, pedidoId, fetchFn, aPng, nombreEstacion, avisarAdmin, simular, marcarRevisar }) {
  const producto = tienda.productos?.[pedido.producto];
  const recipient = destinatario(pedido.envio, orden.customer?.email || null);
  if (!recipient) return marcarRevisar('el pedido no tiene una direccion de envio completa');

  if (!simular && pedido.estado === 'borrador') {
    await ref.update({
      estado: 'pagado', polarPedido: orden.id, importe: orden.total_amount ?? null,
      moneda: orden.currency || null, pagadoEn: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  if (!cfg.imprenta) {
    // Sin imprenta: lo preparas tu. El correo lleva todo lo necesario.
    if (!simular) await ref.update({ estado: 'preparar' });
    const d = recipient;
    await avisarAdmin('Tienda: pedido para enviar a mano',
      `${pedido.producto} ${pedido.variante || ''} (pedido ${pedidoId}, Polar ${orden.id}).\n`
      + `Para: ${d.name}\n${d.address1}${d.address2 ? `, ${d.address2}` : ''}\n${d.zip} ${d.city}${d.state_code ? ` (${d.state_code})` : ''}, ${d.country_code}`
      + `${d.phone ? `\nTel.: ${d.phone}` : ''}${d.email ? `\nCorreo: ${d.email}` : ''}\n`
      + 'Cuando lo envies, marcalo como enviado en /admin/tienda/.');
    return 'hecho';
  }

  const varianteId = producto?.variantes?.[pedido.variante];
  if (!varianteId) return marcarRevisar(`no hay variante del proveedor para "${pedido.variante}"`);

  try {
    const { disenoSVG, EMBLEMAS } = await cargarModulos();
    const datos = await reunirDatos(db, pedido, nombreEstacion, EMBLEMAS);
    const png = await aPng(disenoSVG(pedido.producto, datos));
    if (simular) {
      console.log(`  [tienda ${pedidoId}] se mandaria: ${pedido.producto} ${pedido.variante} (${png.length} bytes)`);
      return 'hecho';
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
    return 'hecho';
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

// --- Gastar gemas ------------------------------------------------------------------

/**
 * Canjes de gemas por banners y lemas. Mismo patron que los enlaces de evento
 * (canjes.js): el navegador deja `canjes_gemas/{uid}` con `{ recompensa,
 * estado: 'pendiente' }` y aqui se decide, en una transaccion: que este a la
 * venta (`config/tienda.gemas.precios`), que no la tenga ya y que le lleguen
 * las gemas. Solo entonces se restan y se apunta la recompensa, que el
 * navegador no puede escribir.
 *
 * Resultado en el mismo documento: ok, ya-la-tienes, sin-gemas, no-esta.
 */
async function procesarCanjesGemas({ db, admin, simular = false }) {
  if (simular) return { ok: 0 };
  const pendientes = await db.collection('canjes_gemas').where('estado', '==', 'pendiente').limit(50).get();
  const resumen = { ok: 0, 'ya-la-tienes': 0, 'sin-gemas': 0, 'no-esta': 0 };
  for (const doc of pendientes.docs) {
    const uid = doc.id;
    const recompensa = String(doc.data().recompensa || '');
    try {
      const estado = await db.runTransaction(async (t) => {
        const [usuario, tienda] = await Promise.all([t.get(db.doc(`usuarios/${uid}`)), t.get(db.doc('config/tienda'))]);
        const precio = Number(tienda.exists ? tienda.data().gemas?.precios?.[recompensa] : NaN);
        const u = usuario.exists ? usuario.data() : null;
        let resultado;
        if (!u || u.suspendido || !/^[a-z0-9-]{1,40}$/.test(recompensa) || !(precio > 0)) resultado = 'no-esta';
        else if ((u.recompensas || []).includes(recompensa)) resultado = 'ya-la-tienes';
        else if ((Number(u.gemas) || 0) < precio) resultado = 'sin-gemas';
        else {
          resultado = 'ok';
          t.update(db.doc(`usuarios/${uid}`), {
            gemas: admin.firestore.FieldValue.increment(-precio),
            recompensas: admin.firestore.FieldValue.arrayUnion(recompensa),
          });
        }
        t.update(doc.ref, { estado: resultado, precio: precio > 0 ? precio : null, resuelto: admin.firestore.FieldValue.serverTimestamp() });
        return resultado;
      });
      resumen[estado]++;
    } catch (error) {
      console.warn(`  canje de gemas de ${uid} no resuelto:`, error.message);
    }
  }
  if (pendientes.size) console.log(`Gemas: ${JSON.stringify(resumen)}`);
  return resumen;
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
  procesarCanjesGemas,
  configuracion,
  datosDiseno,
  comprobarCobro,
  destinatario,
  pedidoDeOrden,
  productoDeOrden,
  cuerpoPrintful,
  firmaCloudinary,
  formatearTiempo,
  listarPedidosPolar,
  cargarModulos,
};
