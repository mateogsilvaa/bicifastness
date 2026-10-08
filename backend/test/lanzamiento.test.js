const test = require('node:test');
const assert = require('node:assert');
const { esPrimeraTanda, contadoresACero } = require('../src/lanzamiento');

test('un viaje de antes del 1 de noviembre es de la primera tanda solo pasado el lanzamiento', () => {
  assert.strictEqual(esPrimeraTanda({ fechaViaje: '2026-10-28' }, '2026-10-30'), false);
  assert.strictEqual(esPrimeraTanda({ fechaViaje: '2026-10-28' }, '2026-11-01'), true);
  assert.strictEqual(esPrimeraTanda({ fechaViaje: '2026-11-01' }, '2026-11-02'), false);
});

test('el lanzamiento deja a cada piloto sin clan, sin puntos y sin insignias', () => {
  const cero = contadoresACero();
  for (const campo of ['biciRating', 'viajesVerificados', 'puntosTemporada', 'puntosLiga', 'racha', 'escudos', 'metrosTotales']) {
    assert.strictEqual(cero[campo], 0, campo);
  }
  assert.deepStrictEqual(cero.logros, []);
  assert.deepStrictEqual(cero.puntosPorRuta, {});
  assert.strictEqual(cero.clanId, null);
});
