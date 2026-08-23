'use strict';

/**
 * Reconstruccion incremental de agregados y dominio (#36, #34).
 *
 * DE DONDE SE VIENE. Rehacer los agregados leia las CUATRO colecciones enteras,
 * y recalcular el dominio de una estacion leia las dos grandes. Las dos cosas
 * pasaban en cada pasada del worker que hubiera movido algo: 15.200 lecturas por
 * pasada con 15.000 viajes acumulados, unas 163 veces al dia. Dos millones y
 * medio de lecturas diarias contra una cuota de 50.000, sin que nadie abriera la
 * web (docs/COSTE.md).
 *
 * LA IDEA. Los viajes solo hacen falta para dos cosas: los agregados POR RUTA y
 * el contador de la portada. Las clasificaciones de pilotos, la de clanes y el
 * mapa salen de `usuarios`, `clanes` y `estaciones_stats`. Y la influencia sobre
 * una estacion sale solo de los viajes de las rutas que la tocan. Asi que
 * sabiendo QUE se ha movido, no hace falta leerlo todo.
 *
 * Lo que se prueba aqui es lo unico que importa de eso: que sale el MISMO
 * resultado y cuesta mucho menos. Un incremental que ahorre lecturas pero deje
 * la clasificacion mal no vale nada.
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

const puntuacion = require('../src/puntuacion');
const agregados = require('../src/agregados');

// --- Un proyecto de mentira, pero con la forma del de verdad ------------------

const ESTACIONES = ['001', '002', '003', '004', '005', '006'];
const RUTAS = [];
for (let i = 0; i < ESTACIONES.length; i++) {
  for (let j = 0; j < ESTACIONES.length; j++) {
    if (i !== j) RUTAS.push(`${ESTACIONES[i]}-${ESTACIONES[j]}`);
  }
}

const USUARIOS = 40;
const POR_RUTA = 8;

function sembrar() {
  bd = new FirestoreFalso();

  bd.sembrar('clanes', [
    { id: 'rojos', nombre: 'Rojos', color: '#f00', miembros: [], biciRating: 500 },
    { id: 'azules', nombre: 'Azules', color: '#00f', miembros: [], biciRating: 300 },
  ]);

  const usuarios = [];
  for (let i = 0; i < USUARIOS; i++) {
    usuarios.push({
      id: `u${i}`,
      username: `piloto-${i}`,
      clanId: i % 2 === 0 ? 'rojos' : 'azules',
      biciRating: 100 + i,
      viajesVerificados: 3,
      metrosTotales: 1000 * i,
      mejorRacha: i % 7,
      racha: i % 3,
      puntosPorRuta: { [RUTAS[i % RUTAS.length]]: 10 },
    });
  }
  bd.sembrar('usuarios', usuarios);

  const viajes = [];
  for (const ruta of RUTAS) {
    for (let k = 0; k < POR_RUTA; k++) {
      const uid = `u${(RUTAS.indexOf(ruta) * 3 + k) % USUARIOS}`;
      viajes.push({
        id: `${ruta}-${k}`,
        uid,
        ruta,
        verificado: true,
        tiempoSegundos: 300 + k * 7 + RUTAS.indexOf(ruta),
        distanciaMetros: 2000 + k * 10,
      });
    }
  }
  bd.sembrar('tiempos_viaje', viajes);

  return { usuarios: usuarios.length, viajes: viajes.length };
}

// --- Agregados ----------------------------------------------------------------

test('la reconstruccion parcial da el mismo agregado que la completa', async () => {
  const { viajes: totalViajes } = sembrar();

  await puntuacion.reconstruirAgregados();
  const completa = {
    general: bd.leer('agregados/ranking-general'),
    clanes: bd.leer('agregados/ranking-clanes'),
    rutas: bd.leer('agregados/rutas'),
    portada: bd.leer('agregados/portada'),
    unaRuta: bd.leer(`agregados/ruta-${RUTAS[0]}`),
  };

  assert.strictEqual(completa.portada.viajes, totalViajes);
  assert.strictEqual(completa.rutas.rutas.length, RUTAS.length);

  // Ahora, sabiendo solo que se ha movido UNA ruta.
  bd.reiniciarContador();
  await puntuacion.reconstruirAgregados(null, new Set([RUTAS[0]]));

  assert.deepStrictEqual(bd.leer(`agregados/ruta-${RUTAS[0]}`).filas, completa.unaRuta.filas,
    'el agregado de la ruta movida tiene que salir igual');
  assert.deepStrictEqual(bd.leer('agregados/ranking-general').filas, completa.general.filas,
    'las clasificaciones de pilotos no dependen de los viajes');
  assert.deepStrictEqual(bd.leer('agregados/ranking-clanes').filas, completa.clanes.filas);
});

test('la parcial conserva el indice de rutas y el total de la portada', async () => {
  const { viajes: totalViajes } = sembrar();

  await puntuacion.reconstruirAgregados();
  await puntuacion.reconstruirAgregados(null, new Set([RUTAS[0]]));

  // Lo que se rompe solo si se hace mal: `porRuta` en parcial tiene UNA ruta.
  // Sobrescribir con eso dejaria el selector de `/clasificacion/` con una
  // entrada y la portada diciendo que hay ocho viajes en total.
  assert.strictEqual(bd.leer('agregados/rutas').rutas.length, RUTAS.length,
    'el indice se ha quedado solo con la ruta movida');
  assert.strictEqual(bd.leer('agregados/portada').viajes, totalViajes,
    'la portada ha perdido el resto de viajes');
  assert.strictEqual(bd.leer('agregados/portada').rutas, RUTAS.length);
});

test('la parcial cuesta una fraccion de la completa', async () => {
  const { viajes: totalViajes } = sembrar();

  bd.reiniciarContador();
  await puntuacion.reconstruirAgregados();
  const completa = bd.coste.lecturas;

  bd.reiniciarContador();
  await puntuacion.reconstruirAgregados(null, new Set([RUTAS[0]]));
  const parcial = bd.coste.lecturas;

  // Lo que se ahorra son los viajes que NO son de la ruta movida.
  assert.ok(completa > totalViajes, `la completa deberia leer los ${totalViajes} viajes`);
  assert.ok(parcial < completa / 2,
    `la parcial cuesta ${parcial} lecturas y la completa ${completa}: no ahorra lo suficiente`);
});

test('una pasada sin rutas movidas sigue refrescando pilotos y clanes', async () => {
  // Pasa cuando solo se han rechazado viajes o ha cambiado un clan: no se mueve
  // ninguna ruta, pero las clasificaciones si.
  sembrar();
  await puntuacion.reconstruirAgregados();

  bd.sembrar('clanes', [{ id: 'rojos', nombre: 'Rojos renombrados', color: '#f00', biciRating: 900 }]);

  bd.reiniciarContador();
  await puntuacion.reconstruirAgregados(null, new Set());

  assert.strictEqual(bd.leer('agregados/ranking-clanes').filas[0].nombre, 'Rojos renombrados');
  assert.ok(bd.coste.lecturas < 100, `${bd.coste.lecturas} lecturas para no mover ninguna ruta`);
  assert.strictEqual(bd.leer('agregados/rutas').rutas.length, RUTAS.length);
});

test('el total de la portada se cuenta sin leer los viajes', async () => {
  const { viajes: totalViajes } = sembrar();

  bd.reiniciarContador();
  const contados = await puntuacion.contarViajesVerificados();

  assert.strictEqual(contados, totalViajes);
  assert.ok(bd.coste.lecturas <= Math.ceil(totalViajes / 1000) + 1,
    `contar ha costado ${bd.coste.lecturas} lecturas: no esta usando la consulta de agregacion`);
});

// --- Dominio de las estaciones -------------------------------------------------

test('el dominio de una estacion sale igual leyendo solo sus rutas', async () => {
  sembrar();
  // El camino barato necesita el indice de rutas, que deja la reconstruccion.
  await puntuacion.reconstruirAgregados();

  await puntuacion.recalcularEstaciones(['001']);
  const barato = bd.leer('estaciones_stats/001');

  bd.vaciar('estaciones_stats');
  await puntuacion.recalcularEstaciones(['001'], await puntuacion.cargarBase());
  const caro = bd.leer('estaciones_stats/001');

  assert.deepStrictEqual(barato.cuota, caro.cuota, 'el reparto de influencia no coincide');
  assert.strictEqual(barato.clanDominante, caro.clanDominante);
  assert.strictEqual(barato.lider, caro.lider);
});

test('recalcular el dominio ya no lee los viajes enteros', async () => {
  const { viajes: totalViajes } = sembrar();
  await puntuacion.reconstruirAgregados();

  bd.reiniciarContador();
  await puntuacion.recalcularEstaciones(['001', '002']);

  assert.ok(bd.coste.lecturas < totalViajes,
    `${bd.coste.lecturas} lecturas con ${totalViajes} viajes: sigue leyendolos todos`);
});

test('sin indice de rutas se lee todo, en vez de borrar el mapa', async () => {
  // El respaldo no es decorativo: si el camino barato tomara "no hay indice"
  // por "no hay rutas", la influencia saldria a cero y el mapa se quedaria sin
  // dueños de un dia para otro.
  sembrar();
  assert.strictEqual(await puntuacion.rutasConViajes(), null, 'no deberia haber indice todavia');

  await puntuacion.recalcularEstaciones(['001']);

  assert.ok(Object.keys(bd.leer('estaciones_stats/001').cuota).length > 0,
    'sin indice, el dominio se ha calculado sobre cero viajes');
});

// --- Las rutas que esperan -----------------------------------------------------

test('las rutas movidas mientras el limitador espera no se pierden', async () => {
  sembrar();

  // Una pasada que mueve una ruta y a la que el limitador dice que no.
  await agregados.apuntarPendientes(['001-002']);
  // Otra, quince segundos despues.
  await agregados.apuntarPendientes(['003-004', '001-002']);

  assert.deepStrictEqual((await agregados.leerPendientes()).sort(), ['001-002', '003-004']);

  await agregados.olvidarPendientes();
  assert.deepStrictEqual(await agregados.leerPendientes(), []);
});

test('apuntar cero rutas no escribe nada', async () => {
  sembrar();
  bd.reiniciarContador();

  assert.strictEqual(await agregados.apuntarPendientes([]), 0);
  assert.strictEqual(bd.coste.escrituras, 0);
});

test('una ruta que se queda sin viajes deja de tener clasificacion', async () => {
  // Pasa cuando se anula el ultimo viaje verificado de una ruta. Si el agregado
  // no se toca, `/clasificacion/` sigue ensenando un podio que ya no existe, y
  // el selector sigue ofreciendo la ruta.
  sembrar();
  await puntuacion.reconstruirAgregados();
  assert.ok(bd.leer(`agregados/ruta-${RUTAS[0]}`).filas.length > 0);

  for (let k = 0; k < POR_RUTA; k++) await bd.doc(`tiempos_viaje/${RUTAS[0]}-${k}`).delete();
  await puntuacion.reconstruirAgregados(null, new Set([RUTAS[0]]));

  assert.deepStrictEqual(bd.leer(`agregados/ruta-${RUTAS[0]}`).filas, [],
    'la ruta vaciada conserva su podio');
  assert.ok(!bd.leer('agregados/rutas').rutas.includes(RUTAS[0]),
    'la ruta vaciada sigue en el selector');
  assert.strictEqual(bd.leer('agregados/rutas').rutas.length, RUTAS.length - 1);
});
