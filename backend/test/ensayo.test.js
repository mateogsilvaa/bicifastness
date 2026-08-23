'use strict';

/**
 * Ensayo general con datos realistas (#56).
 *
 * Casi todo el juego se estrena en produccion sin haber corrido nunca con
 * volumen. El cierre de temporada, en concreto, toca a TODOS los usuarios y
 * pone contadores a cero: no puede ser la primera vez el dia 1, con gente
 * mirando y sin vuelta atras.
 *
 * Aqui se ejecutan las operaciones periodicas DE VERDAD — el mismo codigo que
 * corre en produccion — sobre 200 usuarios, 20 clanes y 5.000 viajes repartidos
 * en tres meses, contra un Firestore en memoria que cuenta lecturas y
 * escrituras (`ayuda/firestore-falso.js`).
 *
 * Lo que responde y ningun test de unidad responde:
 *
 *   - ¿terminan?
 *   - ¿dejan los datos coherentes, o archivan ceros y ponen a cero lo bueno?
 *   - ¿cuanta cuota se comen, comparado con lo que dice docs/COSTE.md?
 *   - ¿se recuperan de un fallo a medias?
 *
 * El generador es determinista: un fallo aqui se reproduce con la misma semilla.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const { FirestoreFalso, FieldValue } = require('./ayuda/firestore-falso');
const { generar } = require('../../scripts/lib/generador');

// --- Inyeccion del doble ------------------------------------------------------
//
// Los modulos hacen `admin.firestore()` en cada acceso, pero `admin.firestore`
// es una propiedad con solo getter: no se puede sustituir. Se sustituye el
// modulo entero en la cache de `require` ANTES de cargarlos, que ademas deja
// claro que aqui no se habla con Firebase de ninguna forma.

let bd = new FirestoreFalso();

const adminFalso = {
  firestore: Object.assign(() => bd, { FieldValue }),
  initializeApp: () => {},
  credential: { cert: () => ({}), applicationDefault: () => ({}) },
  auth: () => ({ getUser: async () => ({ email: null }) }),
};

const rutaAdmin = require.resolve('firebase-admin');
require.cache[rutaAdmin] = new Module(rutaAdmin, null);
require.cache[rutaAdmin].exports = adminFalso;
require.cache[rutaAdmin].loaded = true;

const temporadas = require('../src/temporadas');
const divisiones = require('../src/divisiones');
const territorio = require('../src/territorio');
const puntuacion = require('../src/puntuacion');

// --- Preparacion ---------------------------------------------------------------

const DATOS = generar({ usuarios: 200, clanes: 20, viajes: 5000, meses: 3, semilla: 42 });

function sembrar() {
  bd = new FirestoreFalso();
  bd.sembrar('usuarios', DATOS.usuarios, 'uid');
  bd.sembrar('clanes', DATOS.clanes);
  bd.sembrar('tiempos_viaje', DATOS.viajes);
  bd.sembrar('estaciones_stats', DATOS.estadisticas);
  bd.reiniciarContador();
  return bd;
}

const verificados = DATOS.viajes.filter((v) => v.verificado);

/** Lo que da el plan Spark en un dia. */
const CUOTA_LECTURAS = 50000;
const CUOTA_ESCRITURAS = 20000;

const informe = [];
function anotar(operacion, coste) {
  informe.push({ operacion, ...coste });
  console.log(`  ${operacion.padEnd(34)} ${String(coste.lecturas).padStart(7)} lecturas  `
    + `${String(coste.escrituras).padStart(7)} escrituras`);
}

test.after(() => {
  console.log('\n  --- Ensayo general: 200 usuarios, 20 clanes, 5.000 viajes ---');
  const total = informe.reduce((t, i) => ({
    lecturas: t.lecturas + i.lecturas,
    escrituras: t.escrituras + i.escrituras,
  }), { lecturas: 0, escrituras: 0 });
  console.log(`  ${'TOTAL de las periodicas'.padEnd(34)} ${String(total.lecturas).padStart(7)} lecturas  `
    + `${String(total.escrituras).padStart(7)} escrituras`);
  console.log(`  Sobre la cuota diaria: ${Math.round(total.lecturas / CUOTA_LECTURAS * 100)}% de lecturas, `
    + `${Math.round(total.escrituras / CUOTA_ESCRITURAS * 100)}% de escrituras\n`);
});

// --- Los datos de partida son creibles -------------------------------------------

test('el conjunto generado se parece a algo real', () => {
  assert.strictEqual(DATOS.usuarios.length, 200);
  assert.strictEqual(DATOS.clanes.length, 20);
  assert.strictEqual(DATOS.viajes.length, 5000);

  // Ni todo aprobado ni todo pendiente: la cola de revision existe.
  const proporcion = verificados.length / DATOS.viajes.length;
  assert.ok(proporcion > 0.8 && proporcion < 0.95, `proporcion de verificados: ${proporcion}`);

  // La actividad no se reparte por igual. Con todo el mundo igual, el cierre de
  // temporada reparte insignias de una forma que no es la real.
  const activos = [...DATOS.usuarios].sort((a, b) => b.viajesVerificados - a.viajesVerificados);
  assert.ok(activos[0].viajesVerificados > activos[100].viajesVerificados * 3,
    'la actividad esta repartida demasiado plana para ser realista');

  // Y hay gente sin clan: el reparto de territorio tiene que aguantarlo.
  assert.ok(DATOS.usuarios.some((u) => !u.clanId));

  // Los contadores cuadran con los viajes. Si no, el ensayo mide una situacion
  // imposible y sus conclusiones no valen para nada.
  const sumaViajes = DATOS.usuarios.reduce((t, u) => t + u.viajesVerificados, 0);
  assert.strictEqual(sumaViajes, verificados.length);
});

// --- Cierre de temporada ----------------------------------------------------------

test('el cierre de temporada archiva a todo el mundo y solo pone a cero lo suyo', async () => {
  sembrar();

  const antes = DATOS.usuarios.map((u) => ({
    uid: u.uid, rating: u.biciRating, metros: u.metrosTotales, viajes: u.viajesVerificados,
  }));

  const resultado = await temporadas.cerrar('2026-07');
  anotar('temporadas.cerrar', bd.coste);

  assert.strictEqual(resultado.archivados, 200, 'alguien se ha quedado sin archivar');

  for (const previo of antes) {
    const ahora = bd.leer(`usuarios/${previo.uid}`);
    const archivo = bd.leer(`usuarios/${previo.uid}/temporadas/2026-07`);

    assert.ok(archivo, `${previo.uid} no tiene archivo de la temporada`);
    assert.strictEqual(ahora.puntosTemporada, 0, 'los puntos de temporada tienen que resetearse');

    // Y lo que NO se resetea. Un cierre que se lleve por delante los kilometros
    // o los viajes verificados destruye el historial de la gente, y eso no se
    // deshace.
    assert.strictEqual(ahora.biciRating, previo.rating, 'el cierre ha tocado el BiciRating');
    assert.strictEqual(ahora.metrosTotales, previo.metros, 'el cierre ha borrado kilometros');
    assert.strictEqual(ahora.viajesVerificados, previo.viajes, 'el cierre ha borrado viajes');
  }
});

test('cerrar dos veces no archiva ceros encima de lo bueno', async () => {
  sembrar();
  await temporadas.cerrar('2026-07');

  const archivoBueno = bd.leer('usuarios/uid-1/temporadas/2026-07');
  bd.reiniciarContador();

  // Un workflow que falla a medias se reintenta. Si el segundo intento
  // archivara el estado ya reseteado, guardaria ceros encima del mes real.
  const segunda = await temporadas.cerrar('2026-07');
  anotar('temporadas.cerrar (2.a vez)', bd.coste);

  assert.strictEqual(segunda.yaCerrada, true);
  assert.deepStrictEqual(bd.leer('usuarios/uid-1/temporadas/2026-07'), archivoBueno);
  assert.strictEqual(bd.coste.escrituras, 0, 'un reintento no debe escribir nada');
});

test('la simulacion del cierre no escribe absolutamente nada', async () => {
  sembrar();
  const resultado = await temporadas.cerrar('2026-07', { simular: true });
  anotar('temporadas.cerrar --simular', bd.coste);

  assert.strictEqual(resultado.simulado, true);
  assert.strictEqual(resultado.usuarios, 200);
  assert.strictEqual(bd.coste.escrituras, 0, '--simular ha escrito: el cierre no tiene vuelta atras');
  assert.strictEqual(bd.leer('usuarios/uid-1').puntosTemporada, DATOS.usuarios[0].puntosTemporada);
});

test('el cierre no supera el limite de 500 operaciones por lote', async () => {
  // El doble ya lo comprueba y lanza. Con 200 usuarios y dos operaciones cada
  // uno son 400 por lote, justo por debajo: el margen es de un solo usuario mas
  // por lote, asi que conviene que quede escrito.
  sembrar();
  await assert.doesNotReject(() => temporadas.cerrar('2026-07'));
});

// --- Divisiones ---------------------------------------------------------------------

test('el cambio semanal de division mueve gente sin dejar a nadie fuera', () => {
  const pilotos = DATOS.usuarios.map((u) => ({
    uid: u.uid, puntos: u.puntosTemporada, division: u.division,
  }));

  const cambios = divisiones.calcularSemana(pilotos);

  assert.ok(cambios.length > 0, 'con 200 pilotos alguien tiene que moverse');
  assert.ok(cambios.length < pilotos.length, 'no puede moverse todo el mundo');

  // Nadie sale del rango de niveles ni aparece dos veces.
  const vistos = new Set();
  for (const c of cambios) {
    assert.ok(divisiones.NIVELES.includes(c.division), `division invalida: ${c.division}`);
    assert.ok(!vistos.has(c.uid), `${c.uid} cambia dos veces en la misma semana`);
    vistos.add(c.uid);
    assert.ok(pilotos.some((p) => p.uid === c.uid), 'un cambio para alguien que no existe');
  }
});

test('quien no tiene puntos no sube de division', () => {
  const pilotos = DATOS.usuarios.map((u) => ({
    uid: u.uid, puntos: u.puntosTemporada, division: u.division,
  }));
  const cambios = divisiones.calcularSemana(pilotos);
  const porUid = new Map(pilotos.map((p) => [p.uid, p]));

  for (const c of cambios) {
    const antes = porUid.get(c.uid);
    if (antes.puntos > 0) continue;
    const subida = divisiones.NIVELES.indexOf(c.division) > divisiones.NIVELES.indexOf(antes.division);
    assert.ok(!subida, `${c.uid} sube de division con 0 puntos`);
  }
});

// --- Decaimiento del territorio -------------------------------------------------------

test('el decaimiento baja la influencia sin volverla negativa ni borrarla de golpe', () => {
  const antes = { 'clan-1': 100, 'clan-2': 40, 'clan-3': 1 };
  // Por diferencia de fechas, no por ejecuciones: se ejecute cuando se ejecute,
  // un dia descuenta un dia.
  const despues = territorio.decaer(antes, '2026-08-22', '2026-08-23');

  for (const [clan, valor] of Object.entries(despues)) {
    assert.ok(valor >= 0, `${clan} ha quedado en negativo: ${valor}`);
    assert.ok(valor <= antes[clan], `${clan} ha SUBIDO al decaer: ${antes[clan]} -> ${valor}`);
  }

  // Y no se lo lleva todo en un dia: el mapa tiene que moverse, no reiniciarse.
  assert.ok(despues['clan-1'] > 90, `un solo dia se ha llevado demasiado: ${despues['clan-1']}`);
  assert.strictEqual(despues['clan-1'], 97, 'con CONSERVA_DIARIA 0,97, 100 pasa a 97');
});

test('ejecutarlo dos veces el mismo dia no descuenta dos veces', () => {
  // Es la razon de que vaya por fechas: GitHub retrasa los cron programados, y
  // un decaimiento que dependiera de cuantas veces corre dejaria el mapa a cero
  // el dia que el workflow se dispare cuatro veces.
  const antes = { 'clan-1': 100 };
  const una = territorio.decaer(antes, '2026-08-22', '2026-08-23');
  const otra = territorio.decaer(una, '2026-08-23', '2026-08-23');

  assert.deepStrictEqual(otra, una, 'el mismo dia ha descontado dos veces');
  assert.deepStrictEqual(territorio.decaer(antes, null, '2026-08-23'), antes,
    'sin fecha anterior no hay nada que descontar');
});

test('el decaimiento aplicado 90 dias converge a cero sin romperse', () => {
  // Un clan que conquisto una estacion y dejo de pedalear pierde el control
  // solo. Que el mapa se limpie es el objetivo; que produzca NaN o negativos,
  // no.
  const estado = territorio.decaer({ 'clan-1': 100 }, '2026-05-25', '2026-08-23');
  const restante = estado['clan-1'] || 0;

  assert.ok(Number.isFinite(restante), `el decaimiento ha producido ${restante}`);
  assert.ok(restante >= 0 && restante < 10, `tras 90 dias sin pedalear quedan ${restante}`);

  // Por debajo de medio punto se quita del documento, en vez de dejar ceros
  // acumulandose para siempre.
  const residuo = territorio.decaer({ 'clan-1': 0.4 }, '2026-08-22', '2026-08-23');
  assert.deepStrictEqual(residuo, {}, 'los residuos se quedan ocupando sitio en el documento');
});

// --- Recalculo completo -----------------------------------------------------------------

test('la reconstruccion de agregados aguanta el volumen y no publica nada de nadie', async () => {
  sembrar();

  const escritos = await puntuacion.reconstruirAgregados();
  anotar('puntuacion.reconstruirAgregados', bd.coste);

  assert.ok(bd.contar('agregados') > 0, 'no se ha escrito ningun agregado');
  assert.ok(escritos.clanes >= 1);

  // Lo que de verdad importa de un agregado: es de lectura publica, asi que no
  // puede llevar dentro nada que no salga ya en la pantalla (#60).
  const prohibidos = ['uid', 'email', 'correo', 'consentimiento', 'clanId'];
  for (const [id] of bd.datos.get('agregados')) {
    const doc = bd.leer(`agregados/${id}`);
    for (const fila of doc.filas || []) {
      for (const campo of prohibidos) {
        assert.strictEqual(fila[campo], undefined,
          `el agregado ${id} publica '${campo}'`);
      }
    }
  }
});

test('ninguna pagina de un agregado se pasa del tope de un documento', async () => {
  sembrar();
  await puntuacion.reconstruirAgregados();

  // Un documento de Firestore tiene un tope duro de 1 MiB. Un ranking largo no
  // cabe, y si el partido en paginas falla no se entera nadie hasta que la
  // escritura peta en produccion con la coleccion ya grande.
  for (const [id] of bd.datos.get('agregados')) {
    const bytes = Buffer.byteLength(JSON.stringify(bd.leer(`agregados/${id}`)), 'utf8');
    assert.ok(bytes < 1048576, `agregados/${id} ocupa ${bytes} bytes`);
    assert.ok((bd.leer(`agregados/${id}`).filas || []).length <= 200,
      `agregados/${id} tiene mas de 200 filas`);
  }
});

// --- Cuando algo se cae a medias -------------------------------------------------------

test('un fallo despues de marcar el cierre no vuelve a archivar en el reintento', async () => {
  sembrar();

  // El cierre pone la marca ANTES de archivar, a proposito. Aqui se simula que
  // el proceso muere justo despues: es lo que pasa si GitHub Actions mata el
  // job por tiempo con el cierre a medias.
  const Lote = Object.getPrototypeOf(bd.batch());
  const commitReal = Lote.commit;
  Lote.commit = async function morir() { throw new Error('el runner ha muerto'); };

  await assert.rejects(() => temporadas.cerrar('2026-07'), /el runner ha muerto/);
  Lote.commit = commitReal;

  // La marca quedo puesta y nadie llego a archivarse.
  assert.ok(bd.leer('config/temporadas/cerradas/2026-07'), 'la marca deberia estar puesta');
  assert.strictEqual(bd.leer('usuarios/uid-1/temporadas/2026-07'), undefined);

  // Y el reintento NO vuelve a archivar. Es lo que protege el archivo: si
  // reintentara sobre un estado a medias, guardaria los ceros del reseteo
  // encima del mes real. El precio es que parte del reseteo se pierde, y eso lo
  // arregla solo el worker en cuanto recalcule.
  const segunda = await temporadas.cerrar('2026-07');
  assert.strictEqual(segunda.yaCerrada, true,
    'el reintento vuelve a archivar: acabaria guardando ceros encima del mes real');
  assert.strictEqual(bd.leer('usuarios/uid-1').puntosTemporada, DATOS.usuarios[0].puntosTemporada,
    'el reseteo se aplico pese a que el cierre fallo');
});

test('el recalculo no se cae porque un viaje venga incompleto', async () => {
  sembrar();

  // Datos de la v1 a medio migrar, o un viaje que el worker dejo a mitad.
  bd.sembrar('tiempos_viaje', [
    { id: 'roto-1', uid: 'uid-1', verificado: true },
    { id: 'roto-2', uid: 'uid-2', verificado: true, ruta: '100-101' },
    { id: 'roto-3', uid: null, verificado: true, ruta: '100-101', tiempoSegundos: 500 },
  ]);

  await assert.doesNotReject(() => puntuacion.reconstruirAgregados(),
    'un viaje incompleto tumba la reconstruccion entera');
});

test('el cierre aguanta una base sin usuarios', async () => {
  bd = new FirestoreFalso();
  const resultado = await temporadas.cerrar('2026-07');
  assert.strictEqual(resultado.archivados, 0);
});
