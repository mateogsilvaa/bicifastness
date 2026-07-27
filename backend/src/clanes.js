'use strict';

/**
 * Operaciones de clanes.
 *
 * La pagina de clanes hacia 15 escrituras directas a Firestore desde el
 * navegador: crear, aceptar solicitudes, expulsar, disolver... Con las reglas
 * antiguas (`write: if isAuthed()`) cualquiera podia meterse en el clan que
 * quisiera, expulsar a sus miembros o disolverlo. Todo eso vive ahora aqui, en
 * transacciones que comprueban quien manda.
 */

const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const { limpiarTexto } = require('./util');
const { contienePalabrasProhibidas } = require('./badwords');

const db = () => admin.firestore();
const AHORA = () => admin.firestore.FieldValue.serverTimestamp();

const MAX_MIEMBROS = 20;
const DIAS_PENALIZACION = 5;

/** "Los Rayos" -> "los_rayos". Es el id del documento. */
function idDesdeNombre(nombre) {
  return nombre.toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

async function perfilDe(uid) {
  const snap = await db().doc(`usuarios/${uid}`).get();
  if (!snap.exists) throw new HttpsError('failed-precondition', 'Tu perfil no existe.');
  return { ref: snap.ref, ...snap.data() };
}

async function crear(uid, { nombre, color, descripcion }) {
  const perfil = await perfilDe(uid);
  if (perfil.clanId) throw new HttpsError('failed-precondition', 'Ya perteneces a un clan.');

  if (perfil.penalizadoHasta && perfil.penalizadoHasta.toMillis() > Date.now()) {
    throw new HttpsError('failed-precondition',
      `Has disuelto un clan hace poco. Podras crear otro el ${perfil.penalizadoHasta.toDate().toLocaleDateString('es-ES')}.`);
  }

  const nombreLimpio = limpiarTexto(nombre, 28);
  if (nombreLimpio.length < 3) throw new HttpsError('invalid-argument', 'El nombre del clan necesita al menos 3 caracteres.');
  if (!/^[\p{L}\p{N}_\- ]+$/u.test(nombreLimpio)) throw new HttpsError('invalid-argument', 'El nombre del clan tiene caracteres no permitidos.');
  if (contienePalabrasProhibidas(nombreLimpio)) throw new HttpsError('invalid-argument', 'Ese nombre de clan no esta permitido.');

  // Solo colores hexadecimales: cualquier otra cosa acabaria inyectada en un
  // estilo del mapa.
  const colorLimpio = /^#[0-9a-f]{6}$/i.test(String(color)) ? color : '#0071c3';
  const clanId = idDesdeNombre(nombreLimpio);
  if (!clanId) throw new HttpsError('invalid-argument', 'Ese nombre no es valido.');

  await db().runTransaction(async (tx) => {
    const ref = db().doc(`clanes/${clanId}`);
    if ((await tx.get(ref)).exists) {
      throw new HttpsError('already-exists', 'Ya existe un clan con ese nombre.');
    }
    tx.set(ref, {
      clanId,
      nombre: nombreLimpio,
      descripcion: limpiarTexto(descripcion, 160),
      color: colorLimpio,
      lider: uid,
      miembros: [uid],
      solicitudes: [],
      biciRating: perfil.biciRating || 0,
      numMiembros: 1,
      logros: [],
      creado: AHORA(),
    });
    tx.update(perfil.ref, { clanId });
  });

  return { clanId };
}

async function solicitar(uid, { clanId }) {
  const perfil = await perfilDe(uid);
  if (perfil.clanId) throw new HttpsError('failed-precondition', 'Ya perteneces a un clan.');

  await db().runTransaction(async (tx) => {
    const ref = db().doc(`clanes/${clanId}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Ese clan no existe.');

    const clan = snap.data();
    if (clan.miembros.includes(uid)) throw new HttpsError('already-exists', 'Ya eres miembro.');
    if (clan.solicitudes.includes(uid)) throw new HttpsError('already-exists', 'Ya has enviado una solicitud.');
    if (clan.miembros.length >= MAX_MIEMBROS) throw new HttpsError('failed-precondition', 'El clan esta lleno.');

    tx.update(ref, { solicitudes: admin.firestore.FieldValue.arrayUnion(uid) });
  });

  return { ok: true };
}

/** Acepta o rechaza una solicitud. Solo el lider. */
async function responderSolicitud(uid, { clanId, candidatoUid, aceptar }) {
  await db().runTransaction(async (tx) => {
    const ref = db().doc(`clanes/${clanId}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Ese clan no existe.');

    const clan = snap.data();
    if (clan.lider !== uid) throw new HttpsError('permission-denied', 'Solo el lider gestiona las solicitudes.');
    if (!clan.solicitudes.includes(candidatoUid)) throw new HttpsError('not-found', 'Esa solicitud ya no existe.');

    const cambios = { solicitudes: admin.firestore.FieldValue.arrayRemove(candidatoUid) };

    if (aceptar) {
      if (clan.miembros.length >= MAX_MIEMBROS) throw new HttpsError('failed-precondition', 'El clan esta lleno.');
      const candidatoRef = db().doc(`usuarios/${candidatoUid}`);
      const candidato = await tx.get(candidatoRef);
      if (!candidato.exists) throw new HttpsError('not-found', 'Ese piloto ya no existe.');
      if (candidato.data().clanId) throw new HttpsError('failed-precondition', 'Ese piloto ya se ha unido a otro clan.');

      cambios.miembros = admin.firestore.FieldValue.arrayUnion(candidatoUid);
      cambios.numMiembros = clan.miembros.length + 1;
      tx.update(candidatoRef, { clanId });
    }

    tx.update(ref, cambios);
  });

  return { ok: true };
}

/** Expulsa a un miembro. Solo el lider, y no a si mismo. */
async function expulsar(uid, { clanId, miembroUid }) {
  if (uid === miembroUid) throw new HttpsError('invalid-argument', 'Para salirte usa "abandonar clan".');

  await db().runTransaction(async (tx) => {
    const ref = db().doc(`clanes/${clanId}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Ese clan no existe.');
    if (snap.data().lider !== uid) throw new HttpsError('permission-denied', 'Solo el lider puede expulsar.');

    tx.update(ref, {
      miembros: admin.firestore.FieldValue.arrayRemove(miembroUid),
      numMiembros: Math.max(0, snap.data().miembros.length - 1),
    });
    tx.update(db().doc(`usuarios/${miembroUid}`), { clanId: null });
  });

  return { ok: true };
}

async function abandonar(uid) {
  const perfil = await perfilDe(uid);
  if (!perfil.clanId) throw new HttpsError('failed-precondition', 'No perteneces a ningun clan.');

  await db().runTransaction(async (tx) => {
    const ref = db().doc(`clanes/${perfil.clanId}`);
    const snap = await tx.get(ref);
    if (snap.exists) {
      if (snap.data().lider === uid) {
        throw new HttpsError('failed-precondition',
          'Eres el lider. Cede el liderazgo o disuelve el clan antes de irte.');
      }
      tx.update(ref, {
        miembros: admin.firestore.FieldValue.arrayRemove(uid),
        numMiembros: Math.max(0, snap.data().miembros.length - 1),
      });
    }
    tx.update(perfil.ref, { clanId: null });
  });

  // Se devuelve el clan abandonado para que el llamante pueda recalcular su
  // rating: el cliente no lo envia, asi que sin esto el clan se quedaba con la
  // puntuacion de un miembro que ya no esta.
  return { ok: true, clanId: perfil.clanId };
}

/** Disuelve el clan. Solo el lider, y con penalizacion para evitar el abuso. */
async function disolver(uid, { clanId }) {
  const snap = await db().doc(`clanes/${clanId}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Ese clan no existe.');
  if (snap.data().lider !== uid) throw new HttpsError('permission-denied', 'Solo el lider puede disolver el clan.');

  const lote = db().batch();
  for (const miembroUid of snap.data().miembros || []) {
    lote.update(db().doc(`usuarios/${miembroUid}`), { clanId: null });
  }
  lote.update(db().doc(`usuarios/${uid}`), {
    penalizadoHasta: admin.firestore.Timestamp.fromMillis(Date.now() + DIAS_PENALIZACION * 864e5),
  });
  lote.delete(snap.ref);
  await lote.commit();

  return { ok: true };
}

/** Cede el liderazgo a otro miembro. */
async function cederLiderazgo(uid, { clanId, nuevoLiderUid }) {
  await db().runTransaction(async (tx) => {
    const ref = db().doc(`clanes/${clanId}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Ese clan no existe.');

    const clan = snap.data();
    if (clan.lider !== uid) throw new HttpsError('permission-denied', 'Solo el lider puede ceder el liderazgo.');
    if (!clan.miembros.includes(nuevoLiderUid)) throw new HttpsError('invalid-argument', 'Ese piloto no es miembro del clan.');

    tx.update(ref, { lider: nuevoLiderUid });
  });

  return { ok: true };
}

module.exports = {
  crear, solicitar, responderSolicitud, expulsar, abandonar, disolver, cederLiderazgo,
};
