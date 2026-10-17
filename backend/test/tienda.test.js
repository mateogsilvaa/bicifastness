'use strict';

/**
 * La tienda: el diseño que se imprime y el camino del pago a la imprenta.
 * Nada sale a la red: Gumroad, Cloudinary y Printful son un `fetch` de mentira.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { FirestoreFalso, FieldValue } = require('./ayuda/firestore-falso');
const tienda = require('../src/tienda');

const RAIZ = path.join(__dirname, '..', '..');
const cargarModuloCliente = (rel) => import(`data:text/javascript;base64,${
  Buffer.from(fs.readFileSync(path.join(RAIZ, rel), 'utf8')).toString('base64')}`);

// --- El diseño -------------------------------------------------------------------

test('limpiar quita emojis y caracteres raros y recorta con puntos suspensivos', async () => {
  const { limpiar } = await cargarModuloCliente('assets/js/tienda-diseno.js');
  assert.strictEqual(limpiar('  Pepe 🚲  el\u0000 rápido  '), 'Pepe el rápido');
  assert.strictEqual(limpiar('abcdefghij', 6), 'abcde…');
  assert.strictEqual(limpiar(null), '');
});

test('un nombre con etiquetas no puede romper el SVG', async () => {
  const { disenoSVG } = await cargarModuloCliente('assets/js/tienda-diseno.js');
  const svg = disenoSVG('camiseta', { nombre: '"><script>alert(1)</script>', clan: { nombre: 'A&B <c>', color: 'red;"', texto: '<x' } });
  assert.doesNotMatch(svg, /<script/);
  assert.doesNotMatch(svg, /fill="red;"/, 'un color raro del clan no entra en un atributo');
  assert.match(svg, /^<svg [^>]+>.*<\/svg>$/s);
});

test('ningun texto se sale de su hueco, por largo que sea', async () => {
  const { linea, anchoEstimado } = await cargarModuloCliente('assets/js/tienda-diseno.js');
  const texto = 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW';
  const svg = linea(texto, { x: 0, y: 0, ancho: 500, max: 120, min: 40, color: '#000', peso: 900 });
  const tam = Number(svg.match(/font-size="(\d+)"/)[1]);
  const dentro = svg.match(/>([^<]*)<\/text>/)[1];
  assert.ok(tam >= 40, 'no baja del minimo');
  assert.ok(anchoEstimado(dentro, tam, 900) <= 500, 'lo que queda cabe');
  assert.match(svg, /textLength="\d+" lengthAdjust="spacingAndGlyphs"/, 'y el renderizador no lo puede desbordar');
});

test('lo que no se sabe no sale en el diseño', async () => {
  const { disenoSVG } = await cargarModuloCliente('assets/js/tienda-diseno.js');
  const svg = disenoSVG('taza', { nombre: 'pepa' });
  assert.doesNotMatch(svg, /undefined|null|NaN/);
});

test('el diseño de la web y el del worker reciben los mismos datos', async () => {
  // Las dos puntas tienen su `datosDiseno`; si un dia divergen, la camiseta
  // no seria la de la vista previa.
  const web = fs.readFileSync(path.join(RAIZ, 'assets/js/paginas/tienda.js'), 'utf8');
  for (const campo of ['nombre', 'clan', 'tiempo', 'origen', 'destino', 'puesto', 'total']) {
    assert.match(web, new RegExp(`\\b${campo}:`), `la web no pasa "${campo}"`);
  }
  const datos = tienda.datosDiseno({
    perfil: { username: 'pepa' }, clan: { nombre: 'Los Radios', color: '#FF5A1F', emblema: 'rayo' },
    viaje: { ruta: '002-110', tiempoSegundos: 749 }, puesto: 3, total: 40,
    nombreEstacion: (c) => ({ '002': 'Metro Callao', 110: 'Moncloa' })[c] || null,
    emblemas: { rayo: { d: 'M1 1' } },
  });
  assert.deepStrictEqual(datos, {
    nombre: 'pepa',
    clan: { nombre: 'Los Radios', color: '#FF5A1F', emblemaD: 'M1 1', texto: 'LR' },
    tiempo: '12:29', origen: 'Metro Callao', destino: 'Moncloa', puesto: 3, total: 40,
  });
});

test('el tiempo se escribe igual que en la web', () => {
  assert.strictEqual(tienda.formatearTiempo(749), '12:29');
  assert.strictEqual(tienda.formatearTiempo(3729), '62:09');
  assert.strictEqual(tienda.formatearTiempo(65), '01:05');
});

// --- Cobro y direccion -----------------------------------------------------------

// Una venta tal y como la da GET /v2/sales (los campos que se usan).
const ventaBuena = (extra = {}) => ({
  id: 'venta1', created_at: '2026-10-17T10:00:00Z', order_id: 123456,
  product_permalink: 'camiseta1', paid: true, price: 2890, tax_cents: 607,
  refunded: false, partially_refunded: false, chargedback: false, disputed: false,
  email: 'pepa@ejemplo.com', full_name: 'Pepa Pérez',
  street_address: 'Calle Mayor 1, 3ºB', city: 'Madrid', state: 'Madrid', zip_code: '28013',
  country: 'Spain', country_iso2: 'ES',
  custom_fields: { pedido: 'uid1_20000_0' },
  ...extra,
});

test('el enlace de Gumroad se reconoce y se saca su permalink', () => {
  assert.strictEqual(tienda.permalinkGumroad('https://pepa.gumroad.com/l/camiseta1'), 'camiseta1');
  assert.strictEqual(tienda.permalinkGumroad('https://gumroad.com/l/abc_12'), 'abc_12');
  assert.strictEqual(tienda.permalinkGumroad('https://buy.stripe.com/x'), null);
  assert.strictEqual(tienda.permalinkGumroad('https://gumroad.com.malo.es/l/x'), null);
});

test('el pedido sale del campo personalizado de la venta', () => {
  assert.strictEqual(tienda.pedidoDeVenta(ventaBuena()), 'uid1_20000_0');
  assert.strictEqual(tienda.pedidoDeVenta(ventaBuena({ custom_fields: {} })), null);
  assert.strictEqual(tienda.pedidoDeVenta(ventaBuena({ custom_fields: undefined })), null);
});

test('se manda a imprimir solo si la venta es del producto, cobrada y sin devolver', () => {
  const producto = { precio: 24.9, enlacePago: 'https://pepa.gumroad.com/l/camiseta1' };
  assert.strictEqual(tienda.comprobarCobro(ventaBuena(), producto), null);
  assert.match(tienda.comprobarCobro(ventaBuena({ product_permalink: 'taza1' }), producto), /producto/);
  assert.match(tienda.comprobarCobro(ventaBuena({ paid: false }), producto), /importe/);
  assert.match(tienda.comprobarCobro(ventaBuena({ refunded: true }), producto), /devuelta/);
  assert.match(tienda.comprobarCobro(ventaBuena({ chargedback: true }), producto), /disputa/);
  assert.ok(tienda.comprobarCobro(ventaBuena(), undefined));
});

test('la direccion de Gumroad se convierte en el recipient de Printful', () => {
  assert.deepStrictEqual(tienda.destinatario(ventaBuena()), {
    name: 'Pepa Pérez', address1: 'Calle Mayor 1, 3ºB', city: 'Madrid', country_code: 'ES', zip: '28013', email: 'pepa@ejemplo.com',
  });
  const eeuu = tienda.destinatario(ventaBuena({ state: 'CA', country_iso2: 'US', city: 'San Francisco', zip_code: '94103' }));
  assert.strictEqual(eeuu.state_code, 'CA', 'en EE. UU. Printful pide el estado');
  assert.strictEqual(tienda.destinatario(ventaBuena({ street_address: '' })), null);
  assert.strictEqual(tienda.destinatario(ventaBuena({ country_iso2: null })), null, 'sin codigo de pais no hay envio');
});

test('la firma de Cloudinary es la que documentan', () => {
  // Ejemplo de la documentacion de Cloudinary (firma de subida).
  const firma = tienda.firmaCloudinary({ eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop', public_id: 'sample_image', timestamp: 1315060510 }, 'abcd');
  assert.strictEqual(firma, 'bfd09f95f331f558cbd1320e67aa8d488770583e');
});

// --- El flujo entero ---------------------------------------------------------------

const ENV = {
  GUMROAD_TOKEN: 'gr_test', PRINTFUL_TOKEN: 'pf', CLOUDINARY_CLOUD: 'nube', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's',
};

function montar({ ventas = [ventaBuena()], printfulYaExiste = false, cloudinaryFalla = false } = {}) {
  const db = new FirestoreFalso();
  db.sembrar('config', [{ id: 'tienda', visible: true, productos: { camiseta: { activo: true, precio: 24.9, enlacePago: 'https://pepa.gumroad.com/l/camiseta1', variantes: { M: 4012 } } } }]);
  db.sembrar('pedidos_tienda', [{ id: 'uid1_20000_0', uid: 'uid1', producto: 'camiseta', variante: 'M', viajeId: 'v1', estado: 'borrador' }]);
  db.sembrar('usuarios', [{ id: 'uid1', username: 'pepa', clanId: null }]);
  db.sembrar('tiempos_viaje', [{ id: 'v1', uid: 'uid1', verificado: true, ruta: '002-110', tiempoSegundos: 749 }]);
  db.sembrar('agregados', [{ id: 'ranking-general', filas: [{ nombre: 'pepa', pos: 7 }], total: 50 }]);

  const llamadas = [];
  const fetchFn = async (url, opciones = {}) => {
    llamadas.push({ url, metodo: opciones.method || 'GET', cuerpo: opciones.body });
    const responder = (status, cuerpo) => ({ ok: status < 300, status, text: async () => JSON.stringify(cuerpo) });
    if (url.startsWith('https://api.gumroad.com/v2/sales')) return responder(200, { success: true, sales: ventas });
    if (url.startsWith('https://api.cloudinary.com/')) {
      return cloudinaryFalla ? responder(500, { error: { message: 'caido' } }) : responder(200, { secure_url: 'https://res.cloudinary.com/x.png' });
    }
    if (url.includes('/orders/@')) return printfulYaExiste ? responder(200, { result: { id: 77, status: 'draft' } }) : responder(404, { error: { message: 'no' } });
    if (url.startsWith('https://api.printful.com/orders')) return responder(200, { result: { id: 99, status: 'draft' } });
    throw new Error(`url inesperada ${url}`);
  };
  const avisos = [];
  const ctx = {
    db, admin: { firestore: { FieldValue } }, fetchFn, env: ENV,
    aPng: async (svg) => Buffer.from(svg),
    nombreEstacion: () => null,
    avisarAdmin: async (asunto, cuerpo) => { avisos.push(`${asunto}: ${cuerpo}`); },
  };
  return { db, ctx, llamadas, avisos };
}

test('un pago bueno acaba en un pedido de Printful con el diseño y la direccion', async () => {
  const { db, ctx, llamadas, avisos } = montar();
  const mandados = await tienda.procesarTienda(ctx);
  assert.strictEqual(mandados, 1);

  const pedido = db.leer('pedidos_tienda/uid1_20000_0');
  assert.strictEqual(pedido.estado, 'en_proveedor', 'sin TIENDA_CONFIRMAR llega como borrador');
  assert.strictEqual(pedido.printfulId, 99);
  assert.strictEqual(pedido.imagenUrl, 'https://res.cloudinary.com/x.png');
  assert.strictEqual(pedido.gumroadVenta, 'venta1');
  assert.strictEqual(pedido.impuesto, 607, 'el IVA que cobro Gumroad queda apuntado');

  const alta = llamadas.find((l) => l.metodo === 'POST' && l.url.startsWith('https://api.printful.com/orders'));
  const cuerpo = JSON.parse(alta.cuerpo);
  assert.strictEqual(cuerpo.external_id, 'uid1_20000_0');
  assert.strictEqual(cuerpo.items[0].variant_id, 4012);
  assert.strictEqual(cuerpo.items[0].files[0].url, 'https://res.cloudinary.com/x.png');
  assert.strictEqual(cuerpo.recipient.zip, '28013');

  // El diseño sale de la base de datos: lleva su tiempo y su puesto.
  const subida = llamadas.find((l) => l.url.startsWith('https://api.cloudinary.com/'));
  const svg = Buffer.from(subida.cuerpo.get('file').split(',')[1], 'base64').toString('utf8');
  assert.match(svg, />12:29</);
  assert.match(svg, />#7</);
  assert.ok(avisos.some((a) => /confirmalo/.test(a)));

  // Y la siguiente ejecucion no lo vuelve a mandar.
  llamadas.length = 0;
  assert.strictEqual(await tienda.procesarTienda(ctx), 0);
  assert.ok(!llamadas.some((l) => l.metodo === 'POST'));
});

test('si el pedido ya estaba en Printful no se duplica', async () => {
  const { db, ctx, llamadas } = montar({ printfulYaExiste: true });
  await tienda.procesarTienda(ctx);
  assert.ok(!llamadas.some((l) => l.metodo === 'POST' && l.url.startsWith('https://api.printful.com/')));
  assert.strictEqual(db.leer('pedidos_tienda/uid1_20000_0').printfulId, 77);
});

test('un pago que no cuadra va a revisar y no se imprime', async () => {
  const { db, ctx, llamadas, avisos } = montar({ ventas: [ventaBuena({ product_permalink: 'taza1' })] });
  await tienda.procesarTienda(ctx);
  assert.strictEqual(db.leer('pedidos_tienda/uid1_20000_0').estado, 'revisar');
  assert.ok(!llamadas.some((l) => l.url.startsWith('https://api.printful.com/')));
  assert.ok(avisos.some((a) => /revisar/.test(a)));
});

test('un trayecto ajeno no se imprime: el pedido sale sin tiempo', async () => {
  const { db, ctx, llamadas } = montar();
  db.sembrar('tiempos_viaje', [{ id: 'v1', uid: 'otra', verificado: true, ruta: '002-110', tiempoSegundos: 60 }]);
  await tienda.procesarTienda(ctx);
  const subida = llamadas.find((l) => l.url.startsWith('https://api.cloudinary.com/'));
  const svg = Buffer.from(subida.cuerpo.get('file').split(',')[1], 'base64').toString('utf8');
  assert.doesNotMatch(svg, /01:00/);
});

test('un fallo de un servicio se reintenta, y al tercero avisa', async () => {
  const { db, ctx, avisos } = montar({ cloudinaryFalla: true });
  for (let i = 0; i < 3; i++) await tienda.procesarTienda(ctx);
  const pedido = db.leer('pedidos_tienda/uid1_20000_0');
  assert.strictEqual(pedido.intentos, 3);
  assert.strictEqual(pedido.estado, 'error');
  assert.ok(avisos.some((a) => /no ha podido salir/.test(a)));
});

test('sin token de Gumroad la tienda no lee nada', async () => {
  const { db, ctx } = montar();
  db.reiniciarContador();
  assert.strictEqual(await tienda.procesarTienda({ ...ctx, env: {} }), 0);
  assert.strictEqual(db.lecturas, 0);
});

test('un pago sin pedido de la web avisa y no imprime nada', async () => {
  const { ctx, llamadas, avisos } = montar({ ventas: [ventaBuena({ custom_fields: {} })] });
  await tienda.procesarTienda(ctx);
  assert.ok(avisos.some((a) => /pago sin pedido/.test(a)));
  assert.ok(!llamadas.some((l) => l.url.startsWith('https://api.printful.com/')));
});

// --- La coleccion de Printful ---------------------------------------------------------

const productoPrintful = () => ({
  sync_product: { id: 101, name: 'Sudadera Calzada', thumbnail_url: 'https://files.cdn.printful.com/t.png' },
  sync_variants: [
    { id: 9001, size: 'M', color: 'Negro', retail_price: '39.90', currency: 'EUR', availability_status: 'active',
      files: [{ type: 'default' }, { type: 'preview', preview_url: 'https://files.cdn.printful.com/m.png' }] },
    { id: 9002, size: 'XL', color: 'Negro', retail_price: '42.90', currency: 'EUR', availability_status: 'discontinued' },
    { id: 9003, size: 'L', color: 'Negro', retail_price: '39.90', currency: 'EUR', is_ignored: true },
  ],
});

test('un producto de Printful se queda con lo que enseña la web, sin variantes agotadas', () => {
  assert.deepStrictEqual(tienda.productoCatalogo(productoPrintful()), {
    nombre: 'Sudadera Calzada', imagen: 'https://files.cdn.printful.com/t.png',
    variantes: { 9001: { nombre: 'M · Negro', precio: 39.9, moneda: 'EUR', imagen: 'https://files.cdn.printful.com/m.png' } },
  });
  assert.strictEqual(tienda.productoCatalogo({ sync_product: { id: 1 }, sync_variants: [] }), null, 'sin variantes no se vende');
});

test('el catalogo se copia como mucho una vez por hora', async () => {
  const db = new FirestoreFalso();
  const llamadas = [];
  const fetchFn = async (url) => {
    llamadas.push(url);
    const responder = (cuerpo) => ({ ok: true, status: 200, text: async () => JSON.stringify(cuerpo) });
    if (url.endsWith('/store/products?limit=100')) return responder({ result: [{ id: 101 }, { id: 102, is_ignored: true }] });
    if (url.endsWith('/store/products/101')) return responder({ result: productoPrintful() });
    throw new Error(`url inesperada ${url}`);
  };
  const ctx = { db, admin: { firestore: { FieldValue } }, fetchFn, env: { PRINTFUL_TOKEN: 'pf' }, ahora: 1e12 };
  await tienda.sincronizarCatalogo(ctx);
  assert.deepStrictEqual(Object.keys(db.leer('config/tienda_catalogo').productos), ['101']);
  assert.strictEqual(llamadas.length, 2, 'el ignorado ni se pide');

  llamadas.length = 0;
  assert.strictEqual(await tienda.sincronizarCatalogo({ ...ctx, ahora: 1e12 + 30 * 60e3 }), null);
  assert.strictEqual(llamadas.length, 0, 'a la media hora no vuelve a preguntar');
  assert.ok(await tienda.sincronizarCatalogo({ ...ctx, ahora: 1e12 + 61 * 60e3 }), 'pasada la hora, si');
  assert.strictEqual(await tienda.sincronizarCatalogo({ ...ctx, env: {} }), null, 'sin token no hace nada');
});

function montarCatalogo({ venta = ventaBuena({ product_permalink: 'sudadera1' }), variante = '9001' } = {}) {
  const db = new FirestoreFalso();
  db.sembrar('config', [
    { id: 'tienda', visible: true, productos: {}, catalogo: { 101: 'https://pepa.gumroad.com/l/sudadera1' } },
    { id: 'tienda_catalogo', productos: { 101: { nombre: 'Sudadera Calzada', variantes: { 9001: { nombre: 'M · Negro', precio: 39.9 } } } } },
  ]);
  db.sembrar('pedidos_tienda', [{ id: 'uid1_20000_0', uid: 'uid1', producto: 'pf_101', variante, estado: 'borrador' }]);
  const llamadas = [];
  const fetchFn = async (url, opciones = {}) => {
    llamadas.push({ url, metodo: opciones.method || 'GET', cuerpo: opciones.body });
    const responder = (status, cuerpo) => ({ ok: status < 300, status, text: async () => JSON.stringify(cuerpo) });
    if (url.startsWith('https://api.gumroad.com/v2/sales')) return responder(200, { success: true, sales: [venta] });
    if (url.includes('/orders/@')) return responder(404, { error: { message: 'no' } });
    if (url.startsWith('https://api.printful.com/orders')) return responder(200, { result: { id: 55, status: 'draft' } });
    throw new Error(`url inesperada ${url}`);
  };
  const avisos = [];
  // Sin claves de Cloudinary: la coleccion no las necesita.
  const ctx = {
    db, admin: { firestore: { FieldValue } }, fetchFn, env: { GUMROAD_TOKEN: 'gr', PRINTFUL_TOKEN: 'pf' },
    aPng: async () => { throw new Error('la coleccion no pinta nada'); },
    nombreEstacion: () => null,
    avisarAdmin: async (asunto, cuerpo) => { avisos.push(`${asunto}: ${cuerpo}`); },
  };
  return { db, ctx, llamadas, avisos };
}

test('una venta de la coleccion se pide a Printful por su variante, sin diseño ni Cloudinary', async () => {
  const { db, ctx, llamadas } = montarCatalogo();
  assert.strictEqual(await tienda.procesarTienda(ctx), 1);
  const alta = llamadas.find((l) => l.metodo === 'POST');
  assert.deepStrictEqual(JSON.parse(alta.cuerpo).items, [{ sync_variant_id: 9001, quantity: 1 }]);
  assert.strictEqual(JSON.parse(alta.cuerpo).recipient.zip, '28013');
  assert.ok(!llamadas.some((l) => l.url.includes('cloudinary')));
  assert.strictEqual(db.leer('pedidos_tienda/uid1_20000_0').printfulId, 55);
});

test('una venta de la coleccion con otro producto de Gumroad o sin variante va a revisar', async () => {
  const otro = montarCatalogo({ venta: ventaBuena({ product_permalink: 'gorra1' }) });
  await tienda.procesarTienda(otro.ctx);
  assert.strictEqual(otro.db.leer('pedidos_tienda/uid1_20000_0').estado, 'revisar');
  assert.ok(!otro.llamadas.some((l) => l.metodo === 'POST'));

  const sinVariante = montarCatalogo({ variante: '7777' });
  await tienda.procesarTienda(sinVariante.ctx);
  assert.match(sinVariante.db.leer('pedidos_tienda/uid1_20000_0').mensajeError, /variante/);
});

// --- La invitacion -----------------------------------------------------------------

test('la invitacion a la tienda no persigue a nadie', async () => {
  // tienda.js importa firebase.js: se prueba la regla, que esta escrita sin dependencias.
  const codigo = fs.readFileSync(path.join(RAIZ, 'assets/js/tienda.js'), 'utf8');
  const cuerpo = codigo.slice(codigo.indexOf('export function tocaInvitar'), codigo.indexOf('\n}\n', codigo.indexOf('export function tocaInvitar')) + 2);
  const { tocaInvitar } = await import(`data:text/javascript;base64,${Buffer.from(
    `const DIAS_ENTRE = 30; const VECES_MAX = 3; const leerVista = () => ({});\n${cuerpo}`,
  ).toString('base64')}`);
  const ahora = Date.now();
  const veterano = { viajesVerificados: 20, creado: { toMillis: () => ahora - 60 * 864e5 } };
  assert.strictEqual(tocaInvitar(veterano, ahora, {}), true);
  assert.strictEqual(tocaInvitar({ ...veterano, viajesVerificados: 2 }, ahora, {}), false, 'a quien empieza no se le pide nada');
  assert.strictEqual(tocaInvitar({ ...veterano, creado: { toMillis: () => ahora - 864e5 } }, ahora, {}), false);
  assert.strictEqual(tocaInvitar(veterano, ahora, { ultima: ahora - 5 * 864e5, veces: 1 }), false, 'una vez al mes como mucho');
  assert.strictEqual(tocaInvitar(veterano, ahora, { ultima: ahora - 40 * 864e5, veces: 3 }), false, 'tres veces en total');
  assert.strictEqual(tocaInvitar(veterano, ahora, { nunca: true }), false);
});
