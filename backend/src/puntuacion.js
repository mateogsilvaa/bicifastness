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
const { PUNTOS } = require('./config');

const db = () => admin.firestore();

/** Puntos que da una posicion (0-indexada) en el ranking de una ruta. */
function puntosPorPosicion(indice) {
  return PUNTOS.POR_POSICION[indice] ?? 0;
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

/** Suma el biciRating de los miembros de un clan. */
async function recalcularClan(clanId) {
  if (!clanId) return;
  const miembros = await db().collection('usuarios').where('clanId', '==', clanId).get();
  const total = miembros.docs.reduce((suma, d) => suma + (d.data().biciRating || 0), 0);
  await db().doc(`clanes/${clanId}`).set(
    { biciRating: total, numMiembros: miembros.size },
    { merge: true }
  );
}

/**
 * Recalcula que clan domina una estacion.
 * Cada ruta que toca la estacion reparte puntos entre los 10 mejores tiempos;
 * el clan de cada piloto se los lleva.
 */
async function recalcularEstacion(estacionId, viajesPrecargados = null, usuariosPrecargados = null) {
  const viajes = viajesPrecargados
    || (await db().collection('tiempos_viaje').where('verificado', '==', true).get()).docs.map((d) => d.data());
  const usuarios = usuariosPrecargados
    || (await db().collection('usuarios').get()).docs.map((d) => ({ uid: d.id, ...d.data() }));

  const clanPorUid = new Map(usuarios.map((u) => [u.uid, u.clanId || null]));
  const objetivo = String(estacionId);

  // Agrupamos por ruta los viajes que tocan esta estacion.
  const porRuta = new Map();
  for (const viaje of viajes) {
    if (!viaje.ruta) continue;
    const [origen, destino] = viaje.ruta.split('-');
    if (origen !== objetivo && destino !== objetivo) continue;
    if (!porRuta.has(viaje.ruta)) porRuta.set(viaje.ruta, []);
    porRuta.get(viaje.ruta).push(viaje);
  }

  const puntosClan = {};
  for (const lista of porRuta.values()) {
    // Solo el mejor tiempo de cada piloto compite por el territorio.
    const mejorPorPiloto = new Map();
    for (const v of lista) {
      const previo = mejorPorPiloto.get(v.uid);
      if (!previo || v.tiempoSegundos < previo.tiempoSegundos) mejorPorPiloto.set(v.uid, v);
    }

    const top = [...mejorPorPiloto.values()]
      .sort((a, b) => a.tiempoSegundos - b.tiempoSegundos)
      .slice(0, PUNTOS.ESTACION_POR_POSICION.length);

    top.forEach((viaje, indice) => {
      const clanId = clanPorUid.get(viaje.uid);
      if (!clanId) return;
      puntosClan[clanId] = (puntosClan[clanId] || 0) + PUNTOS.ESTACION_POR_POSICION[indice];
    });
  }

  let dominante = null;
  let maximo = 0;
  let total = 0;
  for (const [clanId, puntos] of Object.entries(puntosClan)) {
    total += puntos;
    if (puntos > maximo) { maximo = puntos; dominante = clanId; }
  }

  await db().doc(`estaciones_stats/${objetivo}`).set({
    estacionId: objetivo,
    clanDominante: dominante,
    totalPuntos: total,
    detalle: puntosClan,
    actualizado: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

/**
 * Recalculo completo tras aprobar o eliminar un viaje: puntos de la ruta y
 * dominio de las dos estaciones implicadas.
 */
async function recalcularTrasCambio(ruta) {
  await recalcularRuta(ruta);

  const [origen, destino] = ruta.split('-');
  const [viajesSnap, usuariosSnap] = await Promise.all([
    db().collection('tiempos_viaje').where('verificado', '==', true).get(),
    db().collection('usuarios').get(),
  ]);
  const viajes = viajesSnap.docs.map((d) => d.data());
  const usuarios = usuariosSnap.docs.map((d) => ({ uid: d.id, ...d.data() }));

  await recalcularEstacion(origen, viajes, usuarios);
  await recalcularEstacion(destino, viajes, usuarios);
}

module.exports = {
  recalcularRuta,
  recalcularClan,
  recalcularEstacion,
  recalcularTrasCambio,
  puntosPorPosicion,
  escribirEnLotes,
};
