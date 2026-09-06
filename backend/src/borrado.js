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
 *   - La auditoria de cada viaje suyo (`auditorias/{viajeId}`), que lleva
 *     dentro lo que se leyo en esa captura: estaciones, horas y duracion.
 *   - La reserva de su nombre de piloto, para que quede libre.
 *   - Su contador de escrituras del dia (`cupos/{uid}`).
 *   - Su pertenencia al clan.
 *   - Sus suscripciones a los avisos push, que van dentro del perfil y se
 *     borran con el.
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
 *
 *   - Los REPORTES se conservan y se les quita el uid por los dos lados. Un
 *     historial de moderacion al que se le borran casos deja de servir para lo
 *     que existe, pero tampoco puede seguir apuntando a nadie.
 *
 *   - Lo transitorio se borra entero: su peticion de invitacion, las
 *     invitaciones que hubiera creado y su solicitud de baja de correo. Ninguna
 *     de las tres le sirve ya a nadie, y las tres llevan su uid dentro.
 *
 * SOBRE LO QUE SE OLVIDA. Cada coleccion nueva que guarde un uid hay que
 * anadirla aqui a mano: no hay forma de preguntarle a Firestore "donde aparece
 * esta persona". Por eso hay una prueba de regresion que compara las
 * colecciones que menciona `firestore.rules` con las que toca este fichero, y
 * falla cuando aparece una que nadie ha decidido que hacer con ella.
 */

const admin = require('firebase-admin');

// Firestore se coge de `db.js`, no de `admin` directamente: es lo que permite
// que el contador de cuota (#38) vea TODO lo que hace el backend.
const { db } = require('./db');

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
    // El analisis que vivia dentro del viaje, en los que son de antes de que se
    // mudara a `auditorias`. Lleva lo que se leyo en su captura.
    auditoria: admin.firestore.FieldValue.delete(),
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
  const resumen = {
    uid, viajes: 0, capturas: 0, auditorias: 0, subcolecciones: 0, huellas: 0,
    reportes: 0, invitaciones: 0, correosEncolados: 0,
  };

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
        // Y la auditoria, que lleva dentro lo que se leyo en esa captura: las
        // estaciones, las horas y la duracion de un trayecto suyo. El viaje se
        // anonimiza y se queda; el analisis de su captura no tiene por que.
        lote.delete(db().doc(`auditorias/${doc.id}`));
        resumen.auditorias++;
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

  // --- Reportes: se conservan sin dueño ------------------------------------
  // Por los DOS lados. Quien denuncia y quien es denunciado tienen el mismo
  // derecho, y el caso sigue siendo util para la moderacion sin ninguno de los
  // dos uid.
  for (const campo of ['reportanteUid', 'reportadoUid']) {
    const suyos = await db().collection('reportes').where(campo, '==', uid).get();
    resumen.reportes += suyos.size;

    if (!simular && !suyos.empty) {
      const lote = db().batch();
      for (const doc of suyos.docs) lote.update(doc.ref, { [campo]: null });
      await lote.commit();
    }
  }

  // --- Lo transitorio: se borra entero ------------------------------------
  if (!simular) {
    // Su peticion de entrar en un clan con un codigo. El id ES el uid.
    await db().doc(`usos_invitacion/${uid}`).delete();

    // Su contador de escrituras del dia (#62). El id ES el uid, y lleva dentro
    // cuantas veces ha subido algo hoy: no es gran cosa, pero es suyo y no hay
    // ningun motivo para conservarlo cuando la cuenta ya no existe.
    await db().doc(`cupos/${uid}`).delete();

    // Y los correos que tenia encolados (#65). No llevan su direccion —eso vive
    // en Auth— pero si su uid, y ademas escribirle a quien acaba de borrar su
    // cuenta es justo lo que no se puede hacer.
    //
    // OJO: esta coleccion no tiene bloque en `firestore.rules` porque solo la
    // toca el Admin SDK, asi que la comprobacion que cruza reglas con este
    // fichero NO la ve. Se limpia aqui a mano y esa comprobacion mira ahora
    // tambien las colecciones que solo salen en el codigo.
    const encolados = await db().collection('correos_pendientes')
      .where('uid', '==', uid).get();

    for (const doc of encolados.docs) await doc.ref.delete();
    resumen.correosEncolados = encolados.size;

    // Las invitaciones que hubiera creado. Ademas de llevar su uid, un enlace
    // que sigue funcionando despues de que su autor se haya ido mete gente en
    // un clan en nombre de alguien que ya no esta.
    const suyas = await db().collection('invitaciones').where('creadaPor', '==', uid).get();
    resumen.invitaciones = suyas.size;

    if (!suyas.empty) {
      const lote = db().batch();
      for (const doc of suyas.docs) lote.delete(doc.ref);
      await lote.commit();
    }

    // Su solicitud de baja de correo, si la dejo pendiente. Va indexada por el
    // token, asi que solo se puede encontrar desde el perfil — y el perfil se
    // borra unas lineas mas abajo.
    if (datos?.tokenBaja) {
      await db().doc(`solicitudes_baja/${datos.tokenBaja}`).delete();
    }
  }

  // --- Clan y nombre -------------------------------------------------------
  if (!simular && datos) {
    if (datos.clanId) {
      await db().doc(`clanes/${datos.clanId}`).update({
        miembros: admin.firestore.FieldValue.arrayRemove(uid),
        // Tambien el cargo. Un uid suelto en `oficiales` de un documento que lee
        // cualquiera es un resto que no hace falta, y ademas `elegirSucesor`
        // acabaria buscando a alguien que ya no existe.
        oficiales: admin.firestore.FieldValue.arrayRemove(uid),
        numMiembros: admin.firestore.FieldValue.increment(-1),
      }).catch(() => {});   // el clan puede haberse disuelto
    }

    // Y las solicitudes pendientes en clanes DONDE NO ENTRO. Se queda su uid en
    // la lista de candidatos de un documento publico, y ademas el lider ve para
    // siempre a alguien que ya no puede aceptar.
    const pendientes = await db().collection('clanes')
      .where('solicitudes', 'array-contains', uid)
      .get();

    for (const doc of pendientes.docs) {
      await doc.ref.update({
        solicitudes: admin.firestore.FieldValue.arrayRemove(uid),
      }).catch((error) => {
        // El clan puede haberse disuelto entre la consulta y esto. Cualquier
        // otro motivo deja su uid en un documento publico, asi que se dice: el
        // borrado sigue —los datos gordos ya se han ido— pero no en silencio.
        console.warn(`  no se ha podido sacar su solicitud del clan ${doc.id}:`,
          error.message);
      });
    }
    if (datos.usernameLower) {
      await db().doc(`nombres_usuario/${datos.usernameLower}`).delete();
    }

    // Y se rehace el agregado del clan, que lleva la plantilla con nombres
    // dentro y es PUBLICO. Sacar a alguien de `clanes.miembros` no lo actualiza:
    // hasta la siguiente reconstruccion, el nombre de quien acaba de borrar su
    // cuenta seguiria publicado ahi. Se pide aqui, y no se deja para la pasada
    // periodica, porque "en algun momento" no es un plazo.
    if (datos.clanId) {
      const puntuacion = require('./puntuacion');

      // Este SI puede fallar sin echar atras el borrado: los datos de la
      // persona ya se han ido, y lo que queda es refrescar un agregado que la
      // pasada periodica va a rehacer igual. Pero se dice, porque mientras
      // tanto su nombre sigue publicado en la plantilla del clan.
      await puntuacion.recalcularClan(datos.clanId).catch((error) => {
        console.warn(`  el agregado del clan ${datos.clanId} no se ha podido rehacer:`,
          error.message);
      });
    }
  }

  // --- El perfil y la cuenta ----------------------------------------------
  if (!simular) {
    await perfilRef.delete();

    // Al final, y a prueba de que ya no exista: si el borrado se reintenta,
    // aqui es donde falla la segunda vez.
    await admin.auth().deleteUser(uid).catch((error) => {
      if (error.code !== 'auth/user-not-found') throw error;
    });

    await db().doc(`solicitudes_borrado/${uid}`).delete();
  }

  return resumen;
}

module.exports = { ejecutar, anonimizarViaje, borrarSubcoleccion, SUBCOLECCIONES };
