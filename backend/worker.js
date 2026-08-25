#!/usr/bin/env node
'use strict';

/**
 * Worker de verificacion de viajes.
 *
 * Este es el "servidor de confianza" de BiciFastness. No atiende peticiones:
 * se despierta cada pocos minutos desde GitHub Actions, coge los viajes que
 * esperan analisis y los resuelve.
 *
 * Por que asi y no con Cloud Functions: desplegar funciones en Firebase exige
 * el plan Blaze (tarjeta). GitHub Actions es gratis e ilimitado en repositorios
 * publicos, y aqui es donde vive el codigo de todas formas.
 *
 * Lo unico que se pierde frente a un servidor HTTP es la inmediatez: un viaje
 * tarda entre 5 y 10 minutos en resolverse en vez de segundos. A cambio, las
 * credenciales de administrador NUNCA tocan el navegador, que es lo que provoco
 * el compromiso anterior.
 *
 * No depende de ningun servicio de IA: la captura se lee con OCR local
 * (src/ocr.js). Ver ahi que se gana y que se pierde.
 *
 * Variables de entorno (GitHub Secrets):
 *   FIREBASE_SERVICE_ACCOUNT  JSON de la cuenta de servicio
 *   RESEND_API_KEY            clave de Resend (opcional: sin ella no se avisa)
 *
 * Uso:
 *   node backend/worker.js              procesa la cola
 *   node backend/worker.js --once       procesa como mucho un viaje (pruebas)
 *   node backend/worker.js --simular    analiza pero no escribe nada
 */

const admin = require('firebase-admin');

const { LIMITES, TIEMPO, IMAGEN } = require('./src/config');
const { construirRuta, inicioDelDiaMadrid, diaMadrid } = require('./src/util');
const imagen = require('./src/imagen');
const { leerCaptura, elegirTrayecto, cerrar: cerrarOcr } = require('./src/ocr');
const { evaluar, distanciaCalleMetros } = require('./src/verificacion');
const puntuacion = require('./src/puntuacion');
const distancias = require('./src/distancias');
const rachas = require('./src/rachas');
const correo = require('./src/correo');
const plantillas = require('./src/plantillas');
const metricas = require('./src/metricas');
const borrado = require('./src/borrado');
const cuota = require('./src/cuota');
const logros = require('./src/logros');
const clanes = require('./src/clan-mantenimiento');
const agregados = require('./src/agregados');
const push = require('./src/push');
const almacen = require('./src/db');
const misiones = require('./src/misiones');

const SIMULAR = process.argv.includes('--simular');
const SOLO_UNO = process.argv.includes('--once');

// Cuantos viajes se procesan por ejecucion. Con una ejecucion cada 5 minutos
// esto da holgura de sobra y evita agotar la cuota diaria de Firestore del plan
// gratuito (50.000 lecturas y 20.000 escrituras al dia).
const MAX_POR_TANDA = SOLO_UNO ? 1 : 25;

/**
 * A partir de cuantas horas en revision manual se avisa al piloto.
 *
 * 24 y no 2: la revision la hace una persona, y una persona duerme. Avisar a
 * las dos horas seria avisar de que el sistema funciona como esta previsto.
 */
const HORAS_REVISION_LENTA = 24;

/**
 * Cuanto tiempo se queda vivo el worker dando pasadas a la cola, y cuanto
 * espera entre una y otra (#14).
 *
 * EL PROBLEMA. El cron pide una ejecucion cada 5 minutos, pero GitHub retrasa
 * los programados cuando hay carga: el hueco real esta entre 5 y 15 minutos. Y
 * quien acaba de subir un viaje esta mirando la pantalla.
 *
 * QUE SE HACE. En vez de mirar la cola una vez y morir, la ejecucion se queda
 * unos minutos dando pasadas cada poco. Dentro de esa ventana, el tiempo de
 * espera de un viaje pasa de "hasta el proximo despertar" a menos de un minuto.
 *
 * LO QUE CUESTA, dicho claro: la ejecucion pasa de durar ~1 minuto a durar
 * hasta VENTANA_MINUTOS. En un repositorio PUBLICO Actions es gratis e
 * ilimitado, que es justo por lo que el worker vive aqui; en uno privado esto
 * multiplicaria el consumo por cuatro y NO compensa. Por eso se apaga poniendo
 * VENTANA_MINUTOS=0.
 *
 * La ventana se queda por debajo del periodo del cron para no solaparse con la
 * siguiente ejecucion, que ademas quedaria descartada por `concurrency`.
 */
const VENTANA_MS = Number(process.env.VENTANA_MINUTOS ?? 4) * 60000;
const ESPERA_MS = Number(process.env.ESPERA_SEGUNDOS ?? 45) * 1000;

const esperar = (ms) => new Promise((listo) => setTimeout(listo, ms));

// El dominio tiene que estar verificado en Resend con SPF, DKIM y DMARC, o el
// correo se va a spam.
const REMITENTE = 'BiciFastness <avisos@bicifastness.es>';

function arrancar() {
  const credenciales = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!credenciales) {
    console.error('Falta FIREBASE_SERVICE_ACCOUNT.');
    process.exit(1);
  }

  let cuenta;
  try {
    cuenta = JSON.parse(credenciales);
  } catch {
    console.error('FIREBASE_SERVICE_ACCOUNT no es un JSON valido.');
    process.exit(1);
  }

  admin.initializeApp({ credential: admin.credential.cert(cuenta) });
  return admin.firestore();
}

/**
 * Todo lo que hace el backend pasa por un contador (#38).
 *
 * Es la unica forma de saber lo que se gasta de verdad: docs/COSTE.md modela lo
 * que DEBERIA costar cada operacion, pero no sabe cuanta gente entra hoy ni
 * cuantos viajes hay ya acumulados.
 *
 * Se instala en `db.js`, no solo aqui: si se quedara en la instancia del worker
 * mediria unicamente sus consultas directas, y los agregados, la puntuacion y
 * las metricas — que es donde esta casi todo el gasto — quedarian fuera de la
 * cuenta.
 *
 * El envoltorio delega en Firestore y solo suma; si el contador fallara, la
 * operacion sigue adelante igual. Medir el consumo no puede ser el motivo de
 * que el worker deje de verificar viajes.
 */
const { db, coste: costeDeLaPasada } = cuota.contar(arrancar());
almacen.usar(db);
const AHORA = () => admin.firestore.FieldValue.serverTimestamp();

/**
 * Estaciones cuyo dominio hay que rehacer al final de la ejecucion.
 *
 * Recalcular el dominio de una estacion cuesta leer `tiempos_viaje` y
 * `usuarios` ENTEROS. Hacerlo por cada viaje aprobado eran 15.464 lecturas por
 * viaje con 15.000 acumulados: treinta y tres aprobaciones agotaban la cuota
 * diaria del proyecto (docs/COSTE.md). Y encima recalcular la misma estacion
 * diez veces en una pasada da diez veces el mismo resultado.
 *
 * Mismo patron que los agregados (#36): se apuntan aqui y se hacen una vez al
 * final, con la carga que para entonces ya esta en la mano.
 */
const estacionesTocadas = new Set();

/**
 * Rutas cuya clasificacion ha cambiado en esta ejecucion.
 *
 * Es lo que permite que la reconstruccion de agregados sea PARCIAL: los viajes
 * solo hacen falta para los agregados por ruta, asi que sabiendo cuales se han
 * movido se leen los de esas rutas y no los 15.000 (#36).
 */
const rutasTocadas = new Set();

function apuntarEstaciones(ruta) {
  if (ruta) rutasTocadas.add(String(ruta));
  for (const estacion of puntuacion.estacionesDe(ruta)) estacionesTocadas.add(estacion);
}

/**
 * Comprueba lo que el navegador no puede garantizar por si solo.
 *
 * Las reglas de Firestore validan la forma del documento y que el dueno sea
 * quien dice ser, pero no saben contar cuantos viajes ha subido alguien hoy ni
 * si la ruta existe de verdad. Eso se comprueba aqui, y lo que no cuadra se
 * rechaza sin llegar a gastar una pasada de OCR, que es lo mas lento del pipeline.
 *
 * Devuelve `null` si todo cuadra, o un problema con CODIGO. El codigo no es
 * decoracion: es lo unico que mira el navegador para explicarle el rechazo a la
 * persona (`assets/js/motivos.js`). Sin el, todos estos rechazos le llegarian
 * como "no hemos podido verificar la captura", que aqui seria mentira: no es la
 * captura, es la fecha o el cupo.
 */
async function validarBasico(viaje, uid) {
  const problema = (codigo, mensaje) => ({ codigo, mensaje });

  try {
    construirRuta(...String(viaje.ruta || '').split('-'));
  } catch {
    return problema('ruta_inexistente', 'La ruta declarada no existe.');
  }

  if (!Number.isInteger(viaje.tiempoSegundos)
    || viaje.tiempoSegundos < TIEMPO.MIN_SEGUNDOS
    || viaje.tiempoSegundos > TIEMPO.MAX_SEGUNDOS) {
    return problema('tiempo_fuera_de_rango', 'El tiempo declarado esta fuera de rango.');
  }

  const fecha = new Date(`${String(viaje.fechaViaje).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(fecha.getTime())) {
    return problema('fecha_no_valida', 'La fecha del viaje no es valida.');
  }

  const ahora = Date.now();
  if (fecha.getTime() > ahora + 864e5) {
    return problema('viaje_futuro', 'No se pueden registrar viajes futuros.');
  }
  if (ahora - fecha.getTime() > LIMITES.DIAS_MAX_ANTIGUEDAD * 864e5) {
    return problema('viaje_muy_antiguo',
      `Solo se admiten viajes de los ultimos ${LIMITES.DIAS_MAX_ANTIGUEDAD} dias.`);
  }

  // Cupo diario, contado en el servidor. En el navegador se puede saltar
  // cualquier limite abriendo la consola.
  const inicioHoy = inicioDelDiaMadrid(new Date());
  const hoy = await db.collection('tiempos_viaje')
    .where('uid', '==', uid)
    .where('creado', '>=', admin.firestore.Timestamp.fromMillis(inicioHoy))
    .get();

  // El propio viaje que estamos procesando cuenta dentro del resultado.
  if (hoy.size > LIMITES.VIAJES_POR_DIA) {
    return problema('cupo_diario', `Limite de ${LIMITES.VIAJES_POR_DIA} viajes al dia superado.`);
  }

  return null;
}

/** Veredicto de rechazo con una sola señal, para los cortes tempranos. */
function rechazoDirecto(codigo, mensaje) {
  return {
    decision: 'rechazado',
    resumen: mensaje,
    riesgo: 100,
    señales: [{ codigo, gravedad: 100, mensaje }],
  };
}

/**
 * Huellas de captura recientes, una vez por ejecucion.
 *
 * Era la lectura mas cara del worker: la MISMA ventana de huellas, releida
 * entera por cada viaje de la tanda. Con 25 viajes en una pasada eran 25 veces
 * los mismos documentos (docs/COSTE.md).
 *
 * Cachear no arriesga nada aqui: `huellas_captura` no la escribe nadie mas — las
 * reglas la tienen cerrada a cal y canto y solo la toca este worker con el Admin
 * SDK — y las ejecuciones no se solapan (`concurrency` en el workflow). Las que
 * escribe esta misma ejecucion se meten en la cache segun se crean, que es justo
 * lo que hace falta para pillar a quien sube la misma imagen dos veces seguidas.
 */
let huellasRecientes = null;

async function cargarHuellas() {
  if (huellasRecientes) return huellasRecientes;

  const snap = await db.collection('huellas_captura')
    .orderBy('creado', 'desc').limit(IMAGEN.VENTANA_COMPARACION).get();

  huellasRecientes = snap.docs.map((d) => ({ sha: d.id, ...d.data() }));
  return huellasRecientes;
}

/** Mete en la cache una huella recien escrita, sin volver a leer. */
function apuntarHuella(huella) {
  if (!huellasRecientes) return;
  huellasRecientes.unshift(huella);
  huellasRecientes.length = Math.min(huellasRecientes.length, IMAGEN.VENTANA_COMPARACION);
}

/** Contexto competitivo y estadistico que alimenta al motor. */
async function reunirContexto(viaje, uid, hashSha) {
  const [rutaSnap, propiosSnap, huellas, exacta] = await Promise.all([
    // El agregado de la ruta, no sus 200 mejores tiempos. Trae la distribucion
    // calculada sobre TODOS los tiempos del tramo — que es lo que la
    // comprobacion estadistica siempre quiso, y no lo que recibia — y el record
    // vigente en la primera fila. Una lectura en vez de doscientas.
    db.doc(`agregados/ruta-${viaje.ruta}`).get(),
    db.collection('tiempos_viaje')
      .where('uid', '==', uid).where('verificado', '==', true)
      .orderBy('creado', 'desc').limit(40).get(),
    cargarHuellas(),
    // El duplicado byte a byte NO se busca recorriendo la ventana: el id del
    // documento es el sha, asi que es una lectura directa. Ademas de costar una
    // en vez de cuatrocientas, pilla el duplicado por viejo que sea, y antes se
    // escapaba todo lo que hubiera salido de la ventana.
    hashSha ? db.collection('huellas_captura').doc(hashSha).get() : Promise.resolve(null),
  ]);

  const ruta = rutaSnap.exists ? rutaSnap.data() : {};
  const propios = propiosSnap.docs.map((d) => d.data());

  return {
    distribucionRuta: ruta.distribucion || null,
    // El agregado esta ordenado por marca, asi que el record es la primera fila.
    // Puede tener hasta quince minutos: un record recien batido y todavia no
    // agregado se compara contra el anterior, que como mucho hace que un viaje
    // buenisimo pase a revision. Es el lado correcto por el que equivocarse.
    mejorTiempoRuta: ruta.filas?.length ? ruta.filas[0].marca : null,
    mejorTiempoPropio: propios
      .filter((v) => v.ruta === viaje.ruta)
      .reduce((mejor, v) => (mejor === null || v.tiempoSegundos < mejor ? v.tiempoSegundos : mejor), null),
    velocidadesPrevias: propios
      .map((v) => {
        const metros = distanciaCalleMetros(...String(v.ruta || '').split('-'));
        return metros && v.tiempoSegundos ? (metros / v.tiempoSegundos) * 3.6 : null;
      })
      .filter(Boolean),
    // `capturaId` viaja con la huella para poder distinguir "la misma imagen
    // otra vez" de "varios trayectos de la misma captura" (#11).
    //
    // Es una lista de cero o un elemento, no la ventana entera: la busqueda
    // exacta ya la ha resuelto Firestore por el id del documento. El motor la
    // sigue recibiendo con la misma forma porque lo que tiene que decidir — si
    // el duplicado es de OTRA captura — no cambia.
    shaPrevios: exacta && exacta.exists
      ? [{
        sha: exacta.id,
        tripId: exacta.data().tripId,
        uid: exacta.data().uid,
        capturaId: exacta.data().capturaId || null,
      }]
      : [],
    hashesPrevios: huellas.map((h) => ({
      dhash: h.dhash, tripId: h.tripId, capturaId: h.capturaId || null,
    })),
  };
}

/** Procesa un viaje de principio a fin. */
async function procesar(doc) {
  const viaje = doc.data();
  const uid = viaje.uid;
  console.log(`\n[${doc.id}] ${viaje.username} — ruta ${viaje.ruta} en ${viaje.tiempoSegundos}s`);

  // 1. Validaciones que el cliente no puede garantizar.
  const problema = await validarBasico(viaje, uid);
  if (problema) {
    console.log(`  rechazado: ${problema.mensaje}`);
    if (!SIMULAR) await resolver(doc, rechazoDirecto(problema.codigo, problema.mensaje));
    return 'rechazado';
  }

  // 2. La captura vive en su propia coleccion, que el cliente no puede leer.
  // Varios viajes pueden apuntar a la MISMA captura, asi que el documento no
  // tiene por que llamarse como el viaje (#11). Los viajes de antes de eso no
  // llevan `capturaId` y siguen funcionando.
  const capturaId = viaje.capturaId || doc.id;
  const capturaSnap = await db.doc(`capturas/${capturaId}`).get();
  if (!capturaSnap.exists) {
    console.log('  rechazado: no hay captura asociada');
    if (!SIMULAR) {
      await resolver(doc, rechazoDirecto('captura_ausente', 'No se ha recibido la captura.'));
    }
    return 'rechazado';
  }

  let buffer;
  let mime;
  try {
    ({ buffer, mime } = imagen.decodificarDataUrl(capturaSnap.data().datos));
  } catch (error) {
    console.log(`  rechazado: captura invalida (${error.message})`);
    if (!SIMULAR) {
      await resolver(doc, rechazoDirecto('captura_invalida', 'La captura no es una imagen valida.'));
    }
    return 'rechazado';
  }

  // 3. Huellas y metadatos.
  const [hashSha, hashPerceptual, inspeccion] = await Promise.all([
    Promise.resolve(imagen.hashExacto(buffer)),
    imagen.hashPerceptual(buffer),
    imagen.inspeccionar(buffer),
  ]);

  // 4. Contexto competitivo y lectura de la captura.
  const contexto = await reunirContexto(viaje, uid, hashSha);

  // De todos los trayectos que haya en la captura, el que dice ser este viaje.
  // Sin esto, subir los tres viajes de una misma captura acabaria con dos
  // rechazados por `ruta_no_coincide`.
  const lectura = elegirTrayecto(await leerCaptura({ buffer, mime }), viaje.ruta);

  // 5. Veredicto.
  const veredicto = evaluar({
    ruta: viaje.ruta,
    tiempoSegundos: viaje.tiempoSegundos,
    lectura,
    capturaId,
    hashSha,
    hashPerceptual,
    edicionSospechosa: inspeccion.sospechaEdicion,
    software: inspeccion.software,
    ...contexto,
  });

  // Lo que se LEYO en la captura, para que la cola de revision pueda enseñar
  // lado a lado lo declarado y lo leido (#15). Sin esto, quien revisa ve las
  // señales ("la ruta no coincide") pero no CON QUE no coincide, y tiene que
  // abrir la captura y compararla a ojo en cada caso.
  //
  // Se guarda un resumen, no `lectura` entera: el texto completo del OCR puede
  // arrastrar lo que hubiera alrededor en la pantalla, y no hace falta.
  veredicto.lectura = lectura.disponible
    ? {
      origen: lectura.origen || null,
      destino: lectura.destino || null,
      horaSalida: lectura.horaSalida || null,
      horaLlegada: lectura.horaLlegada || null,
      segundosDuracion: lectura.segundosDuracion,
      confianza: lectura.confianza,
    }
    : null;

  console.log(`  -> ${veredicto.decision} (riesgo ${veredicto.riesgo}): ${veredicto.resumen}`);
  for (const s of veredicto.señales) console.log(`     [${s.gravedad}] ${s.mensaje}`);

  if (SIMULAR) return veredicto.decision;

  // 6. Guardar la huella para que la captura no se pueda reutilizar. `create`
  // y no `set`: si ya existe hay que conservar la del viaje original.
  const huella = { sha: hashSha, dhash: hashPerceptual, tripId: doc.id, capturaId, uid };
  await db.collection('huellas_captura').doc(hashSha).create({ ...huella, creado: AHORA() })
    .then(() => apuntarHuella(huella))
    .catch((error) => {
      if (error.code !== 6) throw error; // 6 = ALREADY_EXISTS
    });

  await resolver(doc, veredicto);
  return veredicto.decision;
}

/** Escribe el veredicto y, si procede, recalcula la clasificacion. */
async function resolver(doc, veredicto) {
  const viaje = doc.data();
  const aprobado = veredicto.decision === 'aprobado';

  await avisarPorPush(doc.id, viaje, veredicto.decision);

  await doc.ref.update({
    estado: veredicto.decision,
    verificado: aprobado,
    auditoria: veredicto,
    // De donde venia la captura. No decide nada, pero sin esto "el OCR falla a
    // veces" no se convierte nunca en "falla en recortes de iPhone".
    varianteCaptura: veredicto.varianteCaptura || null,
    revisadoPor: 'automatico',
    revisadoEn: AHORA(),
    // Marca para el aviso de revision lenta. En `false` y no ausente: un campo
    // que falta no lo devuelve ninguna consulta de Firestore, y sin poder
    // filtrar habria que traer la cola entera y descartar en memoria — que es
    // como los viajes ya avisados acaban ocupando el hueco de los nuevos.
    ...(veredicto.decision === 'revision' ? { avisoRevision: false } : {}),
  });

  if (aprobado) {
    await premiar(doc, viaje);
    // Los puntos de la ruta SI se rehacen viaje a viaje: cambian la
    // clasificacion y el siguiente viaje de la tanda tiene que verla al dia.
    // El dominio de las estaciones se apunta y se hace una vez al final.
    await puntuacion.recalcularRuta(viaje.ruta);
    apuntarEstaciones(viaje.ruta);
  }

  // Las capturas rechazadas no aportan nada y ocupan cuota: el hash ya impide
  // reutilizar la imagen, asi que el fichero en si sobra.
  if (veredicto.decision === 'rechazado') {
    await borrarCapturaSiSobra(doc, viaje);
    await avisarRechazo(viaje, veredicto);
  }
}

/**
 * Borra la captura de un viaje rechazado... salvo que la compartan otros.
 *
 * Desde #11 una misma captura puede sostener varios viajes (tres trayectos del
 * mismo dia en una sola imagen). Borrarla al rechazar UNO dejaria a los otros
 * dos sin imagen que analizar, y el worker los rechazaria a todos con "no se ha
 * recibido la captura". Solo se borra cuando ya no le sirve a nadie.
 */
async function borrarCapturaSiSobra(doc, viaje) {
  const capturaId = viaje.capturaId || doc.id;

  if (viaje.capturaId) {
    const hermanos = await db.collection('tiempos_viaje')
      .where('capturaId', '==', capturaId).get();

    const laNecesitaAlguien = hermanos.docs
      .some((d) => d.id !== doc.id && d.data().estado !== 'rechazado');

    if (laNecesitaAlguien) return;
  }

  await db.doc(`capturas/${capturaId}`).delete().catch(() => {});
}

/**
 * Avisa por correo de un rechazo automatico.
 *
 * Es el unico correo que se manda en el momento, y por un motivo: sin el, la
 * persona sube un viaje, no pasa nada y no sabe por que. Los avisos de viaje
 * aprobado NO van aqui, van agrupados, o se come el cupo diario de Resend en
 * cuanto haya unos pocos pilotos activos.
 *
 * Que falle el correo no puede afectar al veredicto: el viaje ya esta resuelto.
 */
/**
 * Manda un correo a un piloto, respetando su preferencia y su baja.
 *
 * Sale de `avisarRechazo`, que era el unico sitio que sabia hacer esto. Habia
 * tres plantillas mas escritas y probadas —bienvenida, viaje anulado y revision
 * lenta— que no enviaba nadie, y duplicar estas veinte lineas por cada una es
 * como se acaba enviando correo a quien pidio no recibirlo.
 *
 * `plantilla` recibe `{ nombre, tokenBaja, ...extra }`.
 *
 * `yaLeido` evita releer el perfil cuando quien llama ya lo tiene en la mano:
 * las bienvenidas salen de una consulta sobre `usuarios`, y sin esto cada
 * piloto nuevo costaba dos lecturas del mismo documento.
 *
 * @returns {boolean} si el correo ha salido
 */
async function avisarPorCorreo(uid, plantilla, extra = {}, yaLeido = null) {
  try {
    const refUsuario = db.doc(`usuarios/${uid}`);
    const usuario = yaLeido || await refUsuario.get();
    if (!usuario.exists) return false;

    const datos = usuario.data();

    // Respeta la preferencia. Un aviso sobre el propio viaje es transaccional y
    // se puede enviar sin consentimiento, pero a quien lo ha desactivado a
    // proposito no se le insiste.
    if (datos.avisosCorreo === false) return false;

    // El correo se pide a Firebase Auth, no al documento: ahi es donde vive
    // (#60), y ademas nunca esta obsoleto.
    // OJO con el nombre: `correo` es el modulo de envio importado arriba. Una
    // variable local con ese nombre lo taparia y `correo.enviar(...)` reventaria.
    let destinatario = null;
    try {
      destinatario = (await admin.auth().getUser(uid)).email || null;
    } catch {
      return false;   // cuenta borrada: no hay a quien avisar
    }
    if (!destinatario) return false;

    // El token de baja se crea la primera vez y se queda. Si cambiara en cada
    // correo, un enlace de hace dos dias dejaria de funcionar, que es justo lo
    // que hace que la gente marque spam.
    let tokenBaja = datos.tokenBaja;
    if (!tokenBaja) {
      tokenBaja = correo.generarTokenBaja();
      if (!SIMULAR) await refUsuario.update({ tokenBaja });
    }

    const mensaje = plantilla({ nombre: datos.username || 'piloto', tokenBaja, ...extra });

    const resultado = await correo.enviar({
      ...mensaje,
      para: destinatario,
      remitente: REMITENTE,
      apiKey: process.env.RESEND_API_KEY,
      simular: SIMULAR,
    });

    if (resultado.error) {
      console.warn(`  aviso no enviado a ${uid}: ${resultado.error}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`  no se ha podido avisar a ${uid}:`, err.message);
    return false;
  }
}

async function avisarRechazo(viaje, veredicto) {
  try {
    const usuario = await db.doc(`usuarios/${viaje.uid}`).get();
    if (!usuario.exists) return;

    const datos = usuario.data();

    // El correo se pide a Firebase Auth, no al documento. Ahi es donde vive de
    // verdad, y ademas nunca esta obsoleto: si alguien lo cambia en su cuenta,
    // una copia en Firestore se quedaria apuntando a la direccion vieja.
    // OJO con el nombre: `correo` es el modulo de envio importado arriba. Una
    // variable local con ese nombre lo tapa dentro de esta funcion y
    // `correo.enviar(...)` reventaria.
    let destinatario = null;
    try {
      destinatario = (await admin.auth().getUser(viaje.uid)).email || null;
    } catch {
      // Cuenta borrada: no hay a quien avisar.
      return;
    }
    if (!destinatario) return;

    // Respeta la preferencia, si la hay. Un rechazo es transaccional y se puede
    // enviar sin consentimiento, pero si alguien lo ha desactivado a proposito
    // no se le insiste.
    if (datos.avisosCorreo === false) return;

    // El token de baja se crea la primera vez que se le escribe y se queda.
    // Si cambiara en cada correo, un enlace de hace dos dias dejaria de
    // funcionar, que es justo lo que hace que la gente marque spam.
    let tokenBaja = datos.tokenBaja;
    if (!tokenBaja) {
      tokenBaja = correo.generarTokenBaja();
      if (!SIMULAR) await usuario.ref.update({ tokenBaja });
    }

    const mensaje = plantillas.viajeRechazado({
      nombre: datos.username || 'piloto',
      ruta: viaje.ruta,
      // `resumen` es el texto para la persona. Las señales con sus pesos se
      // quedan en la auditoria: no salen en el correo.
      motivo: veredicto.resumen,
      tokenBaja,
    });

    const resultado = await correo.enviar({
      ...mensaje,
      para: destinatario,
      remitente: REMITENTE,
      apiKey: process.env.RESEND_API_KEY,
      simular: SIMULAR,
    });

    if (resultado.error) console.warn(`  aviso no enviado: ${resultado.error}`);
  } catch (err) {
    console.warn('  no se ha podido avisar del rechazo:', err.message);
  }
}

/**
 * ¿Alguna de las dos estaciones la controla el clan del piloto?
 *
 * El bonus se aplica UNA VEZ aunque las controle las dos. Acumularlo premiaria
 * dar vueltas dentro del feudo propio, que es justo lo contrario de lo que
 * busca el mapa: que los clanes se disputen las fronteras.
 *
 * Y `clanDominante` es quien pasa del 50%, no quien va primero: en una estacion
 * en disputa no hay bonus para nadie. Tenerla a medias no es tenerla.
 */
async function tocaTerritorioPropio(uid, estaciones) {
  try {
    const usuario = await db.doc(`usuarios/${uid}`).get();
    const clan = usuario.exists ? usuario.data().clanId : null;
    if (!clan) return false;

    const stats = await db.getAll(
      ...estaciones.map((e) => db.doc(`estaciones_stats/${e}`)));

    return stats.some((d) => d.exists && d.data().clanDominante === clan);
  } catch (error) {
    // Sin esta informacion se puntua sin bonus, que es lo conservador: es peor
    // dar puntos de mas que de menos.
    console.warn('  no se ha podido comprobar el territorio:', error.message);
    return false;
  }
}

/**
 * Cierra un viaje aprobado: mide el trayecto, actualiza la racha del piloto y
 * le da los puntos que le tocan.
 *
 * Va en una transaccion sobre el documento del usuario porque la racha es
 * lectura-modificacion-escritura, y el worker puede aprobar dos viajes del
 * mismo piloto en la misma tanda: sin transaccion, el segundo pisaria al
 * primero. Los acumulados van con `increment` por el mismo motivo.
 *
 * La distancia y la velocidad NO las declara el usuario: salen del par de
 * estaciones y del tiempo, que es lo que el pipeline ya ha contrastado contra
 * la captura. Anadirlas al juego no abre superficie nueva de fraude.
 */
async function premiar(doc, viaje) {
  const [origen, destino] = String(viaje.ruta).split('-');

  const cache = {
    leer: async () => {
      const guardada = await db.doc(`distancias/${viaje.ruta}`).get();
      return guardada.exists ? guardada.data().metros : null;
    },
    escribir: async () => {},
  };

  const medida = await distancias.resolverConCache(origen, destino, cache);
  const metros = medida ? medida.metros : null;
  const kmh = distancias.velocidadKmh(metros, viaje.tiempoSegundos);

  const multRuta = await puntuacion.multiplicadorRuta(viaje.ruta);
  const cuando = new Date(`${String(viaje.fechaViaje).slice(0, 10)}T12:00:00Z`);

  const refUsuario = db.doc(`usuarios/${viaje.uid}`);
  let puntos;
  let ganadas = [];

  // Bonus por pedalear en territorio del propio clan. Se mira ANTES de la
  // transaccion: dentro no se pueden hacer lecturas sueltas despues de escribir,
  // y ademas estas dos son de otra coleccion.
  const enCasa = await tocaTerritorioPropio(viaje.uid, [origen, destino]);

  await db.runTransaction(async (tx) => {
    const usuario = await tx.get(refUsuario);
    if (!usuario.exists) return;

    const previo = usuario.data();
    const racha = rachas.registrarDiaActivo({
      racha: previo.racha,
      mejorRacha: previo.mejorRacha,
      escudos: previo.escudos,
      diasHastaEscudo: previo.diasHastaEscudo,
      ultimoDiaActivo: previo.ultimoDiaActivo,
    }, cuando);

    puntos = puntuacion.calcularPuntosViaje({
      distanciaMetros: metros,
      velocidadKmh: kmh,
      multiplicadorRuta: multRuta,
      racha: racha.racha,
      territorioPropio: enCasa,
    });

    // Insignias (#24). Se evaluan sobre el estado que va a QUEDAR, no sobre el
    // que habia: si no, la que se gana con este viaje no se concede hasta el
    // siguiente, y el momento en que la persona la esperaba ya paso.
    //
    // No cuesta ni una lectura: el documento ya esta leido para la transaccion,
    // y las reglas del catalogo solo miran campos suyos. Conceder una medalla
    // no puede salir mas caro que verificar el viaje que la gana.
    const nuevasInsignias = logros.nuevas({
      ...previo,
      viajesVerificados: (previo.viajesVerificados || 0) + 1,
      metrosTotales: (previo.metrosTotales || 0) + (metros || 0),
      mejorRacha: racha.mejorRacha,
    });

    // Misiones del dia (#30). Se generaban y se pintaban, pero NADIE escribia el
    // progreso: `misiones.progreso` estaba exportada y probada, y no la llamaba
    // nadie. La portada leia `perfil.misiones`, que no existia, asi que las tres
    // misiones ponian "Pendiente" para siempre y no habia forma de completarlas.
    //
    // No cuesta ni una lectura. Las misiones son deterministas a partir de la
    // fecha —por eso regenerarlas en cada pasada es inofensivo—, asi que aqui se
    // generan igual que las genero la pasada que las publico, sin leer el
    // documento. Y los totales se acumulan en el propio perfil, que la
    // transaccion ya tiene leido, en vez de consultar los viajes de hoy cada vez
    // que se aprueba uno.
    //
    // Solo cuenta si el viaje es de HOY. Un trayecto de hace cinco dias no puede
    // completar la mision de hoy, por el mismo motivo por el que no toca la
    // racha: no lo has hecho hoy.
    let progresoMisiones = null;
    const diaDelViaje = String(viaje.fechaViaje).slice(0, 10);

    if (diaDelViaje === diaMadrid()) {
      // Las estaciones donde ya habia terminado antes de este viaje. Sale de
      // `puntosPorRuta`, que ya esta en el documento: igual que hace `logros.js`
      // para las insignias de exploracion, y por la misma razon.
      const previas = new Set();
      for (const ruta of Object.keys(previo.puntosPorRuta || {})) {
        const suDestino = String(ruta).split('-')[1];
        if (suDestino) previas.add(suDestino);
      }

      const totales = misiones.acumular(
        previo.misiones, diaDelViaje,
        { distanciaMetros: metros, velocidadKmh: kmh },
        Boolean(destino) && !previas.has(destino)
      );

      progresoMisiones = {
        ...totales,
        progreso: misiones.progresoDeTotales(misiones.generar(diaDelViaje).misiones, totales),
      };
    }

    tx.update(refUsuario, {
      viajesVerificados: admin.firestore.FieldValue.increment(1),
      metrosTotales: admin.firestore.FieldValue.increment(metros || 0),
      segundosTotales: admin.firestore.FieldValue.increment(viaje.tiempoSegundos || 0),
      puntosTemporada: admin.firestore.FieldValue.increment(puntos.total),
      ...(progresoMisiones ? { misiones: progresoMisiones } : {}),
      racha: racha.racha,
      mejorRacha: racha.mejorRacha,
      escudos: racha.escudos,
      diasHastaEscudo: racha.diasHastaEscudo,
      ultimoDiaActivo: racha.ultimoDiaActivo,
      // Solo si hay algo nuevo. La mayoria de los viajes no desbloquean nada, y
      // un `arrayUnion` vacio es una escritura por viaje para confirmar que no
      // hay novedad.
      ...(nuevasInsignias.length
        ? { logros: admin.firestore.FieldValue.arrayUnion(...nuevasInsignias) }
        : {}),
    });

    if (nuevasInsignias.length) ganadas = nuevasInsignias;
  });

  if (!puntos) return;

  await doc.ref.update({
    distanciaMetros: metros,
    distanciaEstimada: medida ? medida.estimada : true,
    velocidadKmh: kmh === null ? null : Number(kmh.toFixed(2)),
    puntos: puntos.total,
    puntosDesglose: puntos.desglose,
    // Marca de que este viaje ya sumo. Es lo que permite deshacerlo despues sin
    // restar dos veces si el viaje se anula, se reactiva y se vuelve a anular.
    premiado: true,
  });

  console.log(`  +${puntos.total} puntos (${((metros || 0) / 1000).toFixed(2)} km`
    + `${kmh ? `, ${kmh.toFixed(1)} km/h` : ''}`
    + `${enCasa ? ', en territorio propio' : ''}`
    + `${medida && medida.estimada ? ', distancia estimada' : ''})`);

  if (ganadas.length) console.log(`  insignias: ${ganadas.join(', ')}`);
}

/**
 * Deshace lo que sumo un viaje que despues se ha anulado.
 *
 * Se resta EXACTAMENTE lo que se guardo en el propio viaje, no lo que se
 * volveria a calcular hoy: entre medias pueden haber cambiado los umbrales de
 * `config.js`, la racha del piloto o la ruta del dia, y recalcular restaria una
 * cantidad distinta de la que se sumo. La marca `premiado` evita restar dos
 * veces si el viaje se anula, se reactiva y se vuelve a anular.
 *
 * La RACHA no se toca, y es deliberado. Deshacerla bien exigiria saber si ese
 * dia le quedaban otros viajes verificados y, si no, recomponer la cadena
 * entera desde ahi. Desproporcionado para lo que es: la racha premia haber
 * aparecido, no la marca conseguida, y quitarsela meses despues a alguien
 * castiga mas de lo que corrige.
 */
async function revertirPremio(doc, viaje) {
  const refUsuario = db.doc(`usuarios/${viaje.uid}`);
  const menos = admin.firestore.FieldValue.increment;

  await refUsuario.update({
    viajesVerificados: menos(-1),
    metrosTotales: menos(-(viaje.distanciaMetros || 0)),
    segundosTotales: menos(-(viaje.tiempoSegundos || 0)),
    puntosTemporada: menos(-(viaje.puntos || 0)),
  }).catch((err) => {
    // Si el usuario ya no existe (cuenta borrada), no hay nada que devolver.
    console.warn(`No se han podido revertir los acumulados de ${viaje.uid}:`, err.message);
  });

  await doc.ref.update({ premiado: false });
  console.log(`  [${doc.id}] revertidos ${viaje.puntos || 0} puntos y `
    + `${((viaje.distanciaMetros || 0) / 1000).toFixed(2)} km`);

  // Y se le dice. Anular un viaje le quita a alguien puntos que ya tenia: si no
  // se avisa, lo que ve es que su puntuacion ha bajado sola de un dia para otro
  // y no hay forma de que sepa por que. La plantilla existia desde el principio
  // y no la enviaba nadie.
  await avisarPorCorreo(viaje.uid, plantillas.viajeAnulado, {
    ruta: viaje.ruta,
    motivo: viaje.motivoRevision || viaje.auditoria?.resumen
      || 'Una revision posterior no ha podido dar el trayecto por bueno.',
  });
}

/**
 * Cuantos viajes verificados tiene cada tramo.
 *
 * Sale del indice que deja la reconstruccion de agregados: una lectura. El
 * respaldo cuenta a mano leyendo la coleccion entera, que es lo que se hacia
 * siempre, y solo hace falta la primera vez, antes de que exista el indice.
 */
async function conteoPorRuta() {
  const indice = await db.doc('agregados/rutas').get();
  const conteos = indice.exists ? indice.data().viajesPorRuta : null;

  if (conteos && Object.keys(conteos).length) return new Map(Object.entries(conteos));

  const viajes = await db.collection('tiempos_viaje').where('verificado', '==', true).get();
  const porRuta = new Map();
  for (const d of viajes.docs) {
    const ruta = d.data().ruta;
    if (ruta) porRuta.set(ruta, (porRuta.get(ruta) || 0) + 1);
  }
  return porRuta;
}

/**
 * Deja listas las misiones del dia y la ruta destacada.
 *
 * Se llama en cada pasada y no pasa nada: las misiones se generan de forma
 * DETERMINISTA a partir de la fecha, asi que regenerarlas da lo mismo. Eso
 * evita depender de un cron a medianoche que, si se salta, dejaria el dia sin
 * misiones.
 *
 * La ruta del dia si se fija una vez: se guarda con su fecha y no se vuelve a
 * elegir hasta el dia siguiente. Cambiarla a media mañana invalidaria la
 * clasificacion diaria que la gente ya esta compitiendo.
 */
async function prepararDia() {
  // El dia en Madrid, NO en UTC. `territorio.dia()` da el dia UTC, que en
  // horario de verano va dos horas por detras: las misiones se publicaban con
  // esa clave y el navegador las pedia con la suya, asi que entre las 22:00 y
  // las 00:00 el documento que buscaba no existia todavia y la seccion de
  // misiones desaparecia de la portada cada noche.
  const hoy = diaMadrid();
  const refMisiones = db.doc(`config/misiones/dias/${hoy}`);

  if (!(await refMisiones.get()).exists) {
    if (!SIMULAR) await refMisiones.set(misiones.generar(hoy));
    console.log(`Misiones del ${hoy} preparadas.`);
  }

  const refGeneral = db.doc('config/general');
  const general = await refGeneral.get();
  const datos = general.exists ? general.data() : {};

  if (datos.rutaDestacadaDia === hoy) return;

  // Cuantos viajes tiene cada tramo, para descartar los que no mueve nadie.
  //
  // Sale del indice de rutas, que el worker ya deja escrito al reconstruir los
  // agregados: una lectura en vez de la coleccion de viajes ENTERA, que con
  // 15.000 acumulados era una de las tres cosas que quedaban leyendola entera.
  // Si el indice todavia no existe — proyecto recien estrenado — se cuenta a
  // mano una vez, que es exactamente lo que hacia antes siempre.
  const porRuta = await conteoPorRuta();

  const recientes = Array.isArray(datos.rutasHistoricas) ? datos.rutasHistoricas.slice(-7) : [];
  const elegida = misiones.rutaDelDia(porRuta, recientes, hoy);

  if (!elegida) {
    console.log('Sin tramos con actividad suficiente: hoy no hay ruta del dia.');
    return;
  }

  if (!SIMULAR) {
    await refGeneral.set({
      rutaDestacada: elegida,
      rutaDestacadaDia: hoy,
      // Las ya destacadas conservan un multiplicador menor, y ademas sirven
      // para no repetir tramo cada dos por tres.
      rutasHistoricas: admin.firestore.FieldValue.arrayUnion(elegida),
    }, { merge: true });
  }

  console.log(`Ruta del dia: ${elegida}`);
}

/**
 * Procesa las bajas de correo pedidas desde el enlace del propio correo.
 *
 * El navegador solo puede CREAR `solicitudes_baja/{token}`: no puede leer esa
 * coleccion ni tocar el perfil de nadie. Aqui se cambia el token por su dueño y
 * se apagan sus avisos.
 *
 * Se borra la solicitud siempre, incluso si el token ya no corresponde a nadie.
 * Si no, un token caducado se quedaria dando vueltas en cada pasada, y esa
 * coleccion la escribe gente sin sesion: es justo la que no debe acumular.
 */
async function procesarBajas() {
  const solicitudes = await db.collection('solicitudes_baja').limit(50).get();
  if (solicitudes.empty) return 0;

  let dadas = 0;

  for (const solicitud of solicitudes.docs) {
    const token = solicitud.id;

    const usuarios = await db.collection('usuarios')
      .where('tokenBaja', '==', token).limit(1).get();

    if (!usuarios.empty) {
      if (!SIMULAR) await usuarios.docs[0].ref.update({ avisosCorreo: false });
      dadas++;
    }

    if (!SIMULAR) await solicitud.ref.delete().catch(() => {});
  }

  console.log(`Bajas de correo procesadas: ${dadas} de ${solicitudes.size} solicitudes.`);
  return dadas;
}

/**
 * Ejecuta las solicitudes de borrado de cuenta (RGPD art. 17).
 *
 * Esto no lo hacia nadie: la politica lo prometia, el perfil dejaba pedirlo y
 * las peticiones se acumulaban en `solicitudes_borrado` sin que las procesara
 * nunca nada. Prometer un derecho y no ejecutarlo es peor que no ofrecerlo.
 *
 * Se procesan pocas por pasada a proposito: cada una toca varias colecciones y
 * una tanda grande se comeria el tiempo del worker, que es lo que verifica los
 * viajes de todo el mundo. Como corre cada 5 minutos, cinco por pasada son
 * 1.440 al dia: de sobra.
 */
async function procesarBorrados() {
  const solicitudes = await db.collection('solicitudes_borrado').limit(5).get();
  if (solicitudes.empty) return 0;

  let hechos = 0;

  for (const solicitud of solicitudes.docs) {
    try {
      const resumen = await borrado.ejecutar(solicitud.id, { simular: SIMULAR });
      console.log(`  ${solicitud.id}: ${resumen.viajes} viajes anonimizados, `
        + `${resumen.capturas} capturas y ${resumen.subcolecciones} documentos de subcoleccion borrados`);
      hechos++;
    } catch (error) {
      // Que falle un borrado no puede parar los demas ni tumbar la
      // verificacion. La solicitud se queda y se reintenta: `ejecutar` es
      // idempotente justo para esto.
      console.error(`  ERROR borrando ${solicitud.id}:`, error.message);
    }
  }

  console.log(`Borrados de cuenta: ${hechos} de ${solicitudes.size} solicitudes.`);
  return hechos;
}

/**
 * Aplica las decisiones que un administrador ha marcado desde el panel.
 *
 * El admin puede escribir `estado` gracias a su custom claim, pero recalcular
 * la clasificacion desde el navegador costaria cientos de lecturas. Marca la
 * decision y el worker hace el trabajo pesado.
 */
async function aplicarDecisionesManuales() {
  const pendientes = await db.collection('tiempos_viaje')
    .where('recalculoPendiente', '==', true).limit(20).get();

  if (pendientes.empty) return 0;

  const rutas = new Set();
  for (const doc of pendientes.docs) {
    const viaje = doc.data();
    rutas.add(viaje.ruta);

    // Un viaje que ya habia sumado y que deja de estar verificado hay que
    // deshacerlo, o el piloto se queda con los kilometros y los puntos de un
    // viaje anulado.
    if (viaje.premiado === true && viaje.verificado !== true) {
      if (!SIMULAR) await revertirPremio(doc, viaje);
      else console.log(`  [${doc.id}] se revertirian ${viaje.puntos || 0} puntos`);
    }

    if (!SIMULAR) await doc.ref.update({ recalculoPendiente: false });
  }

  if (!SIMULAR) {
    for (const ruta of rutas) {
      await puntuacion.recalcularRuta(ruta);
      apuntarEstaciones(ruta);
    }
  }

  console.log(`Recalculadas ${rutas.size} rutas tras decisiones manuales.`);
  return pendientes.size;
}

/**
 * Avisa por push de que un trayecto se ha resuelto (#33).
 *
 * Llega antes que el correo y sin molestar: es lo que la persona esta esperando
 * desde que subio la captura. Nunca lanza — un fallo de push no puede tumbar la
 * verificacion — y no se envia nada a quien no lo haya aceptado: `push.enviar`
 * comprueba la suscripcion y el tipo de aviso.
 */
async function avisarPorPush(viajeId, viaje, decision) {
  const textos = {
    aprobado: { titulo: 'Trayecto verificado', cuerpo: 'Ya cuenta en la clasificacion.' },
    rechazado: { titulo: 'Trayecto rechazado', cuerpo: 'Entra para ver por que.' },
    revision: { titulo: 'Trayecto en revision', cuerpo: 'Lo va a mirar una persona.' },
  };
  const texto = textos[decision];
  if (!texto) return;

  try {
    await push.enviar(viaje.uid, 'viajeResuelto', { ...texto, url: '/yo/' }, { simular: SIMULAR });
  } catch (error) {
    console.warn(`  push no enviado (${viajeId}):`, error.message);
  }
}

/**
 * Avisa a quien tiene la racha en peligro (#33).
 *
 * A las 20:00 de Madrid: queda tarde para salir, y es lo bastante pronto como
 * para que dé tiempo. Antes seria pesado; mas tarde, inutil.
 *
 * Se manda UNA vez al dia por persona, y solo a quien tiene racha que perder y
 * no ha salido todavia. Avisar a quien ya salio, o dos veces, es como se
 * desactivan los avisos para siempre.
 */
async function avisarRachasEnPeligro() {
  const hora = Number(new Date().toLocaleString('en-US', {
    timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false,
  }));

  // La ventana es de una hora: el worker corre cada cinco minutos y GitHub
  // retrasa los cron, asi que exigir una hora exacta se saltaria dias enteros.
  //
  // La comprobacion de la hora va ANTES de leer nada: esto se ejecuta en las 288
  // pasadas del dia y solo hace algo en una.
  if (hora !== 20) return 0;

  // Solo `usuarios`. Antes tiraba de la carga compartida, que traia ademas
  // `tiempos_viaje` entera: 15.000 lecturas al dia para un aviso que no mira ni
  // un viaje.
  const snap = await db.collection('usuarios').get();
  const usuarios = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  // El dia en Madrid, que es el que decide si alguien ha salido "hoy". A las
  // 20:00 coincide con el UTC, pero atarlo al dia correcto evita que esto se
  // rompa el dia que alguien mueva la hora del aviso.
  const hoy = diaMadrid();
  const enPeligro = push.rachaEnPeligro(usuarios, hoy);

  if (!enPeligro.length) return 0;

  let avisados = 0;
  for (const usuario of enPeligro) {
    try {
      const resultado = await push.enviar(usuario.uid, 'rachaEnPeligro', {
        titulo: `Tu racha de ${usuario.racha} dias`,
        cuerpo: usuario.escudos > 0
          ? 'Si no sales hoy se gasta un escudo.'
          : 'Si no sales hoy la pierdes.',
        url: '/subir/',
      }, { simular: SIMULAR });

      if (resultado.enviados > 0) {
        avisados++;
        // La marca del dia impide el segundo aviso. Se escribe DESPUES de
        // enviar: al reves, un fallo de envio dejaria a la persona sin aviso y
        // marcada como avisada.
        if (!SIMULAR) {
          await db.doc(`usuarios/${usuario.uid}`).update({ 'push.ultimoAvisoRacha': hoy });
        }
      }
    } catch (error) {
      console.warn(`  aviso de racha a ${usuario.uid}:`, error.message);
    }
  }

  if (avisados) console.log(`Avisos de racha en peligro: ${avisados}.`);
  return avisados;
}

/**
 * Cierra los dias perdidos de todo el mundo: gasta escudos y rompe las rachas
 * que ya no se sostienen.
 *
 * `rachas.cerrarDiasPerdidos` existia, estaba probada y su propia documentacion
 * decia "lo llama la pasada diaria del worker". No la llamaba nadie: no habia
 * pasada diaria. El efecto era que **ninguna racha se rompia nunca** y **ningun
 * escudo se gastaba jamas**. Quien salio una vez en septiembre seguia con su
 * racha intacta en el perfil en diciembre, y el escudo —la mecanica que hace
 * que valga la pena mantener la racha— no protegia de nada porque no habia nada
 * de lo que proteger.
 *
 * UNA VEZ AL DIA, y de verdad una: la marca en `config/juego/rachas` cuesta una
 * lectura y evita repetir el recorrido de `usuarios` en las doce pasadas que
 * caen dentro de la ventana de medianoche.
 *
 * La operacion es idempotente de todas formas — al sobrevivir la racha se mueve
 * `ultimoDiaActivo` a ayer para no cobrar dos veces por los mismos dias, y al
 * romperse `racha` queda en 0 y la siguiente llamada no hace nada — pero
 * idempotente no quiere decir gratis.
 */
/**
 * Da la bienvenida a quien acaba de registrarse.
 *
 * La plantilla estaba escrita y probada desde #46 y no la enviaba nadie: nadie
 * ha recibido nunca el correo de bienvenida.
 *
 * Va en cada pasada y no en el trabajo diario porque un saludo que llega al dia
 * siguiente no es un saludo. La consulta es indexada y acotada: cuesta tanto
 * como pilotos nuevos haya, que casi siempre son cero.
 */
async function darBienvenidas() {
  try {
    const nuevos = await db.collection('usuarios')
      .where('bienvenidaEnviada', '==', false)
      .limit(20)
      .get();

    if (nuevos.empty) return 0;

    let saludados = 0;

    for (const doc of nuevos.docs) {
      const enviado = await avisarPorCorreo(doc.id, plantillas.bienvenida, {}, doc);

      // La marca se pone salga o no el correo. Si ha fallado, reintentarlo en
      // la siguiente pasada tampoco va a arreglarlo, y sin marca este perfil
      // volveria a salir en la consulta 288 veces al dia.
      if (!SIMULAR) await doc.ref.update({ bienvenidaEnviada: true });
      if (enviado) saludados++;
    }

    if (saludados) console.log(`Bienvenidas: ${saludados} piloto(s) nuevo(s).`);
    return saludados;
  } catch (error) {
    console.warn('No se han podido enviar las bienvenidas:', error.message);
    return 0;
  }
}

/**
 * Avisa de los viajes que llevan demasiado tiempo esperando a una persona.
 *
 * Un viaje que cae en revision manual no tiene plazo: se queda ahi hasta que
 * alguien abra el panel. Desde fuera es indistinguible de que se haya perdido, y
 * la plantilla para decirlo llevaba escrita desde el principio sin que la
 * enviara nadie.
 *
 * La marca `avisoRevision` va en el propio viaje, y la escribe `resolver()` en
 * `false` al mandarlo a revision. Dos razones, y la segunda no es evidente:
 *
 *   1. sin marca el aviso saldria en cada pasada, o sea 288 veces al dia
 *   2. la consulta puede FILTRAR por ella. Filtrar en memoria sobre los
 *      primeros 50 parecia equivalente y no lo es: un viaje sigue en revision
 *      hasta que una persona lo resuelve, asi que los ya avisados se quedan
 *      ocupando el hueco, y con la cola cargada los nuevos no llegan a mirarse
 *      nunca
 *
 * Solo entran los que manda a revision el worker. Los que llegan por una
 * impugnacion o porque la administracion los mueve a mano no llevan la marca y
 * no se avisan, que es lo correcto: en los dos casos quien esta al otro lado ya
 * sabe que el viaje esta ahi.
 */
async function avisarRevisionesLentas() {
  try {
    const limite = Date.now() - HORAS_REVISION_LENTA * 3600 * 1000;

    const enRevision = await db.collection('tiempos_viaje')
      .where('estado', '==', 'revision')
      .where('avisoRevision', '==', false)
      .limit(50)
      .get();

    if (enRevision.empty) return 0;

    let avisados = 0;

    for (const doc of enRevision.docs) {
      const viaje = doc.data();

      const desde = viaje.revisadoEn?.toMillis?.() ?? viaje.creado?.toMillis?.() ?? null;
      if (desde === null || desde > limite) continue;

      const enviado = await avisarPorCorreo(viaje.uid, plantillas.revisionLenta, { ruta: viaje.ruta });

      // La marca va DESPUES del envio, y se pone tambien si el correo no sale:
      // reintentarlo cada pasada no lo va a arreglar, y sin marca este viaje
      // volveria a intentarlo 288 veces al dia.
      if (!SIMULAR) await doc.ref.update({ avisoRevision: true });
      if (enviado) avisados++;
    }

    if (avisados) console.log(`Revisiones lentas: ${avisados} piloto(s) avisado(s).`);
    return avisados;
  } catch (error) {
    console.warn('No se ha podido avisar de las revisiones lentas:', error.message);
    return 0;
  }
}

/**
 * Lo que se hace una vez al dia, y una sola.
 *
 * Las dos operaciones de aqui recorren colecciones enteras, y el worker se
 * despierta cada cinco minutos: sin una marca, cada una se repetiria 288 veces
 * al dia. La marca cuesta UNA lectura de un solo documento y las agrupa a las
 * dos, en vez de una marca por operacion.
 *
 * La marca se escribe al FINAL. Si la ejecucion se corta a medias, la siguiente
 * pasada lo reintenta entero: las dos operaciones son idempotentes, asi que a
 * quien ya se proceso no le vuelve a pasar nada.
 */
async function trabajoDiario() {
  const hoy = diaMadrid();
  // Un documento suelto bajo `config`, como `config/agregados_pendientes`. Solo
  // lo toca el Admin SDK: el cierre por defecto de las reglas lo deja fuera del
  // alcance del navegador sin tener que decir nada.
  const ref = db.doc('config/trabajo_diario');

  try {
    const marca = await ref.get();
    if (marca.exists && marca.data().ultimoDia === hoy) return false;

    await cerrarRachas();
    await avisarRevisionesLentas();

    const rescatados = await clanes.rescatarSinLider({ simular: SIMULAR });
    if (rescatados) console.log(`Clanes: ${rescatados} rescatado(s) de un lider inactivo.`);

    if (!SIMULAR) await ref.set({ ultimoDia: hoy }, { merge: true });
    return true;
  } catch (error) {
    // Que esto falle no puede parar la verificacion de viajes.
    console.warn('El trabajo diario no ha podido terminar:', error.message);
    return false;
  }
}

async function cerrarRachas() {
  try {
    const snap = await db.collection('usuarios').get();

    let lote = db.batch();
    let enLote = 0;
    let tocados = 0;
    let rotas = 0;
    let escudosGastados = 0;

    for (const doc of snap.docs) {
      const datos = doc.data();
      const cierre = rachas.cerrarDiasPerdidos({
        racha: datos.racha,
        mejorRacha: datos.mejorRacha,
        escudos: datos.escudos,
        diasHastaEscudo: datos.diasHastaEscudo,
        ultimoDiaActivo: datos.ultimoDiaActivo,
      });

      // La inmensa mayoria no ha perdido nada: escribirles seria una escritura
      // por usuario y por dia para confirmar que no ha pasado nada.
      if (!cierre.escudosGastados && !cierre.rota) continue;

      if (!SIMULAR) {
        lote.update(doc.ref, {
          racha: cierre.racha,
          escudos: cierre.escudos,
          ultimoDiaActivo: cierre.ultimoDiaActivo,
        });
        enLote++;
      }

      tocados++;
      if (cierre.rota) rotas++;
      escudosGastados += cierre.escudosGastados;

      if (enLote >= 400) {
        await lote.commit();
        lote = db.batch();
        enLote = 0;
      }
    }

    if (enLote) await lote.commit();

    if (tocados) {
      console.log(`Rachas: ${rotas} rotas, ${escudosGastados} escudo(s) gastado(s), `
        + `${tocados} piloto(s) afectado(s).`);
    }
    return tocados;
  } catch (error) {
    // Que esto falle no puede parar la verificacion de viajes.
    console.warn('No se han podido cerrar las rachas:', error.message);
    return 0;
  }
}

/**
 * Lo que la gestion de clanes no puede hacer desde el navegador (#29).
 *
 * Al expulsar a alguien, o al disolver un clan, solo se toca el documento del
 * clan: nadie puede escribir en el documento de otra persona, y a quien acaban
 * de expulsar no se le va a pedir que colabore. Su `clanId` se queda apuntando
 * a un clan que ya no le lista.
 *
 * No afecta a la puntuacion — el clan suma desde su plantilla — pero su perfil
 * dice que sigue en un clan del que ya no es.
 */
/**
 * Resuelve las peticiones de entrar con un enlace de invitacion (#29).
 *
 * `clanes.aplicarInvitacion` estaba escrita, probada y sin llamar. Y la otra
 * punta tampoco encajaba: el navegador se limitaba a meter al candidato en
 * `solicitudes`, o sea a convertir el enlace en una solicitud normal que el
 * lider tenia que aprobar a mano — justo lo que un enlace de invitacion existe
 * para evitar — y el codigo no se guardaba en ningun sitio, asi que aqui no
 * habia forma de saber que invitacion gastar.
 *
 * El resultado se escribe en la propia peticion en vez de borrarla: su dueño
 * puede leerla, asi que es por donde se entera de que su invitacion habia
 * caducado o que el clan estaba lleno. Borrarla dejaria a la persona mirando una
 * pantalla que no cambia.
 */
async function procesarInvitaciones() {
  try {
    const pendientes = await db.collection('usos_invitacion')
      .where('estado', '==', 'pendiente')
      .limit(50)
      .get();

    if (pendientes.empty) return 0;

    let entrados = 0;

    for (const doc of pendientes.docs) {
      const { codigo, uid } = doc.data();
      if (!codigo || !uid) continue;

      const resultado = await clanes.aplicarInvitacion(codigo, uid, { simular: SIMULAR });

      if (!SIMULAR) {
        await doc.ref.update({
          estado: resultado.entrado ? 'entrado' : 'rechazado',
          motivo: resultado.motivo || null,
          clanId: resultado.clanId || null,
          resuelta: AHORA(),
        });
      }

      if (resultado.entrado) entrados++;
      else console.log(`  invitacion ${codigo} para ${uid}: ${resultado.motivo}`);
    }

    if (entrados) console.log(`Invitaciones: ${entrados} piloto(s) han entrado en su clan.`);
    return entrados;
  } catch (error) {
    // Que esto falle no puede parar la verificacion de viajes.
    console.warn('No se han podido resolver las invitaciones:', error.message);
    return 0;
  }
}

async function mantenerClanes() {
  try {
    const limpiados = await clanes.limpiarHuerfanos({ simular: SIMULAR });
    if (limpiados) console.log(`Clanes: ${limpiados} usuario(s) sin clan actualizado(s).`);

    return limpiados;
  } catch (error) {
    // Que esto falle no puede parar la verificacion de viajes.
    console.warn('No se han podido limpiar los clanes:', error.message);
    return 0;
  }
}

/**
 * Estado de la cuota al empezar la ejecucion.
 *
 * Se lee UNA vez, al principio, y se usa para decidir si esta pasada tiene que
 * ir en modo degradado. Una lectura al dia... bueno, 288, pero de un solo
 * documento: es lo mas barato que se puede pagar por no quedarse sin web a las
 * seis de la tarde.
 */
async function leerCuota() {
  try {
    const snap = await db.doc(`cuota/${cuota.dia()}`).get();
    return snap.exists ? snap.data() : { lecturas: 0, escrituras: 0, avisado: null };
  } catch {
    // Sin dato no se degrada nada: prefiero gastar de mas a apagar la web por
    // no haber podido leer un contador.
    return { lecturas: 0, escrituras: 0, avisado: null };
  }
}

/**
 * Cierra la contabilidad de la pasada: la registra y avisa si toca (#38).
 *
 * Va lo ultimo a proposito, para contar tambien lo que ha costado el trabajo
 * periodico. Nada de aqui puede tumbar el worker: si falla, se avisa por
 * consola y se sigue.
 */
async function cerrarCuota(alEmpezar) {
  if (SIMULAR) {
    console.log(`\nCoste de la pasada (simulada): ${costeDeLaPasada.lecturas} lecturas, `
      + `${costeDeLaPasada.escrituras} escrituras.`);
    return;
  }

  const acumulado = {
    lecturas: (alEmpezar.lecturas || 0) + costeDeLaPasada.lecturas,
    escrituras: (alEmpezar.escrituras || 0) + costeDeLaPasada.escrituras,
  };

  const estado = cuota.nivel(acumulado);
  console.log(`\nCoste de la pasada: ${costeDeLaPasada.lecturas} lecturas, `
    + `${costeDeLaPasada.escrituras} escrituras. `
    + `Hoy va el ${Math.round(estado.porcentaje)}% de la cuota (solo worker).`);

  const aviso = cuota.avisoPendiente(acumulado, alEmpezar.avisado || null);

  try {
    await cuota.registrar(costeDeLaPasada);
    if (aviso) {
      await db.doc(`cuota/${cuota.dia()}`).set({ avisado: aviso.nivel }, { merge: true });
    }
  } catch (error) {
    console.warn('No se ha podido registrar el consumo:', error.message);
  }

  if (!aviso) return;

  const destinatario = process.env.CORREO_ADMIN;
  if (!destinatario) {
    console.warn(`::warning::Cuota al ${Math.round(aviso.porcentaje)}%, `
      + 'y sin CORREO_ADMIN no hay a quien avisar.');
    return;
  }

  try {
    const mensaje = plantillas.cuotaEnPeligro({
      nivel: aviso.nivel,
      porcentaje: aviso.porcentaje,
      consumido: acumulado,
      proyeccion: cuota.estimar(acumulado),
      limites: cuota.LIMITES,
    });

    const resultado = await correo.enviar({
      ...mensaje,
      para: destinatario,
      remitente: REMITENTE,
      apiKey: process.env.RESEND_API_KEY,
    });

    if (resultado.error) console.warn(`  aviso de cuota no enviado: ${resultado.error}`);
    else console.log(`  avisado a la administracion: nivel ${aviso.nivel}.`);
  } catch (error) {
    console.warn('  no se ha podido avisar de la cuota:', error.message);
  }
}

/**
 * Una pasada por la cola. Devuelve cuantos viajes habia.
 *
 * Separada de `main` para poder repetirla dentro de la misma ejecucion sin
 * repetir tambien el trabajo periodico (metricas, agregados, temporadas), que
 * es lo caro y basta con hacerlo una vez.
 */
async function procesarCola(cuenta) {
  const cola = await db.collection('tiempos_viaje')
    .where('estado', '==', 'pendiente')
    .orderBy('creado', 'asc')
    .limit(MAX_POR_TANDA)
    .get();

  console.log(`Viajes en cola: ${cola.size}`);

  for (const doc of cola.docs) {
    try {
      const decision = await procesar(doc);
      cuenta[decision] = (cuenta[decision] || 0) + 1;
    } catch (error) {
      cuenta.error++;
      console.error(`  ERROR procesando ${doc.id}:`, error.message);
      // Un fallo no debe dejar el viaje atascado en la cola para siempre: pasa
      // a revision manual, que es el estado seguro.
      if (!SIMULAR) {
        await doc.ref.update({
          estado: 'revision',
          avisoRevision: false,
          auditoria: {
            resumen: 'El analisis automatico ha fallado. Requiere revision humana.',
            riesgo: 50,
            señales: [{ codigo: 'error_worker', gravedad: 50, mensaje: error.message }],
          },
        }).catch(() => {});
      }
    }
  }

  return cola.size;
}

async function main() {
  console.log(SIMULAR ? '=== SIMULACION: no se escribe nada ===' : '=== Worker de verificacion ===');

  const cuenta = { aprobado: 0, rechazado: 0, revision: 0, error: 0 };

  // Lo gastado hoy antes de empezar. Decide si esta pasada va en modo degradado.
  const cuotaAlEmpezar = SIMULAR ? { lecturas: 0, escrituras: 0 } : await leerCuota();
  const degradado = cuota.nivel(cuotaAlEmpezar).nivel === 'degradado';

  // En simulacion NO se dan mas pasadas: como no se escribe el veredicto, los
  // viajes siguen pendientes y la siguiente pasada volveria a analizar los
  // mismos, en bucle, hasta agotar la ventana.
  const daVueltas = VENTANA_MS > 0 && !SIMULAR && !SOLO_UNO;
  const hasta = Date.now() + VENTANA_MS;
  let pasadas = 0;

  for (;;) {
    pasadas++;
    const habia = await procesarCola(cuenta);

    if (!daVueltas || Date.now() >= hasta) break;

    // Si la cola venia llena pueden quedar viajes por encima del tope de la
    // tanda: se sigue sin esperar. Si venia a medias, se duerme hasta la
    // siguiente pasada.
    if (habia >= MAX_POR_TANDA) continue;
    await esperar(Math.min(ESPERA_MS, Math.max(0, hasta - Date.now())));
  }

  if (pasadas > 1) console.log(`\n${pasadas} pasadas a la cola en esta ejecucion.`);

  await prepararDia();
  await aplicarDecisionesManuales();
  await procesarBajas();
  await procesarBorrados();
  await mantenerClanes();
  await procesarInvitaciones();
  await darBienvenidas();
  await trabajoDiario();

  // Los agregados se reconstruyen UNA VEZ al final, no por viaje: es la
  // operacion mas cara que hace el worker (#36).
  //
  // `usuarios` y `tiempos_viaje` se cargan aqui una sola vez y se comparten con
  // el resumen de metricas, que necesita exactamente las mismas dos. Cuando las
  // dos cosas caen en la misma pasada — que es justo cuando ha habido
  // movimiento — leerlas por separado costaba el doble (#34).
  const huboMovimiento = cuenta.aprobado > 0 || cuenta.rechazado > 0;

  // Reconstruir los agregados lee las CUATRO colecciones enteras: es la
  // operacion mas cara que queda. Hacerlo en cada pasada con movimiento son
  // unas treinta veces al dia, y quince minutos de antiguedad no se notan —
  // el worker ya llega con 5-15 de retraso, asi que la clasificacion nunca ha
  // sido instantanea (docs/COSTE.md).
  //
  // Quien acaba de subir un trayecto ve su veredicto por el seguimiento en vivo
  // del propio viaje, que no pasa por los agregados.
  const rehacerAgregados = huboMovimiento
    && !SIMULAR
    && await agregados.tocaReconstruir().catch(() => true);

  // Modo degradado (#38): por encima del 95% de la cuota se deja de hacer lo
  // que mas lee. La clasificacion se queda con los datos de la ultima
  // reconstruccion — unos minutos vieja — en vez de que la web deje de
  // funcionar entera hasta medianoche. Los viajes se siguen verificando: eso es
  // lo que la gente esta esperando.
  if (degradado) {
    console.log('::warning::Cuota por encima del 95%: se omiten agregados, metricas y dominio.');
  }

  const resumirMetricas = !SIMULAR && !degradado && await metricas.tocaResumir().catch(() => false);
  const rehacerPesado = !SIMULAR && !degradado;

  // Ninguna de las tres cosas de abajo lee ya una coleccion entera: el dominio
  // pide los viajes de las rutas que tocan sus estaciones, los agregados los de
  // las rutas movidas, y el resumen de metricas no pide viajes en absoluto. Por
  // eso ya no hay una carga compartida que repartir entre ellas (#34).

  // El dominio de las estaciones que se han movido en esta ejecucion, de una
  // tacada: recalcular la misma estacion diez veces da diez veces lo mismo.
  if (rehacerPesado && estacionesTocadas.size) {
    const cuantas = await puntuacion.recalcularEstaciones(estacionesTocadas);
    console.log(`Dominio recalculado en ${cuantas} estaciones.`);
  }

  if (rehacerPesado && rehacerAgregados) {
    // Lo de esta pasada MAS lo que quedo apuntado de las pasadas que el
    // limitador salto. Si no, una ruta o una estacion movidas durante esos
    // quince minutos se quedarian con el agregado viejo.
    const pendientes = await agregados.leerPendientes();
    const rutas = new Set([...rutasTocadas, ...pendientes.rutas]);
    const estaciones = new Set([...estacionesTocadas, ...pendientes.estaciones]);

    const escritos = await puntuacion.reconstruirAgregados(null, rutas, estaciones);
    console.log(`Agregados reconstruidos (${rutas.size} rutas movidas`
      + ` + ${agregados.RUTAS_POR_TURNO} de turno, ${estaciones.size} estaciones): `
      + JSON.stringify(escritos));

    // Despues de reconstruir, no antes: si falla, sigue todo apuntado.
    await agregados.olvidarPendientes();
    rutasTocadas.clear();
    estacionesTocadas.clear();
  } else if (huboMovimiento && !SIMULAR) {
    // Se apunta para la proxima: el proceso muere al acabar la ejecucion, asi
    // que sin esto la ruta se quedaria con el agregado viejo. Vale para las dos
    // razones por las que se llega aqui: el limitador de quince minutos y el
    // modo degradado por cuota.
    await agregados.apuntarPendientes(rutasTocadas, estacionesTocadas).catch(() => {});
    console.log(`Agregados: movimiento en ${rutasTocadas.size} rutas y `
      + `${estacionesTocadas.size} estaciones, sin reconstruir todavia. `
      + 'Queda apuntado para la proxima.');
    estacionesTocadas.clear();
  }

  // Metricas, en dos mitades con coste MUY distinto.
  //
  // `agregarSesiones` es la barata y va en cada pasada: las visitas ocurren
  // aunque no se suba ningun viaje, y ademas poda el detalle viejo segun llega.
  //
  // `resumir` es la cara: necesita `usuarios` y `tiempos_viaje` enteros, porque
  // la retencion por cohortes no sale de otro sitio. Hacerlo en cada pasada
  // costaba 288 x (usuarios + viajes) lecturas al dia — 402.000 con los datos
  // de hoy, ocho veces la cuota diaria, con seis personas usando la web y
  // aunque no pasara nada. Ahora va como mucho una vez por hora (#34).
  if (!SIMULAR) {
    try {
      const sesiones = await metricas.agregarSesiones();
      console.log(`Metricas: ${sesiones.sesiones || 0} sesiones agregadas, `
        + `${sesiones.podados || 0} podadas.`);
    } catch (error) {
      // Que fallen las metricas no puede tumbar la verificacion de viajes.
      console.warn('No se han podido agregar las sesiones:', error.message);
    }

    try {
      if (resumirMetricas) {
        await metricas.resumir();
        console.log('Metricas: resumen y cohortes recalculados.');

        // Los errores del cliente tienen un plazo de conservacion en la
        // politica de privacidad, y un plazo que no ejecuta nadie no es un
        // plazo: hasta ahora solo se vaciaban a mano desde el panel. Va aqui,
        // con el resumen, porque tampoco necesita mas de cuatro veces al dia.
        const podados = await metricas.podarErrores();
        if (podados) console.log(`Errores del cliente podados: ${podados}.`);
      }
    } catch (error) {
      console.warn('No se ha podido recalcular el resumen de metricas:', error.message);
    }
  }

  // El OCR comparte un worker de tesseract para toda la ejecucion, y mientras
  // viva mantiene el proceso en pie.
  await cerrarOcr();

  console.log(`\nResumen: ${cuenta.aprobado} aprobados, ${cuenta.rechazado} rechazados, `
    + `${cuenta.revision} a revision, ${cuenta.error} con error.`);

  // Los avisos de racha leen `usuarios` una vez al dia, a las 20:00. Es el aviso
  // que justifica todo el push, y la funcion corta por la hora antes de leer
  // nada: en las otras 287 pasadas no cuesta una sola lectura.
  if (!degradado) await avisarRachasEnPeligro();

  // Lo ultimo, para contar tambien lo que ha costado el trabajo periodico.
  await cerrarCuota(cuotaAlEmpezar);

  process.exit(0);
}

main().catch((error) => {
  console.error('Fallo del worker:', error);
  process.exit(1);
});
