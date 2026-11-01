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

test('un miembro repetido en la plantilla cuenta una sola vez', async () => {
  sembrar();
  // Lo que escribia un lider desde la consola antes de que las reglas lo
  // impidieran: el mismo uid cincuenta veces para multiplicar la nota.
  bd.sembrar('clanes', [{
    id: 'rayos', lider: 'u1', miembros: Array(50).fill('u1').concat(['u2']), numMiembros: 51,
  }]);

  await puntuacion.recalcularClan('rayos');
  const clan = bd.leer('clanes/rayos');
  assert.strictEqual(clan.biciRating, 150);
  assert.strictEqual(clan.numMiembros, 2);
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

// --- Doble membresia -------------------------------------------------------------

test('quien se cambia de clan deja de contar en el que dejo', async () => {
  // Como se llega aqui: estas en `rayos`, pides entrar en `truenos`, su lider te
  // acepta y confirmas. Tu perfil dice `truenos`, `truenos` te lista... y
  // `rayos` tambien. Las reglas no pueden impedirlo: aceptar lo hace el lider,
  // que solo escribe en SU documento, y el `clanId` lo escribes tu, que solo
  // escribes en el tuyo. Nadie puede tocar el clan que dejas atras.
  sembrar();
  bd.sembrar('clanes', [{
    id: 'truenos', lider: 'u4', oficiales: [], miembros: ['u4', 'u3'],
    solicitudes: [], numMiembros: 2,
  }]);
  // u3 se ha pasado a truenos, pero rayos sigue listandolo.
  await bd.doc('usuarios/u3').update({ clanId: 'truenos' });

  const sacados = await clanes.limpiarDoblesMembresias();
  assert.strictEqual(sacados, 1);

  const rayos = (await bd.doc('clanes/rayos').get()).data();
  assert.ok(!rayos.miembros.includes('u3'), 'rayos sigue sumando a alguien que ya no juega con ellos');
  assert.strictEqual(rayos.numMiembros, 2);

  const truenos = (await bd.doc('clanes/truenos').get()).data();
  assert.ok(truenos.miembros.includes('u3'), 'lo ha sacado del clan que SI es el suyo');
});

test('la limpieza tambien le quita el cargo', async () => {
  // Un oficial que se va y se queda en `oficiales` es alguien con permisos en un
  // clan al que ya no pertenece.
  sembrar();
  bd.sembrar('clanes', [{
    id: 'truenos', lider: 'u4', oficiales: [], miembros: ['u4', 'u2'],
    solicitudes: [], numMiembros: 2,
  }]);
  await bd.doc('usuarios/u2').update({ clanId: 'truenos' });

  await clanes.limpiarDoblesMembresias();

  const rayos = (await bd.doc('clanes/rayos').get()).data();
  assert.ok(!rayos.oficiales.includes('u2'), 'sigue siendo oficial de un clan del que ya no es');
});

test('a quien esta donde debe no se le toca', async () => {
  sembrar();
  const antes = (await bd.doc('clanes/rayos').get()).data();

  const sacados = await clanes.limpiarDoblesMembresias();

  assert.strictEqual(sacados, 0);
  assert.deepStrictEqual((await bd.doc('clanes/rayos').get()).data().miembros, antes.miembros);
});

test('un enlace de invitacion no te mete en dos clanes a la vez', async () => {
  // El mismo agujero por la otra puerta. Aqui SI se puede rechazar antes de
  // escribir nada, porque lo resuelve el worker: se rechaza en vez de sacarle
  // de su clan, que es una decision suya y no la toma por abrir un enlace.
  sembrar();
  bd.sembrar('clanes', [{
    id: 'truenos', lider: 'u4', oficiales: [], miembros: ['u4'],
    solicitudes: [], numMiembros: 1,
  }]);
  bd.sembrar('invitaciones', [{
    id: 'abc123', clanId: 'truenos', creadaPor: 'u4',
    caduca: new Date(Date.now() + 86400000), usos: 0, maxUsos: 1,
  }]);

  // u3 ya esta en rayos.
  const resultado = await clanes.aplicarInvitacion('abc123', 'u3');

  assert.strictEqual(resultado.entrado, false);
  assert.match(resultado.motivo, /otro clan/);

  const truenos = (await bd.doc('clanes/truenos').get()).data();
  assert.ok(!truenos.miembros.includes('u3'));

  // Y la invitacion no se ha gastado.
  assert.strictEqual((await bd.doc('invitaciones/abc123').get()).data().usos, 0);
});

// --- La identidad del clan -----------------------------------------------------------
//
// Emblemas, formas y patrones estan escritos en tres sitios: el catalogo del
// navegador, las reglas y el agregado del mapa. Si uno se queda atras, un clan
// elige algo que no se puede guardar o que el mapa no publica.

test('emblemas, formas y patrones son los mismos en el catalogo, las reglas y el agregado', async () => {
  const raiz = path.join(__dirname, '..', '..');
  const catalogo = await import(`data:text/javascript;base64,${
    Buffer.from(fs.readFileSync(path.join(raiz, 'assets/data/emblemas-clan.js'), 'utf8')).toString('base64')}`);
  const reglas = fs.readFileSync(path.join(raiz, 'firestore.rules'), 'utf8');
  const agregado = fs.readFileSync(path.join(raiz, 'backend/src/agregados.js'), 'utf8');
  const lista = (texto, campo) => {
    const m = texto.match(new RegExp(String.raw`datos\(\)\.${campo} in \[([^\]]+)\]`));
    return m[1].match(/'([a-z]+)'/g).map((x) => x.slice(1, -1)).sort();
  };
  const conjunto = (nombre) => agregado.match(new RegExp(String.raw`const ${nombre} = new Set\(\[([^\]]+)\]`))[1]
    .match(/'([a-z]+)'/g).map((x) => x.slice(1, -1)).sort();

  for (const [campo, claves, set] of [
    ['emblema', Object.keys(catalogo.EMBLEMAS), 'EMBLEMAS_CLAN'],
    ['forma', Object.keys(catalogo.FORMAS), 'FORMAS_CLAN'],
    ['patron', Object.keys(catalogo.PATRONES), 'PATRONES_CLAN'],
  ]) {
    assert.deepStrictEqual(lista(reglas, campo), [...claves].sort(), `las reglas no admiten los mismos ${campo}`);
    assert.deepStrictEqual(conjunto(set), [...claves].sort(), `el agregado no publica los mismos ${campo}`);
  }
});

test('el escudo solo usa colores y claves de verdad, y cae a liso sin segundo color', async () => {
  const raiz = path.join(__dirname, '..', '..');
  const { piezasEscudo, FORMAS, PATRONES } = await import(`data:text/javascript;base64,${
    Buffer.from(fs.readFileSync(path.join(raiz, 'assets/data/emblemas-clan.js'), 'utf8')).toString('base64')}`);
  const liso = piezasEscudo({ color: '#FF5A1F', patron: 'mitad' }, 'cr');
  assert.strictEqual(liso.c1, '#FF5A1F');
  assert.strictEqual(liso.patron, '');
  assert.strictEqual(liso.silueta, FORMAS.cuadro.d);
  assert.strictEqual(liso.siglas, 'CR');
  const mitad = piezasEscudo({ color: '#FF5A1F', color2: '#111110', patron: 'mitad', forma: 'blason', emblema: 'bici' });
  assert.strictEqual(mitad.patron, PATRONES.mitad.d);
  assert.strictEqual(mitad.silueta, FORMAS.blason.d);
  assert.ok(mitad.emblema);
  assert.strictEqual(mitad.siglas, '');
  // Lo que llega de la base de datos no se cuela en el SVG.
  const raro = piezasEscudo({ color: 'red;x', color2: 'url(x)', patron: 'rayas', forma: '../x', emblema: 'cohete', siglas: '<b>' }, 'AB');
  assert.strictEqual(raro.c1, '#8A8F98');
  assert.strictEqual(raro.c2, null);
  assert.strictEqual(raro.patron, '');
  assert.strictEqual(raro.silueta, FORMAS.cuadro.d);
  assert.strictEqual(raro.emblema, null);
  assert.strictEqual(raro.siglas, 'AB');
  // Tinta oscura sobre un color claro.
  assert.strictEqual(piezasEscudo({ color: '#E0A800' }).tinta, '#111110');
  assert.strictEqual(piezasEscudo({ color: '#13A89E' }).tinta, '#FFFFFF');
});

// --- El avatar que se publica ------------------------------------------------------

test('solo se publica un avatar en data:, nunca una URL ajena', () => {
  const { avatarSeguro } = require('../src/util');
  assert.strictEqual(avatarSeguro('https://rastreo.example/pixel.png'), null);
  assert.strictEqual(avatarSeguro('javascript:alert(1)'), null);
  assert.strictEqual(avatarSeguro(`data:image/svg+xml,${'x'.repeat(20000)}`), null);
  assert.strictEqual(avatarSeguro(42), null);
  assert.strictEqual(avatarSeguro('data:image/svg+xml,%3Csvg%3E'), 'data:image/svg+xml,%3Csvg%3E');
  assert.strictEqual(avatarSeguro('data:image/webp;base64,AAAA'), 'data:image/webp;base64,AAAA');
});

test('un clan nuevo o con altas y bajas se recalcula sin esperar a un trayecto', () => {
  const { clanesPorRecalcular } = require('../src/puntuacion');
  const r = clanesPorRecalcular([
    { id: 'nuevo', miembros: ['a'] },
    { id: 'al-dia', miembros: ['a', 'b'], biciRating: 40, numMiembros: 2, plantillaPublicada: 'a,b|' },
    { id: 'entro-uno', miembros: ['a', 'b', 'c'], biciRating: 40, numMiembros: 2, plantillaPublicada: 'a,b|' },
    { id: 'repetido', miembros: ['a', 'a'], biciRating: 10, numMiembros: 1, plantillaPublicada: 'a|' },
    // La web ya subio numMiembros al aceptar: el numero cuadra pero la ficha
    // publica no tiene a 'c' (salia "Piloto").
    { id: 'aceptado-en-web', miembros: ['a', 'c'], biciRating: 40, numMiembros: 2, plantillaPublicada: 'a|c' },
    { id: 'sin-firma', miembros: ['a'], biciRating: 40, numMiembros: 1 },
  ]);
  assert.deepStrictEqual(r, ['nuevo', 'entro-uno', 'aceptado-en-web', 'sin-firma']);
});

test('quien entra en un clan recupera los viajes que no sumaron a nadie, una vez', () => {
  const { miembrosNuevos, reclamable, firmaPlantilla } = require('../src/puntuacion');
  assert.strictEqual(firmaPlantilla({ miembros: ['b', 'a', 'a'], solicitudes: ['c'] }), 'a,b|c');

  // Con firma: solo los que no estaban, sin tope de fecha.
  assert.deepStrictEqual(miembrosNuevos({ miembros: ['a', 'b', 'c'], plantillaPublicada: 'a,b|c' }), { uids: ['c'], hasta: null });
  // Sin firma (la primera vez): todos, pero solo lo aprobado antes de fundarse.
  const creado = { toMillis: () => 1000 };
  assert.deepStrictEqual(miembrosNuevos({ miembros: ['a'], creado }), { uids: ['a'], hasta: 1000 });
  assert.deepStrictEqual(miembrosNuevos({ miembros: ['a'] }), { uids: [], hasta: null });

  const t = (ms) => ({ toMillis: () => ms });
  const r = { desde: 100, hasta: null };
  assert.strictEqual(reclamable({ revisadoEn: t(500) }, r), true);
  assert.strictEqual(reclamable({ revisadoEn: t(500), territorioSumado: true }, r), false, 'ya sumo');
  assert.strictEqual(reclamable({ revisadoEn: t(50) }, r), false, 'demasiado viejo');
  assert.strictEqual(reclamable({}, r), false, 'sin fecha de aprobacion');
  assert.strictEqual(reclamable({ revisadoEn: t(500) }, { desde: 100, hasta: 400 }), false, 'aprobado con el clan ya fundado');
  assert.strictEqual(reclamable({ revisadoEn: t(300) }, { desde: 100, hasta: 400 }), true);
});
