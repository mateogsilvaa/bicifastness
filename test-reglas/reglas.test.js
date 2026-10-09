/**
 * firestore.rules, EJECUTADAS.
 *
 * El resto de pruebas del repositorio leen las reglas como texto: comprueban
 * que una linea esta o no esta. Eso vigila que nadie deshaga un arreglo, pero no
 * dice si la regla FUNCIONA, y aqui eso importa mas que en ningun otro sitio:
 * no hay servidor delante, las reglas son el control de acceso.
 *
 * Y hay reglas que, si estan mal, no fallan "un poco". El freno de #62 gatea
 * CADA subida de viaje; una expresion mal escrita no deja pasar mas de la
 * cuenta, deja a todo el mundo sin poder subir nada. Por eso estas pruebas
 * reproducen EXACTAMENTE los lotes que escriben `crearViajes` (subir.js) y
 * `crearPerfil` (acciones.js): si alguien cambia uno de los dos lados sin el
 * otro, falla aqui y no en produccion.
 *
 * Corren contra el emulador de Firestore, que necesita Java 21. Por eso van en
 * su propio paquete y su propio trabajo del CI, y no dentro de `npm test`:
 *
 *     cd test-reglas && npm ci && npm test
 */

const { test, before, after, beforeEach } = require('node:test');
const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment, assertSucceeds, assertFails,
} = require('@firebase/rules-unit-testing');
const {
  doc, getDoc, getDocs, collection, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, increment, Timestamp,
} = require('firebase/firestore');

let entorno;

const UID = 'piloto1';
const OTRO = 'piloto2';
const diaUTC = () => Math.floor(Date.now() / 86400000);
const hoyISO = () => new Date().toISOString().slice(0, 10);

before(async () => {
  entorno = await initializeTestEnvironment({
    projectId: 'demo-bicifastness',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8') },
  });
});

after(async () => { await entorno?.cleanup(); });
beforeEach(async () => { await entorno.clearFirestore(); });

const como = (uid, claims = {}) => entorno.authenticatedContext(uid, claims).firestore();
const anonimo = () => entorno.unauthenticatedContext().firestore();

// --- Perfil ------------------------------------------------------------------

/** Lo mismo que escribe `crearPerfil`, campo por campo. */
function perfilNuevo(uid, nombre = 'Piloto Uno') {
  const ahora = new Date().toISOString();
  return {
    uid,
    username: nombre,
    usernameLower: nombre.toLowerCase(),
    avatarUrl: 'data:image/svg+xml,x',
    biciRating: 0,
    viajesVerificados: 0,
    puntosPorRuta: {},
    logros: [],
    clanId: null,
    favoritas: [],
    suspendido: false,
    bienvenidaEnviada: false,
    creado: serverTimestamp(),
    consentimiento: {
      terminos: { version: '2026-08', aceptadoEn: ahora },
      privacidad: { version: '2026-08', aceptadoEn: ahora },
    },
  };
}

async function altaDePerfil(db, uid, nombre) {
  const lote = writeBatch(db);
  lote.set(doc(db, 'usuarios', uid), perfilNuevo(uid, nombre));
  lote.set(doc(db, 'nombres_usuario', nombre.toLowerCase()), { uid, creado: serverTimestamp() });
  return lote.commit();
}

test('el alta de perfil que escribe crearPerfil pasa', async () => {
  await assertSucceeds(altaDePerfil(como(UID), UID, 'Piloto Uno'));
});

test('nadie nace con puntos ni con rol de administracion', async () => {
  const db = como(UID);
  await assertFails(setDoc(doc(db, 'usuarios', UID), { ...perfilNuevo(UID), biciRating: 9000 }));
  await assertFails(setDoc(doc(db, 'usuarios', UID), { ...perfilNuevo(UID), isAdmin: true }));
  await assertFails(setDoc(doc(db, 'usuarios', UID), { ...perfilNuevo(UID), email: 'a@b.es' }));
});

test('no se puede crear el perfil de otra persona', async () => {
  await assertFails(setDoc(doc(como(UID), 'usuarios', OTRO), perfilNuevo(OTRO)));
});

test('el perfil ajeno no se lee: lleva datos que no son publicos', async () => {
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'usuarios', OTRO), { uid: OTRO, username: 'Otro' });
  });
  await assertFails(getDoc(doc(como(UID), 'usuarios', OTRO)));
  await assertFails(getDoc(doc(anonimo(), 'usuarios', OTRO)));
  await assertSucceeds(getDoc(doc(como(OTRO), 'usuarios', OTRO)));
});

test('el piloto no puede tocarse la puntuacion', async () => {
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'usuarios', UID), perfilNuevo(UID));
  });
  await assertFails(updateDoc(doc(como(UID), 'usuarios', UID), { biciRating: 500 }));
  await assertFails(updateDoc(doc(como(UID), 'usuarios', UID), { viajesVerificados: 50 }));
  await assertSucceeds(updateDoc(doc(como(UID), 'usuarios', UID), { favoritas: ['001-002'] }));
});

// --- Subida de viajes: el freno de #62 ------------------------------------------

function viaje(uid, extra = {}) {
  return {
    uid,
    username: 'Piloto Uno',
    ruta: '001-002',
    tiempoSegundos: 600,
    tiempoFormateado: '10m 00s',
    fechaViaje: hoyISO(),
    estado: 'pendiente',
    verificado: false,
    capturaId: `${uid}_${diaUTC()}_c1`,
    creado: serverTimestamp(),
    ...extra,
  };
}

const captura = (uid) => ({
  uid, datos: 'data:image/jpeg;base64,AAAA', creado: serverTimestamp(),
});

/**
 * Reproduce `crearViajes` de subir.js: un lote por viaje, la captura con el
 * primero y el contador en el mismo lote.
 */
async function subir(db, uid, cupo, { conCaptura = true } = {}) {
  // El viaje lleva el nombre del perfil (las reglas lo comparan): el perfil
  // tiene que existir, como en la web.
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'usuarios', uid), { uid, username: 'Piloto Uno', usernameLower: 'piloto uno' }, { merge: true });
  });
  const dia = diaUTC();
  const viajes = cupo.viajes + 1;
  const capturas = cupo.capturas + (conCaptura ? 1 : 0);

  const lote = writeBatch(db);
  if (conCaptura) lote.set(doc(db, 'capturas', `${uid}_${dia}_c${capturas}`), captura(uid));
  lote.set(doc(db, 'cupos', uid), { dia, viajes, capturas });
  lote.set(doc(db, 'tiempos_viaje', `${uid}_${dia}_${viajes}`),
    viaje(uid, { capturaId: `${uid}_${dia}_c${capturas}` }));
  await lote.commit();

  return { viajes, capturas };
}

test('la primera subida del dia, con su captura, pasa', async () => {
  await assertSucceeds(subir(como(UID), UID, { viajes: 0, capturas: 0 }));
});

test('tres trayectos de la misma captura pasan, uno por lote', async () => {
  const db = como(UID);
  let cupo = await subir(db, UID, { viajes: 0, capturas: 0 });
  cupo = await assertSucceeds(subir(db, UID, cupo, { conCaptura: false }));
  await assertSucceeds(subir(db, UID, cupo, { conCaptura: false }));
});

test('el cupo de ayer se reinicia al escribir el dia nuevo', async () => {
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'cupos', UID), { dia: diaUTC() - 1, viajes: 10, capturas: 10 });
  });
  await assertSucceeds(subir(como(UID), UID, { viajes: 0, capturas: 0 }));
});

test('sin contador en el mismo lote, el viaje no entra', async () => {
  const db = como(UID);
  await assertFails(setDoc(doc(db, 'tiempos_viaje', `${UID}_${diaUTC()}_1`), viaje(UID)));
});

test('dos viajes en un mismo lote no entran', async () => {
  const db = como(UID);
  const dia = diaUTC();
  const lote = writeBatch(db);
  lote.set(doc(db, 'cupos', UID), { dia, viajes: 1, capturas: 0 });
  lote.set(doc(db, 'tiempos_viaje', `${UID}_${dia}_1`), viaje(UID));
  lote.set(doc(db, 'tiempos_viaje', `${UID}_${dia}_x`), viaje(UID));
  await assertFails(lote.commit());
});

test('el contador no salta de dos en dos', async () => {
  const db = como(UID);
  const dia = diaUTC();
  const lote = writeBatch(db);
  lote.set(doc(db, 'cupos', UID), { dia, viajes: 2, capturas: 0 });
  lote.set(doc(db, 'tiempos_viaje', `${UID}_${dia}_2`), viaje(UID));
  await assertFails(lote.commit());
});

test('pasado el tope diario, ni un viaje mas', async () => {
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'cupos', UID), { dia: diaUTC(), viajes: 10, capturas: 10 });
  });
  await assertFails(subir(como(UID), UID, { viajes: 10, capturas: 10 }));
});

test('el contador no se puede borrar ni bajar', async () => {
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'cupos', UID), { dia: diaUTC(), viajes: 5, capturas: 5 });
  });
  const db = como(UID);
  await assertFails(setDoc(doc(db, 'cupos', UID), { dia: diaUTC(), viajes: 0, capturas: 0 }));
  await assertFails(require('firebase/firestore').deleteDoc(doc(db, 'cupos', UID)));
});

test('un viaje no nace verificado ni a nombre de otro', async () => {
  const db = como(UID);
  const dia = diaUTC();
  for (const trampa of [{ verificado: true }, { estado: 'aprobado' }, { uid: OTRO }]) {
    const lote = writeBatch(db);
    lote.set(doc(db, 'cupos', UID), { dia, viajes: 1, capturas: 0 });
    lote.set(doc(db, 'tiempos_viaje', `${UID}_${dia}_1`), viaje(UID, trampa));
    await assertFails(lote.commit());
  }
});

test('los metadatos admiten el dia del fichero y nada que no sea eso', async () => {
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'usuarios', UID), { uid: UID, username: 'Piloto Uno', usernameLower: 'piloto uno' });
  });
  const db = como(UID);
  const dia = diaUTC();
  const conMetadatos = async (metadatos) => {
    const lote = writeBatch(db);
    lote.set(doc(db, 'cupos', UID), { dia, viajes: 1, capturas: 0 });
    lote.set(doc(db, 'tiempos_viaje', `${UID}_${dia}_1`), viaje(UID, { metadatos }));
    return lote.commit();
  };
  await assertFails(conMetadatos({ capturadaEn: '2026-07-15T10:00:00Z' }));
  await assertFails(conMetadatos({ gps: '40.4,-3.7' }));
  await assertSucceeds(conMetadatos({ software: 'Snapseed', capturadaEn: '2026-07-15' }));
});

test('el viaje ajeno no se lee, ni con sesion ni sin ella', async () => {
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'tiempos_viaje', 'v1'), { uid: OTRO, verificado: true });
  });
  await assertFails(getDoc(doc(como(UID), 'tiempos_viaje', 'v1')));
  await assertFails(getDoc(doc(anonimo(), 'tiempos_viaje', 'v1')));
});

// --- Pedir revision humana -----------------------------------------------------

const rechazoAutomatico = (extra = {}) => ({
  uid: UID, ruta: '001-002', estado: 'rechazado', verificado: false, revisadoPor: 'automatico', ...extra,
});
const impugnacion = {
  estado: 'revision', impugnado: true, alegacion: 'La captura es la original, de ayer', impugnadoEn: serverTimestamp(),
};

test('se pide revision de un rechazo automatico mientras se guarda la captura', async () => {
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'tiempos_viaje', 'v1'),
      rechazoAutomatico({ capturaCaduca: Timestamp.fromMillis(Date.now() + 864e5) }));
  });
  await assertSucceeds(updateDoc(doc(como(UID), 'tiempos_viaje', 'v1'), impugnacion));
});

test('sin captura guardada, o con el plazo pasado, no se pide revision', async () => {
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'tiempos_viaje', 'sin'), rechazoAutomatico());
    await setDoc(doc(ctx.firestore(), 'tiempos_viaje', 'pasado'),
      rechazoAutomatico({ capturaCaduca: Timestamp.fromMillis(Date.now() - 1000) }));
  });
  await assertFails(updateDoc(doc(como(UID), 'tiempos_viaje', 'sin'), impugnacion));
  await assertFails(updateDoc(doc(como(UID), 'tiempos_viaje', 'pasado'), impugnacion));
});

test('las capturas no las lee nadie desde el navegador, ni su autor', async () => {
  await subir(como(UID), UID, { viajes: 0, capturas: 0 });
  await assertFails(getDoc(doc(como(UID), 'capturas', `${UID}_${diaUTC()}_c1`)));
});

// --- Analitica y errores sin sesion (#67) ----------------------------------------

const sesion = () => ({
  dia: hoyISO(), version: 'abc12345', creado: serverTimestamp(),
  pagina_vista: increment(1),
});

test('la analitica sin sesion se sigue pudiendo escribir: mide el registro', async () => {
  await assertSucceeds(setDoc(doc(anonimo(), 'sesiones_web', `${hoyISO()}_abc123`), sesion(), { merge: true }));
});

test('una sesion de analitica no se reescribe: una escritura por visita', async () => {
  const id = `${hoyISO()}_abc123`;
  await setDoc(doc(anonimo(), 'sesiones_web', id), sesion(), { merge: true });
  await assertFails(setDoc(doc(anonimo(), 'sesiones_web', id), sesion(), { merge: true }));
});

test('la analitica no admite ids ni contadores inventados', async () => {
  const db = anonimo();
  await assertFails(setDoc(doc(db, 'sesiones_web', 'cualquier-cosa'), sesion()));
  await assertFails(setDoc(doc(db, 'sesiones_web', `${hoyISO()}_abc123`),
    { ...sesion(), pagina_vista: 100000 }));
  await assertFails(setDoc(doc(db, 'sesiones_web', `${hoyISO()}_abc123`),
    { ...sesion(), inventado: 1 }));
});

/** Lo mismo que escribe `errores.registrar`. */
const error = (sesiones = increment(1)) => ({
  mensaje: 'x', pila: '', pagina: '/entrar/', navegador: 'Chrome 130',
  version: 'abc12345', ancho: 390, conSesion: false, sesiones,
  visto: serverTimestamp(),
});

test('los errores del cliente se recogen sin sesion, y el mismo suma de uno en uno', async () => {
  const ref = doc(anonimo(), 'errores_cliente', 'eabc123');
  await assertSucceeds(setDoc(ref, error(), { merge: true }));
  await assertSucceeds(setDoc(ref, error(), { merge: true }));
});

test('nadie pone un error en el primer puesto de un solo golpe', async () => {
  const ref = doc(anonimo(), 'errores_cliente', 'eabc123');
  await assertFails(setDoc(ref, error(50000), { merge: true }));
  await setDoc(ref, error(), { merge: true });
  await assertFails(setDoc(ref, error(increment(1000)), { merge: true }));
});

test('la configuracion y los agregados solo los escribe el worker', async () => {
  const db = como(UID);
  await assertFails(setDoc(doc(db, 'config', 'general'), { rutaDestacada: '001-002' }));
  await assertFails(setDoc(doc(db, 'agregados', 'pilotos'), { filas: [] }));
});

// --- Correos que pide alguien --------------------------------------------------

/** Lo mismo que escribe `escribirAPiloto` (acciones.js). */
const mensaje = (por, extra = {}) => ({
  uid: OTRO, tipo: 'mensaje_equipo', asunto: 'Sobre tu trayecto',
  texto: 'Hola, te escribimos por lo de ayer.', sobre: 'Trayecto Sol → Ópera',
  firma: 'El equipo de bicifastness', por, creado: serverTimestamp(), ...extra,
});

test('solo la administracion escribe a un piloto, y firmando como ella', async () => {
  const { addDoc, collection } = require('firebase/firestore');
  const admin = como('jefa', { admin: true });
  await assertSucceeds(addDoc(collection(admin, 'mensajes_equipo'), mensaje('jefa')));
  await assertSucceeds(addDoc(collection(admin, 'mensajes_equipo'),
    { uid: OTRO, tipo: 'cuenta_suspendida', motivo: 'Capturas editadas', hasta: null, por: 'jefa', creado: serverTimestamp() }));
  await assertFails(addDoc(collection(admin, 'mensajes_equipo'), mensaje('otra-persona')));
  await assertFails(addDoc(collection(admin, 'mensajes_equipo'), mensaje('jefa', { tipo: 'bienvenida' })));
  await assertFails(addDoc(collection(como(UID), 'mensajes_equipo'), mensaje(UID)));
});

test('el aviso de contraseña cambiada, cada uno el suyo y una vez', async () => {
  const aviso = { tipo: 'clave_cambiada', dispositivo: 'Chrome en Android', creado: serverTimestamp() };
  const db = como(UID);
  await assertSucceeds(setDoc(doc(db, 'avisos_seguridad', UID), aviso));
  await assertFails(setDoc(doc(db, 'avisos_seguridad', UID), aviso));
  await assertFails(setDoc(doc(db, 'avisos_seguridad', OTRO), aviso));
  await assertFails(getDoc(doc(db, 'avisos_seguridad', UID)));
});

// --- Bicirating -------------------------------------------------------------------

/** Lo mismo que escribe `guardarValoracion` (assets/js/encuesta-bici.js). */
const valoracion = (extra = {}) => ({
  bici: '2471', uid: UID, dia: diaUTC(), nota: 2, fallos: ['frenos'], comentario: '',
  viajeId: 'v1', estacion: '001', procesada: false, creado: serverTimestamp(), ...extra,
});

async function conViaje(uid = UID) {
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'tiempos_viaje', 'v1'), { uid, ruta: '001-002', estado: 'pendiente' });
  });
}

test('se valora la bici de un trayecto propio, una vez al dia y se puede cambiar', async () => {
  await conViaje();
  const db = como(UID);
  const ref = doc(db, 'valoraciones_bici', `2471_${UID}_${diaUTC()}`);
  await assertSucceeds(setDoc(ref, valoracion()));
  await assertSucceeds(setDoc(ref, valoracion({ nota: 3, comentario: 'Frena poco' })));
  await assertSucceeds(getDoc(ref));
  // Otro id para la misma bici y dia no cuadra con lo que dice el documento.
  await assertFails(setDoc(doc(db, 'valoraciones_bici', `2471_${UID}_${diaUTC() - 1}`), valoracion()));
});

test('el comentario de una bici no lleva enlaces ni pasa de 200 caracteres', async () => {
  await conViaje();
  const ref = doc(como(UID), 'valoraciones_bici', `2471_${UID}_${diaUTC()}`);
  await assertFails(setDoc(ref, valoracion({ comentario: 'Mirad https://spam.example' })));
  await assertFails(setDoc(ref, valoracion({ comentario: 'Entra en bicis-baratas.com ya' })));
  await assertFails(setDoc(ref, valoracion({ comentario: 'www.algo raro' })));
  await assertFails(setDoc(ref, valoracion({ comentario: 'x'.repeat(201) })));
  await assertSucceeds(setDoc(ref, valoracion({ comentario: 'Frena mal. Es ruidosa y la bici.esta floja' })));
});

test('no se valora una bici con el viaje de otro ni con datos inventados', async () => {
  await conViaje(OTRO);
  const db = como(UID);
  const ref = doc(db, 'valoraciones_bici', `2471_${UID}_${diaUTC()}`);
  await assertFails(setDoc(ref, valoracion()));
});

test('la valoracion no admite notas, fallos ni estaciones fuera de lo previsto', async () => {
  await conViaje();
  const db = como(UID);
  const ref = doc(db, 'valoraciones_bici', `2471_${UID}_${diaUTC()}`);
  await assertFails(setDoc(ref, valoracion({ nota: 6 })));
  await assertFails(setDoc(ref, valoracion({ fallos: ['inventado'] })));
  await assertFails(setDoc(ref, valoracion({ estacion: '099' })));
  await assertFails(setDoc(ref, valoracion({ procesada: true })));
  await assertFails(getDoc(doc(como(OTRO), 'valoraciones_bici', `2471_${UID}_${diaUTC()}`)));
});

// 11 · Valorar sin viaje: la prueba es una captura propia, en el mismo lote.
const valoracionConCaptura = (capturaId, extra = {}) => {
  const { viajeId: _viaje, ...resto } = valoracion({ estacion: '124', ...extra });
  return { ...resto, capturaId };
};

test('se valora una bici sin viaje subiendo la captura en el mismo lote', async () => {
  const db = como(UID);
  const dia = diaUTC();
  const capturaId = `${UID}_${dia}_c1`;
  const lote = writeBatch(db);
  lote.set(doc(db, 'capturas', capturaId), { uid: UID, datos: 'data:image/jpeg;base64,AAAA', creado: serverTimestamp() });
  lote.set(doc(db, 'cupos', UID), { dia, viajes: 0, capturas: 1 });
  lote.set(doc(db, 'valoraciones_bici', `2471_${UID}_${dia}`), valoracionConCaptura(capturaId));
  await assertSucceeds(lote.commit());
});

test('sin viaje no vale la captura de otro ni llevar viaje y captura a la vez', async () => {
  const dia = diaUTC();
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'capturas', `${OTRO}_${dia}_c1`), { uid: OTRO, datos: 'data:image/jpeg;base64,AAAA' });
  });
  await conViaje();
  const db = como(UID);
  const ref = doc(db, 'valoraciones_bici', `2471_${UID}_${dia}`);
  await assertFails(setDoc(ref, valoracionConCaptura(`${OTRO}_${dia}_c1`)));
  await assertFails(setDoc(ref, { ...valoracion(), capturaId: `${OTRO}_${dia}_c1` }));
});

test('la ficha de una bici la lee cualquiera y no la escribe nadie', async () => {
  await assertSucceeds(getDoc(doc(anonimo(), 'bicis', '2471')));
  await assertFails(setDoc(doc(como(UID), 'bicis', '2471'), { media: 5 }));
});

// --- Foto de perfil e identidad del clan ------------------------------------------

const FOTO = `data:image/webp;base64,${'A'.repeat(2000)}`;

test('la foto la sube la cuenta de ese nombre, pequena y sin URLs', async () => {
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'usuarios', UID), { uid: UID, username: 'Laura', usernameLower: 'laura' });
  });
  const ref = doc(como(UID), 'fotos', 'laura');
  await assertSucceeds(setDoc(ref, { uid: UID, img: FOTO, actualizado: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(anonimo(), 'fotos', 'laura')));
  // La de otro nombre, no.
  await assertFails(setDoc(doc(como(UID), 'fotos', 'otro'), { uid: UID, img: FOTO, actualizado: serverTimestamp() }));
  // Ni una URL, ni un SVG, ni una foto enorme.
  await assertFails(setDoc(ref, { uid: UID, img: 'https://malo.example/x.png', actualizado: serverTimestamp() }));
  await assertFails(setDoc(ref, { uid: UID, img: 'data:image/svg+xml;base64,AAAA', actualizado: serverTimestamp() }));
  await assertFails(setDoc(ref, { uid: UID, img: `data:image/webp;base64,${'A'.repeat(14001)}`, actualizado: serverTimestamp() }));
  await assertSucceeds(deleteDoc(ref));
});

test('el lider personaliza el clan con emblema, siglas y lema validos', async () => {
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'clanes', 'c1'), {
      nombre: 'Clan Uno', color: '#FF5A1F', lider: UID, miembros: [UID, OTRO], oficiales: [], solicitudes: [],
    });
  });
  const ref = doc(como(UID), 'clanes', 'c1');
  await assertSucceeds(updateDoc(ref, { color: '#1B80E5', emblema: 'rayo', siglas: 'CU', descripcion: 'Los mas rapidos' }));
  await assertFails(updateDoc(ref, { emblema: 'cohete' }));
  await assertFails(updateDoc(ref, { siglas: 'DEMASIADO' }));
  await assertFails(updateDoc(ref, { descripcion: 'Entrad en clan-uno.com' }));
  await assertFails(updateDoc(ref, { color: 'red' }));
  // Un miembro que no es lider, no.
  await assertFails(updateDoc(doc(como(OTRO), 'clanes', 'c1'), { emblema: 'llama' }));
});

// --- Web en construccion ----------------------------------------------------------

async function enObras() {
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'config', 'acceso'), { modo: 'obras', mensaje: '' });
    await setDoc(doc(ctx.firestore(), 'acceso_lista', 'amiga@ejemplo.es'), { por: 'admin' });
  });
}

test('en obras solo se registra la lista blanca, con el correo verificado', async () => {
  await enObras();
  await assertFails(altaDePerfil(como(UID, { email: 'otra@ejemplo.es', email_verified: true }), UID, 'Piloto Uno'));
  // El correo de la lista, pero sin verificar: no (podria ser cualquiera).
  await assertFails(altaDePerfil(como(UID, { email: 'amiga@ejemplo.es', email_verified: false }), UID, 'Piloto Uno'));
  await assertSucceeds(altaDePerfil(como(UID, { email: 'Amiga@Ejemplo.es', email_verified: true }), UID, 'Piloto Uno'));
});

test('la lista blanca no la lee nadie salvo su propia entrada, y no da el panel', async () => {
  await enObras();
  const amiga = como(UID, { email: 'amiga@ejemplo.es', email_verified: true });
  await assertSucceeds(getDoc(doc(amiga, 'acceso_lista', 'amiga@ejemplo.es')));
  await assertFails(getDoc(doc(amiga, 'acceso_lista', 'otra@ejemplo.es')));
  await assertFails(getDocs(collection(amiga, 'acceso_lista')));
  await assertFails(setDoc(doc(amiga, 'config', 'acceso'), { modo: 'abierta', por: UID, actualizado: serverTimestamp() }));
  await assertFails(setDoc(doc(amiga, 'acceso_lista', 'colega@ejemplo.es'), { por: UID, creado: serverTimestamp() }));
  const admin = como('jefa', { admin: true });
  await assertSucceeds(setDoc(doc(admin, 'config', 'acceso'), { modo: 'abierta', mensaje: '', por: 'jefa', actualizado: serverTimestamp() }));
  await assertSucceeds(getDocs(collection(admin, 'acceso_lista')));
});

test('una cuenta suspendida no puede valorar bicis ni crear clanes', async () => {
  await conViaje();
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'usuarios', UID), { uid: UID, username: 'Laura', usernameLower: 'laura', suspendido: true });
  });
  const db = como(UID);
  await assertFails(setDoc(doc(db, 'valoraciones_bici', `2471_${UID}_${diaUTC()}`), valoracion()));
  await assertFails(setDoc(doc(db, 'clanes', 'nuevo'), {
    nombre: 'Nuevo', color: '#FF5A1F', lider: UID, miembros: [UID], oficiales: [], solicitudes: [], biciRating: 0, logros: [],
  }));
});

// --- Auditoria de seguridad ---------------------------------------------------------

test('el nombre de piloto no admite emojis ni simbolos raros', async () => {
  await assertFails(altaDePerfil(como(UID), UID, 'Piloto 🚲'));
  await assertFails(altaDePerfil(como(UID), UID, 'adm<b>in'));
  await assertSucceeds(altaDePerfil(como(UID), UID, 'Lucía_Pedalea'));
});

test('una cuenta no puede reservar nombres que no son el suyo', async () => {
  await altaDePerfil(como(UID), UID, 'Piloto Uno');
  await assertFails(setDoc(doc(como(UID), 'nombres_usuario', 'otro nombre'), { uid: UID, creado: serverTimestamp() }));
});

test('solo una denuncia por persona y viaje', async () => {
  const db = como(UID);
  const datos = { viajeId: 'v9', reportanteUid: UID, motivo: 'Tiempo imposible para esa ruta', estado: 'sin_resolver', creado: serverTimestamp() };
  await assertFails(setDoc(doc(db, 'reportes', 'cualquiera'), datos));
  await assertSucceeds(setDoc(doc(db, 'reportes', `${UID}_v9`), datos));
  await assertFails(setDoc(doc(db, 'reportes', `${UID}_v9`), datos));
});

test('el lider no mete en el clan a quien no lo ha pedido', async () => {
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'clanes', 'c1'), {
      nombre: 'Clan Uno', color: '#FF5A1F', lider: UID, miembros: [UID], oficiales: [], solicitudes: ['quiere'],
    });
  });
  const ref = doc(como(UID), 'clanes', 'c1');
  await assertFails(updateDoc(ref, { miembros: [UID, 'el_mejor_del_ranking'] }));
  await assertFails(updateDoc(ref, { miembros: [UID, 'quiere'], solicitudes: [], numMiembros: 9 }));
  await assertSucceeds(updateDoc(ref, { miembros: [UID, 'quiere'], solicitudes: [], numMiembros: 2 }));
});

test('un trayecto no se sube con el nombre de otro piloto', async () => {
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'usuarios', UID), { uid: UID, username: 'Piloto Uno', usernameLower: 'piloto uno' });
  });
  const db = como(UID);
  const dia = diaUTC();
  const lote = writeBatch(db);
  lote.set(doc(db, 'capturas', `${UID}_${dia}_c1`), captura(UID));
  lote.set(doc(db, 'cupos', UID), { dia, viajes: 1, capturas: 1 });
  lote.set(doc(db, 'tiempos_viaje', `${UID}_${dia}_1`), viaje(UID, { username: 'El Campeon' }));
  await assertFails(lote.commit());
});
