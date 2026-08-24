'use strict';

/**
 * Temporadas mensuales.
 *
 * POR QUE EXISTEN. Sin temporadas, quien llega en el mes seis ve una tabla que
 * no va a alcanzar nunca y se va. Con ellas, cada mes es una carrera nueva y el
 * que se registra hoy compite desde el principio.
 *
 * QUE SE RESETEA Y QUE NO
 *   se resetea    los puntos de la temporada
 *   se conserva   records por tramo, kilometros historicos e insignias
 *
 * Lo conseguido no se borra. Solo vuelve a cero el marcador de la carrera.
 *
 * ESTO ES LA OPERACION MAS PELIGROSA DEL PROYECTO
 *
 * Toca a TODOS los usuarios y pone contadores a cero. Si se ejecuta dos veces,
 * la segunda archivaria ceros encima de lo que archivo la primera y borraria la
 * temporada entera de todo el mundo. Por eso el cierre marca la temporada como
 * cerrada ANTES de tocar a nadie, y comprueba esa marca al entrar.
 *
 * El orden importa y no es negociable:
 *   1. comprobar que no esta cerrada
 *   2. MARCARLA cerrada
 *   3. archivar y resetear
 *
 * Al reves, un corte entre 3 y 2 dejaria la puerta abierta a repetirlo todo.
 */

const admin = require('firebase-admin');

// Firestore se coge de `db.js`, no de `admin` directamente: es lo que permite
// que el contador de cuota (#38) vea TODO lo que hace el backend.
const { db } = require('./db');

/** Identificador de temporada: el mes natural. */
function idTemporada(fecha = new Date()) {
  return `${fecha.getUTCFullYear()}-${String(fecha.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** La temporada anterior a la dada. */
function temporadaAnterior(id) {
  const [anio, mes] = id.split('-').map(Number);
  return mes === 1 ? `${anio - 1}-12` : `${anio}-${String(mes - 1).padStart(2, '0')}`;
}

/**
 * Reparte las insignias de cierre a partir de una clasificacion.
 *
 * Se separa del resto para poder probarla: es la parte con reglas, y el resto
 * es escribir en lotes.
 *
 * @param {Array} clasificacion  ordenada de mas a menos puntos
 * @param {string} temporada
 * @returns {Map<string, string[]>} uid -> insignias
 */
function insigniasDeCierre(clasificacion, temporada) {
  const premios = new Map();
  const dar = (uid, insignia) => {
    if (!uid) return;
    if (!premios.has(uid)) premios.set(uid, []);
    premios.get(uid).push(insignia);
  };

  // Solo puntua quien tiene puntos: dar un podio a quien saco 0 lo vacia de
  // significado, y con pocos pilotos pasaria cada mes.
  const conPuntos = clasificacion.filter((p) => (p.puntos || 0) > 0);

  const podio = ['oro', 'plata', 'bronce'];
  conPuntos.slice(0, 3).forEach((p, i) => dar(p.uid, `temporada-${temporada}-${podio[i]}`));

  // Y el reconocimiento por modo, que es el que hace que no solo gane el mismo
  // perfil de piloto siempre.
  const mejorEn = (campo) => conPuntos
    .filter((p) => (p[campo] || 0) > 0)
    .sort((a, b) => (b[campo] || 0) - (a[campo] || 0))[0];

  const fondista = mejorEn('metros');
  if (fondista) dar(fondista.uid, `temporada-${temporada}-fondo`);

  const constante = mejorEn('mejorRacha');
  if (constante) dar(constante.uid, `temporada-${temporada}-constancia`);

  return premios;
}

/**
 * Cierra una temporada: archiva, reparte insignias y pone a cero.
 *
 * Idempotente. Si ya estaba cerrada devuelve `{ yaCerrada: true }` sin tocar
 * nada, que es lo que permite reintentar el workflow sin miedo.
 */
async function cerrar(temporada, { simular = false } = {}) {
  const refConfig = db().doc(`config/temporadas/cerradas/${temporada}`);

  const marca = await refConfig.get();
  if (marca.exists) {
    return { yaCerrada: true, temporada };
  }

  const usuariosSnap = await db().collection('usuarios').get();
  const usuarios = usuariosSnap.docs.map((d) => ({ uid: d.id, ...d.data() }));

  const clasificacion = usuarios
    .map((u) => ({
      uid: u.uid,
      puntos: u.puntosTemporada || 0,
      metros: u.metrosTotales || 0,
      mejorRacha: u.mejorRacha || 0,
    }))
    .sort((a, b) => b.puntos - a.puntos);

  const premios = insigniasDeCierre(clasificacion, temporada);

  if (simular) {
    return {
      simulado: true,
      temporada,
      usuarios: usuarios.length,
      conPuntos: clasificacion.filter((c) => c.puntos > 0).length,
      insignias: premios.size,
    };
  }

  // PRIMERO la marca. Si el proceso muere a mitad del reseteo, la siguiente
  // ejecucion NO vuelve a archivar: se pierde parte del reseteo, que se arregla
  // solo en cuanto el worker recalcule, pero no se destruye el archivo.
  await refConfig.set({
    cerrada: admin.firestore.FieldValue.serverTimestamp(),
    usuarios: usuarios.length,
  });

  let archivados = 0;

  for (let i = 0; i < usuarios.length; i += 400) {
    const lote = db().batch();

    for (const u of usuarios.slice(i, i + 400)) {
      const posicion = clasificacion.findIndex((c) => c.uid === u.uid) + 1;

      // El archivo va en una subcoleccion del propio usuario: asi su historial
      // se borra con su cuenta, sin tener que ir a buscarlo a otro sitio.
      lote.set(db().doc(`usuarios/${u.uid}/temporadas/${temporada}`), {
        temporada,
        puntos: u.puntosTemporada || 0,
        posicion: (u.puntosTemporada || 0) > 0 ? posicion : null,
        viajes: u.viajesVerificados || 0,
        metros: u.metrosTotales || 0,
        mejorRacha: u.mejorRacha || 0,
        division: u.division || null,
        cerrada: admin.firestore.FieldValue.serverTimestamp(),
      });

      const nuevasInsignias = premios.get(u.uid) || [];

      lote.update(db().doc(`usuarios/${u.uid}`), {
        // Lo unico que se resetea.
        puntosTemporada: 0,
        // Lo conseguido se queda: records, kilometros e insignias.
        logros: admin.firestore.FieldValue.arrayUnion(...nuevasInsignias),
      });

      archivados++;
    }

    await lote.commit();
  }

  return { temporada, archivados, insignias: premios.size };
}

/**
 * Abre la temporada en curso si no lo estaba.
 * Se limita a dejar constancia de cual es: no toca a nadie.
 */
async function abrir(temporada) {
  await db().doc('config/temporada').set({
    actual: temporada,
    desde: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return temporada;
}

module.exports = {
  idTemporada,
  temporadaAnterior,
  insigniasDeCierre,
  cerrar,
  abrir,
};
