'use strict';

/**
 * Metricas y retencion.
 *
 * Lo que se prueba de verdad es el calculo de cohortes, que es la unica parte
 * con logica: el resto es sumar y escribir. Y sobre todo, que la retencion NO
 * necesita seguir a nadie: se saca de datos que ya existen.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const metricas = require('../src/metricas');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

/** Usuario con fecha de alta, como lo devuelve Firestore. */
const alta = (uid, iso) => ({ uid, creado: { toDate: () => new Date(iso) } });
const viaje = (uid, fecha) => ({ uid, fechaViaje: fecha });

// --- Cohortes ----------------------------------------------------------------

test('agrupa las altas por semana', () => {
  // Lunes 2026-09-07 y miercoles 2026-09-09 son la misma cohorte.
  const cohortes = metricas.calcularCohortes(
    [alta('a', '2026-09-07T10:00:00Z'), alta('b', '2026-09-09T10:00:00Z')],
    []
  );

  assert.strictEqual(cohortes.length, 1);
  assert.strictEqual(cohortes[0].total, 2);
  assert.strictEqual(cohortes[0].semana, '2026-09-07');
});

test('quien no vuelve no cuenta en ninguna ventana', () => {
  const cohortes = metricas.calcularCohortes([alta('a', '2026-09-07T10:00:00Z')], []);

  assert.strictEqual(cohortes[0].total, 1);
  assert.strictEqual(cohortes[0].d1, 0);
  assert.strictEqual(cohortes[0].d30, 0);
});

test('un trayecto al dia siguiente cuenta solo en d1', () => {
  const cohortes = metricas.calcularCohortes(
    [alta('a', '2026-09-07T10:00:00Z')],
    [viaje('a', '2026-09-08')]
  );

  assert.strictEqual(cohortes[0].d1, 1);
  assert.strictEqual(cohortes[0].d7, 0, 'un dia despues no es seguir activo a la semana');
});

test('quien sigue a los 30 dias cuenta en todas las ventanas anteriores', () => {
  // Es la lectura correcta de una curva de retencion: seguir ahi el dia 30
  // implica haber seguido el 1, el 7 y el 14.
  const cohortes = metricas.calcularCohortes(
    [alta('a', '2026-09-07T10:00:00Z')],
    [viaje('a', '2026-10-10')]
  );

  assert.strictEqual(cohortes[0].d1, 1);
  assert.strictEqual(cohortes[0].d7, 1);
  assert.strictEqual(cohortes[0].d14, 1);
  assert.strictEqual(cohortes[0].d30, 1);
});

test('un usuario con muchos viajes no cuenta varias veces', () => {
  // Sin el corte, quien sube treinta trayectos inflaria su cohorte al 3.000%.
  const cohortes = metricas.calcularCohortes(
    [alta('a', '2026-09-07T10:00:00Z')],
    Array.from({ length: 30 }, (_, i) => viaje('a', `2026-09-${String(9 + i).padStart(2, '0')}`))
  );

  assert.strictEqual(cohortes[0].total, 1);
  assert.ok(cohortes[0].d1 <= 1, `d1 = ${cohortes[0].d1}, deberia ser como mucho 1`);
});

test('cuenta el trayecto MAS LEJANO, no el primero que aparezca', () => {
  // Alguien que hizo un viaje el dia 2 y otro el dia 40 sigue activo a los 30.
  // Mirando solo el primero contaba como que se fue en el dia 2, y ademas cual
  // se miraba dependia del orden en que llegaran los viajes.
  const cohortes = metricas.calcularCohortes(
    [alta('a', '2026-09-07T10:00:00Z')],
    [viaje('a', '2026-09-09'), viaje('a', '2026-10-17')]
  );

  assert.strictEqual(cohortes[0].d1, 1);
  assert.strictEqual(cohortes[0].d30, 1, 'el viaje del dia 40 se estaba ignorando');
});

test('el orden de los viajes no cambia el resultado', () => {
  const alReves = metricas.calcularCohortes(
    [alta('a', '2026-09-07T10:00:00Z')],
    [viaje('a', '2026-10-17'), viaje('a', '2026-09-09')]
  );
  const enOrden = metricas.calcularCohortes(
    [alta('a', '2026-09-07T10:00:00Z')],
    [viaje('a', '2026-09-09'), viaje('a', '2026-10-17')]
  );

  assert.deepStrictEqual(alReves, enOrden);
});

test('un alta sin fecha valida no rompe el calculo', () => {
  const cohortes = metricas.calcularCohortes(
    [{ uid: 'a' }, { uid: 'b', creado: 'no es una fecha' }, alta('c', '2026-09-07T10:00:00Z')],
    []
  );

  assert.strictEqual(cohortes.length, 1, 'solo la que tiene fecha valida');
});

// --- Privacidad --------------------------------------------------------------

test('la analitica del navegador no identifica a nadie', () => {
  const cliente = leer('assets/js/metricas.js');
  const bloque = cliente.slice(cliente.indexOf('const datos = {'), cliente.indexOf('setDoc('));

  for (const prohibido of ['uid', 'email', 'username', 'currentUser', 'localStorage', 'cookie']) {
    assert.ok(!bloque.includes(prohibido), `la analitica incluye "${prohibido}"`);
  }
});

test('no hay identificador que sobreviva a la pestaña', () => {
  // Sin esto seria seguimiento entre visitas, y haria falta banner.
  const cliente = leer('assets/js/metricas.js');

  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(cliente),
    'la analitica guarda un identificador persistente');
});

test('la lista de eventos es cerrada', () => {
  // El documento acepta escritura SIN sesion: sin lista cerrada, cualquiera
  // escribe las claves que quiera.
  const cliente = leer('assets/js/metricas.js');
  assert.match(cliente, /if \(!EVENTOS\.includes\(evento\)\) return;/);

  // Y las reglas repiten la lista, porque el cliente no es quien la impone.
  const reglas = leer('firestore.rules');
  const inicio = reglas.indexOf('match /sesiones_web/');
  const bloque = reglas.slice(inicio, reglas.indexOf('match /', inicio + 10));
  assert.match(bloque, /hasOnly\(\[/);
  assert.match(bloque, /allow read: if esAdmin\(\)/);
});

test('la retencion se calcula sin datos del navegador', () => {
  // Es la decision que evita elegir entre saber si el producto funciona y no
  // rastrear a la gente.
  const servidor = leer('backend/src/metricas.js');
  const funcion = servidor.slice(
    servidor.indexOf('function calcularCohortes'),
    servidor.indexOf('async function resumir'));

  assert.ok(!funcion.includes('sesiones_web'),
    'las cohortes dependen de la analitica del navegador');
  assert.ok(funcion.includes('fechaViaje') && funcion.includes('creado'),
    'las cohortes deberian salir de altas y trayectos');
});
