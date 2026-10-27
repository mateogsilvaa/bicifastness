'use strict';

/**
 * Canjes de enlaces de evento: el navegador pide, el worker decide.
 * Lo que se vigila: que un codigo solo lo gane UNA persona, que no se
 * gaste si ya tenia el premio, y que ninguna peticion rara escriba nada.
 */

const test = require('node:test');
const assert = require('node:assert');

const { FirestoreFalso, FieldValue } = require('./ayuda/firestore-falso');
const canjes = require('../src/canjes');

const admin = { firestore: { FieldValue } };
const CODIGO = 'abcdefghjkmnpqrstuvw'; // 20 caracteres, como los que reparte /admin/
const OTRO = 'xyzxyzxyzxyzxyzxyzxy';

function base() {
  const db = new FirestoreFalso();
  db.sembrar('usuarios', [
    { id: 'u1', username: 'pepa', recompensas: [] },
    { id: 'u2', username: 'ana', recompensas: [] },
    { id: 'u3', username: 'luis', recompensas: ['metro'], suspendido: false },
    { id: 'u4', username: 'malo', recompensas: [], suspendido: true },
  ]);
  db.sembrar('recompensas_codigos', [
    { id: CODIGO, recompensa: 'metro' },
    { id: OTRO, recompensa: 'neon' },
  ]);
  return db;
}

const pedir = (db, uid, codigo) => db.sembrar('canjes_recompensa', [{ id: uid, codigo, estado: 'pendiente' }]);
const leer = (db, ruta) => db.doc(ruta).get().then((s) => s.data());

test('un codigo valido da la recompensa y se queda gastado', async () => {
  const db = base();
  pedir(db, 'u1', CODIGO);
  const avisos = [];
  const r = await canjes.procesarCanjes({ db, admin, avisar: async (uid, id) => avisos.push([uid, id]) });

  assert.strictEqual(r.ok, 1);
  assert.deepStrictEqual((await leer(db, 'usuarios/u1')).recompensas, ['metro']);
  const codigo = await leer(db, `recompensas_codigos/${CODIGO}`);
  assert.strictEqual(codigo.usadoPor, 'u1');
  assert.strictEqual(codigo.usadoPorNombre, 'pepa');
  // Y queda publicado por su huella, para que quien llegue tarde lo sepa ya.
  assert.deepStrictEqual(await leer(db, `codigos_gastados/${canjes.huellaCodigo(CODIGO)}`), { gastado: true });
  const canje = await leer(db, 'canjes_recompensa/u1');
  assert.strictEqual(canje.estado, 'ok');
  assert.strictEqual(canje.recompensa, 'metro');
  assert.deepStrictEqual(avisos, [['u1', 'metro']]);
});

test('el mismo enlace no lo gana una segunda persona', async () => {
  const db = base();
  pedir(db, 'u1', CODIGO);
  pedir(db, 'u2', CODIGO);
  await canjes.procesarCanjes({ db, admin });

  assert.strictEqual((await leer(db, 'canjes_recompensa/u1')).estado, 'ok');
  assert.strictEqual((await leer(db, 'canjes_recompensa/u2')).estado, 'usado');
  assert.deepStrictEqual((await leer(db, 'usuarios/u2')).recompensas, []);
});

test('si ya la tenia, el enlace NO se gasta y vale para otra persona', async () => {
  const db = base();
  pedir(db, 'u3', CODIGO);
  await canjes.procesarCanjes({ db, admin });
  assert.strictEqual((await leer(db, 'canjes_recompensa/u3')).estado, 'ya-lo-tenias');
  assert.strictEqual((await leer(db, `recompensas_codigos/${CODIGO}`)).usadoPor, undefined);

  pedir(db, 'u1', CODIGO);
  await canjes.procesarCanjes({ db, admin });
  assert.strictEqual((await leer(db, 'canjes_recompensa/u1')).estado, 'ok');
});

test('un codigo que no existe, o con forma rara, es invalido y no escribe nada', async () => {
  for (const codigo of ['noexistenoexistenoexiste', 'corto', '../usuarios/u1', 'a'.repeat(200), 12345, null]) {
    const db = base();
    pedir(db, 'u1', codigo);
    await canjes.procesarCanjes({ db, admin });
    assert.strictEqual((await leer(db, 'canjes_recompensa/u1')).estado, 'invalido', String(codigo));
    assert.deepStrictEqual((await leer(db, 'usuarios/u1')).recompensas, []);
  }
});

test('una cuenta suspendida no canjea, y el codigo se queda libre', async () => {
  const db = base();
  pedir(db, 'u4', CODIGO);
  await canjes.procesarCanjes({ db, admin });
  assert.strictEqual((await leer(db, 'canjes_recompensa/u4')).estado, 'invalido');
  assert.strictEqual((await leer(db, `recompensas_codigos/${CODIGO}`)).usadoPor, undefined);
});

test('un codigo con una recompensa de nombre raro no se concede', async () => {
  const db = base();
  db.sembrar('recompensas_codigos', [{ id: 'q'.repeat(20), recompensa: '../../admin' }]);
  pedir(db, 'u1', 'q'.repeat(20));
  await canjes.procesarCanjes({ db, admin });
  assert.strictEqual((await leer(db, 'canjes_recompensa/u1')).estado, 'invalido');
  assert.deepStrictEqual((await leer(db, 'usuarios/u1')).recompensas, []);
});

test('lo ya resuelto no se vuelve a mirar, y sin pendientes solo cuesta una consulta', async () => {
  const db = base();
  db.sembrar('canjes_recompensa', [{ id: 'u1', codigo: CODIGO, estado: 'ok', recompensa: 'metro' }]);
  const antes = db.escrituras;
  const r = await canjes.procesarCanjes({ db, admin });
  assert.deepStrictEqual(r, { ok: 0, usado: 0, invalido: 0, 'ya-lo-tenias': 0 });
  assert.strictEqual(db.escrituras, antes);
});

test('en simulacion no se canjea nada', async () => {
  const db = base();
  pedir(db, 'u1', CODIGO);
  await canjes.procesarCanjes({ db, admin, simular: true });
  assert.strictEqual((await leer(db, 'canjes_recompensa/u1')).estado, 'pendiente');
  assert.deepStrictEqual((await leer(db, 'usuarios/u1')).recompensas, []);
});

test('si el aviso push falla, el canje sigue valiendo', async () => {
  const db = base();
  pedir(db, 'u1', CODIGO);
  await canjes.procesarCanjes({ db, admin, avisar: async () => { throw new Error('sin red'); } });
  assert.strictEqual((await leer(db, 'canjes_recompensa/u1')).estado, 'ok');
});
