'use strict';

/**
 * La tienda: el diseño que se imprime y el camino del pago a la imprenta.
 * Nada sale a la red: Polar, Cloudinary y Printful son un `fetch` de mentira.
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

// Hace una hora: la tienda solo mira los pedidos de los ultimos dias, y con
// una fecha fija la prueba caducaba sola (pasaba el 29 y fallaba el 30).
const ordenBuena = (extra = {}) => ({
  id: 'ord_1', created_at: new Date(Date.now() - 3600e3).toISOString(), status: 'paid', paid: true,
  currency: 'eur', subtotal_amount: 2490, total_amount: 2490, product_id: 'prod_cam',
  metadata: { pedido: 'uid1_20000_0' },
  customer: { email: 'pepa@ejemplo.com', external_id: 'uid1' },
  ...extra,
});

const ENVIO = { nombre: 'Pepa Pérez', direccion: 'Calle Mayor 1', ciudad: 'Madrid', cp: '28013', pais: 'es' };

test('se manda a imprimir solo si lo cobrado cuadra con el precio', () => {
  assert.strictEqual(tienda.comprobarCobro(ordenBuena(), 24.9), null);
  assert.match(tienda.comprobarCobro(ordenBuena({ subtotal_amount: 100 }), 24.9), /centimos/);
  assert.match(tienda.comprobarCobro(ordenBuena({ paid: false, status: 'refunded' }), 24.9), /refunded/);
  assert.match(tienda.comprobarCobro(ordenBuena({ currency: 'usd' }), 24.9), /moneda/);
  assert.ok(tienda.comprobarCobro(ordenBuena(), undefined));
});

test('la direccion sale de nuestro formulario, y si esta incompleta no hay envio', () => {
  assert.deepStrictEqual(tienda.destinatario(ENVIO, 'pepa@ejemplo.com'), {
    name: 'Pepa Pérez', address1: 'Calle Mayor 1', city: 'Madrid', country_code: 'ES', zip: '28013', email: 'pepa@ejemplo.com',
  });
  assert.strictEqual(tienda.destinatario({ ...ENVIO, direccion2: '3ºB' }).address2, '3ºB');
  assert.strictEqual(tienda.destinatario({ ...ENVIO, cp: '' }), null);
  assert.strictEqual(tienda.destinatario({ ...ENVIO, pais: 'España' }), null);
  assert.strictEqual(tienda.destinatario(null), null);
});

test('el pedido de Polar se casa por su id, o por cliente y producto', () => {
  assert.strictEqual(tienda.pedidoDeOrden(ordenBuena()), 'uid1_20000_0');
  assert.strictEqual(tienda.pedidoDeOrden(ordenBuena({ metadata: { pedido: '../malo' } })), null);
  const config = { productos: { camiseta: { polarProducto: 'prod_cam' } }, gemas: { packs: { p100: { polarProducto: 'prod_g' } } } };
  assert.strictEqual(tienda.productoDeOrden(config, ordenBuena()).clave, 'camiseta');
  assert.strictEqual(tienda.productoDeOrden(config, ordenBuena({ product_id: 'prod_g' })).tipo, 'gemas');
  assert.strictEqual(tienda.productoDeOrden(config, ordenBuena({ product_id: 'otro' })), null);
});

test('la firma de Cloudinary es la que documentan', () => {
  // Ejemplo de la documentacion de Cloudinary (firma de subida).
  const firma = tienda.firmaCloudinary({ eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop', public_id: 'sample_image', timestamp: 1315060510 }, 'abcd');
  assert.strictEqual(firma, 'bfd09f95f331f558cbd1320e67aa8d488770583e');
});

// --- El flujo entero ---------------------------------------------------------------

const ENV = {
  POLAR_ACCESS_TOKEN: 'polar_oat', PRINTFUL_TOKEN: 'pf', CLOUDINARY_CLOUD: 'nube', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's',
};

function montar({ ordenes = [ordenBuena()], printfulYaExiste = false, cloudinaryFalla = false, pedido = {} } = {}) {
  const db = new FirestoreFalso();
  db.sembrar('config', [{
    id: 'tienda', visible: true,
    productos: { camiseta: { activo: true, precio: 24.9, enlacePago: 'https://buy.polar.sh/polar_cl_x', polarProducto: 'prod_cam', variantes: { M: 4012 } } },
    gemas: { packs: { p100: { activo: true, gemas: 100, precio: 2, enlacePago: 'https://buy.polar.sh/polar_cl_g', polarProducto: 'prod_g' } }, precios: { neon: 80 } },
  }]);
  db.sembrar('pedidos_tienda', [{ id: 'uid1_20000_0', uid: 'uid1', producto: 'camiseta', variante: 'M', viajeId: 'v1', estado: 'borrador', envio: ENVIO, ...pedido }]);
  db.sembrar('usuarios', [{ id: 'uid1', username: 'pepa', clanId: null, gemas: 0, recompensas: [] }]);
  db.sembrar('tiempos_viaje', [{ id: 'v1', uid: 'uid1', verificado: true, ruta: '002-110', tiempoSegundos: 749 }]);
  db.sembrar('agregados', [{ id: 'ranking-general', filas: [{ nombre: 'pepa', pos: 7 }], total: 50 }]);

  const llamadas = [];
  const fetchFn = async (url, opciones = {}) => {
    llamadas.push({ url, metodo: opciones.method || 'GET', cuerpo: opciones.body });
    const responder = (status, cuerpo) => ({ ok: status < 300, status, text: async () => JSON.stringify(cuerpo) });
    if (url.startsWith('https://api.polar.sh/v1/orders/')) return responder(200, { items: ordenes, pagination: { max_page: 1 } });
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
  assert.strictEqual(pedido.polarPedido, 'ord_1');

  const alta = llamadas.find((l) => l.metodo === 'POST' && l.url.startsWith('https://api.printful.com/orders'));
  const cuerpo = JSON.parse(alta.cuerpo);
  assert.strictEqual(cuerpo.external_id, 'uid1_20000_0');
  assert.strictEqual(cuerpo.items[0].variant_id, 4012);
  assert.strictEqual(cuerpo.recipient.zip, '28013');
  assert.strictEqual(cuerpo.recipient.country_code, 'ES');

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

test('sin el id del pedido, se casa por cliente y producto', async () => {
  const { db, ctx } = montar({ ordenes: [ordenBuena({ metadata: {} })] });
  assert.strictEqual(await tienda.procesarTienda(ctx), 1);
  assert.strictEqual(db.leer('pedidos_tienda/uid1_20000_0').polarPedido, 'ord_1');
});

test('sin imprenta configurada, el pedido queda para enviar a mano con la direccion', async () => {
  const { db, ctx, llamadas, avisos } = montar();
  await tienda.procesarTienda({ ...ctx, env: { POLAR_ACCESS_TOKEN: 'x' } });
  assert.strictEqual(db.leer('pedidos_tienda/uid1_20000_0').estado, 'preparar');
  assert.ok(!llamadas.some((l) => l.url.includes('printful') || l.url.includes('cloudinary')));
  assert.ok(avisos.some((a) => /a mano/.test(a) && /Calle Mayor 1/.test(a) && /28013 Madrid/.test(a)));
});

test('un pack de gemas suma las gemas una sola vez', async () => {
  const { db, ctx } = montar({
    ordenes: [ordenBuena({ id: 'ord_g', product_id: 'prod_g', subtotal_amount: 200, metadata: { pedido: 'uid1_20000_1' } })],
  });
  db.sembrar('pedidos_tienda', [{ id: 'uid1_20000_1', uid: 'uid1', producto: 'gemas', variante: 'p100', estado: 'borrador' }]);
  assert.strictEqual(await tienda.procesarTienda(ctx), 1);
  assert.strictEqual(db.leer('usuarios/uid1').gemas, 100);
  assert.strictEqual(db.leer('pedidos_tienda/uid1_20000_1').estado, 'entregado');
  await tienda.procesarTienda(ctx);
  assert.strictEqual(db.leer('usuarios/uid1').gemas, 100);
});

test('un pedido aun sin cobrar se vuelve a mirar despues', async () => {
  const { db, ctx } = montar({ ordenes: [ordenBuena({ status: 'pending', paid: false })] });
  assert.strictEqual(await tienda.procesarTienda(ctx), 0);
  assert.strictEqual(db.leer('pedidos_tienda/uid1_20000_0').estado, 'borrador');
  assert.deepStrictEqual(db.leer('tienda_interno/polar').vistas, []);
});

test('si el pedido ya estaba en Printful no se duplica', async () => {
  const { db, ctx, llamadas } = montar({ printfulYaExiste: true });
  await tienda.procesarTienda(ctx);
  assert.ok(!llamadas.some((l) => l.metodo === 'POST' && l.url.startsWith('https://api.printful.com/')));
  assert.strictEqual(db.leer('pedidos_tienda/uid1_20000_0').printfulId, 77);
});

test('un pago que no cuadra va a revisar y no se imprime', async () => {
  const { db, ctx, llamadas, avisos } = montar({ ordenes: [ordenBuena({ subtotal_amount: 500 })] });
  await tienda.procesarTienda(ctx);
  assert.strictEqual(db.leer('pedidos_tienda/uid1_20000_0').estado, 'revisar');
  assert.ok(!llamadas.some((l) => l.url.startsWith('https://api.printful.com/')));
  assert.ok(avisos.some((a) => /revisar/.test(a)));
});

test('sin direccion completa va a revisar', async () => {
  const { db, ctx } = montar({ pedido: { envio: { nombre: 'Pepa' } } });
  await tienda.procesarTienda(ctx);
  assert.strictEqual(db.leer('pedidos_tienda/uid1_20000_0').estado, 'revisar');
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

test('sin el token de Polar la tienda no lee nada', async () => {
  const { db, ctx } = montar();
  db.reiniciarContador();
  assert.strictEqual(await tienda.procesarTienda({ ...ctx, env: {} }), 0);
  assert.strictEqual(db.lecturas, 0);
});

test('un pago sin pedido de la web avisa y no imprime nada', async () => {
  const { ctx, llamadas, avisos } = montar({ ordenes: [ordenBuena({ metadata: {}, customer: { external_id: 'nadie' } })] });
  await tienda.procesarTienda(ctx);
  assert.ok(avisos.some((a) => /pago sin pedido/.test(a)));
  assert.ok(!llamadas.some((l) => l.url.startsWith('https://api.printful.com/')));
});

// --- Gastar gemas ------------------------------------------------------------------

test('las gemas se gastan solo en lo que esta a la venta, y si llegan', async () => {
  const { db, ctx } = montar();
  db.sembrar('usuarios', [{ id: 'uid1', username: 'pepa', gemas: 100, recompensas: [] }, { id: 'uid2', username: 'luis', gemas: 10, recompensas: [] }, { id: 'uid3', username: 'ana', gemas: 500, recompensas: [] }]);
  db.sembrar('canjes_gemas', [
    { id: 'uid1', recompensa: 'neon', estado: 'pendiente' },
    { id: 'uid2', recompensa: 'neon', estado: 'pendiente' },
    { id: 'uid3', recompensa: 'noche', estado: 'pendiente' },
  ]);
  const r = await tienda.procesarCanjesGemas(ctx);
  assert.strictEqual(r.ok, 1);
  assert.strictEqual(db.leer('usuarios/uid1').gemas, 20);
  assert.deepStrictEqual(db.leer('usuarios/uid1').recompensas, ['neon']);
  assert.strictEqual(db.leer('canjes_gemas/uid2').estado, 'sin-gemas');
  assert.strictEqual(db.leer('usuarios/uid2').gemas, 10);
  assert.strictEqual(db.leer('canjes_gemas/uid3').estado, 'no-esta');
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
