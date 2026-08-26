'use strict';

/**
 * Revision de nombres de piloto y de clan (#64).
 *
 * Esto merece pruebas de verdad, y no una comprobacion sobre el texto del
 * fichero, porque aqui viven dos reglas que ANTES no las aplicaba nadie: el
 * filtro de palabras y el saneado de invisibles. Las dos estaban escritas,
 * probadas por separado y sin un solo llamante desde que se borro `clanes.js`.
 */

const test = require('node:test');
const assert = require('node:assert');

const nombres = require('../src/nombres');

// U+202E: da la vuelta al texto que viene detras. U+200B: espacio de ancho cero.
const BIDI = '‮';
const ANCHO_CERO = '​';

test('un nombre normal pasa', () => {
  const v = nombres.revisar('Ana Perez');

  assert.strictEqual(v.aceptable, true);
  assert.strictEqual(v.motivo, null);
  assert.strictEqual(v.limpio, 'Ana Perez');
});

test('los espacios de los bordes no cuentan como algo raro', () => {
  // `limpiarTexto` recorta, asi que si se comparara con el original a secas,
  // cualquier nombre escrito con un espacio delante saldria marcado.
  const v = nombres.revisar('  Ana  ');

  assert.strictEqual(v.aceptable, true);
  assert.strictEqual(v.limpio, 'Ana');
});

test('una marca bidi se detecta: es lo que da la vuelta al nombre al pintarlo', () => {
  const v = nombres.revisar(`Ana${BIDI}bis`);

  assert.strictEqual(v.aceptable, false);
  assert.strictEqual(v.invisibles, true);
  assert.match(v.motivo, /invisibles/);
});

test('un espacio de ancho cero tambien', () => {
  const v = nombres.revisar(`An${ANCHO_CERO}a`);

  assert.strictEqual(v.invisibles, true);
  assert.strictEqual(v.aceptable, false);
});

test('una palabra de la lista se detecta', () => {
  const v = nombres.revisar('puta');

  assert.strictEqual(v.aceptable, false);
  assert.strictEqual(v.prohibido, true);
});

test('esconder la palabra con un invisible NO la salva', () => {
  // Es el motivo de mirar el nombre LIMPIO y no el original. Con un espacio de
  // ancho cero en medio, el filtro por subcadena no encuentra nada — y a la
  // vista el nombre se lee igual de mal.
  const v = nombres.revisar(`pu${ANCHO_CERO}ta`);

  assert.strictEqual(v.prohibido, true, 'el invisible ha escondido la palabra del filtro');
  assert.strictEqual(v.aceptable, false);
});

test('los nombres corrientes que llevan una palabra dentro siguen pasando', () => {
  // La lista de excepciones de `badwords.js` costo afinarla. Si esta revision
  // la saltara, "Cassandra" no podria registrarse.
  for (const nombre of ['Cassandra', 'Titan', 'Sextante', 'Analisis']) {
    assert.strictEqual(nombres.revisar(nombre).aceptable, true, `${nombre} deberia pasar`);
  }
});

test('un nombre de clan se mide con el largo de los clanes', () => {
  // 28 y no 24. Si se midiera con el de piloto, un nombre de clan legitimo de
  // 26 caracteres saldria recortado y por tanto "distinto del original", o sea
  // marcado como sospechoso sin serlo.
  const largo = 'Los Rayos Azules del Norte';   // 26

  assert.strictEqual(largo.length, 26);
  assert.strictEqual(nombres.revisar(largo, { ambito: 'clan' }).aceptable, true);
});

test('lo que va a la cola de moderacion no lleva las marcas dentro', () => {
  // El texto lo lee una persona en el panel. Mandar el nombre TAL CUAL meteria
  // la marca bidi ahi, que es justo donde no se quiere: le daria la vuelta al
  // texto que esta leyendo quien revisa.
  const sucio = `Ana${BIDI}bis`;
  const texto = nombres.explicar(sucio, nombres.revisar(sucio));

  assert.ok(!texto.includes(BIDI), 'la marca bidi ha llegado al panel');
  assert.match(texto, /Anabis/);
  assert.match(texto, /invisibles/);
});

test('revivir esto es el motivo del issue: las dos piezas se usan de verdad', () => {
  // `badwords` y `util.limpiarTexto` llevaban sin llamante desde que se borro
  // `src/clanes.js`. Si alguien vuelve a dejarlas sueltas, esta prueba cae.
  const fuente = require('node:fs')
    .readFileSync(require.resolve('../src/nombres'), 'utf8');

  assert.match(fuente, /require\('\.\/badwords'\)/);
  assert.match(fuente, /require\('\.\/util'\)/);
});
