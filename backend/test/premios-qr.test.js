'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { FirestoreFalso, FieldValue } = require('./ayuda/firestore-falso');
const q = require('../src/premios-qr');

test('sorteo: banner a los 30 primeros, lema con un 2% hasta 30', () => {
  assert.deepStrictEqual(q.sortear({ banners: 0, lemas: 0, azar: 0.5 }), { banner: true, lema: false });
  assert.deepStrictEqual(q.sortear({ banners: 0, lemas: 0, azar: 0.01 }), { banner: true, lema: true });
  assert.deepStrictEqual(q.sortear({ banners: 30, lemas: 30, azar: 0.01 }), { banner: false, lema: false });
  assert.deepStrictEqual(q.sortear({ banners: 0, lemas: 0, azar: 0.01, tiene: ['estaciones', 'desde-el-origen'] }), { banner: false, lema: false });
});

test('cada peticion se resuelve una vez y cuenta en el cupo', async () => {
  const db = new FirestoreFalso();
  db.sembrar('usuarios', [{ id: 'u1', recompensas: [] }, { id: 'u2', recompensas: ['estaciones'] }]);
  db.sembrar('premios_qr', [{ id: 'u1', estado: 'pendiente' }, { id: 'u2', estado: 'pendiente' }]);
  const avisos = [];
  await q.procesarPremiosQr({ db, admin: { firestore: { FieldValue } }, azar: () => 0.01, avisar: async (uid) => avisos.push(uid) });
  assert.deepStrictEqual(db.leer('usuarios/u1').recompensas.sort(), ['desde-el-origen', 'estaciones']);
  assert.deepStrictEqual(db.leer('usuarios/u2').recompensas.sort(), ['desde-el-origen', 'estaciones']);
  assert.strictEqual(db.leer('premios_qr/u1').estado, 'resuelto');
  assert.strictEqual(db.leer('config/premios_qr').banners, 1);
  assert.strictEqual(db.leer('config/premios_qr').lemas, 2);
  assert.deepStrictEqual(avisos.sort(), ['u1', 'u2']);
  await q.procesarPremiosQr({ db, admin: { firestore: { FieldValue } }, azar: () => 0.01 });
  assert.strictEqual(db.leer('config/premios_qr').lemas, 2);
});
