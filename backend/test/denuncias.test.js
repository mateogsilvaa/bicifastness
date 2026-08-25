'use strict';

/**
 * Que hacer con una denuncia (#61).
 *
 * Esto merece pruebas de verdad y no una comprobacion sobre el texto del
 * fichero, porque aqui vive una regla de seguridad que ANTES estaba en las
 * reglas de Firestore: "no te denuncies a ti mismo". Las reglas son
 * declarativas y no se estropean solas; esto es codigo normal y si.
 *
 * Bajo aqui porque mandar el uid del denunciado obligaba a publicar los uid de
 * todo el que sale en una clasificacion, que es justo lo que no se hace desde la
 * fuga de correos (#60).
 */

const test = require('node:test');
const assert = require('node:assert');

const denuncias = require('../src/denuncias');

const DENUNCIA = { viajeId: 'v1', reportanteUid: 'ana' };
const VIAJE = { uid: 'bea', ruta: '002-110' };

test('una denuncia normal se encola, y dice a quien señala', () => {
  const veredicto = denuncias.decidir(DENUNCIA, VIAJE, []);

  assert.strictEqual(veredicto.encolar, true);
  assert.strictEqual(veredicto.reportadoUid, 'bea');
  assert.strictEqual(veredicto.ruta, '002-110');
});

test('no puedes denunciar tu propio viaje', () => {
  // La comprobacion que hacian las reglas y que se perdio al sacar el uid del
  // documento. Servia para no poder inflar el contador de nadie, empezando por
  // el propio.
  const veredicto = denuncias.decidir(DENUNCIA, { uid: 'ana', ruta: '002-110' }, []);

  assert.strictEqual(veredicto.encolar, false);
  assert.match(veredicto.motivo, /tu propio viaje/);
});

test('una segunda denuncia de la misma persona al mismo viaje no se encola', () => {
  // Sin esto, una persona sola llena la cola de la administracion con el mismo
  // caso repetido.
  const veredicto = denuncias.decidir(DENUNCIA, VIAJE, [{ estado: 'pendiente' }]);

  assert.strictEqual(veredicto.encolar, false);
  assert.match(veredicto.motivo, /ya habias denunciado/);
});

test('pero una descartada antes no bloquea el segundo intento', () => {
  // Si la primera se tiro porque el viaje aun no existia, la segunda merece que
  // se mire. Descartar no puede ser una condena.
  const veredicto = denuncias.decidir(DENUNCIA, VIAJE, [{ estado: 'descartado' }]);

  assert.strictEqual(veredicto.encolar, true);
});

test('que dos personas distintas denuncien lo mismo NO es un problema', () => {
  // Es justo la señal que le interesa a quien revisa. El limite es por persona y
  // viaje, no por viaje: `previas` solo trae las de quien denuncia ahora.
  const deOtra = denuncias.decidir({ viajeId: 'v1', reportanteUid: 'carla' }, VIAJE, []);

  assert.strictEqual(deOtra.encolar, true);
  assert.strictEqual(deOtra.reportadoUid, 'bea');
});

test('un viaje que ya no existe se descarta sin llegar a la cola', () => {
  const veredicto = denuncias.decidir(DENUNCIA, null, []);

  assert.strictEqual(veredicto.encolar, false);
  assert.match(veredicto.motivo, /ya no existe/);
});

test('un viaje anonimizado no tiene a quien señalar', () => {
  // Su dueño borro la cuenta: el viaje se queda en el ranking sin uid (ver
  // `src/borrado.js`). No hay a quien denunciar, y encolarlo mandaria a la
  // administracion un caso sin nadie al otro lado.
  const veredicto = denuncias.decidir(DENUNCIA, { uid: null, ruta: '002-110' }, []);

  assert.strictEqual(veredicto.encolar, false);
  assert.match(veredicto.motivo, /sin dueño|no tiene dueño/);
});

test('nunca se encola sin decir a quien señala', () => {
  // Es lo que arregla el problema de raiz: si esto se colara vacio, la cola
  // tendria casos que no apuntan a nadie y el panel no podria suspender.
  for (const viaje of [VIAJE, { uid: 'bea' }]) {
    const veredicto = denuncias.decidir(DENUNCIA, viaje, []);
    if (veredicto.encolar) {
      assert.ok(veredicto.reportadoUid, 'encolada sin reportadoUid');
    }
  }
});
