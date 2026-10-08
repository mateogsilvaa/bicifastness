'use strict';

/**
 * El lanzamiento (1 de noviembre): la web empieza de cero.
 *
 * Todo lo de antes fue la fase de pruebas, la "primera tanda". Se conserva —
 * cada piloto sigue viendo sus viajes en el historial, aparte— pero no cuenta
 * para nada:
 *
 *   - los viajes de antes del lanzamiento quedan con `fase: 'beta'` y, los que
 *     estaban aprobados, con `verificado: false`. Como todo lo que puntua lee
 *     solo viajes verificados, salen de rankings, rutas y territorio sin tocar
 *     ninguna consulta
 *   - los clanes desaparecen, y con ellos su agregado y el territorio
 *   - los contadores de cada piloto vuelven a cero: puntos, kilometros, racha,
 *     escudos, insignias y division (empieza sin clasificar)
 *
 * Una sola vez: `config/lanzamiento` guarda que ya se hizo, asi que el cron y
 * una ejecucion a mano no lo repiten. Y simula por defecto.
 */

const admin = require('firebase-admin');
const { db } = require('./db');
const { LANZAMIENTO } = require('./divisiones');
const { diaMadrid } = require('./util');
const { RACHA } = require('./config');

const MARCA = () => db().doc('config/lanzamiento');

/** ¿Es un viaje de la primera tanda, ya pasado el lanzamiento? */
function esPrimeraTanda(viaje, hoy = diaMadrid()) {
  return hoy >= LANZAMIENTO && String(viaje?.fechaViaje || '') < LANZAMIENTO;
}

/** Lo que vuelve a cero en cada piloto. */
function contadoresACero() {
  const borrar = admin.firestore.FieldValue.delete();
  return {
    biciRating: 0,
    viajesVerificados: 0,
    viajesSinPuntos: 0,
    puntosPorRuta: {},
    metrosTotales: 0,
    segundosTotales: 0,
    puntosTemporada: 0,
    puntosLiga: 0,
    racha: 0,
    mejorRacha: 0,
    escudos: 0,
    diasHastaEscudo: RACHA.DIAS_POR_ESCUDO,
    ultimoDiaActivo: null,
    misiones: borrar,
    misionesCompletadas: 0,
    logros: [],
    division: borrar,
    grupo: borrar,
    grupoDesde: borrar,
    clanId: null,
  };
}

async function enLotes(refs, operacion) {
  for (let i = 0; i < refs.length; i += 400) {
    const lote = db().batch();
    for (const ref of refs.slice(i, i + 400)) operacion(lote, ref);
    await lote.commit();
  }
}

/**
 * @param {{simular?: boolean, forzar?: boolean}} opciones
 *   `forzar` lo deja correr antes del dia (solo a mano y sabiendo lo que se hace).
 */
async function lanzar({ simular = true, forzar = false } = {}) {
  const hoy = diaMadrid();
  if (hoy < LANZAMIENTO && !forzar) {
    return { hecho: false, motivo: `Hoy es ${hoy}; el lanzamiento es el ${LANZAMIENTO}.` };
  }
  const marca = await MARCA().get();
  if (marca.exists && marca.data().hecho) {
    return { hecho: false, motivo: 'Ya se hizo.', yaHecho: true };
  }

  const [viajes, clanes, agregadosClan, estaciones, usuarios] = await Promise.all([
    db().collection('tiempos_viaje').where('fechaViaje', '<', LANZAMIENTO).get(),
    db().collection('clanes').get(),
    db().collection('agregados')
      .where(admin.firestore.FieldPath.documentId(), '>=', 'clan-')
      .where(admin.firestore.FieldPath.documentId(), '<', 'clan.')
      .get(),
    db().collection('estaciones_stats').get(),
    db().collection('usuarios').get(),
  ]);

  const resumen = {
    viajes: viajes.size,
    clanes: clanes.size,
    agregadosClan: agregadosClan.size,
    estaciones: estaciones.size,
    usuarios: usuarios.size,
  };
  if (simular) return { hecho: false, simulado: true, ...resumen };

  // Los viajes primero: si algo falla despues, al menos ya no puntuan.
  await enLotes(viajes.docs.map((d) => d.ref), (lote, ref) => lote.update(ref, {
    fase: 'beta',
    verificado: false,
    // Sin esto, `aplicarDecisionesManuales` veria un viaje premiado que deja
    // de estar verificado y "devolveria" sus puntos a contadores ya a cero.
    premiado: false,
    recalculoPendiente: admin.firestore.FieldValue.delete(),
  }));

  await enLotes([...clanes.docs, ...agregadosClan.docs, ...estaciones.docs].map((d) => d.ref),
    (lote, ref) => lote.delete(ref));

  const cero = contadoresACero();
  await enLotes(usuarios.docs.map((d) => d.ref), (lote, ref) => lote.update(ref, cero));

  await MARCA().set({
    hecho: true,
    dia: hoy,
    ...resumen,
    en: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { hecho: true, ...resumen };
}

module.exports = { lanzar, esPrimeraTanda, contadoresACero };
