'use strict';

/**
 * Agregados: lo que el navegador lee sin sesion.
 *
 * Lo que se prueba aqui no es que Firestore funcione, sino la regla que impide
 * que esto se convierta en la tercera fuga de datos personales: un agregado
 * SOLO puede llevar lo que ya se ve en pantalla.
 *
 * Los dos primeros escapes (#59 y #60) fueron exactamente esto: un documento de
 * lectura publica que llevaba dentro mas de lo que la pantalla necesitaba.
 */

const test = require('node:test');
const assert = require('node:assert');

const agregados = require('../src/agregados');

test('un agregado solo lleva los campos publicables', () => {
  const usuario = {
    pos: 1,
    nombre: 'Ana',
    avatar: 'https://ejemplo/a.svg',
    clan: 'los-rapidos',
    puntos: 120,
    // Todo esto NO puede salir de la coleccion cerrada.
    email: 'ana@ejemplo.es',
    uid: 'abc123',
    tokenBaja: 'secreto',
    consentimiento: { version: '1.0.0' },
    racha: 7,
  };

  const limpio = agregados.limpiar(usuario);

  assert.deepStrictEqual(Object.keys(limpio).sort(),
    ['avatar', 'clan', 'nombre', 'pos', 'puntos']);

  for (const prohibido of ['email', 'uid', 'tokenBaja', 'consentimiento', 'racha']) {
    assert.ok(!(prohibido in limpio), `"${prohibido}" ha llegado a un documento publico`);
  }
});

test('la lista blanca no incluye nada identificable', () => {
  // Guarda contra anadir un campo "solo para esta pantalla" sin pensarlo. Si
  // hace falta uno nuevo, se anade a proposito y se piensa si es publicable.
  const sospechosos = ['email', 'correo', 'uid', 'token', 'telefono', 'ip', 'consentimiento'];

  for (const campo of agregados.CAMPOS_PUBLICABLES) {
    for (const sospechoso of sospechosos) {
      assert.ok(!campo.toLowerCase().includes(sospechoso),
        `"${campo}" esta en la lista blanca y parece identificable`);
    }
  }
});

test('limpiar descarta los campos vacios, no los pone a null', () => {
  // Un `clan: null` en cada fila de un ranking de 200 son 200 claves inutiles
  // contra el tope de 1 MiB del documento.
  const limpio = agregados.limpiar({ pos: 1, nombre: 'Ana', clan: null, avatar: undefined });

  assert.deepStrictEqual(Object.keys(limpio).sort(), ['nombre', 'pos']);
});

test('las paginas caben en un documento de Firestore', () => {
  // Tope duro de 1 MiB por documento. Con filas de ~120 bytes, 200 van muy
  // holgadas; el numero importa cuando alguien lo suba "para ahorrar lecturas".
  assert.ok(agregados.POR_PAGINA <= 500,
    'con mas de 500 filas por pagina el documento se acerca al limite de 1 MiB');

  const filaGorda = agregados.limpiar({
    pos: 999, nombre: 'x'.repeat(40), avatar: 'https://'.padEnd(200, 'a'),
    clan: 'y'.repeat(40), puntos: 99999, marca: 9999, viajes: 999,
  });
  const bytes = JSON.stringify(filaGorda).length * agregados.POR_PAGINA;

  assert.ok(bytes < 1048576, `una pagina llena ocuparia ${bytes} bytes`);
});

// --- El limitador de reconstrucciones ------------------------------------------

test('los agregados no se rehacen en cada pasada con movimiento', () => {
  // Es el segundo de los dos frenos: el modo parcial abarata UNA reconstruccion
  // y este recorta cuantas se hacen. Aun en parcial, cada una lee `usuarios` y
  // `estaciones_stats` enteras y escribe nueve documentos largos, y con 240
  // subidas al dia se llegaria aqui unas 163 veces (docs/COSTE.md).
  assert.ok(agregados.MINUTOS_ENTRE_RECONSTRUCCIONES >= 10,
    'un intervalo corto devuelve el problema: usuarios y estaciones enteras cada vez');

  const ahora = Date.parse('2026-08-23T12:00:00Z');
  const hace = (min) => new Date(ahora - min * 60000).toISOString();

  assert.strictEqual(agregados.hayQueReconstruir(hace(2), ahora), false, 'recien hecho');
  assert.strictEqual(
    agregados.hayQueReconstruir(hace(agregados.MINUTOS_ENTRE_RECONSTRUCCIONES), ahora), true,
    'justo en el limite');
});

test('ante la duda se reconstruye, en vez de dejar la clasificacion congelada', () => {
  const ahora = Date.now();
  assert.strictEqual(agregados.hayQueReconstruir(null, ahora), true, 'no existe todavia');
  assert.strictEqual(agregados.hayQueReconstruir(undefined, ahora), true);
  assert.strictEqual(agregados.hayQueReconstruir('lo que sea', ahora), true, 'marca ilegible');
});

test('acepta la marca tal y como la escribe Firestore', () => {
  // `serverTimestamp()` vuelve como Timestamp, no como cadena. Contemplar solo
  // el string haria que el limitador dijera siempre que si y no limitara nada.
  const ahora = Date.parse('2026-08-23T12:00:00Z');
  const timestamp = (min) => ({ toMillis: () => ahora - min * 60000 });

  assert.strictEqual(agregados.hayQueReconstruir(timestamp(3), ahora), false);
  assert.strictEqual(agregados.hayQueReconstruir(timestamp(60), ahora), true);
});
