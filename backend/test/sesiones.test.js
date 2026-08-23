'use strict';

/**
 * Agregacion de sesiones del navegador (#34, #38).
 *
 * Antes se leia `sesiones_web` ENTERA en cada pasada del worker — 288 veces al
 * dia — para volver a sumar exactamente lo mismo. Con 200 activos eran 400
 * documentos por pasada: 115.200 lecturas al dia.
 *
 * Ahora cada sesion se suma UNA vez y se borra en el acto. Eso obliga a que los
 * contadores se INCREMENTEN en vez de reescribirse, y ahi es donde se rompe si
 * alguien se despista: sumando totales absolutos sobre una coleccion que se
 * vacia, cada pasada pisaria el contador del dia con lo poco que hubiera
 * llegado en los ultimos cinco minutos.
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

const metricas = require('../src/metricas');

const sesion = (id, dia, eventos = {}) => ({ id, dia, ...eventos });

// --- Lo que no puede romperse -------------------------------------------------

test('dos pasadas seguidas suman, no se pisan', () => {
  return (async () => {
    bd = new FirestoreFalso();

    bd.sembrar('sesiones_web', [
      sesion('s1', '2026-08-23', { pagina_vista: 3, subida_enviada: 1 }),
      sesion('s2', '2026-08-23', { pagina_vista: 2 }),
    ]);
    await metricas.agregarSesiones();

    assert.strictEqual(bd.leer('metricas/2026-08-23').sesiones, 2);
    assert.strictEqual(bd.leer('metricas/2026-08-23').pagina_vista, 5);

    // Cinco minutos despues llega una mas. Si el contador se reescribiera con el
    // total de lo leido ahora, el dia pasaria de 5 paginas vistas a 1.
    bd.sembrar('sesiones_web', [sesion('s3', '2026-08-23', { pagina_vista: 1 })]);
    await metricas.agregarSesiones();

    assert.strictEqual(bd.leer('metricas/2026-08-23').sesiones, 3,
      'la segunda pasada ha pisado el contador en vez de sumar');
    assert.strictEqual(bd.leer('metricas/2026-08-23').pagina_vista, 6);
  })();
});

test('el detalle se borra en cuanto esta contado', async () => {
  bd = new FirestoreFalso();
  bd.sembrar('sesiones_web', [
    sesion('s1', '2026-08-23', { pagina_vista: 1 }),
    sesion('s2', '2026-08-22', { pagina_vista: 1 }),
  ]);

  await metricas.agregarSesiones();

  // Es lo que hace que la coleccion este casi vacia entre pasadas, y de paso lo
  // mejor para quien nos visita: el detalle por sesion deja de existir en
  // cuanto esta sumado.
  assert.strictEqual(bd.contar('sesiones_web'), 0);
});

test('una pasada en vacio cuesta una lectura, no una por documento', async () => {
  bd = new FirestoreFalso();
  bd.reiniciarContador();

  const resultado = await metricas.agregarSesiones();

  assert.deepStrictEqual(resultado, { dias: 0, sesiones: 0 });
  assert.strictEqual(bd.coste.lecturas, 1);
  assert.strictEqual(bd.coste.escrituras, 0, 'una pasada sin sesiones no debe escribir');
});

test('un pico no se lleva por delante el tiempo del worker', async () => {
  bd = new FirestoreFalso();
  bd.sembrar('sesiones_web', Array.from({ length: 1200 }, (_, i) =>
    sesion(`s${i}`, '2026-08-23', { pagina_vista: 1 })));

  const primera = await metricas.agregarSesiones();

  // Lo que no entra en la pasada se suma en la siguiente. El worker es lo que
  // verifica los viajes de todo el mundo: no puede quedarse una hora sumando
  // metricas.
  assert.strictEqual(primera.sesiones, metricas.MAX_SESIONES_POR_PASADA);
  assert.ok(bd.contar('sesiones_web') > 0, 'se ha tragado el pico entero de una vez');

  await metricas.agregarSesiones();
  await metricas.agregarSesiones();

  assert.strictEqual(bd.contar('sesiones_web'), 0, 'tres pasadas deberian vaciar 1.200');
  assert.strictEqual(bd.leer('metricas/2026-08-23').sesiones, 1200,
    'se han perdido sesiones por el camino');
});

test('una sesion sin dia no atasca la cola para siempre', async () => {
  bd = new FirestoreFalso();
  bd.sembrar('sesiones_web', [
    { id: 'rota' },
    sesion('s1', '2026-08-23', { pagina_vista: 1 }),
  ]);

  await metricas.agregarSesiones();

  // No se puede sumar a ningun contador, pero si se quedara ahi la consulta la
  // devolveria en cada pasada, para siempre.
  assert.strictEqual(bd.contar('sesiones_web'), 0);
  assert.strictEqual(bd.leer('metricas/2026-08-23').sesiones, 1);
});

test('cada dia va a su contador', async () => {
  bd = new FirestoreFalso();
  bd.sembrar('sesiones_web', [
    sesion('s1', '2026-08-22', { pagina_vista: 4 }),
    sesion('s2', '2026-08-23', { pagina_vista: 1 }),
    sesion('s3', '2026-08-23', { subida_enviada: 2 }),
  ]);

  await metricas.agregarSesiones();

  assert.strictEqual(bd.leer('metricas/2026-08-22').pagina_vista, 4);
  assert.strictEqual(bd.leer('metricas/2026-08-23').pagina_vista, 1);
  assert.strictEqual(bd.leer('metricas/2026-08-23').subida_enviada, 2);
  assert.strictEqual(bd.leer('metricas/2026-08-23').sesiones, 2);
});
