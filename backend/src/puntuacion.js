'use strict';

/**
 * Calculo de BiciRating, ranking por ruta y dominio de estaciones.
 *
 * Antes esto se ejecutaba en el NAVEGADOR del admin (admin/index.html hacia
 * cientos de writes sueltos desde el cliente). Cualquiera con la consola abierta
 * podia escribirse el biciRating que quisiera. Ahora es codigo de servidor y el
 * cliente no puede tocar ninguna de estas colecciones.
 */

const admin = require('firebase-admin');
const { PUNTOS, VIAJE } = require('./config');
const rachas = require('./rachas');
const agregados = require('./agregados');
const territorio = require('./territorio');

// Firestore se coge de `db.js`, no de `admin` directamente: es lo que permite
// que el contador de cuota (#38) vea TODO lo que hace el backend.
const { db } = require('./db');

/** Puntos que da una posicion (0-indexada) en el ranking de una ruta. */
function puntosPorPosicion(indice) {
  return PUNTOS.POR_POSICION[indice] ?? 0;
}

// --- Puntos de un viaje suelto -----------------------------------------------
/**
 * Lo que suma un trayecto por si mismo, al margen de la clasificacion del tramo.
 *
 * Este es el cambio que hace que el juego deje de ser solo de velocistas: un
 * fondista de 6 km a 12 km/h y un velocista de 1,5 km a 20 km/h acaban en el
 * mismo orden de magnitud. Los numeros y su justificacion, en `config.js` y en
 * docs/JUEGO.md.
 *
 * Devuelve tambien el desglose, porque un jugador que no entiende de donde
 * salen sus puntos no confia en la puntuacion.
 *
 * @param {object} viaje
 * @param {number} viaje.distanciaMetros
 * @param {number} [viaje.velocidadKmh]
 * @param {number} [viaje.multiplicadorRuta]  x2 si es la ruta del dia
 * @param {number} [viaje.racha]              dias de racha del piloto
 * @param {boolean} [viaje.territorioPropio]  toca estacion que controla su clan
 * @param {boolean} [viaje.puntua]            false pasado el cupo diario
 */
function calcularPuntosViaje({
  distanciaMetros,
  velocidadKmh = null,
  multiplicadorRuta = 1,
  racha = 0,
  territorioPropio = false,
  puntua = true,
} = {}) {
  const km = Math.max(0, Number(distanciaMetros) || 0) / 1000;
  const kmh = Math.max(0, Number(velocidadKmh) || 0);

  const base = VIAJE.BASE;
  const porDistancia = Math.round(km * VIAJE.PUNTOS_POR_KM);
  // El maximo(0, ...) es lo que hace que un trayecto lento no reste: sigue
  // sumando por base y por distancia.
  const porVelocidad = Math.round(
    Math.max(0, kmh - VIAJE.VELOCIDAD_UMBRAL_KMH) * VIAJE.PUNTOS_POR_KMH
  );

  const bruto = base + porDistancia + porVelocidad;

  const multRacha = rachas.multiplicador(racha);
  const multTerritorio = territorioPropio ? VIAJE.MULTIPLICADOR_TERRITORIO : 1;
  const multRuta = Number(multiplicadorRuta) || 1;

  // Pasado el cupo diario el viaje se registra en las estadisticas pero no da
  // puntos. El cupo lo cuenta el worker sobre Firestore, nunca el navegador.
  const total = puntua ? Math.round(bruto * multRacha * multRuta * multTerritorio) : 0;

  return {
    total,
    puntua,
    desglose: {
      base,
      distancia: porDistancia,
      velocidad: porVelocidad,
      subtotal: bruto,
      multiplicadorRacha: multRacha,
      multiplicadorRuta: multRuta,
      multiplicadorTerritorio: multTerritorio,
    },
  };
}

/** Multiplicador de la ruta segun si esta destacada o es historica. */
async function multiplicadorRuta(ruta) {
  const conf = await db().doc('config/general').get();
  if (!conf.exists) return 1;
  const datos = conf.data();
  if (datos.rutaDestacada === ruta) return PUNTOS.MULTIPLICADOR_RUTA_DESTACADA;
  if (Array.isArray(datos.rutasHistoricas) && datos.rutasHistoricas.includes(ruta)) {
    return PUNTOS.MULTIPLICADOR_RUTA_HISTORICA;
  }
  return 1;
}

/**
 * Recalcula los puntos de todos los pilotos que compiten en una ruta.
 * Solo cuenta el mejor tiempo verificado de cada piloto.
 */
async function recalcularRuta(ruta) {
  const multiplicador = await multiplicadorRuta(ruta);

  const snapshot = await db().collection('tiempos_viaje')
    .where('ruta', '==', ruta)
    .where('verificado', '==', true)
    .get();

  /** @type {Map<string, number>} uid -> mejor tiempo */
  const mejorPorPiloto = new Map();
  for (const doc of snapshot.docs) {
    const { uid, tiempoSegundos } = doc.data();
    if (!uid) continue;
    const actual = mejorPorPiloto.get(uid);
    if (actual === undefined || tiempoSegundos < actual) {
      mejorPorPiloto.set(uid, tiempoSegundos);
    }
  }

  const clasificacion = [...mejorPorPiloto.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([uid], indice) => ({ uid, puntos: Math.round(puntosPorPosicion(indice) * multiplicador) }));

  const puntosPorUid = new Map(clasificacion.map((c) => [c.uid, c.puntos]));

  // Pilotos que YA tenian puntos en esta ruta. Si han caido del top hay que
  // quitarselos, o conservarian los puntos de un puesto que ya han perdido.
  //
  // El nombre de la ruta ("002-110") no es un segmento de field path valido sin
  // comillas: empieza por digito y lleva un guion. Con la cadena literal
  // `puntosPorRuta.${ruta}` la consulta lanzaba error. Hay que usar FieldPath,
  // que se encarga de entrecomillar el segmento.
  const campoRuta = new admin.firestore.FieldPath('puntosPorRuta', ruta);
  const conPuntosPrevios = await db().collection('usuarios').where(campoRuta, '>', 0).get();

  // Union de los dos conjuntos: los que puntuan ahora y los que puntuaban antes.
  const afectados = new Set([...puntosPorUid.keys(), ...conPuntosPrevios.docs.map((d) => d.id)]);
  if (afectados.size === 0) return 0;

  // Una sola lectura por lotes en vez de un get() por piloto dentro del bucle.
  const refs = [...afectados].map((uid) => db().doc(`usuarios/${uid}`));
  const documentos = await db().getAll(...refs);

  const clanesAfectados = new Set();
  const escrituras = [];

  for (const usuario of documentos) {
    if (!usuario.exists) continue;

    const datos = usuario.data();
    const porRuta = { ...(datos.puntosPorRuta || {}) };
    const puntos = puntosPorUid.get(usuario.id) || 0;

    if (puntos > 0) porRuta[ruta] = puntos;
    else delete porRuta[ruta];

    const suma = Object.values(porRuta).reduce((t, p) => t + p, 0);
    const biciRating = (datos.viajesVerificados || 0) * PUNTOS.POR_VIAJE_VERIFICADO + suma;

    // Nos ahorramos la escritura si nada cambia.
    if (datos.biciRating === biciRating && (datos.puntosPorRuta || {})[ruta] === porRuta[ruta]) continue;

    escrituras.push({ ref: usuario.ref, datos: { puntosPorRuta: porRuta, biciRating } });
    if (datos.clanId) clanesAfectados.add(datos.clanId);
  }

  await escribirEnLotes(escrituras);

  for (const clanId of clanesAfectados) await recalcularClan(clanId);
  return clasificacion.length;
}

/**
 * Aplica las escrituras en tandas de 450.
 * Un batch de Firestore admite 500 operaciones como maximo; con una ruta muy
 * concurrida se superaba y fallaba el lote entero.
 */
async function escribirEnLotes(escrituras, tamano = 450) {
  for (let i = 0; i < escrituras.length; i += tamano) {
    const lote = db().batch();
    for (const { ref, datos } of escrituras.slice(i, i + tamano)) lote.update(ref, datos);
    await lote.commit();
  }
}

/**
 * Suma el biciRating de los miembros de un clan.
 *
 * La plantilla sale de `clanes/{id}.miembros`, que es lo que el lider gestiona y
 * lo que las reglas protegen. ANTES salia de consultar `usuarios` por su campo
 * `clanId`, y ese campo lo escribe cada usuario en su propio documento: bastaba
 * con ponerselo a mano para sumarle puntos a un clan ajeno con cuentas nuevas
 * (#29). Las reglas ya no lo permiten, pero la puntuacion tampoco tiene por que
 * fiarse de un campo que no es la fuente de verdad.
 *
 * De paso es mas barato: `getAll` de N miembros en vez de recorrer `usuarios`
 * entera, que crece con el proyecto mientras que un clan tiene tope (#34).
 */
async function recalcularClan(clanId) {
  if (!clanId) return;

  const clan = await db().doc(`clanes/${clanId}`).get();
  if (!clan.exists) return;

  const miembros = clan.data().miembros || [];
  if (!miembros.length) {
    await db().doc(`clanes/${clanId}`).set({ biciRating: 0, numMiembros: 0 }, { merge: true });
    return;
  }

  const documentos = await db().getAll(...miembros.map((uid) => db().doc(`usuarios/${uid}`)));
  const total = documentos.reduce((suma, d) => suma + (d.exists ? (d.data().biciRating || 0) : 0), 0);

  await db().doc(`clanes/${clanId}`).set(
    { biciRating: total, numMiembros: miembros.length },
    { merge: true }
  );
}

/**
 * Recalcula la influencia de los clanes sobre una estacion.
 *
 * Antes repartia solo por posicion en el ranking de tiempos, o sea que el mapa
 * era un juego exclusivo de velocistas. Ahora pesa presencia, velocidad y
 * kilometros (ver src/territorio.js), y lo acumulado DECAE con los dias.
 *
 * El decaimiento se aplica por diferencia de fechas y no "una vez al dia": asi
 * da igual cuando corra el worker, y si un dia no corre, al siguiente aplica los
 * dos. Un cron que se salta un dia dejaria el territorio congelado sin que nadie
 * lo note.
 */
async function recalcularEstacion(estacionId, viajesPrecargados = null, usuariosPrecargados = null) {
  const viajes = viajesPrecargados
    || (await db().collection('tiempos_viaje').where('verificado', '==', true).get()).docs.map((d) => d.data());
  const usuarios = usuariosPrecargados
    || (await db().collection('usuarios').get()).docs.map((d) => ({ uid: d.id, ...d.data() }));

  const clanPorUid = new Map(usuarios.map((u) => [u.uid, u.clanId || null]));
  const objetivo = String(estacionId);
  const hoy = territorio.dia();

  const ref = db().doc(`estaciones_stats/${objetivo}`);
  const previo = await ref.get();
  const datos = previo.exists ? previo.data() : {};

  // 1. Lo acumulado pierde fuelle desde la ultima vez.
  const acumuladoDecaido = territorio.decaer(
    datos.acumulado || {},
    datos.ultimoDecaimiento || hoy,
    hoy);

  // 2. Lo que aporta la actividad actual.
  const nuevo = territorio.influenciaDelPeriodo(objetivo, viajes, clanPorUid);

  // 3. Reparto y quien controla.
  const reparto = territorio.repartir(acumuladoDecaido, nuevo);

  await ref.set({
    estacionId: objetivo,
    acumulado: reparto.acumulado,
    cuota: reparto.cuota,
    clanDominante: reparto.dominante,
    lider: reparto.lider,
    enDisputa: reparto.enDisputa,
    ultimoDecaimiento: hoy,
    actualizado: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return reparto;
}

/**
 * Recalcula el dominio de varias estaciones de una tacada.
 *
 * Antes esto vivia dentro de `recalcularTrasCambio`, que se llamaba POR CADA
 * VIAJE APROBADO y leia `tiempos_viaje` y `usuarios` enteros cada vez. Con
 * 15.000 viajes acumulados eran 15.464 lecturas por viaje: treinta y tres
 * aprobaciones agotaban la cuota diaria del proyecto entero, y no dependia de
 * que nadie mirase la web — bastaba con que la gente subiera viajes
 * (docs/COSTE.md).
 *
 * Ahora es el mismo patron que los agregados (#36): el worker acumula las
 * estaciones tocadas durante la tanda y las recalcula UNA vez al final, con la
 * carga que ya tiene en la mano. Recalcular la misma estacion diez veces en una
 * pasada daba diez veces el mismo resultado.
 *
 * `base` es opcional: si no viene, se lee aqui.
 */
async function recalcularEstaciones(estacionIds, base = null) {
  const unicas = [...new Set([...estacionIds].filter(Boolean).map(String))];
  if (!unicas.length) return 0;

  const { viajes, usuarios } = base || await cargarEstaciones(unicas);

  for (const estacionId of unicas) {
    await recalcularEstacion(estacionId, viajes, usuarios);
  }
  return unicas.length;
}

/**
 * Las rutas que tienen algun viaje verificado, del indice que deja el agregado.
 *
 * Devuelve `null` — no una lista vacia — si el indice todavia no existe. La
 * diferencia importa: "no lo se" obliga a leer los viajes enteros, mientras que
 * "no hay ninguna" borraria el territorio del mapa.
 */
async function rutasConViajes() {
  try {
    const doc = await db().doc('agregados/rutas').get();
    if (!doc.exists) return null;
    const rutas = doc.data().rutas;
    return Array.isArray(rutas) && rutas.length ? rutas : null;
  } catch {
    return null;
  }
}

/**
 * Lo que hace falta para recalcular el dominio de UNAS estaciones concretas.
 *
 * La influencia sobre una estacion sale de los viajes de las rutas que la tocan,
 * y de ninguna otra (src/territorio.js). Asi que no hacen falta los 15.000
 * viajes: bastan los de esas rutas, que el indice de `agregados/rutas` sabe
 * cuales son sin tener que recorrer nada.
 *
 * Es el camino barato; si el indice no esta, se cae al caro y se leen todos. Ese
 * respaldo no es decorativo: con la lista vacia la influencia saldria a cero y
 * el mapa se quedaria sin dueños de un dia para otro.
 */
async function cargarEstaciones(estacionIds) {
  const indice = await rutasConViajes();
  if (!indice) return cargarBase();

  const objetivo = new Set(estacionIds.map(String));
  const rutas = indice.filter((ruta) => estacionesDe(ruta).some((e) => objetivo.has(e)));

  const [viajes, usuariosSnap] = await Promise.all([
    viajesDeRutas(rutas),
    db().collection('usuarios').get(),
  ]);

  return { viajes, usuarios: usuariosSnap.docs.map((d) => ({ uid: d.id, ...d.data() })) };
}

/** Las dos estaciones de una ruta, para acumularlas. */
function estacionesDe(ruta) {
  const partes = String(ruta || '').split('-');
  return partes.length === 2 ? partes : [];
}

/**
 * Recalculo completo tras aprobar o eliminar un viaje.
 *
 * Se conserva para quien necesite el efecto entero de una sola llamada, pero el
 * worker NO la usa en el bucle: ahi separa los puntos de la ruta — que si hay
 * que rehacer viaje a viaje, porque cambian la clasificacion — del dominio de
 * las estaciones, que se acumula y se hace una vez al final.
 */
async function recalcularTrasCambio(ruta, base = null) {
  await recalcularRuta(ruta);
  await recalcularEstaciones(estacionesDe(ruta), base);
}

/**
 * Reconstruye los agregados que lee el navegador.
 *
 * Se llama UNA VEZ al final de la tanda, no por viaje: leer todos los viajes y
 * todos los usuarios es la operacion mas cara del worker, y repetirla por cada
 * viaje aprobado es como se agota la cuota diaria (#36).
 */
/**
 * Lee de una vez las dos colecciones grandes.
 *
 * Existe para que no se lean dos veces en la misma pasada. `reconstruirAgregados`
 * y el resumen de metricas necesitan las mismas dos, y cuando coinciden — que es
 * justo cuando ha habido movimiento — cargarlas por separado costaba el doble
 * (#34). Con los datos de hoy son 1.200 lecturas evitadas cada vez que se
 * juntan.
 */
async function cargarBase() {
  const [viajesSnap, usuariosSnap] = await Promise.all([
    db().collection('tiempos_viaje').where('verificado', '==', true).get(),
    db().collection('usuarios').get(),
  ]);

  return {
    viajes: viajesSnap.docs.map((d) => d.data()),
    usuarios: usuariosSnap.docs.map((d) => ({ uid: d.id, ...d.data() })),
  };
}

/**
 * Los viajes verificados de unas rutas concretas.
 *
 * Una consulta por ruta, cada una acotada por el indice `ruta + verificado`. Con
 * 15.000 viajes repartidos en 600 rutas son unas decenas de lecturas por ruta,
 * frente a los 15.000 de leerlas todas.
 */
async function viajesDeRutas(rutas) {
  const unicas = [...new Set([...rutas].filter(Boolean).map(String))];
  if (!unicas.length) return [];

  const tandas = await Promise.all(unicas.map((ruta) => db().collection('tiempos_viaje')
    .where('ruta', '==', ruta)
    .where('verificado', '==', true)
    .get()));

  return tandas.flatMap((snap) => snap.docs.map((d) => d.data()));
}

/**
 * Cuantos viajes verificados hay, sin leerlos.
 *
 * La consulta de agregacion cobra una lectura por cada 1.000 documentos
 * contados: 15 en vez de 15.000. Solo se usa para el numero de la portada, asi
 * que si fallara — es una consulta que necesita indice — no vale la pena tumbar
 * la reconstruccion entera por ella.
 */
async function contarViajesVerificados() {
  try {
    const conteo = await db().collection('tiempos_viaje')
      .where('verificado', '==', true)
      .count()
      .get();
    return conteo.data().count;
  } catch {
    return null;
  }
}

/**
 * Reconstruye los agregados que lee el navegador.
 *
 * Tres caminos, de mas barato a mas caro:
 *
 * 1. `base` viene dada — alguien ya ha leido usuarios y viajes en esta pasada
 *    (el recalculo de estaciones, el resumen de metricas). Se aprovecha y sale
 *    gratis, y ademas es COMPLETA: se rehacen todas las rutas, que es lo que
 *    limpia el agregado de una ruta que se haya quedado sin viajes.
 * 2. `rutas` trae las que se han movido y no hay base. Modo parcial: se leen
 *    usuarios, los viajes de ESAS rutas y poco mas.
 * 3. Ni una cosa ni otra: se lee todo, como antes.
 *
 * `rutas` no se usa cuando hay `base` a proposito: teniendo los viajes enteros
 * en la mano, hacer la reconstruccion parcial no ahorra nada y pierde la
 * limpieza de las rutas vacias.
 */
async function reconstruirAgregados(base = null, rutas = null) {
  // Basta con que quien llama diga QUE rutas se han movido, aunque sean cero:
  // una pasada que solo ha rechazado viajes, o en la que solo ha cambiado un
  // clan, no mueve ninguna ruta y aun asi hay que rehacer las clasificaciones de
  // pilotos y clanes — que salen de `usuarios` y `clanes`, no de los viajes.
  const parcial = !base && rutas !== null && rutas !== undefined;

  const [clanesSnap, estacionesSnap] = await Promise.all([
    db().collection('clanes').get(),
    db().collection('estaciones_stats').get(),
  ]);

  const comunes = {
    clanes: clanesSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    estaciones: new Map(estacionesSnap.docs.map((d) => [d.id, d.data()])),
  };

  if (!parcial) {
    const { viajes, usuarios } = base || await cargarBase();
    return agregados.reconstruir({ ...comunes, viajes, usuarios });
  }

  const pedidas = [...new Set([...rutas].filter(Boolean).map(String))];

  const [usuariosSnap, viajes, contados, indice, portada] = await Promise.all([
    db().collection('usuarios').get(),
    viajesDeRutas(pedidas),
    contarViajesVerificados(),
    db().doc('agregados/rutas').get(),
    db().doc('agregados/portada').get(),
  ]);

  // Si el conteo falla se conserva el numero anterior. Lo que NO se puede hacer
  // es dejar que caiga en `viajes.length`, que aqui son solo los de las rutas
  // tocadas: la portada pasaria de "1.022 viajes" a "40".
  const totalViajes = contados !== null
    ? contados
    : (portada.exists ? (portada.data().viajes || 0) : 0);

  return agregados.reconstruir({
    ...comunes,
    viajes,
    usuarios: usuariosSnap.docs.map((d) => ({ uid: d.id, ...d.data() })),
    parcial: true,
    rutasPrevias: indice.exists ? (indice.data().rutas || []) : [],
    rutasRehechas: pedidas,
    totalViajes,
  });
}

module.exports = {
  calcularPuntosViaje,
  recalcularRuta,
  recalcularClan,
  recalcularEstacion,
  recalcularTrasCambio,
  recalcularEstaciones,
  estacionesDe,
  reconstruirAgregados,
  cargarBase,
  cargarEstaciones,
  rutasConViajes,
  viajesDeRutas,
  contarViajesVerificados,
  puntosPorPosicion,
  multiplicadorRuta,
  escribirEnLotes,
};
