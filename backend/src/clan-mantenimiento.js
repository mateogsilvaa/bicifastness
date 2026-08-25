'use strict';

/**
 * Lo que la gestion de clanes no puede hacer desde el navegador (#29).
 *
 * Tres cosas, y las tres por el mismo motivo: nadie puede escribir en el
 * documento de otra persona.
 *
 *   1. LIMPIAR `clanId` HUERFANOS. Al expulsar a alguien, o al disolver un
 *      clan, solo se toca el documento del clan: el `clanId` del afectado sigue
 *      apuntando a un clan que ya no le lista, y a el no se le va a pedir que
 *      colabore en su propia expulsion. No afecta a la puntuacion — el worker
 *      suma desde `miembros` — pero su perfil dice que sigue en un clan del que
 *      ya no es.
 *
 *   2. RESOLVER INVITACIONES. El contador de usos lo lleva el worker: si lo
 *      llevara el cliente, un codigo de un solo uso valdria para todo el que lo
 *      tenga.
 *
 *   3. RESCATAR CLANES SIN LIDER. Un clan cuyo lider desaparece se queda sin
 *      nadie que pueda aceptar, expulsar ni disolver: bloqueado para siempre, y
 *      con gente dentro.
 */

const admin = require('firebase-admin');
const { db } = require('./db');

/** Tras cuantos dias sin aparecer se le retira el mando a un lider. */
const DIAS_LIDER_INACTIVO = 60;

/** Tope de miembros. El mismo que aplican las reglas. */
const MAX_MIEMBROS = 50;


/**
 * Pone a null el `clanId` de quien ya no esta en la plantilla de su clan.
 *
 * Se mira solo a los usuarios que DICEN tener clan, no a todos. La consulta es
 * la que es porque la alternativa — recorrer `usuarios` entera — crece con el
 * proyecto y esto corre en cada pasada (#34).
 */
async function limpiarHuerfanos({ simular = false, tope = 200 } = {}) {
  const conClan = await db().collection('usuarios')
    .where('clanId', '!=', null)
    .limit(tope)
    .get();

  if (conClan.empty) return 0;

  // Un `get` por clan distinto, no uno por usuario: en un proyecto con 20
  // clanes y 200 usuarios eso son 20 lecturas en vez de 200.
  const clanes = new Map();
  for (const doc of conClan.docs) {
    const clanId = doc.data().clanId;
    if (clanId && !clanes.has(clanId)) clanes.set(clanId, null);
  }

  for (const clanId of clanes.keys()) {
    const snap = await db().doc(`clanes/${clanId}`).get();
    clanes.set(clanId, snap.exists ? (snap.data().miembros || []) : null);
  }

  const huerfanos = conClan.docs.filter((doc) => {
    const miembros = clanes.get(doc.data().clanId);
    // `null` significa que el clan ya no existe: tambien es huerfano.
    return miembros === null || !miembros.includes(doc.id);
  });

  if (!huerfanos.length || simular) return huerfanos.length;

  for (let i = 0; i < huerfanos.length; i += 400) {
    const lote = db().batch();
    for (const doc of huerfanos.slice(i, i + 400)) lote.update(doc.ref, { clanId: null });
    await lote.commit();
  }

  return huerfanos.length;
}

/**
 * ¿Vale esta invitacion?
 *
 * Pura, para poder probar la caducidad y los usos sin montar nada. Devuelve el
 * motivo cuando no vale: un "no puedes entrar" sin explicacion es como se
 * acumulan los mensajes de gente preguntando por que.
 */
function invitacionValida(invitacion, ahora = new Date()) {
  if (!invitacion) return { vale: false, motivo: 'no existe' };

  const caduca = invitacion.caduca?.toDate?.() || (invitacion.caduca ? new Date(invitacion.caduca) : null);
  if (caduca && caduca <= ahora) return { vale: false, motivo: 'caducada' };

  const usos = Number(invitacion.usos) || 0;
  const maximo = Number(invitacion.maxUsos) || 1;
  if (usos >= maximo) return { vale: false, motivo: 'agotada' };

  return { vale: true, usosRestantes: maximo - usos };
}

/**
 * Aplica una invitacion: mete al candidato en el clan y descuenta un uso.
 *
 * Idempotente: si ya esta dentro no vuelve a descontar. El worker reintenta, y
 * gastar un uso por cada reintento vaciaria un codigo sin que nadie entrara.
 */
async function aplicarInvitacion(codigo, uid, { simular = false, ahora = new Date() } = {}) {
  const refInvitacion = db().doc(`invitaciones/${codigo}`);
  const snap = await refInvitacion.get();

  const estado = invitacionValida(snap.exists ? snap.data() : null, ahora);
  if (!estado.vale) return { entrado: false, motivo: estado.motivo };

  const { clanId } = snap.data();
  const refClan = db().doc(`clanes/${clanId}`);
  const clan = await refClan.get();

  if (!clan.exists) return { entrado: false, motivo: 'el clan ya no existe' };

  const miembros = clan.data().miembros || [];
  if (miembros.includes(uid)) return { entrado: false, motivo: 'ya estaba dentro' };
  if (miembros.length >= MAX_MIEMBROS) return { entrado: false, motivo: 'el clan esta lleno' };

  if (simular) return { entrado: true, clanId, simulado: true };

  const lote = db().batch();
  lote.update(refClan, {
    miembros: admin.firestore.FieldValue.arrayUnion(uid),
    solicitudes: admin.firestore.FieldValue.arrayRemove(uid),
    numMiembros: miembros.length + 1,
  });
  lote.update(refInvitacion, { usos: admin.firestore.FieldValue.increment(1) });
  lote.update(db().doc(`usuarios/${uid}`), { clanId });
  await lote.commit();

  return { entrado: true, clanId };
}

/**
 * Decide a quien pasa el mando de un clan cuyo lider lleva desaparecido.
 *
 * Al oficial mas activo; si no hay oficiales, al miembro mas activo. "Activo"
 * es el ultimo dia con trayecto, que es lo que ya tenemos y no cuesta una
 * lectura extra.
 *
 * Si no queda nadie con actividad, devuelve null y el clan se queda como esta:
 * dar el mando al azar no arregla un clan que ya no juega nadie.
 */
function elegirSucesor(clan, miembros, ahora = new Date(), diasInactivo = DIAS_LIDER_INACTIVO) {
  // `ultimoDiaActivo` es la medianoche del dia en Madrid EN MILISEGUNDOS, que es
  // lo que escribe `rachas.diaDe`. Antes esto lo comparaba como texto contra un
  // 'YYYY-MM-DD', y '1756...' nunca es mayor que '2026-...': `activo` daba
  // siempre false, no habia nunca candidatos y ningun clan sin lider se
  // rescataba jamas. Las pruebas no lo veian porque le pasaban fechas de texto,
  // que es lo que produccion no guarda.
  const limite = ahora.getTime() - diasInactivo * 86400000;

  const activo = (m) => Number(m.ultimoDiaActivo) > limite;
  const porActividad = (a, b) => (Number(b.ultimoDiaActivo) || 0) - (Number(a.ultimoDiaActivo) || 0);

  const lider = miembros.find((m) => m.uid === clan.lider);
  // Si el lider sigue apareciendo, no hay nada que rescatar.
  if (lider && activo(lider)) return null;

  const oficiales = (clan.oficiales || [])
    .map((uid) => miembros.find((m) => m.uid === uid))
    .filter((m) => m && activo(m))
    .sort(porActividad);

  if (oficiales.length) return oficiales[0].uid;

  const resto = miembros
    .filter((m) => m.uid !== clan.lider && activo(m))
    .sort(porActividad);

  return resto.length ? resto[0].uid : null;
}

/**
 * Rescata los clanes cuyo lider lleva desaparecido (#29).
 *
 * `elegirSucesor` decidia a quien pasarle el mando, pero no la llamaba nadie: un
 * clan cuyo lider desaparece se quedaba sin nadie que pudiera aceptar, expulsar
 * ni disolver. Bloqueado para siempre, y con gente dentro.
 *
 * Se lee `clanes` entera —son pocas decenas— y los usuarios que dicen tener
 * clan, que es la misma consulta acotada que usa `limpiarHuerfanos`. Corre una
 * vez al dia, no en cada pasada: un lider no desaparece en cinco minutos.
 */
async function rescatarSinLider({ simular = false, ahora = new Date(), tope = 500 } = {}) {
  const [clanesSnap, conClan] = await Promise.all([
    db().collection('clanes').get(),
    db().collection('usuarios').where('clanId', '!=', null).limit(tope).get(),
  ]);

  if (clanesSnap.empty) return 0;

  const porClan = new Map();
  for (const doc of conClan.docs) {
    const { clanId, ultimoDiaActivo } = doc.data();
    if (!clanId) continue;
    if (!porClan.has(clanId)) porClan.set(clanId, []);
    porClan.get(clanId).push({ uid: doc.id, ultimoDiaActivo });
  }

  let rescatados = 0;

  for (const doc of clanesSnap.docs) {
    const clan = doc.data();
    const miembros = porClan.get(doc.id) || [];
    if (!miembros.length) continue;

    const sucesor = elegirSucesor(clan, miembros, ahora);
    if (!sucesor || sucesor === clan.lider) continue;

    if (!simular) {
      await doc.ref.update({
        lider: sucesor,
        // Quien hereda el mando deja de ser oficial: ya no hay cargo por encima
        // del que ocupar, y dejarlo en las dos listas confunde a las reglas.
        oficiales: admin.firestore.FieldValue.arrayRemove(sucesor),
        liderazgoHeredado: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    console.log(`  clan ${doc.id}: el mando pasa a ${sucesor} (lider inactivo)`);
    rescatados++;
  }

  return rescatados;
}

module.exports = {
  limpiarHuerfanos,
  rescatarSinLider,
  invitacionValida,
  aplicarInvitacion,
  elegirSucesor,
  DIAS_LIDER_INACTIVO,
  MAX_MIEMBROS,
};
