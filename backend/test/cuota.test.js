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

// El dia de la cuota es el del PACIFICO, no el UTC: las cuotas diarias de
// Firestore se reinician alrededor de medianoche de esa zona. En agosto el
// Pacifico va a UTC-7, asi que las horas de aqui llevan las dos escritas.

test('a media mañana proyecta el dia entero', () => {
  // 06:00 del Pacifico (13:00 UTC) es una cuarta parte del dia: por 4.
  const proyeccion = cuota.estimar({ lecturas: 5000, escrituras: 1000 },
    new Date('2026-08-23T13:00:00Z'));

  assert.strictEqual(proyeccion.lecturas, 20000);
  assert.strictEqual(proyeccion.escrituras, 4000);
});

test('la proyeccion va por el dia de la cuota, no por el UTC', () => {
  // Este es el caso que estaba mal. A las 02:00 UTC lleva DOS horas de dia UTC,
  // pero en el Pacifico son las 19:00 del dia anterior: casi ochenta por ciento
  // del dia de cuota gastado.
  //
  // Con la cuenta vieja, 5.000 lecturas a esa hora se proyectaban a 60.000 y
  // disparaban un aviso que no tocaba; y peor al reves, porque el contador
  // acababa de ponerse a cero mientras el consumo real seguia subiendo.
  const proyeccion = cuota.estimar({ lecturas: 5000 }, new Date('2026-08-25T02:00:00Z'));

  assert.ok(proyeccion.lecturas < 7000,
    `proyecta ${proyeccion.lecturas}: esta contando las horas del dia equivocado`);
});

test('no proyecta nada en la primera media hora', () => {
  // Dividir por casi cero da cifras absurdas, y un aviso falso a las 00:10
  // ensena a ignorar los avisos. 00:05 y 00:31 del Pacifico.
  assert.strictEqual(cuota.estimar({ lecturas: 100 }, new Date('2026-08-23T07:05:00Z')), null);
  assert.ok(cuota.estimar({ lecturas: 100 }, new Date('2026-08-23T07:31:00Z')));
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

test('cada dia lleva su cuenta, y el dia es el de la cuota', async () => {
  bd = new FirestoreFalso();
  // 23:00 del 22 y 01:00 del 23, en el Pacifico.
  await cuota.registrar({ lecturas: 100, escrituras: 0 }, new Date('2026-08-23T06:00:00Z'));
  await cuota.registrar({ lecturas: 7, escrituras: 0 }, new Date('2026-08-23T08:00:00Z'));

  assert.strictEqual(bd.leer('cuota/2026-08-22').lecturas, 100);
  assert.strictEqual(bd.leer('cuota/2026-08-23').lecturas, 7);
});

test('el contador no se pone a cero a medianoche UTC', async () => {
  // Es el fallo que esto arregla. Las 00:30 UTC son las 17:30 del Pacifico del
  // dia ANTERIOR: al consumo real le quedan seis horas y media. Contando por
  // dias UTC, las dos pasadas caian en documentos distintos y la segunda
  // arrancaba de cero.
  bd = new FirestoreFalso();
  await cuota.registrar({ lecturas: 40000, escrituras: 0 }, new Date('2026-08-24T23:30:00Z'));
  await cuota.registrar({ lecturas: 500, escrituras: 0 }, new Date('2026-08-25T00:30:00Z'));

  const mismoDia = bd.leer('cuota/2026-08-24');
  assert.strictEqual(mismoDia.lecturas, 40500,
    'las dos pasadas tienen que sumar en el mismo dia de cuota');
  assert.strictEqual(bd.leer('cuota/2026-08-25'), undefined,
    'ha abierto un dia nuevo a medianoche UTC, que no es cuando se reinicia la cuota');
});

// --- Transacciones ------------------------------------------------------------
//
// Era el unico agujero del contador: `runTransaction` caia en el `default` del
// envoltorio y pasaba de largo, asi que todo lo que ocurria dentro quedaba
// fuera de la cuenta. En el worker eso es una lectura y una escritura por cada
// viaje aprobado — o sea justo lo que crece con el uso.

test('una transaccion cuenta lo que lee y lo que escribe', async () => {
  const { db, coste } = cuota.contar(conDatos());

  await db.runTransaction(async (tx) => {
    const doc = await tx.get(db.doc('usuarios/u1'));
    tx.update(db.doc('usuarios/u1'), { puntos: (doc.data().puntos || 0) + 1 });
  });

  assert.strictEqual(coste.lecturas, 1);
  assert.strictEqual(coste.escrituras, 1);
});

test('la transaccion escribe de verdad: contar no puede cambiar lo que hace', async () => {
  // El contador envuelve Firestore, asi que un fallo suyo se lleva por delante
  // la verificacion de viajes. Importa tanto que cuente como que no estorbe.
  const bdReal = conDatos();
  const { db } = cuota.contar(bdReal);

  await db.runTransaction(async (tx) => {
    tx.update(db.doc('usuarios/u1'), { puntos: 999 });
  });

  assert.strictEqual(bdReal.leer('usuarios/u1').puntos, 999);
});

test('lo que devuelve la transaccion llega a quien la lanzo', async () => {
  const { db } = cuota.contar(conDatos());

  const salida = await db.runTransaction(async (tx) => {
    const doc = await tx.get(db.doc('usuarios/u3'));
    return doc.data().puntos;
  });

  assert.strictEqual(salida, 3);
});

test('un reintento cobra sus lecturas pero no repite las escrituras', async () => {
  // Firestore reintenta una transaccion cuando hay contienda, y en cada
  // reintento ejecuta la funcion ENTERA otra vez. Las lecturas de cada intento
  // ocurrieron y se cobran; las escrituras solo se confirman una vez, la del
  // intento que sale bien. Contarlas al apuntarlas dava un gasto inflado en
  // justo el momento en que mas apretaba la cuota.
  const bdReal = conDatos();
  bdReal.reintentosPendientes = 2;   // sale bien al tercer intento

  const { db, coste } = cuota.contar(bdReal);

  await db.runTransaction(async (tx) => {
    await tx.get(db.doc('usuarios/u1'));
    tx.update(db.doc('usuarios/u1'), { puntos: 1 });
  });

  assert.strictEqual(coste.lecturas, 3, 'tres intentos son tres lecturas de verdad');
  assert.strictEqual(coste.escrituras, 1, 'solo se confirmo una escritura');
});

test('una transaccion que revienta no apunta escrituras que no ocurrieron', async () => {
  const { db, coste } = cuota.contar(conDatos());

  await assert.rejects(db.runTransaction(async (tx) => {
    tx.update(db.doc('usuarios/u1'), { puntos: 1 });
    throw new Error('contienda');
  }));

  assert.strictEqual(coste.escrituras, 0);
});

test('getAll dentro de una transaccion cuenta un documento por referencia', async () => {
  const { db, coste } = cuota.contar(conDatos());

  await db.runTransaction(async (tx) => {
    await tx.getAll(db.doc('usuarios/u1'), db.doc('usuarios/u2'), db.doc('usuarios/u3'));
  });

  assert.strictEqual(coste.lecturas, 3);
});
