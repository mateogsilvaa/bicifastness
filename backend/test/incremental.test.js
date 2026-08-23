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

const { FirestoreFalso, FieldValue, FieldPath } = require('./ayuda/firestore-falso');

let bd = new FirestoreFalso();

const rutaAdmin = require.resolve('firebase-admin');
require.cache[rutaAdmin] = new Module(rutaAdmin, null);
require.cache[rutaAdmin].exports = {
  firestore: Object.assign(() => bd, { FieldValue, FieldPath }),
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

  // `miembros` y `clanId` tienen que decir lo mismo: la fuente de verdad de a
  // que clan pertenece alguien es `clanes/{id}.miembros`, y sembrar los dos
  // distintos daria un ensayo verde sobre datos que no pueden existir.
  const miembros = { rojos: [], azules: [] };
  const clanDe = (i) => (i % 2 === 0 ? 'rojos' : 'azules');

  const usuarios = [];
  for (let i = 0; i < USUARIOS; i++) {
    miembros[clanDe(i)].push(`u${i}`);
    usuarios.push({
      id: `u${i}`,
      username: `piloto-${i}`,
      clanId: clanDe(i),
      biciRating: 100 + i,
      viajesVerificados: 3,
      metrosTotales: 1000 * i,
      mejorRacha: i % 7,
      racha: i % 3,
      puntosPorRuta: { [RUTAS[i % RUTAS.length]]: 10 },
    });
  }
  bd.sembrar('usuarios', usuarios);

  bd.sembrar('clanes', [
    { id: 'rojos', nombre: 'Rojos', color: '#f00', miembros: miembros.rojos, biciRating: 500 },
    { id: 'azules', nombre: 'Azules', color: '#00f', miembros: miembros.azules, biciRating: 300 },
  ]);

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

// --- El conteo por ruta del indice ---------------------------------------------

test('el indice de rutas lleva cuantos viajes tiene cada tramo', async () => {
  // Es lo que mira `misiones.rutaDelDia` para descartar los tramos que no mueve
  // nadie. Contarlo aqui, donde los viajes ya estan leidos, le ahorra al worker
  // recorrer `tiempos_viaje` ENTERA una vez al dia solo para eso.
  sembrar();
  await puntuacion.reconstruirAgregados();

  const conteos = bd.leer('agregados/rutas').viajesPorRuta;
  assert.strictEqual(Object.keys(conteos).length, RUTAS.length);
  assert.strictEqual(conteos[RUTAS[0]], POR_RUTA);
});

test('la parcial actualiza el conteo de su ruta sin borrar el resto', async () => {
  sembrar();
  await puntuacion.reconstruirAgregados();

  await bd.doc(`tiempos_viaje/${RUTAS[0]}-0`).delete();
  await puntuacion.reconstruirAgregados(null, new Set([RUTAS[0]]));

  const conteos = bd.leer('agregados/rutas').viajesPorRuta;
  assert.strictEqual(conteos[RUTAS[0]], POR_RUTA - 1, 'la ruta movida no se ha actualizado');
  assert.strictEqual(conteos[RUTAS[1]], POR_RUTA, 'las demas han perdido su conteo');
  assert.strictEqual(Object.keys(conteos).length, RUTAS.length);
});

test('una ruta vaciada sale tambien del conteo', async () => {
  sembrar();
  await puntuacion.reconstruirAgregados();

  for (let k = 0; k < POR_RUTA; k++) await bd.doc(`tiempos_viaje/${RUTAS[0]}-${k}`).delete();
  await puntuacion.reconstruirAgregados(null, new Set([RUTAS[0]]));

  assert.ok(!(RUTAS[0] in bd.leer('agregados/rutas').viajesPorRuta),
    'la ruta sin viajes sigue contando para la ruta del dia');
});

// --- El tope de la clasificacion por ruta ---------------------------------------

test('rehacer la clasificacion de una ruta no lee la ruta entera', async () => {
  // Solo puntuan los siete primeros y solo cuenta el mejor tiempo de cada
  // piloto: leer los 15.000 viajes de una ruta transitada era pagar por lo que
  // no se usa, y era la lectura mas cara del worker (docs/COSTE.md).
  sembrar();

  const ruta = RUTAS[0];
  const muchos = [];
  for (let k = 0; k < 900; k++) {
    muchos.push({
      id: `relleno-${k}`,
      uid: `u${k % USUARIOS}`,
      ruta,
      verificado: true,
      tiempoSegundos: 1000 + k,
      distanciaMetros: 2000,
    });
  }
  bd.sembrar('tiempos_viaje', muchos);

  bd.reiniciarContador();
  await puntuacion.recalcularRuta(ruta);

  assert.ok(bd.coste.lecturas < 400,
    `${bd.coste.lecturas} lecturas con 908 viajes en la ruta: no hay tope`);
});

test('el tope no cambia quien puntua', async () => {
  // Los siete mejores tienen que salir igual con tope y sin el. Si el tope
  // recortara por el sitio equivocado, el podio de una ruta transitada seria
  // otro y nadie lo notaria hasta que alguien reclamara sus puntos.
  sembrar();

  const ruta = RUTAS[0];
  bd.sembrar('tiempos_viaje', Array.from({ length: 500 }, (_, k) => ({
    id: `lento-${k}`,
    uid: `u${(k % (USUARIOS - 8)) + 8}`,
    ruta,
    verificado: true,
    tiempoSegundos: 5000 + k,
    distanciaMetros: 2000,
  })));

  await puntuacion.recalcularRuta(ruta);

  // Los sembrados originales de la ruta son los mas rapidos (300 + k*7).
  const mejores = [...Array(USUARIOS).keys()]
    .map((i) => ({ uid: `u${i}`, puntos: (bd.leer(`usuarios/u${i}`).puntosPorRuta || {})[ruta] || 0 }))
    .filter((x) => x.puntos > 0)
    .sort((a, b) => b.puntos - a.puntos);

  assert.strictEqual(mejores.length, 7, 'no puntuan exactamente siete pilotos');
  assert.strictEqual(mejores[0].puntos, 80, 'el primero no lleva los puntos del primero');
});

// --- El turno de refresco ------------------------------------------------------

test('el turno recorre el catalogo y da la vuelta', () => {
  const rutas = ['a', 'b', 'c', 'd', 'e'];

  assert.deepStrictEqual(agregados.turnoDeRutas(rutas, null, 2), ['a', 'b']);
  assert.deepStrictEqual(agregados.turnoDeRutas(rutas, 'b', 2), ['c', 'd']);
  // Sin vuelta, el final del catalogo dejaria de refrescarse para siempre en
  // cuanto el cursor llegara ahi, y eso no se nota hasta que alguien se queja.
  assert.deepStrictEqual(agregados.turnoDeRutas(rutas, 'd', 3), ['e', 'a', 'b']);
  assert.deepStrictEqual(agregados.turnoDeRutas(rutas, 'z', 2), ['a', 'b']);
});

test('el turno aguanta un catalogo vacio o mas corto que el turno', () => {
  assert.deepStrictEqual(agregados.turnoDeRutas([], null, 3), []);
  assert.deepStrictEqual(agregados.turnoDeRutas(undefined, null, 3), []);
  assert.deepStrictEqual(agregados.turnoDeRutas(['a'], null, 3), ['a']);
});

test('un piloto que se renombra acaba actualizado en las rutas que no ha tocado', async () => {
  // El agregado de una ruta lleva dentro el nombre del piloto, y eso cambia sin
  // que se mueva ninguna ruta. Antes lo tapaba la reconstruccion completa de
  // cada seis horas; ahora tiene que hacerlo el turno.
  sembrar();
  await puntuacion.reconstruirAgregados();

  const conElPiloto = RUTAS.filter((r) => bd.leer(`agregados/ruta-${r}`)
    .filas.some((f) => f.nombre === 'piloto-0'));
  assert.ok(conElPiloto.length > 1, 'el piloto tiene que salir en varias rutas');

  await bd.doc('usuarios/u0').update({ username: 'renombrado' });

  // Muchas reconstrucciones sin tocar NINGUNA ruta: solo el turno trabaja.
  const vueltas = Math.ceil(RUTAS.length / agregados.RUTAS_POR_TURNO) + 1;
  for (let i = 0; i < vueltas; i++) await puntuacion.reconstruirAgregados(null, new Set());

  for (const ruta of conElPiloto) {
    const filas = bd.leer(`agregados/ruta-${ruta}`).filas;
    assert.ok(!filas.some((f) => f.nombre === 'piloto-0'),
      `la ruta ${ruta} sigue con el nombre viejo`);
  }
});

test('el turno no borra el indice al pasar por rutas que no se han movido', async () => {
  sembrar();
  await puntuacion.reconstruirAgregados();

  for (let i = 0; i < 5; i++) await puntuacion.reconstruirAgregados(null, new Set());

  assert.strictEqual(bd.leer('agregados/rutas').rutas.length, RUTAS.length);
  assert.strictEqual(Object.keys(bd.leer('agregados/rutas').viajesPorRuta).length, RUTAS.length);
});
