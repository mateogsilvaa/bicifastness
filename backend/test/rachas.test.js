const { test } = require('node:test');
const assert = require('node:assert');
const rachas = require('../src/rachas');

test('un perfil sin escudos guardados no devuelve campos undefined', () => {
  const sinCampos = { racha: undefined, mejorRacha: undefined, escudos: undefined, diasHastaEscudo: undefined, ultimoDiaActivo: undefined };
  for (const r of [rachas.registrarDiaActivo(sinCampos, new Date('2026-09-28T12:00:00Z')),
    rachas.cerrarDiasPerdidos(sinCampos, new Date('2026-09-28T12:00:00Z'))]) {
    for (const [k, v] of Object.entries(r)) assert.notStrictEqual(v, undefined, k);
  }
  // Atrasado: el mismo caso que tumbaba el viaje (perfil con ultimo dia, sin escudos).
  const r = rachas.registrarDiaActivo({ racha: 3, mejorRacha: 3, escudos: undefined, diasHastaEscudo: undefined, ultimoDiaActivo: 20370 }, new Date('2026-09-28T12:00:00Z'));
  for (const [k, v] of Object.entries(r)) assert.notStrictEqual(v, undefined, k);
});
