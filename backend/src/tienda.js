'use strict';

/**
 * La tienda, del pago a la imprenta.
 *
 * Vende dos cosas:
 *   - el CATALOGO de Printful: los productos que ya estan montados alli, con
 *     sus fotos y sus precios. El worker los copia a `config/tienda_catalogo`
 *     (la web no puede preguntar a Printful: haria falta el token) y, al
 *     venderse uno, lo pide a Printful por su `sync_variant_id`;
 *   - los PERSONALIZADOS (camiseta y taza): el diseño se pinta con los datos
 *     de cada piloto, como se explica abajo.
 *
 * Cobra Gumroad, que es el vendedor a efectos fiscales (merchant of record):
 * calcula, cobra y declara el IVA de cada pais. No hay servidor que reciba su
 * aviso de venta (la web es estatica y el worker corre en GitHub Actions; y el
 * "Ping" de Gumroad, ademas, no va firmado), asi que el worker hace de webhook
 * al reves: en cada ejecucion PREGUNTA a Gumroad por las ventas desde la
 * ultima vez (`GET /v2/sales`). Para cada una:
 *
 * En los dos casos:
 *
 *   1. Busca el pedido borrador por el campo personalizado `pedido` (lo
 *      rellena la web en la URL del producto) y comprueba que la venta es del
 *      producto que toca, cobrada y sin devolver.
 *   2. (Solo personalizados.) Saca los datos que se imprimen de la BASE DE DATOS (perfil, clan,
 *      trayecto, puesto), nunca de lo que mando el navegador.
 *   3. (Solo personalizados.) Pinta el diseño con assets/js/tienda-diseno.js —el mismo de la vista
 *      previa—, lo pasa a PNG con sharp y lo sube a Cloudinary.
 *   4. Crea el pedido en Printful con la direccion que recogio Gumroad.
 *
 * Es idempotente: el pedido de Printful lleva el id del nuestro como
 * `external_id`, y antes de crearlo se pregunta si ya existe. Una ejecucion
 * cortada a medias se retoma sin duplicar nada.
 *
 * Coste en Firestore: dos lecturas por ejecucion (la configuracion y por donde
 * va leyendo) y, por pedido pagado, las cinco o seis de sus datos. Sin el
 * token de Gumroad no lee nada.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { diaMadrid } = require('./util');

const RAIZ = path.join(__dirname, '..', '..');
const PEDIDO_ID = /^[A-Za-z0-9]{1,128}_\d{1,6}_[0-4]$/;
const INTENTOS_MAX = 3;
// Los productos del catalogo van en el pedido como `pf_<id de Printful>`.
const DEL_CATALOGO = /^pf_(\d{1,15})$/;
const CATALOGO_VIGENCIA = 60 * 60 * 1000;
const CATALOGO_MAX = 40;

/** Las claves, de las variables de entorno (secretos del repositorio). */
function configuracion(env = process.env) {
  const cfg = {
    gumroad: env.GUMROAD_TOKEN || '',
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
  // Cloudinary solo hace falta para los personalizados: el catalogo ya tiene
  // sus ficheros en Printful.
  cfg.lista = Boolean(cfg.gumroad && cfg.printful);
  cfg.conCloudinary = Boolean(cfg.cloudinary.nube && cfg.cloudinary.clave && cfg.cloudinary.secreto);
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

/** "abc12" de https://pepa.gumroad.com/l/abc12, o null si no es un enlace de Gumroad. */
function permalinkGumroad(enlace) {
  const m = String(enlace || '').match(/^https:\/\/(?:[a-z0-9-]+\.)?gumroad\.com\/l\/([A-Za-z0-9_-]+)\/?$/);
  return m ? m[1] : null;
}

/** El id de nuestro pedido, del campo personalizado `pedido` de la venta. */
function pedidoDeVenta(venta) {
  const valor = venta.custom_fields?.pedido;
  return typeof valor === 'string' ? valor.trim() : null;
}

/**
 * ¿La venta vale para imprimir? Devuelve el motivo si no, o null si cuadra.
 * El precio lo fija el producto en Gumroad y no se puede tocar desde la web, y
 * el importe que da su API va en dolares (`price`, centimos de USD), asi que
 * en vez del importe se comprueba que es el PRODUCTO del pedido: eso pilla un
 * enlace cambiado de producto o una camiseta pagada con el precio de la taza.
 */
function comprobarCobro(venta, producto) {
  if (!producto) return 'el producto del pedido ya no esta en la tienda';
  if (!venta.paid) return 'la venta no tiene importe';
  if (venta.refunded || venta.partially_refunded) return 'la venta esta devuelta';
  if (venta.chargedback || venta.disputed) return 'la venta tiene una disputa';
  const esperado = permalinkGumroad(producto.enlacePago);
  if (!esperado || venta.product_permalink !== esperado) {
    return `la venta es del producto "${venta.product_permalink}" y el pedido es de "${esperado}"`;
  }
  return null;
}

// Printful pide el estado/provincia solo en estos paises, y como codigo.
const CON_ESTADO = new Set(['US', 'CA', 'AU', 'JP']);

/**
 * La direccion de envio que recogio Gumroad, en el formato de Printful (el
 * `recipient` de POST /orders). Gumroad la da en la venta solo si el producto
 * es fisico ("Require shipping information"): `full_name`, `street_address`
 * (una sola linea), `city`, `state`, `zip_code`, `country` (el nombre, en
 * ingles) y `country_iso2` (el codigo, que es lo que quiere Printful).
 */
function destinatario(venta) {
  const pais = String(venta.country_iso2 || '').toUpperCase();
  if (!venta.street_address || !venta.city || !venta.zip_code || !/^[A-Z]{2}$/.test(pais)) return null;
  const estado = String(venta.state || '').trim();
  return {
    name: String(venta.full_name || '').trim().slice(0, 100),
    address1: String(venta.street_address).trim(),
    city: String(venta.city).trim(),
    ...(CON_ESTADO.has(pais) && estado ? { state_code: estado } : {}),
    country_code: pais,
    zip: String(venta.zip_code).trim(),
    ...(venta.email ? { email: venta.email } : {}),
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

/**
 * Un pedido del catalogo para Printful: el producto ya esta montado alli
 * (diseño y precio), asi que basta con su variante sincronizada.
 */
function cuerpoPrintfulCatalogo({ pedidoId, recipient, syncVariantId }) {
  return {
    external_id: pedidoId,
    shipping: 'STANDARD',
    recipient,
    items: [{ sync_variant_id: Number(syncVariantId), quantity: 1 }],
  };
}

/**
 * Un producto de Printful (`result` de GET /store/products/{id}) como lo
 * enseña la web: nombre, foto y, por variante, su nombre, precio y foto. Las
 * variantes ignoradas, sin existencias o sin precio no salen.
 */
function productoCatalogo(resultado) {
  const sp = resultado?.sync_product;
  if (!sp?.id || sp.is_ignored) return null;
  const variantes = {};
  for (const v of resultado.sync_variants || []) {
    if (!v?.id || v.is_ignored) continue;
    if (v.availability_status && v.availability_status !== 'active') continue;
    const precio = Number(v.retail_price);
    if (!Number.isFinite(precio) || precio <= 0) continue;
    variantes[String(v.id)] = {
      nombre: [v.size, v.color].filter(Boolean).join(' · ') || String(v.name || '').slice(0, 60),
      precio,
      moneda: String(v.currency || 'EUR').toUpperCase(),
      imagen: (v.files || []).find((f) => f?.type === 'preview')?.preview_url || v.product?.image || null,
    };
  }
  if (!Object.keys(variantes).length) return null;
  return { nombre: String(sp.name || '').slice(0, 80), imagen: sp.thumbnail_url || null, variantes };
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
 * Las ventas desde el dia `desde` ("AAAA-MM-DD": Gumroad filtra por fecha, no
 * por hora), con paginacion por `page_key`. Vienen de la mas nueva a la mas vieja.
 */
async function listarVentas(fetchFn, token, desde) {
  const todas = [];
  let clave = null;
  for (let pagina = 0; pagina < 10; pagina++) {
    const q = new URLSearchParams({ after: desde });
    if (clave) q.set('page_key', clave);
    const r = await pedirJson(fetchFn, `https://api.gumroad.com/v2/sales?${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok || r.cuerpo?.success === false) throw new Error(`Gumroad ${r.status}: ${r.cuerpo?.message || 'sin detalle'}`);
    todas.push(...(r.cuerpo.sales || []));
    clave = r.cuerpo.next_page_key || null;
    if (!clave) break;
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

/** Las cabeceras del API de Printful (v1). */
function cabecerasPrintful(cfg) {
  return {
    Authorization: `Bearer ${cfg.printful}`,
    'Content-Type': 'application/json',
    ...(cfg.printfulTienda ? { 'X-PF-Store-Id': cfg.printfulTienda } : {}),
  };
}

/** Crea el pedido en Printful, o devuelve el que ya hubiera con ese id. */
async function pedidoEnPrintful(fetchFn, cfg, cuerpo) {
  const cabeceras = cabecerasPrintful(cfg);
  const ya = await pedirJson(fetchFn, `https://api.printful.com/orders/@${encodeURIComponent(cuerpo.external_id)}`, { headers: cabeceras });
  if (ya.ok && ya.cuerpo?.result?.id) return { id: ya.cuerpo.result.id, estado: ya.cuerpo.result.status, nuevo: false };
  const r = await pedirJson(fetchFn, `https://api.printful.com/orders${cfg.confirmar ? '?confirm=1' : ''}`, {
    method: 'POST', headers: cabeceras, body: JSON.stringify(cuerpo),
  });
  if (!r.ok || !r.cuerpo?.result?.id) throw new Error(`Printful ${r.status}: ${r.cuerpo?.error?.message || r.cuerpo?.result || 'sin detalle'}`);
  return { id: r.cuerpo.result.id, estado: r.cuerpo.result.status, nuevo: true };
}

// --- El catalogo de Printful -------------------------------------------------------

/**
 * Copia los productos de la tienda de Printful a `config/tienda_catalogo`, que
 * es lo que lee la web. Como mucho una vez por hora: cuesta una lectura por
 * ejecucion (saber cuando se copio) y, al copiar, una llamada por producto.
 * Sin `PRINTFUL_TOKEN` no hace nada.
 * @returns {Promise<object|null>} el catalogo copiado, o null si no tocaba
 */
async function sincronizarCatalogo({ db, admin, fetchFn = fetch, env = process.env, simular = false, ahora = Date.now() }) {
  const cfg = configuracion(env);
  if (!cfg.printful) return null;
  const ref = db.doc('config/tienda_catalogo');
  const snap = await ref.get();
  if (snap.exists && ahora - (snap.data().actualizadoMs || 0) < CATALOGO_VIGENCIA) return null;

  const opciones = { headers: cabecerasPrintful(cfg) };
  const lista = await pedirJson(fetchFn, 'https://api.printful.com/store/products?limit=100', opciones);
  if (!lista.ok) throw new Error(`Printful ${lista.status}: ${lista.cuerpo?.error?.message || 'sin detalle'}`);
  const productos = {};
  for (const p of (lista.cuerpo?.result || []).filter((x) => x?.id && !x.is_ignored).slice(0, CATALOGO_MAX)) {
    const r = await pedirJson(fetchFn, `https://api.printful.com/store/products/${encodeURIComponent(p.id)}`, opciones);
    if (!r.ok) throw new Error(`Printful ${r.status}: ${r.cuerpo?.error?.message || 'sin detalle'}`);
    const producto = productoCatalogo(r.cuerpo?.result);
    if (producto) productos[String(p.id)] = producto;
  }
  const catalogo = { productos, actualizadoMs: ahora };
  if (!simular) await ref.set({ ...catalogo, actualizado: admin.firestore.FieldValue.serverTimestamp() });
  console.log(`Tienda: catalogo de Printful copiado, ${Object.keys(productos).length} producto(s).`);
  return catalogo;
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
  if (!cfg.gumroad) return 0;
  if (!cfg.lista) {
    console.warn('::warning::Tienda: hay token de Gumroad pero falta el de Printful. No se procesa nada.');
    return 0;
  }
  // El catalogo se lee solo si alguna venta es de el, y una vez.
  let catalogoLeido = null;
  const leerCatalogo = () => {
    catalogoLeido = catalogoLeido || db.doc('config/tienda_catalogo').get().then((s) => (s.exists ? s.data() : {}));
    return catalogoLeido;
  };

  const [tiendaSnap, cursorSnap] = await Promise.all([
    db.doc('config/tienda').get(),
    db.doc('tienda_interno/gumroad').get(),
  ]);
  const tienda = tiendaSnap.exists ? tiendaSnap.data() : {};
  const cursor = cursorSnap.exists ? cursorSnap.data() : {};
  const ahora = Date.now();
  // Gumroad filtra por dia: se pregunta desde el dia anterior al ultimo que se
  // miro (un dia de solape, por los husos) y lo ya visto se salta por su id.
  const desde = diaMadrid(new Date((cursor.desde || ahora - 3 * 864e5) - 864e5));
  const vistas = new Set(cursor.vistas || []);

  const ventas = (await listarVentas(fetchFn, cfg.gumroad, desde))
    .filter((v) => v.id && !vistas.has(v.id))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  if (!ventas.length) {
    if (!cursorSnap.exists && !simular) await db.doc('tienda_interno/gumroad').set({ desde: ahora, vistas: [] });
    return 0;
  }

  let mandados = 0;
  let pendienteMasViejo = null;
  for (const venta of ventas) {
    const resultado = await procesarVenta({ ...ctx, cfg, tienda, leerCatalogo, venta, fetchFn, aPng, nombreEstacion, avisarAdmin, simular, db, admin });
    if (resultado === 'reintentar') {
      pendienteMasViejo = pendienteMasViejo ?? Date.parse(venta.created_at);
      continue;
    }
    vistas.add(venta.id);
    if (resultado === 'mandado') mandados += 1;
  }

  if (!simular) {
    const ultima = Math.max(...ventas.map((v) => Date.parse(v.created_at) || 0));
    await db.doc('tienda_interno/gumroad').set({
      // Lo que haya que reintentar sigue dentro de la ventana.
      desde: pendienteMasViejo ? Math.min(pendienteMasViejo, ultima) : ultima,
      vistas: [...vistas].slice(-300),
    });
  }
  console.log(`Tienda: ${ventas.length} venta(s) nueva(s), ${mandados} pedido(s) a la imprenta.`);
  return mandados;
}

/** Una venta. Devuelve 'mandado', 'revisar', 'ignorado' o 'reintentar'. */
async function procesarVenta({ db, admin, cfg, tienda, leerCatalogo, venta, fetchFn, aPng, nombreEstacion, avisarAdmin, simular }) {
  // Lo que se guarda de la venta en el pedido. Los importes, como los da
  // Gumroad: centimos de dolar, el IVA incluido en `impuesto`.
  const deLaVenta = {
    gumroadVenta: venta.id, importe: Number.isFinite(venta.price) ? venta.price : null,
    impuesto: Number.isFinite(venta.tax_cents) ? venta.tax_cents : null, moneda: 'usd',
  };
  const pedidoId = pedidoDeVenta(venta);
  if (!pedidoId || !PEDIDO_ID.test(pedidoId)) {
    // Alguien ha comprado en Gumroad sin pasar por la web: no sabemos que
    // imprimir. Lo resuelve una persona (o se devuelve desde Gumroad).
    await avisarAdmin('Tienda: pago sin pedido', `La venta ${venta.id} de Gumroad (pedido nº ${venta.order_id}) no trae un pedido de la web. Hay que resolverla a mano.`);
    return 'revisar';
  }
  const ref = db.doc(`pedidos_tienda/${pedidoId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    await avisarAdmin('Tienda: pago de un pedido que no existe', `Venta ${venta.id}, pedido ${pedidoId}.`);
    return 'revisar';
  }
  const pedido = snap.data();
  if (!['borrador', 'pagado'].includes(pedido.estado)) return 'ignorado';

  const marcarRevisar = async (motivo) => {
    console.warn(`  [tienda ${pedidoId}] a revisar: ${motivo}`);
    if (!simular) {
      await ref.update({
        estado: 'revisar', mensajeError: motivo.slice(0, 300), ...deLaVenta,
        pagadoEn: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await avisarAdmin('Tienda: pedido pagado que hay que revisar', `Pedido ${pedidoId} (venta ${venta.id} de Gumroad): ${motivo}.`);
    return 'revisar';
  };

  const marcarPagado = async () => {
    if (!simular && pedido.estado === 'borrador') {
      await ref.update({
        estado: 'pagado', ...deLaVenta, pagadoEn: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  };
  const reintentarOAvisar = async (error) => {
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
  };
  const avisarNuevo = async (enviado, que) => {
    if (!enviado.nuevo) return;
    await avisarAdmin(
      cfg.confirmar ? 'Tienda: pedido nuevo en produccion' : 'Tienda: pedido nuevo para confirmar',
      `${que}. Printful #${enviado.id}` + (cfg.confirmar ? '.' : ': esta como borrador, confirmalo en el panel de Printful.'),
    );
  };

  // --- Del catalogo de Printful ---
  const delCatalogo = String(pedido.producto || '').match(DEL_CATALOGO);
  if (delCatalogo) {
    const idPrintful = delCatalogo[1];
    const enCatalogo = (await leerCatalogo()).productos?.[idPrintful];
    const enlacePago = tienda.catalogo?.[idPrintful];
    const cobro = comprobarCobro(venta, enCatalogo && enlacePago ? { enlacePago } : null);
    if (cobro) return marcarRevisar(cobro);
    const variante = enCatalogo.variantes?.[pedido.variante];
    if (!variante) return marcarRevisar(`la variante ${pedido.variante} ya no esta en el catalogo de Printful`);
    const recipient = destinatario(venta);
    if (!recipient) return marcarRevisar('Gumroad no ha recogido una direccion de envio completa (¿el producto es fisico y pide la direccion?)');
    await marcarPagado();
    if (simular) {
      console.log(`  [tienda ${pedidoId}] se mandaria: ${enCatalogo.nombre} ${variante.nombre}`);
      return 'mandado';
    }
    try {
      const enviado = await pedidoEnPrintful(fetchFn, cfg, cuerpoPrintfulCatalogo({ pedidoId, recipient, syncVariantId: pedido.variante }));
      await ref.update({
        estado: cfg.confirmar ? 'en_produccion' : 'en_proveedor',
        printfulId: enviado.id, mensajeError: admin.firestore.FieldValue.delete(),
      });
      await avisarNuevo(enviado, `${enCatalogo.nombre} ${variante.nombre}`);
      return 'mandado';
    } catch (error) {
      return reintentarOAvisar(error);
    }
  }

  // --- Personalizado ---
  const producto = tienda.productos?.[pedido.producto];
  const cobro = comprobarCobro(venta, producto);
  if (cobro) return marcarRevisar(cobro);
  const varianteId = producto.variantes?.[pedido.variante];
  if (!varianteId) return marcarRevisar(`no hay variante del proveedor para "${pedido.variante}"`);
  const recipient = destinatario(venta);
  if (!recipient) return marcarRevisar('Gumroad no ha recogido una direccion de envio completa (¿el producto es fisico y pide la direccion?)');
  if (!cfg.conCloudinary) return marcarRevisar('faltan las claves de Cloudinary, que hacen falta para los personalizados');

  await marcarPagado();

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
    await avisarNuevo(enviado, `${pedido.producto} ${pedido.variante} de ${datos.nombre}`);
    return 'mandado';
  } catch (error) {
    return reintentarOAvisar(error);
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
  sincronizarCatalogo,
  productoCatalogo,
  cuerpoPrintfulCatalogo,
  configuracion,
  datosDiseno,
  comprobarCobro,
  destinatario,
  permalinkGumroad,
  pedidoDeVenta,
  cuerpoPrintful,
  firmaCloudinary,
  formatearTiempo,
  listarVentas,
  cargarModulos,
};
