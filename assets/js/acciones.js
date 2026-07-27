/**
 * Operaciones de escritura de la app.
 *
 * Sustituyen a los antiguos callables de Cloud Functions. Ahora el navegador
 * escribe directamente en Firestore y son LAS REGLAS las que deciden si la
 * operacion vale: cada funcion de aqui manda exactamente los campos que su
 * regla permite, ni uno mas.
 *
 * Lo que NO puede vivir aqui, porque exige el Admin SDK:
 *   - poner o quitar el rol de administrador (custom claims)  -> scripts/set-admin.js
 *   - decidir si un viaje se aprueba                          -> backend/worker.js
 *   - recalcular la clasificacion                             -> backend/worker.js
 *   - borrar la cuenta de Firebase Auth                       -> backend/worker.js
 */

import {
  db, auth, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc,
  query, where, orderBy, serverTimestamp, arrayUnion, arrayRemove, writeBatch,
  avatarPorDefecto,
} from './firebase.js';
import { VERSION_LEGAL } from './ui.js';

const uidActual = () => auth.currentUser?.uid;

// --- Perfil -------------------------------------------------------------------

/**
 * Crea el perfil de piloto.
 *
 * Las reglas obligan a que todos los contadores nazcan a cero y no admiten un
 * campo de rol: en la version anterior el navegador enviaba `isAdmin: false`,
 * lo que dejaba claro que ese campo era manipulable desde el cliente.
 */
export async function crearPerfil({ username, email }) {
  const uid = uidActual();
  const nombre = String(username || '').trim();
  const clave = nombre.toLowerCase();

  // La reserva del nombre es orientativa: sirve para avisar pronto de que esta
  // cogido. La unicidad de verdad la impone el worker, porque las reglas de
  // Firestore no pueden hacer transacciones entre documentos.
  const reserva = await getDoc(doc(db, 'nombres_usuario', clave));
  if (reserva.exists() && reserva.data().uid !== uid) {
    throw new Error('Ese nombre de piloto ya esta cogido.');
  }

  const ahora = new Date().toISOString();
  const lote = writeBatch(db);

  lote.set(doc(db, 'usuarios', uid), {
    uid,
    email: String(email || '').toLowerCase(),
    username: nombre,
    usernameLower: clave,
    avatarUrl: avatarPorDefecto(nombre),
    biciRating: 0,
    viajesVerificados: 0,
    puntosPorRuta: {},
    logros: [],
    clanId: null,
    favoritas: [],
    suspendido: false,
    creado: serverTimestamp(),
    // Registro de consentimiento: el RGPD exige poder demostrar QUE se acepto,
    // CUANDO y sobre QUE version del texto.
    consentimiento: {
      terminos: { version: VERSION_LEGAL, aceptadoEn: ahora },
      privacidad: { version: VERSION_LEGAL, aceptadoEn: ahora },
    },
  });

  lote.set(doc(db, 'nombres_usuario', clave), { uid, creado: serverTimestamp() });
  await lote.commit();
}

/** Vuelve a aceptar los textos legales cuando sube la version. */
export async function aceptarLegal() {
  const ahora = new Date().toISOString();
  await updateDoc(doc(db, 'usuarios', uidActual()), {
    consentimiento: {
      terminos: { version: VERSION_LEGAL, aceptadoEn: ahora },
      privacidad: { version: VERSION_LEGAL, aceptadoEn: ahora },
    },
  });
}

/** Guarda las rutas ancladas. Las reglas limitan el maximo a tres. */
export async function guardarFavoritas(favoritas) {
  if (favoritas.length > 3) throw new Error('Solo puedes anclar 3 rutas.');
  await updateDoc(doc(db, 'usuarios', uidActual()), { favoritas });
}

// --- Viajes --------------------------------------------------------------------

/**
 * Pide que una persona revise un rechazo automatico (RGPD art. 22.3).
 * Las reglas solo lo permiten sobre viajes rechazados por la maquina y sin
 * dejar tocar el tiempo, la ruta ni el veredicto.
 */
export async function impugnarViaje(viajeId, alegacion) {
  const texto = String(alegacion || '').trim();
  if (texto.length < 15) {
    throw new Error('Explica en unas lineas por que crees que el rechazo es un error.');
  }
  await updateDoc(doc(db, 'tiempos_viaje', viajeId), {
    estado: 'revision',
    impugnado: true,
    alegacion: texto.slice(0, 600),
    impugnadoEn: serverTimestamp(),
  });
}

/** Denuncia un tiempo sospechoso. */
export async function reportarViaje(viaje, motivo = 'Reportado desde el ranking') {
  const uid = uidActual();
  if (viaje.uid === uid) throw new Error('No puedes reportar tu propio viaje.');

  await addDoc(collection(db, 'reportes'), {
    viajeId: viaje.viajeId,
    reportanteUid: uid,
    reportadoUid: viaje.uid,
    ruta: viaje.ruta,
    motivo: String(motivo).slice(0, 300),
    estado: 'pendiente',
    creado: serverTimestamp(),
  });
}

// --- Derechos RGPD --------------------------------------------------------------

/** Descarga de todos los datos propios (derecho de acceso y portabilidad). */
export async function exportarMisDatos() {
  const uid = uidActual();
  const [perfil, viajes, reportes] = await Promise.all([
    getDoc(doc(db, 'usuarios', uid)),
    getDocs(query(collection(db, 'tiempos_viaje'), where('uid', '==', uid))),
    getDocs(query(collection(db, 'reportes'), where('reportanteUid', '==', uid))).catch(() => ({ docs: [] })),
  ]);

  return {
    exportadoEn: new Date().toISOString(),
    perfil: perfil.exists() ? perfil.data() : null,
    viajes: viajes.docs.map((d) => ({ id: d.id, ...d.data() })),
    reportesEnviados: reportes.docs.map((d) => ({ id: d.id, ...d.data() })),
  };
}

/**
 * Solicita el borrado de la cuenta (derecho de supresion).
 * Eliminar el usuario de Firebase Auth exige el Admin SDK, asi que aqui solo se
 * deja constancia y el worker lo ejecuta en su siguiente pasada.
 */
export async function solicitarBorradoCuenta(confirmacion) {
  if (confirmacion !== 'BORRAR MI CUENTA') {
    throw new Error('Falta la confirmacion exacta.');
  }
  await setDoc(doc(db, 'solicitudes_borrado', uidActual()), {
    uid: uidActual(),
    confirmacion,
    creado: serverTimestamp(),
  });
}

// --- Administracion --------------------------------------------------------------

/**
 * Resuelve un viaje de la cola.
 * `recalculoPendiente` avisa al worker de que rehaga la clasificacion: hacerlo
 * desde el navegador costaria cientos de lecturas de la cuota diaria gratuita.
 */
export async function resolverViaje(viajeId, accion, motivo = null) {
  const aprobar = accion === 'aprobar';
  await updateDoc(doc(db, 'tiempos_viaje', viajeId), {
    estado: aprobar ? 'aprobado' : 'rechazado',
    verificado: aprobar,
    revisadoPor: uidActual(),
    revisadoEn: serverTimestamp(),
    motivoRevision: motivo,
    recalculoPendiente: true,
  });
}

export async function resolverReporte(reporteId, accion, viajeId) {
  const lote = writeBatch(db);

  lote.update(doc(db, 'reportes', reporteId), {
    estado: accion === 'ignorar' ? 'ignorado' : 'resuelto',
    resueltoPor: uidActual(),
    resueltoEn: serverTimestamp(),
  });

  if (accion === 'eliminar_viaje' && viajeId) {
    lote.update(doc(db, 'tiempos_viaje', viajeId), {
      estado: 'rechazado',
      verificado: false,
      revisadoPor: uidActual(),
      revisadoEn: serverTimestamp(),
      motivoRevision: 'Eliminado tras reporte de la comunidad.',
      recalculoPendiente: true,
    });
  }

  await lote.commit();
}

/** Devuelve la captura de un viaje. Las reglas solo dejan leerla a administracion. */
export async function verCaptura(viajeId) {
  const snap = await getDoc(doc(db, 'capturas', viajeId));
  if (!snap.exists()) throw new Error('La captura de este viaje ya no esta disponible.');
  return snap.data().datos;
}

export async function gestionarInsignia(tipo, id, insignia, otorgar) {
  await updateDoc(doc(db, tipo, id), {
    logros: otorgar ? arrayUnion(insignia) : arrayRemove(insignia),
  });
}

export async function destacarRuta(ruta) {
  const conf = await getDoc(doc(db, 'config', 'general'));
  const anterior = conf.exists() ? conf.data().rutaDestacada : null;
  const historicas = conf.exists() ? (conf.data().rutasHistoricas || []) : [];

  if (anterior && anterior !== ruta && !historicas.includes(anterior)) historicas.push(anterior);

  await setDoc(doc(db, 'config', 'general'), {
    rutaDestacada: ruta,
    rutasHistoricas: historicas,
    // El worker vera esto y recalculara las dos rutas afectadas.
    recalculoPendiente: [anterior, ruta].filter(Boolean),
  }, { merge: true });
}

export async function suspenderUsuario(uid, suspender, motivo = null) {
  await updateDoc(doc(db, 'usuarios', uid), {
    suspendido: suspender,
    motivoSuspension: suspender ? motivo : null,
  });
}

// --- Clanes ----------------------------------------------------------------------

export async function crearClan({ nombre, descripcion, color }) {
  const uid = uidActual();
  const limpio = String(nombre || '').trim();
  const clanId = limpio.toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, 40);

  if (clanId.length < 3) throw new Error('Ese nombre de clan no es valido.');
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('El color no es valido.');

  const existente = await getDoc(doc(db, 'clanes', clanId));
  if (existente.exists()) throw new Error('Ya existe un clan con ese nombre.');

  const lote = writeBatch(db);
  lote.set(doc(db, 'clanes', clanId), {
    clanId,
    nombre: limpio,
    descripcion: String(descripcion || '').slice(0, 160),
    color,
    lider: uid,
    miembros: [uid],
    solicitudes: [],
    biciRating: 0,
    numMiembros: 1,
    logros: [],
    creado: serverTimestamp(),
  });
  lote.update(doc(db, 'usuarios', uid), { clanId });
  await lote.commit();
  return clanId;
}

export async function solicitarEntrada(clanId) {
  await updateDoc(doc(db, 'clanes', clanId), { solicitudes: arrayUnion(uidActual()) });
}

export async function responderSolicitud(clanId, candidatoUid, aceptar) {
  const snap = await getDoc(doc(db, 'clanes', clanId));
  if (!snap.exists()) throw new Error('Ese clan ya no existe.');

  const clan = snap.data();
  const lote = writeBatch(db);

  if (aceptar) {
    lote.update(snap.ref, {
      solicitudes: arrayRemove(candidatoUid),
      miembros: arrayUnion(candidatoUid),
      numMiembros: clan.miembros.length + 1,
    });
    lote.update(doc(db, 'usuarios', candidatoUid), { clanId });
  } else {
    lote.update(snap.ref, { solicitudes: arrayRemove(candidatoUid) });
  }

  await lote.commit();
}

export async function expulsarMiembro(clanId, miembroUid) {
  const snap = await getDoc(doc(db, 'clanes', clanId));
  const lote = writeBatch(db);
  lote.update(snap.ref, {
    miembros: arrayRemove(miembroUid),
    numMiembros: Math.max(0, snap.data().miembros.length - 1),
  });
  lote.update(doc(db, 'usuarios', miembroUid), { clanId: null });
  await lote.commit();
}

export async function abandonarClan(clanId) {
  const uid = uidActual();
  const snap = await getDoc(doc(db, 'clanes', clanId));
  if (snap.exists() && snap.data().lider === uid) {
    throw new Error('Eres el lider. Cede el liderazgo o disuelve el clan antes de irte.');
  }

  const lote = writeBatch(db);
  if (snap.exists()) {
    lote.update(snap.ref, {
      miembros: arrayRemove(uid),
      numMiembros: Math.max(0, snap.data().miembros.length - 1),
    });
  }
  lote.update(doc(db, 'usuarios', uid), { clanId: null });
  await lote.commit();
}

export async function disolverClan(clanId) {
  const snap = await getDoc(doc(db, 'clanes', clanId));
  if (!snap.exists()) return;

  const lote = writeBatch(db);
  for (const miembro of snap.data().miembros || []) {
    lote.update(doc(db, 'usuarios', miembro), { clanId: null });
  }
  lote.delete(snap.ref);
  await lote.commit();
}
