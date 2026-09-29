'use strict';

/**
 * Borrado de cuenta (RGPD art. 17).
 *
 * Esto no existia: la politica de privacidad prometia el derecho de supresion,
 * el perfil dejaba pedirlo, las reglas admitian la solicitud... y
 * `solicitudes_borrado` no la procesaba nadie. Prometer un derecho y no
 * ejecutarlo es peor que no ofrecerlo.
 *
 * Lo que se prueba aqui es lo que se rompe en silencio: que no quede nada
 * detras. Un borrado que se deja algo no da error — simplemente deja datos de
 * alguien que pidio que se fueran.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const { FirestoreFalso, FieldValue } = require('./ayuda/firestore-falso');

let bd = new FirestoreFalso();
const borradosDeAuth = [];

const adminFalso = {
  firestore: Object.assign(() => bd, { FieldValue }),
  initializeApp: () => {},
  credential: { cert: () => ({}), applicationDefault: () => ({}) },
  auth: () => ({
    deleteUser: async (uid) => {
      if (uid === 'inexistente') {
        const error = new Error('no existe');
        error.code = 'auth/user-not-found';
        throw error;
      }
      borradosDeAuth.push(uid);
    },
  }),
};

const rutaAdmin = require.resolve('firebase-admin');
require.cache[rutaAdmin] = new Module(rutaAdmin, null);
require.cache[rutaAdmin].exports = adminFalso;
require.cache[rutaAdmin].loaded = true;

const borrado = require('../src/borrado');

function sembrar() {
  bd = new FirestoreFalso();
  borradosDeAuth.length = 0;

  bd.sembrar('usuarios', [
    { id: 'uid-1', username: 'Ana', usernameLower: 'ana', clanId: 'clan-1', biciRating: 400 },
    { id: 'uid-2', username: 'Bea', usernameLower: 'bea', clanId: null },
  ]);
  bd.sembrar('usuarios/uid-1/temporadas', [
    { id: '2026-06', temporada: '2026-06', puntos: 300 },
    { id: '2026-07', temporada: '2026-07', puntos: 500 },
  ]);
  bd.sembrar('clanes', [{ id: 'clan-1', miembros: ['uid-1', 'uid-2'], numMiembros: 2 }]);
  bd.sembrar('nombres_usuario', [{ id: 'ana', uid: 'uid-1' }]);
  bd.sembrar('tiempos_viaje', [
    { id: 'v1', uid: 'uid-1', username: 'Ana', ruta: '100-101', verificado: true, capturaId: 'c1', alegacion: 'mi texto' },
    { id: 'v2', uid: 'uid-1', username: 'Ana', ruta: '100-102', verificado: true },
    { id: 'v3', uid: 'uid-2', username: 'Bea', ruta: '100-101', verificado: true },
  ]);
  bd.sembrar('capturas', [
    { id: 'v1', uid: 'uid-1', datos: 'data:image/jpeg;base64,AAA' },
    { id: 'v2', uid: 'uid-1', datos: 'data:image/jpeg;base64,BBB' },
    { id: 'v3', uid: 'uid-2', datos: 'data:image/jpeg;base64,CCC' },
  ]);
  bd.sembrar('huellas_captura', [{ id: 'sha1', uid: 'uid-1', dhash: 'abc', tripId: 'v1' }]);
  bd.sembrar('solicitudes_borrado', [{ id: 'uid-1', uid: 'uid-1', confirmacion: 'BORRAR MI CUENTA' }]);
  return bd;
}

// --- Que no quede nada ---------------------------------------------------------

test('no queda ni rastro del perfil, ni de sus subcolecciones', async () => {
  sembrar();
  await borrado.ejecutar('uid-1');

  assert.strictEqual(bd.leer('usuarios/uid-1'), undefined);

  // Firestore NO borra las subcolecciones al borrar el documento padre. Sin
  // borrarlas a mano, las temporadas archivadas quedan huerfanas: invisibles en
  // la consola y sin borrar. Siguen siendo datos de esa persona.
  assert.strictEqual(bd.contar('usuarios/uid-1/temporadas'), 0,
    'las temporadas archivadas se han quedado huerfanas');

  assert.strictEqual(bd.leer('nombres_usuario/ana'), undefined, 'el nombre sigue reservado');
  assert.strictEqual(bd.leer('solicitudes_borrado/uid-1'), undefined, 'la solicitud sigue en la cola');
  assert.deepStrictEqual(borradosDeAuth, ['uid-1'], 'la cuenta de Auth sigue existiendo');
});

test('sale del clan, y el contador cuadra', async () => {
  sembrar();
  await borrado.ejecutar('uid-1');

  const clan = bd.leer('clanes/clan-1');
  assert.deepStrictEqual(clan.miembros, ['uid-2']);
  assert.strictEqual(clan.numMiembros, 1);
});

test('las capturas se borran: son fotos suyas', async () => {
  sembrar();
  await borrado.ejecutar('uid-1');

  assert.strictEqual(bd.leer('capturas/v1'), undefined);
  assert.strictEqual(bd.leer('capturas/v2'), undefined);
  // Y las de los demas no se tocan.
  assert.ok(bd.leer('capturas/v3'), 'se ha borrado la captura de otra persona');
});

// --- Lo que se queda, y por que ----------------------------------------------------

test('los tiempos se anonimizan de verdad, no se borran', async () => {
  sembrar();
  await borrado.ejecutar('uid-1');

  for (const id of ['v1', 'v2']) {
    const viaje = bd.leer(`tiempos_viaje/${id}`);
    assert.ok(viaje, 'el tiempo se ha borrado: el ranking historico deja de cuadrar');

    // "Anonimizado" solo vale si no queda por donde atarlo a alguien.
    assert.strictEqual(viaje.uid, null, `${id} conserva el uid`);
    assert.strictEqual(viaje.anonimizado, true);
    assert.ok(!/Ana/.test(JSON.stringify(viaje)), `${id} conserva el nombre`);
    assert.strictEqual(viaje.capturaId, undefined, `${id} apunta todavia a su captura`);
    assert.strictEqual(viaje.alegacion, undefined, `${id} conserva un texto escrito por esa persona`);

    // Y lo que da sentido a conservarlos.
    assert.ok(viaje.ruta && viaje.verificado);
  }

  // El de otra persona, intacto.
  assert.strictEqual(bd.leer('tiempos_viaje/v3').uid, 'uid-2');
});

test('la huella de captura se queda sin uid, pero se queda', async () => {
  sembrar();
  await borrado.ejecutar('uid-1');

  const huella = bd.leer('huellas_captura/sha1');
  assert.ok(huella, 'sin la huella, una imagen ya usada vuelve a colarse');
  assert.strictEqual(huella.uid, null, 'la huella sigue apuntando a la persona');
  assert.strictEqual(huella.dhash, 'abc', 'se ha perdido lo unico que hace util la huella');
});

// --- Cuando algo sale mal ------------------------------------------------------------

test('volver a lanzarlo termina el trabajo en vez de fallar', async () => {
  sembrar();
  await borrado.ejecutar('uid-1');

  // El worker reintenta lo que fallo. Si la segunda pasada reventara porque
  // algo ya no esta, la solicitud se quedaria atascada para siempre.
  await assert.doesNotReject(() => borrado.ejecutar('uid-1'));
});

test('una cuenta que ya no esta en Auth no bloquea el borrado de sus datos', async () => {
  sembrar();
  bd.sembrar('usuarios', [{ id: 'inexistente', username: 'Fantasma' }]);
  bd.sembrar('tiempos_viaje', [{ id: 'v9', uid: 'inexistente', ruta: '100-101', verificado: true }]);

  // Pasa si alguien borro la cuenta a mano desde la consola de Firebase y
  // quedaron sus datos. `auth/user-not-found` no puede parar el resto.
  await assert.doesNotReject(() => borrado.ejecutar('inexistente'));
  assert.strictEqual(bd.leer('usuarios/inexistente'), undefined);
  assert.strictEqual(bd.leer('tiempos_viaje/v9').uid, null);
});

test('simular no toca absolutamente nada', async () => {
  sembrar();
  const resumen = await borrado.ejecutar('uid-1', { simular: true });

  assert.strictEqual(resumen.viajes, 2, 'la simulacion tiene que contar lo que haria');
  assert.ok(bd.leer('usuarios/uid-1'), 'la simulacion ha borrado el perfil');
  assert.strictEqual(bd.leer('tiempos_viaje/v1').uid, 'uid-1');
  assert.deepStrictEqual(borradosDeAuth, [], 'la simulacion ha borrado la cuenta de Auth');
});

test('borrar una cuenta sin nada no revienta', async () => {
  bd = new FirestoreFalso();
  borradosDeAuth.length = 0;
  await assert.doesNotReject(() => borrado.ejecutar('uid-fantasma'));
});

test('si algo del borrado falla, la solicitud NO se da por hecha', async () => {
  // POR QUE ESTO IMPORTA MAS QUE OTRAS COSAS. Borrar una cuenta es una
  // obligacion del RGPD, y quien la pide se queda sin forma de reclamar: al
  // final se borra tambien su cuenta de Auth, asi que no puede volver a entrar
  // ni a pedirlo otra vez.
  //
  // `ejecutar` se tragaba los fallos con `.catch(() => {})` en cada borrado y
  // devolvia un resumen de exito. El worker, que hace lo correcto —registrar el
  // error y DEJAR la solicitud para reintentarla, porque `ejecutar` es
  // idempotente— nunca se enteraba: la solicitud se borraba y los datos se
  // quedaban dentro para siempre.
  //
  // Y esos catch no hacian falta: en Firestore, borrar un documento que no
  // existe NO falla. Solo podian tragarse un error de verdad.
  sembrar();

  const original = bd.doc.bind(bd);
  bd.doc = (ruta) => {
    const ref = original(ruta);
    if (ruta === 'usuarios/uid-1') ref.delete = async () => { throw new Error('permission-denied'); };
    return ref;
  };

  await assert.rejects(borrado.ejecutar('uid-1'), /permission-denied/,
    'el borrado ha dicho que si con el perfil todavia dentro');

  // Y lo que importa de verdad: la solicitud sigue ahi, asi que el worker lo
  // reintenta en la siguiente pasada.
  assert.ok(bd.leer('solicitudes_borrado/uid-1'),
    'la solicitud se ha dado por hecha con el borrado a medias');
});
