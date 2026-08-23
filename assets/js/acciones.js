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
  db, auth, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, serverTimestamp, arrayUnion, arrayRemove, writeBatch, Timestamp,
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
/**
 * Crea el perfil de piloto.
 *
 * NO guarda el correo, y es deliberado: el correo ya vive en Firebase Auth, que
 * es su sitio. Copiarlo aqui lo metia en una coleccion que se leia sin sesion
 * para alimentar los rankings, o sea que publicaba la direccion de todo el
 * mundo. El worker lo saca de Auth cuando necesita escribir.
 *
 * El parametro `email` se sigue aceptando para no romper a quien llame con el,
 * pero se ignora.
 */
export async function crearPerfil({ username }) {
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

/**
 * Activa o desactiva los avisos por correo.
 *
 * La preferencia la escribe el propio usuario y solo el: darse de baja no puede
 * depender de que un administrador lo haga por ti. El enlace de los correos
 * hace lo mismo sin necesidad de iniciar sesion (ver /baja/).
 */
export async function guardarAvisosCorreo(activados) {
  await updateDoc(doc(db, 'usuarios', uidActual()), { avisosCorreo: Boolean(activados) });
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
  const [perfil, temporadas, viajes, reportes] = await Promise.all([
    getDoc(doc(db, 'usuarios', uid)),
    // Las temporadas archivadas son una SUBCOLECCION: no vienen dentro del
    // perfil, hay que pedirlas aparte. Sin esto, el export se dejaba fuera todo
    // el historial de competicion, que es justo lo que el art. 20 del RGPD
    // llama portabilidad.
    getDocs(collection(db, 'usuarios', uid, 'temporadas')).catch(() => ({ docs: [] })),
    getDocs(query(collection(db, 'tiempos_viaje'), where('uid', '==', uid))),
    getDocs(query(collection(db, 'reportes'), where('reportanteUid', '==', uid))).catch(() => ({ docs: [] })),
  ]);

  return {
    exportadoEn: new Date().toISOString(),
    // La cuenta sale de Firebase Auth, no del perfil: el correo vive alli y no
    // se duplica en Firestore (#60). Sin esto, el export se quedaba sin el dato
    // que el art. 15 obliga a devolver.
    cuenta: {
      uid,
      email: auth.currentUser?.email ?? null,
      emailVerificado: auth.currentUser?.emailVerified ?? null,
      creada: auth.currentUser?.metadata?.creationTime ?? null,
      ultimoAcceso: auth.currentUser?.metadata?.lastSignInTime ?? null,
    },
    perfil: perfil.exists() ? perfil.data() : null,
    temporadas: temporadas.docs.map((d) => ({ id: d.id, ...d.data() })),
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
  const lote = writeBatch(db);

  lote.update(doc(db, 'tiempos_viaje', viajeId), {
    estado: aprobar ? 'aprobado' : 'rechazado',
    verificado: aprobar,
    revisadoPor: uidActual(),
    revisadoEn: serverTimestamp(),
    motivoRevision: motivo,
    recalculoPendiente: true,
  });

  // Cada decision manual deja rastro, y en el mismo lote que la decision: un
  // rastro que se escribe "despues, si eso" es un rastro con agujeros. La
  // coleccion no admite modificar ni borrar, asi que esto no se puede maquillar
  // luego (ni por quien lo escribio).
  lote.set(doc(collection(db, 'auditoria_admin')), {
    adminUid: uidActual(),
    accion: `viaje:${aprobar ? 'aprobado' : 'rechazado'}`,
    detalle: { viajeId, motivo: motivo || null },
    creado: serverTimestamp(),
  });

  await lote.commit();
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
//
// Cada funcion de aqui manda EXACTAMENTE los campos que su regla permite. Las
// reglas distinguen tres papeles y una via abierta a cualquiera:
//
//   lider      plantilla + oficiales + liderazgo + identidad del clan
//   oficial    plantilla (aceptar y expulsar), nada mas
//   miembro    irse
//   cualquiera meter o sacar su propia solicitud
//
// `usuarios/{uid}.clanId` lo escribe cada uno en su documento, pero la regla
// solo lo admite si el clan YA le lista como miembro. La fuente de verdad de la
// plantilla es `clanes/{id}.miembros`, y de ahi es de donde suma el worker: si
// se fiara del campo del usuario, cualquiera le inflaria la puntuacion a un clan
// ajeno con cuentas nuevas.

/** Con mas gente deja de sentirse como un equipo. Mismo tope que en las reglas. */
export const MAX_MIEMBROS = 50;

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

  // El clan PRIMERO y el `clanId` del usuario despues, en dos pasos y no en un
  // lote: la regla del usuario comprueba que el clan ya le liste como miembro,
  // y dentro de un lote ese clan todavia no existe.
  await setDoc(doc(db, 'clanes', clanId), {
    clanId,
    nombre: limpio,
    descripcion: String(descripcion || '').slice(0, 160),
    color,
    lider: uid,
    miembros: [uid],
    oficiales: [],
    solicitudes: [],
    biciRating: 0,
    numMiembros: 1,
    logros: [],
    creado: serverTimestamp(),
  });

  await updateDoc(doc(db, 'usuarios', uid), { clanId });
  return clanId;
}

export async function solicitarEntrada(clanId) {
  await updateDoc(doc(db, 'clanes', clanId), { solicitudes: arrayUnion(uidActual()) });
}

/** Retira la propia solicitud. La misma regla que la de arriba, al reves. */
export async function retirarSolicitud(clanId) {
  await updateDoc(doc(db, 'clanes', clanId), { solicitudes: arrayRemove(uidActual()) });
}

/**
 * Acepta o rechaza a un candidato. Lider u oficial.
 *
 * Al aceptar solo se toca el CLAN: el `clanId` del nuevo miembro lo escribe el,
 * porque su documento solo lo puede escribir el. Hasta que entre, la plantilla
 * del clan ya le lista, que es lo que cuenta para la puntuacion.
 */
export async function responderSolicitud(clanId, candidatoUid, aceptar) {
  const snap = await getDoc(doc(db, 'clanes', clanId));
  if (!snap.exists()) throw new Error('Ese clan ya no existe.');

  const clan = snap.data();

  if (!aceptar) {
    await updateDoc(snap.ref, { solicitudes: arrayRemove(candidatoUid) });
    return;
  }

  if ((clan.miembros || []).length >= MAX_MIEMBROS) {
    throw new Error(`Un clan no puede pasar de ${MAX_MIEMBROS} miembros.`);
  }

  await updateDoc(snap.ref, {
    solicitudes: arrayRemove(candidatoUid),
    miembros: arrayUnion(candidatoUid),
    numMiembros: clan.miembros.length + 1,
  });
}

/**
 * Expulsa a un miembro. Lider u oficial.
 *
 * Solo se le saca de la plantilla del clan. Su `clanId` se queda apuntando a un
 * clan que ya no le lista, y eso lo limpia el worker: nadie mas que esa persona
 * puede escribir su documento, y no se le va a pedir que colabore en su propia
 * expulsion. La puntuacion no se ve afectada porque suma desde `miembros`.
 */
export async function expulsarMiembro(clanId, miembroUid) {
  const snap = await getDoc(doc(db, 'clanes', clanId));
  if (!snap.exists()) throw new Error('Ese clan ya no existe.');

  const clan = snap.data();
  if (clan.lider === miembroUid) throw new Error('No se puede expulsar al lider.');

  await updateDoc(snap.ref, {
    miembros: arrayRemove(miembroUid),
    // Al salir pierde el cargo: si volviera a entrar, seria oficial otra vez sin
    // que nadie lo hubiera decidido.
    oficiales: arrayRemove(miembroUid),
    numMiembros: Math.max(0, (clan.miembros || []).length - 1),
  });
}

/** Nombra o retira un oficial. Solo el lider. */
export async function cambiarOficial(clanId, miembroUid, nombrar) {
  const snap = await getDoc(doc(db, 'clanes', clanId));
  if (!snap.exists()) throw new Error('Ese clan ya no existe.');

  if (nombrar && !(snap.data().miembros || []).includes(miembroUid)) {
    throw new Error('Solo se puede nombrar oficial a alguien del clan.');
  }

  await updateDoc(snap.ref, {
    oficiales: nombrar ? arrayUnion(miembroUid) : arrayRemove(miembroUid),
  });
}

/**
 * Traspasa el liderazgo. Solo el lider, y solo a alguien de dentro.
 *
 * Es lo que permite irse sin disolver el clan, y lo que hace que un clan
 * sobreviva a que su fundador se canse.
 */
export async function cederLiderazgo(clanId, nuevoLiderUid) {
  const snap = await getDoc(doc(db, 'clanes', clanId));
  if (!snap.exists()) throw new Error('Ese clan ya no existe.');

  const clan = snap.data();
  if (clan.lider !== uidActual()) throw new Error('Solo el lider puede ceder el mando.');
  if (!(clan.miembros || []).includes(nuevoLiderUid)) {
    throw new Error('El nuevo lider tiene que ser del clan.');
  }

  await updateDoc(snap.ref, {
    lider: nuevoLiderUid,
    // El nuevo lider ya no necesita ser oficial, y el anterior pasa a serlo:
    // asi quien monto el clan no se queda sin poder ayudar a gestionarlo.
    oficiales: arrayUnion(clan.lider),
  });
}

export async function abandonarClan(clanId) {
  const uid = uidActual();
  const snap = await getDoc(doc(db, 'clanes', clanId));

  if (snap.exists() && snap.data().lider === uid) {
    throw new Error('Eres el lider. Cede el liderazgo o disuelve el clan antes de irte.');
  }

  if (snap.exists()) {
    const clan = snap.data();
    await updateDoc(snap.ref, {
      miembros: arrayRemove(uid),
      oficiales: arrayRemove(uid),
      numMiembros: Math.max(0, (clan.miembros || []).length - 1),
    });
  }

  // Ahora si: el clan ya no me lista, y la regla admite ponerlo a null siempre.
  await updateDoc(doc(db, 'usuarios', uid), { clanId: null });
}

export async function disolverClan(clanId) {
  const snap = await getDoc(doc(db, 'clanes', clanId));
  if (!snap.exists()) return;
  if (snap.data().lider !== uidActual()) throw new Error('Solo el lider puede disolver el clan.');

  // El `clanId` de los demas se queda colgando y lo limpia el worker: nadie
  // puede escribir el documento de otro. El de quien disuelve, aqui mismo.
  await deleteDoc(snap.ref);
  await updateDoc(doc(db, 'usuarios', uidActual()), { clanId: null });
}

// --- Invitaciones ------------------------------------------------------------------

/** Cuanto vale un enlace de invitacion, por defecto. */
const DIAS_INVITACION = 7;

/**
 * Crea un enlace de invitacion. Solo el lider.
 *
 * El codigo es el id del documento y es lo unico que hace falta saber para
 * usarlo, asi que tiene que ser imposible de adivinar y la coleccion no se
 * puede listar (lo impide la regla). 128 bits de `crypto`, no `Math.random()`:
 * un codigo predecible es una puerta abierta a cualquiera.
 */
export async function crearInvitacion(clanId, { dias = DIAS_INVITACION, maxUsos = 1 } = {}) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const codigo = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

  const caduca = new Date(Date.now() + dias * 86400000);

  await setDoc(doc(db, 'invitaciones', codigo), {
    clanId,
    creadaPor: uidActual(),
    creada: serverTimestamp(),
    caduca: Timestamp.fromDate(caduca),
    usos: 0,
    maxUsos,
  });

  return { codigo, caduca, enlace: `${window.location.origin}/territorio/?invitacion=${codigo}` };
}

export async function retirarInvitacion(codigo) {
  await deleteDoc(doc(db, 'invitaciones', codigo));
}

/**
 * Usa un enlace de invitacion.
 *
 * El cliente NO se mete solo en el clan: deja una solicitud marcada con el
 * codigo, y el worker comprueba la caducidad y los usos y la resuelve. Si el
 * contador de usos lo llevara el navegador, un codigo de un solo uso valdria
 * para todo el que lo tenga.
 */
export async function usarInvitacion(codigo) {
  const snap = await getDoc(doc(db, 'invitaciones', codigo));
  if (!snap.exists()) throw new Error('Esa invitacion no existe o ya se ha retirado.');

  const invitacion = snap.data();
  const caduca = invitacion.caduca?.toDate?.();

  // Se comprueba aqui para poder decirlo claro, pero quien decide es el worker:
  // esto es un aviso, no el control.
  if (caduca && caduca < new Date()) throw new Error('Esa invitacion ha caducado.');
  if ((invitacion.usos || 0) >= (invitacion.maxUsos || 1)) {
    throw new Error('Esa invitacion ya se ha usado.');
  }

  await updateDoc(doc(db, 'clanes', invitacion.clanId), {
    solicitudes: arrayUnion(uidActual()),
  });

  return invitacion.clanId;
}

/** Confirma la entrada despues de que el clan te haya aceptado. */
export async function confirmarEntrada(clanId) {
  await updateDoc(doc(db, 'usuarios', uidActual()), { clanId });
}

