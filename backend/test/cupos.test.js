'use strict';

/**
 * El freno de escritura de una cuenta (#62).
 *
 * DE DONDE SE VIENE. El cupo de tres viajes al dia lo comprueba el worker, o sea
 * CUANDO EL VIAJE YA ESTA ESCRITO. Entre medias no habia nada: una cuenta con
 * sesion podia crear miles de viajes y una captura de 700 KB por cada uno desde
 * la consola del navegador, sin saltarse ninguna regla. Con 20.000 escrituras al
 * dia en el plan Spark, eso es tirar la web hasta medianoche desde una cuenta
 * recien registrada.
 *
 * COMO SE FRENA. El navegador lleva su contador en `cupos/{uid}` y lo escribe en
 * el mismo lote. Las reglas miran como queda ese documento DESPUES del lote
 * (`getAfter`) y exigen dos cosas que, juntas, lo hacen infalsificable:
 *
 *   1. Cada contador sube de uno en uno como mucho, y un lote no puede escribir
 *      dos veces el mismo documento.
 *   2. El ID del viaje TIENE QUE SER el numero nuevo del contador.
 *
 * Sin la segunda, un lote de quinientos viajes que subiera el contador una sola
 * vez pasaria entero. Eso es lo que prueban los tests de abajo: no que las
 * reglas compilen, sino que siguen diciendo las dos cosas.
 *
 * No hay emulador de Firestore aqui, asi que esto se lee sobre el texto de las
 * reglas. Es menos que ejecutarlas y es lo que se puede: la alternativa era no
 * comprobar nada.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const REGLAS = leer('firestore.rules');
const { LIMITES } = require('../src/config');

/** El bloque de una coleccion, hasta el siguiente `match`. */
function bloque(coleccion) {
  const inicio = REGLAS.indexOf(`match /${coleccion}/`);
  assert.ok(inicio > -1, `no hay reglas para ${coleccion}`);
  return REGLAS.slice(inicio, REGLAS.indexOf('match /', inicio + 10));
}

// --- Lo que ata el id al contador ----------------------------------------------

test('el id del viaje tiene que ser el numero que marca el contador', () => {
  // Es lo unico que impide meter quinientos viajes en un lote que sube el
  // contador una vez. Sin esto el freno no frena nada.
  const viajes = bloque('tiempos_viaje');

  assert.match(viajes, /viajeId == request\.auth\.uid \+ '_' \+ string\(diaUTC\(\)\)/,
    'el id del viaje ya no se ata al dia y al contador');
  assert.match(viajes, /string\(cupoTras\(request\.auth\.uid\)\.viajes\)/,
    'el id del viaje ya no lleva dentro el numero del contador');
});

test('la captura tambien va contada, que es la que ocupa', () => {
  // 700 KB cada una. Es donde mas duele una inundacion, y donde el dano no se
  // deshace con borrar: la cuota de almacenamiento ya esta gastada.
  const capturas = bloque('capturas');

  assert.match(capturas, /viajeId == request\.auth\.uid \+ '_' \+ string\(diaUTC\(\)\)/);
  assert.match(capturas, /string\(cupoTras\(request\.auth\.uid\)\.capturas\)/);
  assert.match(capturas, /cupoTras\(request\.auth\.uid\)\.capturas <= topeDiario\(\)/);
});

test('el contador se mira DESPUES del lote, no antes', () => {
  // Con `get` en vez de `getAfter` se leeria el contador de antes de escribir, y
  // entonces todos los viajes del lote verian el mismo numero: pasarian todos.
  assert.match(REGLAS, /function cupoTras\(uid\) \{\s*return getAfter\(/,
    'el cupo se lee con get() en vez de getAfter()');
});

// --- Lo que impide falsear el contador -----------------------------------------

test('cada contador sube de uno en uno, y solo hacia arriba', () => {
  const cupos = bloque('cupos');

  assert.match(cupos, /datos\(\)\.viajes <= previo\(\)\.viajes \+ 1/,
    'los viajes pueden subir de mas de uno en uno');
  assert.match(cupos, /datos\(\)\.capturas <= previo\(\)\.capturas \+ 1/,
    'las capturas pueden subir de mas de una en una');
  assert.match(cupos, /datos\(\)\.viajes >= previo\(\)\.viajes/,
    'los viajes pueden bajar');
  assert.match(cupos, /datos\(\)\.capturas >= previo\(\)\.capturas/,
    'las capturas pueden bajar');
});

test('el dia lo pone el servidor, no quien escribe', () => {
  // Si el dia viniera del cliente, reiniciar el contador seria mandar otro
  // numero y el freno duraria lo que tarda alguien en leer estas reglas.
  const cupos = bloque('cupos');

  assert.match(cupos, /datos\(\)\.dia == diaUTC\(\)/);
  assert.match(REGLAS, /function diaUTC\(\)[\s\S]{0,120}request\.time\.toMillis\(\)/,
    'el dia no sale de request.time');
});

test('el contador no se puede borrar para empezar de cero', () => {
  assert.match(bloque('cupos'), /allow delete: if false/,
    'borrar el contador es la forma facil de reiniciarlo');
});

test('el contador solo lo ve su dueño', () => {
  assert.match(bloque('cupos'), /allow read: if esYo\(uid\) \|\| esAdmin\(\)/);
});

// --- El tope, y por que no es el cupo del juego ---------------------------------

test('el tope de las reglas es holgado respecto al cupo del juego', () => {
  // El dia de las reglas es UTC porque `request.time` es lo unico que hay ahi.
  // Un dia UTC pisa dos dias de Madrid, asi que quien gaste sus tres viajes a
  // las 23:00 y otros tres a la 01:00 tiene que seguir cabiendo. Un tope
  // ajustado bloquearia a gente legitima de madrugada, que es peor que el
  // problema que resuelve.
  const tope = Number(REGLAS.match(/function topeDiario\(\) \{ return (\d+); \}/)?.[1]);

  assert.ok(Number.isFinite(tope), 'no se encuentra el tope diario en las reglas');
  assert.ok(tope >= LIMITES.VIAJES_POR_DIA * 2,
    `el tope (${tope}) no deja margen para el desfase entre el dia UTC y el de Madrid`);
  assert.ok(tope <= LIMITES.VIAJES_POR_DIA * 10,
    `el tope (${tope}) es tan alto que deja de frenar`);
});

// --- El navegador, que es quien lo escribe --------------------------------------

test('el navegador escribe el contador en el mismo lote que el viaje', () => {
  // En otro lote no valdria de nada: `getAfter` mira ESTE.
  const subir = leer('assets/js/paginas/subir.js');
  const cuerpo = subir.slice(subir.indexOf('async function crearViajes'));

  const lote = cuerpo.indexOf('const lote = writeBatch(db)');
  const cupo = cuerpo.indexOf('lote.set(cupoRef');
  const viaje = cuerpo.indexOf("lote.set(doc(db, 'tiempos_viaje'");
  const commit = cuerpo.indexOf('lote.commit()');

  assert.ok(lote > -1 && cupo > lote && viaje > lote && commit > cupo && commit > viaje,
    'el contador y el viaje no van en el mismo lote');
});

test('el navegador construye el id con el numero nuevo, no con uno automatico', () => {
  const subir = leer('assets/js/paginas/subir.js');
  const cuerpo = subir.slice(subir.indexOf('async function crearViajes'));

  assert.ok(!/doc\(collection\(db, 'tiempos_viaje'\)\)/.test(cuerpo),
    'sigue pidiendo un id automatico, que las reglas van a rechazar');
  assert.match(cuerpo, /\$\{perfil\.uid\}_\$\{cupo\.dia\}_\$\{contados\}/);
});

test('un cupo de ayer no se arrastra a hoy', () => {
  const subir = leer('assets/js/paginas/subir.js');
  const cuerpo = subir.slice(subir.indexOf('async function leerCupo'));

  assert.match(cuerpo, /previo\.dia !== dia/,
    'el navegador reutiliza el contador de otro dia');
});

// --- El cupo del juego, que lo sigue poniendo el worker -------------------------

test('el cupo del dia se cuenta, no se trae', () => {
  // De esto solo hace falta el numero. Traerse los viajes del dia costaba una
  // lectura por viaje —sesenta con una cuenta que inunde— por cada viaje
  // procesado; el conteo cobra una por cada mil.
  const worker = leer('backend/worker.js');
  const cupo = worker.slice(worker.indexOf('// Cupo diario, contado en el servidor'));

  assert.match(cupo.slice(0, 700), /\.count\(\)\s*\n?\s*\.get\(\)/,
    'el cupo diario se sigue trayendo los documentos');
});

// --- El modulo que se va --------------------------------------------------------

test('no queda un modulo de limitacion que no llame nadie', () => {
  // `limites.js` hacia esto mismo con el Admin SDK, o sea DESPUES de la
  // escritura, que es justo cuando ya no sirve. Un modulo de seguridad muerto es
  // peor que no tenerlo: quien lo lea da por hecho que hay freno.
  assert.ok(!fs.existsSync(path.join(RAIZ, 'backend/src/limites.js')),
    'limites.js sigue ahi, y no lo llama nadie');

  const config = leer('backend/src/config.js');
  for (const muerto of ['VIAJES_POR_SEMANA', 'SEGUNDOS_ENTRE_SUBIDAS']) {
    assert.ok(!config.includes(muerto),
      `${muerto} se queda en config sin que lo aplique nadie`);
  }
});
