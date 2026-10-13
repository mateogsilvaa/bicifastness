'use strict';

/**
 * La tienda: el diseño que se imprime y el camino del pago a la imprenta.
 * Nada sale a la red: Stripe, Cloudinary y Printful son un `fetch` de mentira.
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

const sesionBuena = (extra = {}) => ({
  id: 'cs_1', created: 1000, client_reference_id: 'uid1_20000_0',
  payment_status: 'paid', currency: 'eur', amount_subtotal: 2490, amount_total: 2980,
  customer_details: { email: 'pepa@ejemplo.com', name: 'Pepa' },
  collected_information: {
    shipping_details: { name: 'Pepa Pérez', address: { line1: 'Calle Mayor 1', city: 'Madrid', postal_code: '28013', country: 'ES' } },
  },
  ...extra,
});

test('se manda a imprimir solo si lo cobrado cuadra con el precio', () => {
  const producto = { precio: 24.9 };
  assert.strictEqual(tienda.comprobarCobro(sesionBuena(), producto), null);
  assert.match(tienda.comprobarCobro(sesionBuena({ amount_subtotal: 100 }), producto), /centimos/);
  assert.match(tienda.comprobarCobro(sesionBuena({ payment_status: 'unpaid' }), producto), /unpaid/);
  assert.match(tienda.comprobarCobro(sesionBuena({ currency: 'usd' }), producto), /moneda/);
  assert.ok(tienda.comprobarCobro(sesionBuena(), undefined));
});

test('la direccion sale de cualquiera de las dos versiones del API de Stripe', () => {
  const nueva = tienda.destinatario(sesionBuena());
  assert.deepStrictEqual(nueva, {
    name: 'Pepa Pérez', address1: 'Calle Mayor 1', city: 'Madrid', country_code: 'ES', zip: '28013', email: 'pepa@ejemplo.com',
  });
  const vieja = tienda.destinatario(sesionBuena({
    collected_information: undefined,
    shipping_details: { name: 'Pepa', address: { line1: 'C/ Sol 2', line2: '3ºB', city: 'Madrid', postal_code: '28012', country: 'ES' } },
  }));
  assert.strictEqual(vieja.address2, '3ºB');
  assert.strictEqual(tienda.destinatario(sesionBuena({ collected_information: undefined })), null);
});

test('la firma de Cloudinary es la que documentan', () => {
  // Ejemplo de la documentacion de Cloudinary (firma de subida).
  const firma = tienda.firmaCloudinary({ eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop', public_id: 'sample_image', timestamp: 1315060510 }, 'abcd');
  assert.strictEqual(firma, 'bfd09f95f331f558cbd1320e67aa8d488770583e');
});

// --- El flujo entero ---------------------------------------------------------------

const ENV = {
  STRIPE_SECRET_KEY: 'rk_test', PRINTFUL_TOKEN: 'pf', CLOUDINARY_CLOUD: 'nube', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's',
};

function montar({ sesiones = [sesionBuena()], printfulYaExiste = false, cloudinaryFalla = false } = {}) {
  const db = new FirestoreFalso();
  db.sembrar('config', [{ id: 'tienda', visible: true, productos: { camiseta: { activo: true, precio: 24.9, enlacePago: 'https://buy.stripe.com/x', variantes: { M: 4012 } } } }]);
  db.sembrar('pedidos_tienda', [{ id: 'uid1_20000_0', uid: 'uid1', producto: 'camiseta', variante: 'M', viajeId: 'v1', estado: 'borrador' }]);
  db.sembrar('usuarios', [{ id: 'uid1', username: 'pepa', clanId: null }]);
  db.sembrar('tiempos_viaje', [{ id: 'v1', uid: 'uid1', verificado: true, ruta: '002-110', tiempoSegundos: 749 }]);
  db.sembrar('agregados', [{ id: 'ranking-general', filas: [{ nombre: 'pepa', pos: 7 }], total: 50 }]);

  const llamadas = [];
  const fetchFn = async (url, opciones = {}) => {
    llamadas.push({ url, metodo: opciones.method || 'GET', cuerpo: opciones.body });
    const responder = (status, cuerpo) => ({ ok: status < 300, status, text: async () => JSON.stringify(cuerpo) });
    if (url.startsWith('https://api.stripe.com/')) return responder(200, { data: sesiones, has_more: false });
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
  const { db, ctx, llamadas, avisos } = montar({ sesiones: [sesionBuena({ amount_subtotal: 500 })] });
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

test('sin claves de Stripe la tienda no lee nada', async () => {
  const { db, ctx } = montar();
  db.reiniciarContador();
  assert.strictEqual(await tienda.procesarTienda({ ...ctx, env: {} }), 0);
  assert.strictEqual(db.lecturas, 0);
});

test('un pago sin pedido de la web avisa y no imprime nada', async () => {
  const { ctx, llamadas, avisos } = montar({ sesiones: [sesionBuena({ client_reference_id: null })] });
  await tienda.procesarTienda(ctx);
  assert.ok(avisos.some((a) => /pago sin pedido/.test(a)));
  assert.ok(!llamadas.some((l) => l.url.startsWith('https://api.printful.com/')));
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
