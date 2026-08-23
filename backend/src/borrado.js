'use strict';

/**
 * Borrado de cuenta (RGPD art. 17).
 *
 * Esto NO existia. La politica de privacidad prometia el derecho de supresion,
 * la pantalla de perfil dejaba pedirlo y las reglas admitian la solicitud, pero
 * `solicitudes_borrado` no la procesaba nadie: las peticiones se quedaban ahi
 * para siempre. Prometer un derecho y no ejecutarlo es peor que no ofrecerlo.
 *
 * Va en el worker porque borrar el usuario de Firebase Auth exige el Admin SDK,
 * que en el navegador no existe por diseño.
 *
 * QUE SE BORRA Y QUE NO, que es la parte que hay que pensar:
 *
 *   - La cuenta de Auth, el perfil y TODAS sus subcolecciones (las temporadas
 *     archivadas). Firestore NO borra subcolecciones al borrar el documento
 *     padre: quedarian huerfanas e invisibles, y siguen siendo datos de esa
 *     persona.
 *   - Las capturas de sus viajes. Son fotos suyas.
 *   - La reserva de su nombre de piloto, para que quede libre.
 *   - Su pertenencia al clan.
 *
 *   - Los tiempos verificados NO se borran: se ANONIMIZAN. Es lo que dice la
 *     politica de privacidad, y tiene sentido — un ranking historico al que se
 *     le van borrando marcas deja de cuadrar —, pero solo vale si la
 *     anonimizacion es de verdad: fuera uid, fuera nombre, y fuera cualquier
 *     campo por el que se pueda volver a atar a alguien.
 *
 *   - Las huellas de captura se quedan. No llevan datos personales — son un
 *     hash — y son lo unico que impide que una imagen ya usada vuelva a
 *     colarse. Se les quita el uid.
 */

const admin = require('firebase-admin');

const db = () => admin.firestore();

/** Subcolecciones que cuelgan de un usuario y hay que borrar a mano. */
const SUBCOLECCIONES = ['temporadas'];

/**
 * Deja un viaje sin dueño identificable.
 *
 * Se ponen a `null` en vez de borrarse los campos porque el ranking los lee: un
 * documento sin `uid` haria fallar el recalculo, y arreglarlo a base de
 * comprobaciones repartidas es peor que dejar el hueco explicito.
 */
function anonimizarViaje() {
  return {
    uid: null,
    username: 'Piloto retirado',
    anonimizado: true,
    // Lo que quedaria de rastro por otra via.
    capturaId: admin.firestore.FieldValue.delete(),
    alegacion: admin.firestore.FieldValue.delete(),
    correcciones: admin.firestore.FieldValue.delete(),
  };
}

/** Borra una subcoleccion entera, en tandas. */
async function borrarSubcoleccion(ruta) {
  let borrados = 0;
  for (;;) {
    const snap = await db().collection(ruta).limit(400).get();
    if (snap.empty) break;

    const lote = db().batch();
    for (const doc of snap.docs) lote.delete(doc.ref);
    await lote.commit();
    borrados += snap.size;
  }
  return borrados;
}

/**
 * Ejecuta una solicitud de borrado.
 *
 * Es idempotente a proposito: si el proceso muere a mitad, volver a lanzarlo
 * termina el trabajo en vez de fallar porque algo ya no esta.
 *
 * El ORDEN importa. La cuenta de Auth se borra al final: mientras exista, la
 * persona puede volver a entrar y ver que su borrado esta en curso. Si se
 * borrara primero y el resto fallara, se quedaria sin cuenta y con sus datos
 * dentro, que es el peor de los dos fallos posibles.
 */
async function ejecutar(uid, { simular = false } = {}) {
  const resumen = { uid, viajes: 0, capturas: 0, subcolecciones: 0, huellas: 0 };

  const perfilRef = db().doc(`usuarios/${uid}`);
  const perfil = await perfilRef.get();
  const datos = perfil.exists ? perfil.data() : null;

  // --- Viajes: se anonimizan, no se borran --------------------------------
  const viajes = await db().collection('tiempos_viaje').where('uid', '==', uid).get();
  resumen.viajes = viajes.size;

  if (!simular) {
    for (let i = 0; i < viajes.docs.length; i += 200) {
      const lote = db().batch();
      for (const doc of viajes.docs.slice(i, i + 200)) {
        lote.update(doc.ref, anonimizarViaje());
        // La captura si se borra: es una foto suya.
        lote.delete(db().doc(`capturas/${doc.id}`));
        resumen.capturas++;
      }
      await lote.commit();
    }
  }

  // --- Huellas: se les quita el uid, el hash se queda ----------------------
  const huellas = await db().collection('huellas_captura').where('uid', '==', uid).get();
  resumen.huellas = huellas.size;

  if (!simular && !huellas.empty) {
    for (let i = 0; i < huellas.docs.length; i += 400) {
      const lote = db().batch();
      for (const doc of huellas.docs.slice(i, i + 400)) {
        lote.update(doc.ref, { uid: null });
      }
      await lote.commit();
    }
  }

  // --- Subcolecciones del perfil ------------------------------------------
  // Firestore no las borra con el documento padre. Sin esto, las temporadas
  // archivadas quedan huerfanas: invisibles y sin borrar.
  if (!simular) {
    for (const nombre of SUBCOLECCIONES) {
      resumen.subcolecciones += await borrarSubcoleccion(`usuarios/${uid}/${nombre}`);
    }
  }

  // --- Clan y nombre -------------------------------------------------------
  if (!simular && datos) {
    if (datos.clanId) {
      await db().doc(`clanes/${datos.clanId}`).update({
        miembros: admin.firestore.FieldValue.arrayRemove(uid),
        numMiembros: admin.firestore.FieldValue.increment(-1),
      }).catch(() => {});   // el clan puede haberse disuelto
    }
    if (datos.usernameLower) {
      await db().doc(`nombres_usuario/${datos.usernameLower}`).delete().catch(() => {});
    }
  }

  // --- El perfil y la cuenta ----------------------------------------------
  if (!simular) {
    await perfilRef.delete().catch(() => {});

    // Al final, y a prueba de que ya no exista: si el borrado se reintenta,
    // aqui es donde falla la segunda vez.
    await admin.auth().deleteUser(uid).catch((error) => {
      if (error.code !== 'auth/user-not-found') throw error;
    });

    await db().doc(`solicitudes_borrado/${uid}`).delete().catch(() => {});
  }

  return resumen;
}

module.exports = { ejecutar, anonimizarViaje, borrarSubcoleccion, SUBCOLECCIONES };
