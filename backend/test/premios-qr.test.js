'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { FirestoreFalso, FieldValue } = require('./ayuda/firestore-falso');
const q = require('../src/premios-qr');

test('sorteo: un 3% banner, otro 3% lema, nunca los dos, con cupo', () => {
  assert.deepStrictEqual(q.sortear({ banners: 0, lemas: 0, azar: 0.01 }), { banner: true, lema: false });
  assert.deepStrictEqual(q.sortear({ banners: 0, lemas: 0, azar: 0.04 }), { banner: false, lema: true });
  assert.deepStrictEqual(q.sortear({ banners: 0, lemas: 0, azar: 0.5 }), { banner: false, lema: false });
  assert.deepStrictEqual(q.sortear({ banners: 30, lemas: 30, azar: 0.01 }), { banner: false, lema: false });
  assert.deepStrictEqual(q.sortear({ banners: 0, lemas: 0, azar: 0.01, tiene: ['estaciones'] }), { banner: false, lema: false });
  // Con tiradas repartidas, alrededor de un 6% se lleva algo y nadie las dos cosas.
  let alguno = 0;
  for (let i = 0; i < 10000; i++) {
    const r = q.sortear({ banners: 0, lemas: 0, azar: i / 10000 });
    assert.ok(!(r.banner && r.lema));
    if (r.banner || r.lema) alguno++;
  }
  assert.strictEqual(alguno, 600);
});

test('cada peticion se resuelve una vez y cuenta en el cupo', async () => {
  const db = new FirestoreFalso();
  db.sembrar('usuarios', [{ id: 'u1', recompensas: [] }, { id: 'u2', recompensas: [] }, { id: 'u3', recompensas: [] }]);
  db.sembrar('premios_qr', [{ id: 'u1', estado: 'pendiente' }, { id: 'u2', estado: 'pendiente' }, { id: 'u3', estado: 'pendiente' }]);
  const tiradas = [0.01, 0.04, 0.9];
  const avisos = [];
  await q.procesarPremiosQr({ db, admin: { firestore: { FieldValue } }, azar: () => tiradas.shift(), avisar: async (uid) => avisos.push(uid) });
  const quien = ['u1', 'u2', 'u3'].map((u) => db.leer(`usuarios/${u}`).recompensas);
  assert.deepStrictEqual(quien.flat().sort(), ['desde-el-origen', 'estaciones']);
  assert.strictEqual(db.leer('config/premios_qr').banners + db.leer('config/premios_qr').lemas, 2);
  assert.strictEqual(avisos.length, 2);
  assert.ok(['u1', 'u2', 'u3'].every((u) => db.leer(`premios_qr/${u}`).estado === 'resuelto'));
});
