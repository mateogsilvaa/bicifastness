'use strict';

/**
 * Gestion de clanes (#29).
 *
 * De donde se viene: `usuarios.clanId` NO estaba en ninguna lista de campos
 * escribibles, asi que crear un clan, aceptar a alguien o expulsarlo fallaban
 * contra las reglas. La gestion de clanes no funcionaba desde el navegador y
 * nada lo delataba, porque un `permission-denied` en una pantalla que casi
 * nadie usa no lo ve nadie.
 *
 * Y al abrirlo aparecio lo de debajo: la puntuacion del clan se sumaba
 * consultando `usuarios` por su campo `clanId`, que escribe cada uno en su
 * propio documento. Bastaba con ponerselo a mano para inflarle los puntos a un
 * clan ajeno con cuentas nuevas.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
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

const clanes = require('../src/clan-mantenimiento');
const puntuacion = require('../src/puntuacion');
const rachas = require('../src/rachas');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const AHORA = new Date('2026-08-23T12:00:00Z');
const haceDias = (n) => new Date(AHORA.getTime() - n * 86400000);

/**
 * `ultimoDiaActivo` tal y como lo guarda produccion: la medianoche del dia en
 * Madrid, en milisegundos, que es lo que devuelve `rachas.diaDe`.
 *
 * Antes estas pruebas le pasaban un 'YYYY-MM-DD', y por eso no vieron que
 * `elegirSucesor` comparaba texto contra texto: con fechas de texto la
 * comparacion funciona, con los milisegundos de verdad no, y ningun clan sin
 * lider se rescataba nunca. Una prueba que inventa el tipo del dato prueba otro
 * programa.
 */
const activoHace = (n) => rachas.diaDe(haceDias(n));

function sembrar() {
  bd = new FirestoreFalso();
  bd.sembrar('clanes', [{
    id: 'rayos',
    lider: 'u1',
    oficiales: ['u2'],
    miembros: ['u1', 'u2', 'u3'],
    solicitudes: [],
    numMiembros: 3,
  }]);
  bd.sembrar('usuarios', [
    { id: 'u1', clanId: 'rayos', biciRating: 100, ultimoDiaActivo: activoHace(1) },
    { id: 'u2', clanId: 'rayos', biciRating: 50, ultimoDiaActivo: activoHace(2) },
    { id: 'u3', clanId: 'rayos', biciRating: 25, ultimoDiaActivo: activoHace(3) },
    { id: 'u4', clanId: null, biciRating: 999 },
  ]);
  return bd;
}

// --- La puntuacion no se fia de un campo que escribe el usuario -------------------

test('el clan puntua desde su plantilla, no desde lo que diga cada usuario', async () => {
  sembrar();

  // Un intruso se declara miembro escribiendo su propio documento. Es lo unico
  // que hace falta para que la version anterior le sumara 999 puntos al clan.
  bd.sembrar('usuarios', [{ id: 'u4', clanId: 'rayos', biciRating: 999 }]);

  await puntuacion.recalcularClan('rayos');

  const clan = bd.leer('clanes/rayos');
  assert.strictEqual(clan.biciRating, 175, 'la puntuacion ha contado a quien el clan no lista');
  assert.strictEqual(clan.numMiembros, 3);
});

test('un clan vacio puntua cero, no falla', async () => {
  sembrar();
  bd.sembrar('clanes', [{ id: 'rayos', lider: 'u1', miembros: [], numMiembros: 0 }]);

  await puntuacion.recalcularClan('rayos');
  assert.strictEqual(bd.leer('clanes/rayos').biciRating, 0);
});

test('un miembro cuya cuenta ya no existe no rompe la suma', async () => {
  sembrar();
  bd.sembrar('clanes', [{
    id: 'rayos', lider: 'u1', miembros: ['u1', 'fantasma'], numMiembros: 2,
  }]);

  await puntuacion.recalcularClan('rayos');
  assert.strictEqual(bd.leer('clanes/rayos').biciRating, 100);
});

// --- El clanId que se queda colgando ----------------------------------------------

test('a quien expulsan se le limpia el clan', async () => {
  sembrar();

  // Al expulsar solo se toca el clan: nadie puede escribir en el documento de
  // otro, y a la persona expulsada no se le va a pedir que colabore.
  bd.sembrar('clanes', [{
    id: 'rayos', lider: 'u1', oficiales: ['u2'], miembros: ['u1', 'u2'], numMiembros: 2,
  }]);

  const limpiados = await clanes.limpiarHuerfanos();

  assert.strictEqual(limpiados, 1);
  assert.strictEqual(bd.leer('usuarios/u3').clanId, null);
  // Y a los que siguen dentro no se les toca.
  assert.strictEqual(bd.leer('usuarios/u1').clanId, 'rayos');
});

test('si el clan se disuelve, nadie se queda diciendo que pertenece a el', async () => {
  sembrar();
  bd.vaciar('clanes');

  const limpiados = await clanes.limpiarHuerfanos();

  assert.strictEqual(limpiados, 3);
  for (const uid of ['u1', 'u2', 'u3']) {
    assert.strictEqual(bd.leer(`usuarios/${uid}`).clanId, null);
  }
});

test('sin huerfanos no se escribe nada', async () => {
  sembrar();
  bd.reiniciarContador();

  assert.strictEqual(await clanes.limpiarHuerfanos(), 0);
  assert.strictEqual(bd.coste.escrituras, 0);
});

test('mirar los huerfanos cuesta una lectura por clan, no por usuario', async () => {
  sembrar();
  bd.vaciar('clanes');
  bd.reiniciarContador();

  await clanes.limpiarHuerfanos({ simular: true });

  // Tres usuarios del mismo clan: la consulta de usuarios mas UN get del clan.
  // Un get por usuario crece con el proyecto y esto corre en cada pasada.
  assert.ok(bd.coste.lecturas <= 5, `${bd.coste.lecturas} lecturas para tres usuarios de un clan`);
});

// --- Invitaciones -------------------------------------------------------------------

test('una invitacion caducada no vale', () => {
  const caducada = { caduca: haceDias(1), usos: 0, maxUsos: 1 };
  assert.deepStrictEqual(clanes.invitacionValida(caducada, AHORA),
    { vale: false, motivo: 'caducada' });
});

test('una invitacion de un solo uso vale una vez', () => {
  const sinUsar = { caduca: haceDias(-7), usos: 0, maxUsos: 1 };
  assert.strictEqual(clanes.invitacionValida(sinUsar, AHORA).vale, true);

  const usada = { caduca: haceDias(-7), usos: 1, maxUsos: 1 };
  assert.deepStrictEqual(clanes.invitacionValida(usada, AHORA),
    { vale: false, motivo: 'agotada' });
});

test('el contador de usos lo lleva el worker, no el navegador', () => {
  // Si lo llevara el cliente, un codigo de un solo uso valdria para todo el que
  // lo tenga: basta con no escribir el incremento.
  const reglas = leer('firestore.rules');
  const bloque = reglas.slice(reglas.indexOf('match /invitaciones/'));
  const hasta = bloque.slice(0, bloque.indexOf('\n    }'));

  assert.match(hasta, /allow update: if false/,
    'el navegador puede tocar el contador de usos de una invitacion');
});

test('usar una invitacion mete en el clan y descuenta un uso', async () => {
  sembrar();
  bd.sembrar('invitaciones', [{
    id: 'abc123', clanId: 'rayos', creadaPor: 'u1', caduca: haceDias(-7), usos: 0, maxUsos: 1,
  }]);

  const resultado = await clanes.aplicarInvitacion('abc123', 'u4', { ahora: AHORA });

  assert.strictEqual(resultado.entrado, true);
  assert.ok(bd.leer('clanes/rayos').miembros.includes('u4'));
  assert.strictEqual(bd.leer('usuarios/u4').clanId, 'rayos');
  assert.strictEqual(bd.leer('invitaciones/abc123').usos, 1);
});

test('reintentar una invitacion no gasta otro uso', async () => {
  sembrar();
  bd.sembrar('invitaciones', [{
    id: 'abc123', clanId: 'rayos', creadaPor: 'u1', caduca: haceDias(-7), usos: 0, maxUsos: 2,
  }]);

  await clanes.aplicarInvitacion('abc123', 'u4', { ahora: AHORA });
  // El worker reintenta lo que fallo. Gastar un uso por cada reintento vaciaria
  // un codigo sin que nadie llegara a entrar.
  const segunda = await clanes.aplicarInvitacion('abc123', 'u4', { ahora: AHORA });

  assert.strictEqual(segunda.entrado, false);
  assert.strictEqual(segunda.motivo, 'ya estaba dentro');
  assert.strictEqual(bd.leer('invitaciones/abc123').usos, 1);
});

test('una invitacion no mete a nadie en un clan lleno', async () => {
  sembrar();
  bd.sembrar('clanes', [{
    id: 'rayos', lider: 'u1',
    miembros: Array.from({ length: clanes.MAX_MIEMBROS }, (_, i) => `m${i}`),
    numMiembros: clanes.MAX_MIEMBROS,
  }]);
  bd.sembrar('invitaciones', [{
    id: 'abc123', clanId: 'rayos', caduca: haceDias(-7), usos: 0, maxUsos: 5,
  }]);

  const resultado = await clanes.aplicarInvitacion('abc123', 'u4', { ahora: AHORA });

  assert.strictEqual(resultado.entrado, false);
  assert.strictEqual(resultado.motivo, 'el clan esta lleno');
  assert.strictEqual(bd.leer('invitaciones/abc123').usos, 0, 'ha gastado un uso sin meter a nadie');
});

// --- El lider que desaparece -----------------------------------------------------------

test('un clan cuyo lider desaparece pasa al oficial mas activo', () => {
  const clan = { lider: 'u1', oficiales: ['u2', 'u3'] };
  const miembros = [
    { uid: 'u1', ultimoDiaActivo: activoHace(200) },
    { uid: 'u2', ultimoDiaActivo: activoHace(30) },
    { uid: 'u3', ultimoDiaActivo: activoHace(2) },
  ];

  assert.strictEqual(clanes.elegirSucesor(clan, miembros, AHORA), 'u3');
});

test('sin oficiales activos, al miembro mas activo', () => {
  const clan = { lider: 'u1', oficiales: ['u2'] };
  const miembros = [
    { uid: 'u1', ultimoDiaActivo: activoHace(200) },
    { uid: 'u2', ultimoDiaActivo: activoHace(180) },
    { uid: 'u3', ultimoDiaActivo: activoHace(5) },
  ];

  assert.strictEqual(clanes.elegirSucesor(clan, miembros, AHORA), 'u3');
});

test('a un lider que sigue apareciendo no se le quita el mando', () => {
  const clan = { lider: 'u1', oficiales: ['u2'] };
  const miembros = [
    { uid: 'u1', ultimoDiaActivo: activoHace(3) },
    { uid: 'u2', ultimoDiaActivo: activoHace(1) },
  ];

  assert.strictEqual(clanes.elegirSucesor(clan, miembros, AHORA), null);
});

test('un clan que ya no juega nadie se queda como esta', () => {
  // Dar el mando al azar no arregla un clan abandonado, solo mueve el problema.
  const clan = { lider: 'u1', oficiales: ['u2'] };
  const miembros = [
    { uid: 'u1', ultimoDiaActivo: activoHace(300) },
    { uid: 'u2', ultimoDiaActivo: activoHace(250) },
    { uid: 'u3' },
  ];

  assert.strictEqual(clanes.elegirSucesor(clan, miembros, AHORA), null);
});
