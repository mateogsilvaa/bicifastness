'use strict';

/**
 * Vigilancia de la cuota (#38).
 *
 * El plan Spark da 50.000 lecturas y 20.000 escrituras al dia, y al agotarlas
 * la web deja de funcionar hasta medianoche sin previo aviso.
 *
 * Lo delicado aqui es el CONTADOR: envuelve Firestore, asi que un fallo suyo se
 * lleva por delante la verificacion de viajes. Se prueba que cuenta bien, que
 * sigue contando despues de encadenar `where` y `orderBy` — donde es facil
 * perder el envoltorio — y que no rompe nada de lo que envuelve.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const { FirestoreFalso, FieldValue } = require('./ayuda/firestore-falso');

let bd = new FirestoreFalso();

const rutaAdmin = require.resolve('firebase-admin');
require.cache[rutaAdmin] = new Module(rutaAdmin, null);
require.cache[rutaAdmin].exports = {
  firestore: Object.assign(() => bd, { FieldValue }),
  initializeApp: () => {},
  credential: { cert: () => ({}), applicationDefault: () => ({}) },
};

const cuota = require('../src/cuota');

function conDatos() {
  bd = new FirestoreFalso();
  bd.sembrar('usuarios', Array.from({ length: 25 }, (_, i) =>
    ({ id: `u${i}`, puntos: i, clanId: i % 3 === 0 ? 'clan-1' : null })));
  return bd;
}

// --- El contador ------------------------------------------------------------------

test('cuenta una lectura por documento devuelto', async () => {
  const { db, coste } = cuota.contar(conDatos());

  await db.collection('usuarios').get();
  assert.strictEqual(coste.lecturas, 25);

  await db.doc('usuarios/u1').get();
  assert.strictEqual(coste.lecturas, 26, 'un documento suelto cuenta uno');
});

test('sigue contando despues de encadenar where, orderBy y limit', async () => {
  const { db, coste } = cuota.contar(conDatos());

  // Aqui es donde se pierde la cuenta si el envoltorio no se propaga: cada
  // `where` devuelve una consulta NUEVA, y si sale sin envolver el `get` final
  // no pasa por el contador.
  await db.collection('usuarios').where('puntos', '>', 20).orderBy('puntos', 'desc').limit(3).get();

  assert.strictEqual(coste.lecturas, 3, 'la cadena de consulta se ha quedado sin contar');
});

test('una consulta vacia cuenta una lectura, que es lo que cobra Firestore', async () => {
  const { db, coste } = cuota.contar(conDatos());
  await db.collection('usuarios').where('puntos', '==', 9999).get();
  assert.strictEqual(coste.lecturas, 1);
});

test('cuenta las escrituras sueltas', async () => {
  const { db, coste } = cuota.contar(conDatos());

  await db.doc('usuarios/u1').update({ puntos: 99 });
  await db.doc('usuarios/nuevo').set({ puntos: 1 });
  await db.doc('usuarios/u2').delete();

  assert.strictEqual(coste.escrituras, 3);
  assert.strictEqual(coste.lecturas, 0, 'escribir no debe contar como leer');
});

test('un lote cuenta sus operaciones al confirmarse, no al apuntarlas', async () => {
  const { db, coste } = cuota.contar(conDatos());

  const lote = db.batch();
  lote.update(db.doc('usuarios/u1'), { puntos: 1 });
  lote.update(db.doc('usuarios/u2'), { puntos: 2 });
  lote.delete(db.doc('usuarios/u3'));

  assert.strictEqual(coste.escrituras, 0, 'un lote sin confirmar no ha escrito nada');

  await lote.commit();
  assert.strictEqual(coste.escrituras, 3);
});

test('un lote descartado no cuenta', async () => {
  const { db, coste } = cuota.contar(conDatos());

  const lote = db.batch();
  lote.update(db.doc('usuarios/u1'), { puntos: 1 });
  // Nadie llama a commit: no ha llegado a Firestore, no cuesta.

  assert.strictEqual(coste.escrituras, 0);
});

test('el envoltorio no cambia lo que devuelven las operaciones', async () => {
  const { db } = cuota.contar(conDatos());

  const snap = await db.collection('usuarios').where('puntos', '==', 5).get();
  assert.strictEqual(snap.size, 1);
  assert.strictEqual(snap.docs[0].id, 'u5');
  assert.strictEqual(snap.docs[0].data().puntos, 5);

  const doc = await db.doc('usuarios/u7').get();
  assert.strictEqual(doc.exists, true);
  assert.strictEqual(doc.data().puntos, 7);

  await db.doc('usuarios/u7').update({ puntos: 70 });
  assert.strictEqual(bd.leer('usuarios/u7').puntos, 70, 'la escritura no ha llegado');
});

test('las subcolecciones tambien cuentan', async () => {
  const base = conDatos();
  base.sembrar('usuarios/u1/temporadas', [{ id: '2026-07' }, { id: '2026-08' }]);
  const { db, coste } = cuota.contar(base);

  await db.doc('usuarios/u1').collection('temporadas').get();
  assert.strictEqual(coste.lecturas, 2);
});

// --- La proyeccion -----------------------------------------------------------------

test('a media mañana proyecta el dia entero', () => {
  // 06:00 UTC es una cuarta parte del dia: lo consumido se multiplica por 4.
  const proyeccion = cuota.estimar({ lecturas: 5000, escrituras: 1000 },
    new Date('2026-08-23T06:00:00Z'));

  assert.strictEqual(proyeccion.lecturas, 20000);
  assert.strictEqual(proyeccion.escrituras, 4000);
});

test('no proyecta nada en la primera media hora', () => {
  // Dividir por casi cero da cifras absurdas, y un aviso falso a las 00:10
  // ensena a ignorar los avisos.
  assert.strictEqual(cuota.estimar({ lecturas: 100 }, new Date('2026-08-23T00:05:00Z')), null);
  assert.ok(cuota.estimar({ lecturas: 100 }, new Date('2026-08-23T00:31:00Z')));
});

// --- Los umbrales -------------------------------------------------------------------

test('el nivel sale de lo que mas apriete de las dos cuotas', () => {
  // Las escrituras se pueden agotar antes que las lecturas: el limite es menos
  // de la mitad. Mirar solo las lecturas dejaria pasar ese caso.
  assert.strictEqual(cuota.nivel({ lecturas: 1000, escrituras: 19000 }).nivel, 'degradado');
  assert.strictEqual(cuota.nivel({ lecturas: 46000, escrituras: 100 }).nivel, 'alerta');
  assert.strictEqual(cuota.nivel({ lecturas: 36000, escrituras: 100 }).nivel, 'atencion');
  assert.strictEqual(cuota.nivel({ lecturas: 1000, escrituras: 100 }).nivel, 'normal');
});

test('solo se avisa al subir de umbral, no en cada pasada', () => {
  const consumido = { lecturas: 36000, escrituras: 0 };

  // Con el worker cada cinco minutos, avisar mientras se este por encima del
  // 70% son 288 correos en un dia malo. A partir del tercero nadie los lee.
  assert.strictEqual(cuota.avisoPendiente(consumido, null).nivel, 'atencion');
  assert.strictEqual(cuota.avisoPendiente(consumido, 'atencion'), null);

  // Pero si sigue subiendo, si.
  assert.strictEqual(cuota.avisoPendiente({ lecturas: 46000 }, 'atencion').nivel, 'alerta');
  assert.strictEqual(cuota.avisoPendiente({ lecturas: 48000 }, 'alerta').nivel, 'degradado');
  assert.strictEqual(cuota.avisoPendiente({ lecturas: 100 }, 'alerta'), null);
});

// --- El registro ---------------------------------------------------------------------

test('lo consumido se suma al contador del dia, no lo pisa', async () => {
  bd = new FirestoreFalso();

  await cuota.registrar({ lecturas: 100, escrituras: 10 }, new Date('2026-08-23T08:00:00Z'));
  await cuota.registrar({ lecturas: 50, escrituras: 5 }, new Date('2026-08-23T08:05:00Z'));

  const dia = bd.leer('cuota/2026-08-23');
  assert.strictEqual(dia.lecturas, 150);
  assert.strictEqual(dia.escrituras, 15);
  assert.strictEqual(dia.pasadas, 2);
});

test('cada dia lleva su cuenta', async () => {
  bd = new FirestoreFalso();
  await cuota.registrar({ lecturas: 100, escrituras: 0 }, new Date('2026-08-22T23:00:00Z'));
  await cuota.registrar({ lecturas: 7, escrituras: 0 }, new Date('2026-08-23T01:00:00Z'));

  assert.strictEqual(bd.leer('cuota/2026-08-22').lecturas, 100);
  assert.strictEqual(bd.leer('cuota/2026-08-23').lecturas, 7);
});
