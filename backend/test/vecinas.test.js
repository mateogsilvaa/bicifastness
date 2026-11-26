'use strict';

/**
 * La 260 leida como 261 (26 nov 2026). Son vecinas (Fac. de Biologia y
 * Facultad Derecho, a 290 m) y el lector confunde ese 0 con un 1: el
 * verificador "corregia" la ruta a la 261, la aprobaba con la ruta MALA y la
 * mandaba a "Para repasar". Y con esa ruta guardaba el recorte del "260" como
 * muestra de un "261", que es como el lector lo acababa aprendiendo.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { vecinaConfusable, soloVecinas } = require('../src/verificacion');
const { extraerEstaciones } = require('../src/ocr');

const leer = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

test('la 260 y la 261 son vecinas que se confunden por una cifra', () => {
  assert.strictEqual(vecinaConfusable('260', '261'), true);
  assert.strictEqual(vecinaConfusable('261', '260'), true);
  // Una cifra distinta pero lejos: eso no lo arregla nadie a ciegas.
  assert.strictEqual(vecinaConfusable('260', '160'), false);
  assert.strictEqual(vecinaConfusable('260', '260'), false);
  assert.strictEqual(vecinaConfusable('260', '999'), false);
  // Al lado pero con cifras que el lector no confunde (2 y 3): no.
  assert.strictEqual(vecinaConfusable('152', '153'), false);
});

test('una ruta con una punta vecina se queda como la declaro el piloto', () => {
  assert.strictEqual(soloVecinas('260-151', '261-151'), true);
  assert.strictEqual(soloVecinas('075-260', '075-261'), true);
  assert.strictEqual(soloVecinas('260-151', '260-151'), false);
  // Al reves no es una cifra mal leida: eso lo sigue corrigiendo la captura.
  assert.strictEqual(soloVecinas('260-151', '151-260'), false);
  assert.strictEqual(soloVecinas('260-151', '261-153'), false);
});

test('el nombre de la estacion decide entre la 260 y la 261', () => {
  // El numero mal leido y el nombre entero.
  assert.deepStrictEqual(
    extraerEstaciones('261 - Ciudad Universitaria - Fac. de Biología (261)\n151 - Plaza de Cuatro Caminos (151)'),
    ['260', '151'],
  );
  // El nombre cortado por la app: decide el trozo del final.
  assert.deepStrictEqual(
    extraerEstaciones('261 - Ciudad Universitaria - Fac. de Bi...\n151 - Plaza de Cuatro Caminos'),
    ['260', '151'],
  );
  // Y la 261 de verdad se queda en la 261.
  assert.deepStrictEqual(
    extraerEstaciones('261 - Ciudad Universitaria - Facultad Derecho (261)\n151 - Plaza de Cuatro Caminos (151)'),
    ['261', '151'],
  );
});

test('el worker no corrige a la vecina ni entrena con la ruta corregida', () => {
  const worker = leer('backend/worker.js');
  assert.match(worker, /if \(dicha && soloVecinas\(viaje\.ruta, dicha\.ruta\)\)/,
    'la vecina mal leida vuelve a cambiar la ruta del piloto');
  assert.match(worker, /guardarMuestrasCifras\(doc\.id, primera, lectura, veredicto\.rutaCorregida\?\.antes \|\| viaje\.ruta\)/,
    'las muestras de cifras vuelven a etiquetarse con la ruta corregida');
});

test('corregir en "Para repasar" rehace los puntos sin anular ni avisar', () => {
  const worker = leer('backend/worker.js');
  const manual = worker.slice(worker.indexOf('async function aplicarDecisionesManuales'));
  assert.match(manual, /await revertirPremio\(doc, viaje, \{ avisar: false \}\);\s*await premiar\(doc, \{ \.\.\.viaje, premiado: false \}\);/);
  assert.match(manual, /enMs !== \(viaje\.correccionAplicada \|\| 0\)/, 'se rehace dos veces');

  const admin = leer('assets/js/paginas/admin.js');
  assert.ok(!/\/\/ Uno ya aprobado y premiado no se corrige aqui: se anula\.\s*if \(deIA\) return;/.test(admin),
    '"Para repasar" vuelve a no dejar corregir');
  assert.match(admin, /\}, \{ deIA: Boolean\(deIA\) \}\);/);
});
