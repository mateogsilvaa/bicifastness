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
 *   GMAIL_USUARIO             la cuenta de Gmail que envia (bicifastness@gmail.com)
 *   GMAIL_CLAVE_APLICACION    su contraseña de aplicacion (no la de la cuenta)
 *   RESEND_API_KEY            clave de Resend (alternativa a Gmail)
 *
 * Uso:
 *   node backend/worker.js              procesa la cola
 *   node backend/worker.js --once       procesa como mucho un viaje (pruebas)
 *   node backend/worker.js --simular    analiza pero no escribe nada
 */

const admin = require('firebase-admin');

const { LIMITES, TIEMPO, IMAGEN, PUNTOS } = require('./src/config');
const {
  construirRuta, inicioDelDiaMadrid, diaMadrid, buscarEstacion, lunesDe,
} = require('./src/util');
const imagen = require('./src/imagen');
const rutasDestacadas = require('./src/rutas-destacadas');
const {
  leerCaptura, releerCaptura, elegirTrayecto, cerrar: cerrarOcr,
} = require('./src/ocr');
const { evaluar, distanciaCalleMetros, firmaDeLectura } = require('./src/verificacion');
const puntuacion = require('./src/puntuacion');
const distancias = require('./src/distancias');
const rachas = require('./src/rachas');
const correo = require('./src/correo');
const plantillas = require('./src/plantillas');
const bicis = require('./src/bicis');
const metricas = require('./src/metricas');
const borrado = require('./src/borrado');
const cuota = require('./src/cuota');
const logros = require('./src/logros');
const clanes = require('./src/clan-mantenimiento');
const agregados = require('./src/agregados');
const push = require('./src/push');
const almacen = require('./src/db');
/** El proyecto de Firebase de la web (`projectId` en assets/js/firebase.js). */
const PROYECTO_DE_LA_WEB = 'bicifastness';

const misiones = require('./src/misiones');
const divisiones = require('./src/divisiones');
const denuncias = require('./src/denuncias');
const nombres = require('./src/nombres');
const colaCorreo = require('./src/cola-correo');

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
 * LA VENTANA SUPERA EL PERIODO DEL CRON, A PROPOSITO. Con el cron cada 5
 * minutos y la ventana en 9, cada ejecucion se solapa con la siguiente: la
 * siguiente espera en la cola de `concurrency` (no cancela a la que corre) y
 * arranca justo cuando esta termina. Asi no hay huecos aunque GitHub retrase
 * los programados. Una ventana mas corta que el periodo deja la cola sin mirar
 * entre una ejecucion y la siguiente, que es lo que pasaba con 4.
 *
 * Esto cuesta lecturas en vacio (~3 por pasada). Por eso en modo degradado, por
 * encima del 95% de la cuota, no se da ninguna pasada extra (ver `main`).
 */
const VENTANA_MS = Number(process.env.VENTANA_MINUTOS ?? 4) * 60000;
const ESPERA_MS = Number(process.env.ESPERA_SEGUNDOS ?? 45) * 1000;

const esperar = (ms) => new Promise((listo) => setTimeout(listo, ms));

// El dominio tiene que estar verificado en Resend con SPF, DKIM y DMARC, o el
// correo se va a spam — y sin verificar, Resend solo deja enviar a la propia
// cuenta. Por eso se puede cambiar sin tocar codigo (secreto CORREO_REMITENTE):
// el dominio que haya es el que se tenga, no el que estaba escrito aqui.
// Con Gmail, el remitente es la propia cuenta (Gmail no deja otro): lo decide
// `correo.remitentePorDefecto()`.
const REMITENTE = process.env.GMAIL_USUARIO
  ? `BiciFastness <${process.env.GMAIL_USUARIO}>`
  : (process.env.CORREO_REMITENTE || 'BiciFastness <avisos@bicifastness.es>');

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

  // El proyecto sale de la cuenta de servicio, no de un ajuste: si el secreto
  // es de otro proyecto, el worker verifica la cola de OTRA base de datos y la
  // web se queda con sus viajes pendientes para siempre, sin ningun error. Se
  // dice en cada ejecucion para que se vea en el log.
  const proyecto = cuenta.project_id || '(sin project_id)';
  console.log(`Proyecto de Firebase: ${proyecto}`);
  if (proyecto !== PROYECTO_DE_LA_WEB) {
    console.log(`::warning::El worker trabaja contra "${proyecto}" y la web contra "${PROYECTO_DE_LA_WEB}". `
      + 'Los viajes que sube la gente no se van a verificar. Cambia el secreto FIREBASE_SERVICE_ACCOUNT.');
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

  // Ida y vuelta a la misma estacion: sin distancia no hay nada que medir.
  // Va antes que `construirRuta`, que tambien lo rechaza pero como "la ruta no
  // existe", y eso a quien ha hecho el paseo de verdad no le explica nada.
  const [salida, llegada] = String(viaje.ruta || '').split('-').map((v) => v.replace(/^0+/, ''));
  if (salida && salida === llegada) {
    return problema('misma_estacion', 'El trayecto sale y llega a la misma estacion: no se puede medir.');
  }

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
  // En dias de Madrid contra el momento de la SUBIDA, no con un dia de holgura
  // en milisegundos: con la holgura, un viaje declarado para mañana pasaba, y
  // la fecha es lo que decide la racha y las misiones. El navegador nunca ofrece
  // un dia posterior a hoy en Madrid, asi que esto solo lo pisa quien lo fuerza.
  const subida = viaje.creado?.toDate?.() || new Date(ahora);
  if (String(viaje.fechaViaje).slice(0, 10) > diaMadrid(subida)) {
    return problema('viaje_futuro', 'No se pueden registrar viajes futuros.');
  }
  if (ahora - fecha.getTime() > LIMITES.DIAS_MAX_ANTIGUEDAD * 864e5) {
    return problema('viaje_muy_antiguo',
      `Solo se admiten viajes de los ultimos ${LIMITES.DIAS_MAX_ANTIGUEDAD} dias.`);
  }

  // Cupo diario, contado en el servidor. En el navegador se puede saltar
  // cualquier limite abriendo la consola.
  //
  // Con la consulta de agregacion, no trayendose los documentos: de esto solo
  // hace falta el numero, y traerlos costaba una lectura por viaje del dia —
  // sesenta con una cuenta que inunde — por cada viaje procesado. El conteo
  // cobra una lectura por cada MIL documentos contados.
  const inicioHoy = inicioDelDiaMadrid(new Date());
  const hoy = (await db.collection('tiempos_viaje')
    .where('uid', '==', uid)
    .where('creado', '>=', admin.firestore.Timestamp.fromMillis(inicioHoy))
    .count()
    .get()).data().count;

  // El propio viaje que estamos procesando cuenta dentro del resultado.
  //
  // Del cuarto al sexto se verifican igual pero no puntuan (03 Subir · 3n); a
  // partir del septimo, fuera. La marca se deja en el viaje, no en memoria: si
  // acaba en revision y lo aprueba una persona, `premiar` lo lee de ahi.
  const tope = LIMITES.VIAJES_POR_DIA + LIMITES.VIAJES_SIN_PUNTOS_POR_DIA;
  if (hoy > tope) {
    return problema('cupo_diario', `Limite de ${tope} viajes al dia superado.`);
  }
  if (hoy > LIMITES.VIAJES_POR_DIA && viaje.fueraDeCupo !== true) {
    viaje.fueraDeCupo = true;
    if (!SIMULAR && viaje._ref) await viaje._ref.update({ fueraDeCupo: true });
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
let ventanaCambiada = false;

/**
 * La ventana, ya hecha, en UN documento (`huellas_captura/_ventana`).
 *
 * Aun cacheada por ejecucion, la ventana costaba 150 lecturas cada vez que el
 * worker arrancaba con algo en la cola: era la partida mas cara de todo el
 * worker en el modelo de coste (8.100 lecturas al dia con 50 personas). Ahora
 * son dos: este documento, y la consulta de lo que se haya escrito despues de
 * guardarlo — que cuando todo va bien sale vacia y cobra el minimo.
 *
 * Esa segunda consulta es lo que la hace segura: si una ejecucion se corta
 * entre crear una huella y guardar la ventana, la siguiente la recupera de la
 * coleccion. La ventana es un atajo, no la fuente: la fuente siguen siendo las
 * huellas, y el duplicado exacto se sigue buscando por id, que no depende de
 * esto.
 *
 * Vive en la misma coleccion para heredar su regla (cerrada a todo el mundo)
 * sin tocar `firestore.rules`. No lleva `creado` ni `uid`, asi que ni la
 * consulta por fecha ni el borrado de cuenta la confunden con una huella.
 */
const VENTANA = () => db.doc('huellas_captura/_ventana');

async function cargarHuellas() {
  if (huellasRecientes) return huellasRecientes;

  const guardada = await VENTANA().get();
  const datos = guardada.exists ? guardada.data() : null;

  let consulta = db.collection('huellas_captura').orderBy('creado', 'desc');
  if (datos?.hasta) consulta = consulta.where('creado', '>', datos.hasta);
  const nuevas = await consulta.limit(IMAGEN.VENTANA_COMPARACION).get();

  const vistas = new Set();
  huellasRecientes = [
    ...nuevas.docs.map((d) => ({ sha: d.id, ...d.data() })),
    ...(datos?.entradas || []),
  ]
    .map(({ sha, dhash, tripId, capturaId, firma }) => ({ sha, dhash, tripId, capturaId, firma: firma || null }))
    .filter((h) => h.sha && !vistas.has(h.sha) && vistas.add(h.sha))
    .slice(0, IMAGEN.VENTANA_COMPARACION);

  // Sin ventana guardada (la primera vez) o con huellas que no estaban en ella:
  // hay que guardarla al terminar aunque esta ejecucion no escriba ninguna.
  ventanaCambiada = !datos || !nuevas.empty;
  return huellasRecientes;
}

/** Mete en la cache una huella recien escrita, sin volver a leer. */
function apuntarHuella(huella) {
  if (!huellasRecientes) return;
  const { sha, dhash, tripId, capturaId, firma } = huella;
  // Si la huella ya estaba (se ha cambiado de viaje), sale de donde estaba.
  const antes = huellasRecientes.findIndex((h) => h.sha === sha);
  if (antes >= 0) huellasRecientes.splice(antes, 1);
  huellasRecientes.unshift({ sha, dhash, tripId, capturaId, firma: firma || null });
  huellasRecientes.length = Math.min(huellasRecientes.length, IMAGEN.VENTANA_COMPARACION);
  ventanaCambiada = true;
}

/**
 * Guarda la ventana, UNA escritura por ejecucion y solo si ha cambiado.
 *
 * `hasta` es la hora del servidor al guardar: todo lo creado antes ya esta
 * dentro. Las ejecuciones no se solapan (`concurrency` en el workflow), asi que
 * no hay huellas de otra ejecucion entre medias; y si el reloj juega una mala
 * pasada y una se vuelve a leer, se descarta por el sha.
 *
 * Sin `uid`, a proposito: el borrado de cuenta quita el uid de las huellas
 * (`borrado.js`), y una copia con el uid dentro seria un sitio mas del que
 * acordarse.
 */
async function guardarVentana() {
  if (!ventanaCambiada || !huellasRecientes || SIMULAR) return;
  await VENTANA().set({ entradas: huellasRecientes, hasta: AHORA() });
  ventanaCambiada = false;
}

/**
 * Lo leido en la captura de un viaje ya resuelto, con la forma de
 * `firmaDeLectura`. Para las huellas de antes de guardar la firma: se saca del
 * propio viaje. El dia es el declarado (el leido no se guardaba) y la duracion
 * no se pone, porque la del viaje es la escrita y no la leida.
 */
function firmaDeViaje(v) {
  if (!v?.franja?.salida || !v?.franja?.llegada) return null;
  return {
    fecha: v.fechaViaje || null,
    salida: v.franja.salida,
    llegada: v.franja.llegada,
    duracion: null,
    bici: v.numeroBici ? String(v.numeroBici).replace(/^0+/, '') : null,
  };
}

/**
 * Completa los posibles duplicados con lo que dice su viaje: su estado, de
 * quien es y, si la huella es antigua, lo leido. Sin el estado no se puede
 * distinguir "otra vez la misma captura" de "la vuelvo a subir corregida tras
 * un rechazo". Solo los parecidos de verdad, y como mucho tres: en la practica,
 * una o dos lecturas por viaje, y ninguna casi nunca.
 */
async function completarCandidatos(candidatos) {
  const unicos = candidatos.filter((c, i) => c.tripId && candidatos.findIndex((o) => o.tripId === c.tripId) === i);
  const snaps = await Promise.all(unicos.map((c) => db.doc(`tiempos_viaje/${c.tripId}`).get().catch(() => null)));
  const porId = new Map(unicos.map((c, i) => [c.tripId, snaps[i]?.exists ? snaps[i].data() : null]));
  return candidatos.map((c) => {
    const v = porId.get(c.tripId);
    if (!v) return c;
    return { ...c, estado: v.estado || null, uid: c.uid || v.uid || null, firma: c.firma || firmaDeViaje(v) };
  });
}

/** Contexto competitivo y estadistico que alimenta al motor. */
async function reunirContexto(viaje, uid, hashSha, hashPerceptual = null, capturaId = null) {
  const [rutaSnap, propiosSnap, huellas, exacta, mismoDia] = await Promise.all([
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
    // Los de la misma ruta y el mismo dia, para ver si este trayecto ya esta
    // subido con otra captura. Dos igualdades: no pide indice compuesto.
    viaje.fechaViaje
      ? db.collection('tiempos_viaje')
        .where('ruta', '==', viaje.ruta).where('fechaViaje', '==', viaje.fechaViaje)
        .limit(20).get().catch((error) => {
          console.warn('  no se han podido mirar los viajes del mismo dia:', error.message);
          return null;
        })
      : Promise.resolve(null),
  ]);

  const ruta = rutaSnap.exists ? rutaSnap.data() : {};
  const propios = propiosSnap.docs.map((d) => d.data());

  const exactos = exacta && exacta.exists
    ? [{
      sha: exacta.id,
      tripId: exacta.data().tripId,
      uid: exacta.data().uid,
      capturaId: exacta.data().capturaId || null,
      firma: exacta.data().firma || null,
    }]
    : [];
  // Los que se parecen lo bastante como para ser la misma imagen, de otra
  // captura, de mas a menos parecidos. El motor decide; aqui solo se eligen
  // los que merece la pena completar.
  const parecidos = hashPerceptual
    ? huellas
      .filter((h) => h.dhash && h.sha !== hashSha && (!capturaId || !h.capturaId || h.capturaId !== capturaId))
      .map((h) => ({ ...h, distancia: imagen.distanciaHamming(hashPerceptual, h.dhash) }))
      .filter((h) => h.distancia <= IMAGEN.MAX_DISTANCIA_PERCEPTUAL)
      .sort((a, b) => a.distancia - b.distancia)
      .slice(0, 3)
    : [];
  const [shaPrevios, hashesPrevios] = await Promise.all([
    completarCandidatos(exactos),
    completarCandidatos(parecidos.map(({ dhash, tripId, capturaId: c, firma }) => ({
      dhash, tripId, capturaId: c || null, firma: firma || null,
    }))),
  ]);

  const viajesMismoDia = (mismoDia?.docs || [])
    .filter((d) => d.id !== viaje._ref?.id && d.data().franja)
    .map((d) => ({
      tripId: d.id,
      uid: d.data().uid,
      estado: d.data().estado,
      capturaId: d.data().capturaId || d.id,
      salida: d.data().franja.salida,
      llegada: d.data().franja.llegada,
      bici: d.data().numeroBici || null,
    }));

  return {
    distribucionRuta: ruta.distribucion || null,
    // El agregado esta ordenado por marca, asi que el record es la primera fila.
    // Puede tener hasta quince minutos: un record recien batido y todavia no
    // agregado se compara contra el anterior, que como mucho hace que un viaje
    // buenisimo pase a revision. Es el lado correcto por el que equivocarse.
    mejorTiempoRuta: ruta.filas?.length ? ruta.filas[0].marca : null,
    // La marca del ULTIMO puesto que puntua. Un viaje mas lento que esto no
    // puede cambiar el podio, y entonces no hace falta rehacerlo (`resolver`).
    // Null si la ruta todavia no llena el podio: ahi todo viaje entra.
    marcaUltimoPuntuable: (ruta.filas?.length || 0) >= PUNTOS.POR_POSICION.length
      ? ruta.filas[PUNTOS.POR_POSICION.length - 1].marca
      : null,
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
    shaPrevios,
    hashesPrevios,
    viajesMismoDia,
  };
}

/** Procesa un viaje de principio a fin. */
async function procesar(doc) {
  const viaje = doc.data();
  const uid = viaje.uid;
  console.log(`\n[${doc.id}] ${viaje.username} — ruta ${viaje.ruta} en ${viaje.tiempoSegundos}s`);
  // No enumerable: que no acabe copiado en ningun documento por un `...viaje`.
  Object.defineProperty(viaje, '_ref', { value: doc.ref, enumerable: false });

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
  const contexto = await reunirContexto(viaje, uid, hashSha, hashPerceptual, capturaId);

  // De todos los trayectos que haya en la captura, el que dice ser este viaje.
  // Sin esto, subir los tres viajes de una misma captura acabaria con dos
  // rechazados por `ruta_no_coincide`.
  // Con que trayecto de la captura se compara: el de su ruta, su dia y su tiempo.
  const cual = { tiempoSegundos: viaje.tiempoSegundos, fecha: String(viaje.fechaViaje || '').slice(0, 10) };
  const lectura = elegirTrayecto(await leerCaptura({ buffer, mime }), viaje.ruta, cual);

  // Y otra vez, con otra preparacion de la imagen: lo que decide el viaje
  // (estaciones y duracion) tiene que salir igual en las dos (consenso). Solo
  // si la primera ha leido una captura de BiciMAD; si no, ya va a revision.
  const segundaLectura = lectura.disponible && lectura.esBicimad
    ? elegirTrayecto(await releerCaptura({ buffer }), viaje.ruta, cual)
    : null;

  // Quien mas ha llevado esa bici ese dia, para ver si coincide en la hora.
  const usosBici = await usosDeLaBici(lectura, viaje);

  // Lo que el navegador leyo del EXIF del fichero original, antes de que el
  // lienzo lo borrase. Se pasa por la MISMA lista de editores que el servidor,
  // para que las dos puntas no puedan discrepar sobre que es un editor.
  const editorDeclarado = imagen.editorEn(viaje.metadatos?.software);

  // 5. Veredicto.
  const veredicto = evaluar({
    ruta: viaje.ruta,
    tiempoSegundos: viaje.tiempoSegundos,
    lectura,
    capturaId,
    hashSha,
    hashPerceptual,
    // El EXIF del fichero (`inspeccion`) casi nunca trae nada: el navegador
    // recodifica la captura en un lienzo y eso lo borra antes de subirla. Por
    // eso se mira TAMBIEN lo que el navegador declaro leyendo el original antes
    // de comprimir (#66).
    //
    // El del servidor manda si alguna vez trae algo: viene del fichero, no de
    // lo que diga el cliente.
    edicionSospechosa: inspeccion.sospechaEdicion || Boolean(editorDeclarado),
    software: inspeccion.software || editorDeclarado,
    // La fecha del viaje contra la hora de subida (la pone Firestore, no el
    // navegador) y contra la fecha del fichero de la captura.
    fechaViaje: viaje.fechaViaje,
    capturadaEn: viaje.metadatos?.capturadaEn || null,
    subidoEn: viaje.creado?.toDate?.() || null,
    // Comprobaciones de la verificacion ultra precisa: consenso de dos
    // lecturas, formato de pantalla de movil y la misma bici con dos personas.
    segundaLectura,
    usosBici,
    uid,
    ancho: inspeccion.ancho,
    alto: inspeccion.alto,
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
      numeroBici: bicis.normalizarBici(lectura.numeroBici),
      relojBarra: lectura.relojBarra || null,
    }
    : null;

  console.log(`  -> ${veredicto.decision} (riesgo ${veredicto.riesgo}): ${veredicto.resumen}`);
  for (const s of veredicto.señales) console.log(`     [${s.gravedad}] ${s.mensaje}`);

  if (SIMULAR) return veredicto.decision;

  // 6. Guardar la huella para que la captura no se pueda reutilizar. `create`
  // y no `set`: si ya existe hay que conservar la del viaje original.
  //
  // La firma es lo leido del trayecto (dia, horas, bici): es lo que deja al
  // motor distinguir la misma captura de otra captura de la misma pantalla.
  const huella = {
    sha: hashSha, dhash: hashPerceptual, tripId: doc.id, capturaId, uid, firma: firmaDeLectura(lectura),
  };
  await db.collection('huellas_captura').doc(hashSha).create({ ...huella, creado: AHORA() })
    .then(() => apuntarHuella(huella))
    .catch(async (error) => {
      if (error.code !== 6) throw error; // 6 = ALREADY_EXISTS
      // Ya existia, de un viaje que se rechazo y que ahora se vuelve a subir
      // corregido. Si este sale adelante, la huella pasa a ser suya: la
      // siguiente vez que alguien suba esa imagen, el original es este.
      const original = contexto.shaPrevios[0];
      if (original?.estado === 'rechazado' && veredicto.decision !== 'rechazado') {
        await db.collection('huellas_captura').doc(hashSha).set({ ...huella, creado: AHORA() });
        apuntarHuella(huella);
      }
    });

  await resolver(doc, veredicto, {
    mejorTiempoRuta: contexto.mejorTiempoRuta,
    marcaUltimoPuntuable: contexto.marcaUltimoPuntuable,
  });
  return veredicto.decision;
}

/**
 * Los otros viajes de ese dia con la misma bici, con su franja horaria. Una
 * consulta, y solo si la captura trae el numero. Nunca lanza: sin esto, la
 * comprobacion simplemente no opina.
 */
async function usosDeLaBici(lectura, viaje) {
  const n = bicis.normalizarBici(lectura?.numeroBici);
  if (!n || !viaje.fechaViaje) return [];
  try {
    const otros = await db.collection('tiempos_viaje')
      .where('numeroBici', '==', n)
      .where('fechaViaje', '==', viaje.fechaViaje)
      .limit(10)
      .get();
    return otros.docs
      .filter((d) => d.data().franja && d.data().estado !== 'rechazado')
      .map((d) => ({ tripId: d.id, uid: d.data().uid, salida: d.data().franja.salida, llegada: d.data().franja.llegada }));
  } catch (error) {
    console.warn('  no se han podido mirar los usos de la bici:', error.message);
    return [];
  }
}

/**
 * Los codigos de un veredicto, de mas grave a menos.
 *
 * El orden lo pone el servidor y es lo unico que se lleva de la gravedad: asi
 * `motivos.js` puede coger el primero que conozca sin recibir los pesos, que son
 * parte del manual del antifraude.
 */
function codigosDeVeredicto(veredicto) {
  return [...(veredicto?.señales || [])]
    .sort((a, b) => (b.gravedad || 0) - (a.gravedad || 0))
    .map((s) => s.codigo)
    .filter(Boolean);
}

/**
 * Guarda el analisis completo donde solo lo lee la administracion.
 *
 * Va en `auditorias/{viajeId}`, con el mismo id que el viaje: asi se encuentra
 * sin indice y se borra con el viaje cuando alguien ejerce el derecho de
 * supresion (src/borrado.js).
 */
async function escribirAuditoria(viajeId, veredicto) {
  await db.doc(`auditorias/${viajeId}`).set({
    ...veredicto,
    viajeId,
    creado: AHORA(),
  });
}

/** Escribe el veredicto y, si procede, recalcula la clasificacion. */
async function resolver(doc, veredicto, { mejorTiempoRuta = null, marcaUltimoPuntuable = null } = {}) {
  const viaje = doc.data();
  const aprobado = veredicto.decision === 'aprobado';

  // El de aprobado sale despues de `premiar`, con los puntos de verdad (07 ·
  // 7a: "Verificado · +69 pts"). Aqui todavia no se saben.
  if (!aprobado) await avisarPorPush(doc.id, viaje, veredicto.decision);

  // El analisis completo NO va dentro del viaje.
  //
  // Las reglas dejan que el dueño lea su viaje entero, asi que todo lo que se
  // guarde ahi lo puede ver quien abra la consola del navegador. Y el veredicto
  // esta escrito para QUIEN REVISA: lleva el riesgo acumulado, la gravedad de
  // cada señal y mensajes con los numeros exactos ("2,7 desviaciones por debajo
  // de la media de la ruta"). Eso es el manual del antifraude: quien conoce los
  // umbrales sabe cuanto puede acercarse sin saltarlos.
  //
  // En el viaje se queda solo `motivos`: los codigos, ordenados de mas grave a
  // menos. Son etiquetas estables, sin un solo numero, y son justo lo que
  // `assets/js/motivos.js` necesita para explicarle el rechazo a la persona.
  await escribirAuditoria(doc.id, veredicto);

  await doc.ref.update({
    estado: veredicto.decision,
    verificado: aprobado,
    motivos: codigosDeVeredicto(veredicto),
    // Los viajes de antes de la mudanza lo llevan dentro; se quita al pasar.
    auditoria: admin.firestore.FieldValue.delete(),
    // De donde venia la captura. No decide nada, pero sin esto "el OCR falla a
    // veces" no se convierte nunca en "falla en recortes de iPhone".
    varianteCaptura: veredicto.varianteCaptura || null,
    // La bici, si se leyo: la usa la ficha publica (ultima vez vista) y el
    // antifraude (la misma bici a la misma hora con dos personas).
    ...(veredicto.lectura?.numeroBici ? { numeroBici: veredicto.lectura.numeroBici } : {}),
    ...(veredicto.lectura?.horaSalida && veredicto.lectura?.horaLlegada
      ? { franja: { salida: veredicto.lectura.horaSalida, llegada: veredicto.lectura.horaLlegada } }
      : {}),
    revisadoPor: 'automatico',
    revisadoEn: AHORA(),
    // Marca para el aviso de revision lenta. En `false` y no ausente: un campo
    // que falta no lo devuelve ninguna consulta de Firestore, y sin poder
    // filtrar habria que traer la cola entera y descartar en memoria — que es
    // como los viajes ya avisados acaban ocupando el hueco de los nuevos.
    ...(veredicto.decision === 'revision' ? { avisoRevision: false } : {}),
  });

  if (aprobado) {
    // La franja se acaba de escribir en el documento, pero `viaje` es el de
    // antes: se le pasa para las misiones de hora del dia.
    const sumados = await premiar(doc, {
      ...viaje,
      franja: viaje.franja || (veredicto.lectura?.horaSalida
        ? { salida: veredicto.lectura.horaSalida, llegada: veredicto.lectura.horaLlegada || null }
        : undefined),
    });
    await avisarPorPush(doc.id, viaje, 'aprobado', sumados);
    await apuntarBiciVista(veredicto.lectura?.numeroBici, viaje);
    // Los puntos de la ruta SI se rehacen viaje a viaje: cambian la
    // clasificacion y el siguiente viaje de la tanda tiene que verla al dia.
    // El dominio de las estaciones se apunta y se hace una vez al final.
    //
    // ...pero solo si el viaje puede cambiar el podio. Rehacerlo lee los 200
    // mas rapidos de la ruta y a todos los que puntuan en ella, y era la
    // segunda partida mas cara del worker (30.000 lecturas al dia con 200
    // personas) para, casi siempre, escribir exactamente lo que ya habia: solo
    // puntuan siete puestos, y en una ruta con historia casi ningun viaje entra.
    //
    // Es seguro porque las marcas solo mejoran: el agregado puede tener quince
    // minutos, y en ese rato el septimo solo ha podido bajar, nunca subir. Lo
    // unico que las empeora es anular un viaje, y eso pasa por
    // `aplicarDecisionesManuales`, que rehace la ruta siempre. Si la ruta lleva
    // multiplicador (la del dia, las historicas), se rehace igual: los puntos
    // del podio cambian aunque el orden no.
    const fueraDelPodio = marcaUltimoPuntuable !== null
      && viaje.tiempoSegundos > marcaUltimoPuntuable
      && await puntuacion.multiplicadorRuta(viaje.ruta) === 1;
    if (!fueraDelPodio) await puntuacion.recalcularRuta(viaje.ruta);
    apuntarEstaciones(viaje.ruta);

    // Solo si bate la marca que habia: es lo unico que cuesta lecturas, y pasa
    // pocas veces. Sin record previo (ruta nueva) no hay a quien avisar.
    if (mejorTiempoRuta && viaje.tiempoSegundos < mejorTiempoRuta) {
      await avisarRecordPerdido(doc.id, viaje);
    }
  }

  // La captura de un rechazo automatico NO se borra al momento: es lo unico
  // que puede mirar una persona si se pide revision humana, y la pantalla de
  // rechazo ofrece pedirla. Antes se borraba aqui, y al panel llegaban las
  // impugnaciones sin imagen. Se guarda `DIAS_CAPTURA_RECHAZADA` y luego la
  // borra `caducarCapturasRechazadas`, si nadie ha pedido revision.
  if (veredicto.decision === 'rechazado') {
    await doc.ref.update({ capturaCaduca: caducidadCaptura() });
    await avisarRechazo(viaje, veredicto, doc.id);
  }
}

/** Hasta cuando se guarda la captura de un viaje rechazado por la maquina. */
function caducidadCaptura(desde = Date.now()) {
  return admin.firestore.Timestamp.fromMillis(desde + LIMITES.DIAS_CAPTURA_RECHAZADA * 864e5);
}

/**
 * Borra las capturas de los rechazos automaticos cuyo plazo de revision ha
 * pasado. Una consulta por desigualdad sobre un solo campo (sin indice
 * compuesto), que con nada caducado cuesta una lectura.
 *
 * Si mientras tanto se ha pedido revision, el viaje ya no esta rechazado: se le
 * quita la marca y la captura se queda para quien revisa. La borra la decision
 * final de una persona (`aplicarDecisionesManuales`), si rechaza.
 */
async function caducarCapturasRechazadas() {
  try {
    const caducadas = await db.collection('tiempos_viaje')
      .where('capturaCaduca', '<=', admin.firestore.Timestamp.now()).limit(20).get();
    if (caducadas.empty) return 0;
    let borradas = 0;
    for (const doc of caducadas.docs) {
      const viaje = doc.data();
      if (SIMULAR) { console.log(`  [${doc.id}] se borraria la captura caducada`); continue; }
      if (viaje.estado === 'rechazado') {
        await borrarCapturaSiSobra(doc, viaje);
        await doc.ref.update({ capturaCaduca: admin.firestore.FieldValue.delete(), capturaBorrada: true });
        borradas += 1;
      } else {
        await doc.ref.update({ capturaCaduca: admin.firestore.FieldValue.delete() });
      }
    }
    console.log(`Capturas de rechazos caducadas: ${borradas} borradas de ${caducadas.size}.`);
    return borradas;
  } catch (error) {
    console.warn('No se han podido caducar las capturas de rechazos:', error.message);
    return 0;
  }
}

/**
 * "Vista por ultima vez en Metro Bilbao, hace 2 h" (11d): la estacion de
 * salida del ultimo viaje APROBADO con esa bici. Una escritura, y solo cuando
 * la captura trae el numero.
 */
async function apuntarBiciVista(numero, viaje) {
  const n = bicis.normalizarBici(numero);
  if (!n || SIMULAR) return;
  const estacion = String(viaje.ruta || '').split('-')[0] || null;
  if (!estacion) return;
  await db.doc(`bicis/${n}`).set({
    numero: n,
    vista: { estacion, cuando: viaje.creado?.toMillis?.() || Date.now() },
  }, { merge: true }).catch((error) => console.warn(`  no se ha apuntado la bici ${n}:`, error.message));
}

/**
 * Bicirating: junta las valoraciones nuevas en la ficha publica de cada bici.
 *
 * El navegador escribe cada valoracion con `procesada: false` (lo exigen las
 * reglas, tambien al cambiar la nota el mismo dia), asi que la consulta solo
 * trae lo que ha cambiado. Coste con nada nuevo: una lectura.
 *
 * El comentario se limpia AQUI y no en el navegador: lo que se publica es
 * `comentarioPublico`, sin invisibles y vacio si lleva un insulto. El original
 * solo lo lee su autor.
 */
/**
 * ¿La captura de una valoracion sin viaje demuestra esa bici? El numero de la
 * bici tiene que leerse y coincidir, y si la captura trae fecha, no puede
 * tener mas de un mes (LIMITES.DIAS_MAX_ANTIGUEDAD).
 */
async function comprobarCapturaDeBici(capturaId, bici) {
  try {
    const snap = await db.doc(`capturas/${capturaId}`).get();
    if (!snap.exists) return { vale: false, motivo: 'sin captura' };
    const { buffer } = imagen.decodificarDataUrl(snap.data().datos);
    const lectura = await leerCaptura({ buffer });
    if (!lectura.disponible) return { vale: false, motivo: 'captura ilegible' };
    const usada = /^\d{4}-\d{2}-\d{2}$/.test(lectura.fecha || '') ? lectura.fecha : null;
    const leida = bicis.normalizarBici(lectura.numeroBici);
    if (!leida || leida !== bici) return { vale: false, motivo: `la captura no es de la bici ${bici}` };
    if (lectura.fecha) {
      const dias = (Date.now() - new Date(`${lectura.fecha}T12:00:00Z`).getTime()) / 864e5;
      if (dias > LIMITES.DIAS_MAX_ANTIGUEDAD) return { vale: false, motivo: 'captura de hace mas de un mes' };
    }
    return { vale: true, usada };
  } catch (error) {
    return { vale: false, motivo: `error al leerla: ${error.message}` };
  }
}

async function procesarValoraciones() {
  try {
    const nuevas = await db.collection('valoraciones_bici')
      .where('procesada', '==', false).limit(50).get();
    if (nuevas.empty) return 0;

    const tocadas = new Set();
    for (const doc of nuevas.docs) {
      const v = doc.data();
      const n = bicis.normalizarBici(v.bici);
      // Valorar sin subir viaje (11): la prueba es la captura. Aqui se lee y
      // tiene que ser esa bici y de hace menos de un mes; si no, no cuenta.
      const prueba = v.capturaId ? await comprobarCapturaDeBici(v.capturaId, n) : { vale: true };
      // El dia en que se uso la bici: el del viaje, no el de la valoracion.
      let usada = prueba.usada || null;
      if (!usada && v.viajeId) {
        const viaje = await db.doc(`tiempos_viaje/${v.viajeId}`).get().catch(() => null);
        const f = viaje?.exists ? viaje.data().fechaViaje : null;
        if (/^\d{4}-\d{2}-\d{2}$/.test(f || '')) usada = f;
      }
      if (!SIMULAR) {
        await doc.ref.update({
          procesada: true,
          comentarioPublico: bicis.limpiarComentario(v.comentario),
          ...(usada ? { usada } : {}),
          ...(prueba.vale ? { rechazada: false } : { rechazada: true, motivoRechazo: prueba.motivo }),
        });
        // La captura solo servia de prueba: fuera, que son 700 KB.
        if (v.capturaId) await db.doc(`capturas/${v.capturaId}`).delete().catch(() => {});
      }
      if (!prueba.vale) console.log(`  valoracion de la bici ${n} descartada: ${prueba.motivo}`);
      if (n) tocadas.add(n);
    }
    if (!SIMULAR) for (const n of tocadas) await bicis.rehacerBici(db, n);
    console.log(`Bicis: ${nuevas.size} valoracion(es), ${tocadas.size} ficha(s) al dia.`);
    return nuevas.size;
  } catch (error) {
    console.warn('No se han podido juntar las valoraciones de bicis:', error.message);
    return 0;
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

  // Sin `catch`. Borrar en Firestore un documento que no existe NO falla: es un
  // no-op. Asi que tragarse el error aqui no protegia ninguna idempotencia — eso
  // ya lo da Firestore — y lo unico que podia esconder era un fallo de verdad,
  // que en esta linea significa 700 KB que se quedan ocupando para siempre.
  await db.doc(`capturas/${capturaId}`).delete();
}

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
async function avisarPorCorreo(uid, tipo, extra = {}, yaLeido = null, { encolar = true } = {}) {
  const plantilla = plantillas.POR_TIPO[tipo];
  if (!plantilla) throw new Error(`tipo de correo desconocido: ${tipo}`);
  const obligatorio = SIEMPRE_SE_AVISA.has(tipo);

  try {
    const refUsuario = db.doc(`usuarios/${uid}`);
    const usuario = yaLeido || await refUsuario.get();
    if (!usuario.exists) return false;

    const datos = usuario.data();

    // Respeta la preferencia. Un aviso sobre el propio viaje es transaccional y
    // se puede enviar sin consentimiento, pero a quien lo ha desactivado a
    // proposito no se le insiste.
    // Los de seguridad y moderacion, si: desactivar los avisos no puede
    // significar no enterarse de que te han cambiado la contraseña.
    if (datos.avisosCorreo === false && !obligatorio) return false;

    // El correo se pide a Firebase Auth, no al documento: ahi es donde vive
    // (#60), y ademas nunca esta obsoleto.
    // OJO con el nombre: `correo` es el modulo de envio importado arriba. Una
    // variable local con ese nombre lo taparia y `correo.enviar(...)` reventaria.
    let destinatario = null;
    let cuenta = null;
    try {
      cuenta = await admin.auth().getUser(uid);
      destinatario = cuenta.email || null;
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

    // 10c une la verificacion con la bienvenida: si la cuenta es de correo y
    // no esta verificada, el mismo correo lleva el enlace.
    let enlaceVerificacion = null;
    if (tipo === 'bienvenida' && !cuenta.emailVerified) {
      enlaceVerificacion = await admin.auth()
        .generateEmailVerificationLink(destinatario, { url: `${plantillas.SITIO}/` })
        .catch(() => null);
    }

    const mensaje = plantilla({
      nombre: datos.username || 'piloto', tokenBaja, correo: destinatario, enlaceVerificacion, ...extra,
    });

    const resultado = await correo.enviar({
      ...mensaje,
      para: destinatario,
      remitente: REMITENTE,
      apiKey: process.env.RESEND_API_KEY,
      // Un mensaje del equipo se contesta; si hay buzon aparte, las respuestas
      // van alli. Con Gmail, sin esto, vuelven a la propia cuenta, que tambien vale.
      // Una suspension se recurre respondiendo (10e), asi que igual.
      responderA: ['mensaje_equipo', 'cuenta_suspendida'].includes(tipo) ? (process.env.CORREO_RESPUESTA || null) : null,
      simular: SIMULAR,
    });

    if (resultado.error) {
      console.warn(`  aviso no enviado a ${uid}: ${resultado.error}`);

      // Un 429, un 5xx o un timeout SI mejoran reintentando; un 422 por
      // direccion invalida, no. `enviar` ya hace esa distincion y hasta ahora
      // se tiraba a la basura: el correo se perdia para siempre (#65).
      //
      // `encolar` esta para que el propio reintento no vuelva a encolarse desde
      // aqui — de eso se ocupa `reenviarCorreos`, que lleva la cuenta de los
      // intentos.
      if (resultado.reintentable && encolar && !SIMULAR) {
        await db.collection('correos_pendientes')
          .add(colaCorreo.entrada(uid, tipo, extra))
          .catch((error) => {
            console.error('::warning::No se ha podido encolar el correo de'
              + ` ${uid}:`, error.message);
          });
      }
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`  no se ha podido avisar a ${uid}:`, err.message);
    return false;
  }
}

/**
 * Los correos que salen aunque la persona haya apagado los avisos: no son
 * producto, son su cuenta. Tampoco llevan enlace de baja.
 */
const SIEMPRE_SE_AVISA = new Set(['cuenta_suspendida', 'clave_cambiada', 'mensaje_equipo']);

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
async function avisarRechazo(viaje, veredicto, viajeId = '') {
  await avisarPorCorreo(viaje.uid, 'viaje_rechazado', {
    ruta: viaje.ruta,
    viajeId,
    fecha: viaje.fechaViaje || null,
    tiempoSegundos: viaje.tiempoSegundos ?? null,
    distanciaMetros: viaje.distanciaMetros ?? null,
    // `resumen` es el texto para la persona. Las señales con sus pesos se
    // quedan en la auditoria: no salen en el correo.
    motivo: veredicto.resumen,
  });
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

  // `resolver` y no `resolverConCache`.
  //
  // Aqui habia una cache en `distancias/{ruta}`: una lectura por viaje aprobado
  // para un documento QUE NO ESCRIBE NADIE. `escribir` era `async () => {}`, y
  // `build-distancias.js` genera la tabla en `backend/lib/distancias.json`, no
  // en Firestore. O sea que la coleccion no ha existido nunca y esa lectura
  // siempre daba vacio antes de caer a la tabla, que es donde estan los datos.
  //
  // La cache tendria sentido si el worker calculara distancias reales, pero no
  // lo hace: o el par esta en la tabla, o estima. Lo unico que le queda a la
  // cache es guardar estimaciones, y para eso ya esta la formula.
  const medida = distancias.resolver(origen, destino);
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

    // Fuera de cupo (del 4.º al 6.º del dia): cuenta en km y estadisticas, y
    // salva la racha, pero ni puntos ni misiones.
    const puntua = viaje.fueraDeCupo !== true;

    puntos = puntuacion.calcularPuntosViaje({
      distanciaMetros: metros,
      velocidadKmh: kmh,
      multiplicadorRuta: multRuta,
      racha: racha.racha,
      territorioPropio: enCasa,
      puntua,
    });

    // Insignias (#24). Se evaluan sobre el estado que va a QUEDAR, no sobre el
    // que habia: si no, la que se gana con este viaje no se concede hasta el
    // siguiente, y el momento en que la persona la esperaba ya paso.
    //
    // No cuesta ni una lectura: el documento ya esta leido para la transaccion,
    // y las reglas del catalogo solo miran campos suyos. Conceder una medalla
    // no puede salir mas caro que verificar el viaje que la gana.
    //
    // Se calculan DESPUES de las misiones, que tambien dan insignias: la de la
    // mision completada con este viaje se concede con este viaje.
    const insigniasTrasElViaje = () => logros.nuevas({
      ...previo,
      viajesVerificados: (previo.viajesVerificados || 0) + 1,
      metrosTotales: (previo.metrosTotales || 0) + (metros || 0),
      segundosTotales: (previo.segundosTotales || 0) + (viaje.tiempoSegundos || 0),
      misionesCompletadas: (previo.misionesCompletadas || 0) + completadasAhora,
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
    let completadasAhora = 0;
    const diaDelViaje = String(viaje.fechaViaje).slice(0, 10);

    if (puntua && diaDelViaje === diaMadrid()) {
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
        {
          distanciaMetros: metros,
          velocidadKmh: kmh,
          tiempoSegundos: viaje.tiempoSegundos || 0,
          ruta: viaje.ruta,
          // La hora de salida leida en la captura, para las misiones de hora.
          horaSalida: viaje.franja?.salida || null,
        },
        Boolean(destino) && !previas.has(destino)
      );

      const delDia = misiones.generar(diaDelViaje).misiones;
      const progresoNuevo = misiones.progresoDeTotales(delDia, totales);
      const antes = previo.misiones && previo.misiones.fecha === diaDelViaje
        ? previo.misiones.progreso : null;

      progresoMisiones = { ...totales, progreso: progresoNuevo };

      // Lo que dan las misiones que ESTE viaje completa, sumado a su total:
      // asi sale en el desglose (3e) y se devuelve si el viaje se anula.
      const extra = misiones.puntosCompletadas(delDia, antes, progresoNuevo);
      completadasAhora = misiones.cuantasCompletadas(antes, progresoNuevo);
      if (extra > 0) {
        puntos = {
          ...puntos,
          total: puntos.total + extra,
          desglose: { ...puntos.desglose, misiones: extra },
        };
      }
    }

    const nuevasInsignias = insigniasTrasElViaje();

    tx.update(refUsuario, {
      viajesVerificados: admin.firestore.FieldValue.increment(1),
      metrosTotales: admin.firestore.FieldValue.increment(metros || 0),
      segundosTotales: admin.firestore.FieldValue.increment(viaje.tiempoSegundos || 0),
      puntosTemporada: admin.firestore.FieldValue.increment(puntos.total),
      // Los de la liga de dos semanas en juego (`divisiones.inicioLiga`). Un
      // viaje de una liga ya cerrada no suma a la nueva: se reclamo tarde.
      ...(diaDelViaje >= divisiones.inicioLiga(diaMadrid())
        ? { puntosLiga: admin.firestore.FieldValue.increment(puntos.total) }
        : {}),
      ...(completadasAhora ? { misionesCompletadas: admin.firestore.FieldValue.increment(completadasAhora) } : {}),
      ...(puntua ? {} : { viajesSinPuntos: admin.firestore.FieldValue.increment(1) }),
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

  if (!puntos) return null;

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
  return puntos.total;
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
    // Solo si el viaje era de la liga en juego: los de una liga cerrada ya no
    // estan en el marcador, que volvio a cero.
    ...(String(viaje.fechaViaje).slice(0, 10) >= divisiones.inicioLiga(diaMadrid())
      ? { puntosLiga: menos(-(viaje.puntos || 0)) }
      : {}),
    ...(viaje.fueraDeCupo === true ? { viajesSinPuntos: menos(-1) } : {}),
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
  // El motivo sale de lo que escribio quien reviso, o de un texto generico.
  // NUNCA del resumen de la auditoria: esta escrito para quien revisa y lleva
  // los numeros del antifraude dentro, y esto se manda por correo.
  await avisarPorCorreo(viaje.uid, 'viaje_anulado', {
    ruta: viaje.ruta,
    motivo: viaje.motivoRevision
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
 * La ruta destacada es SEMANAL: se elige una vez el lunes, se guarda con su
 * semana y no se vuelve a elegir hasta el lunes siguiente. Una semana da
 * tiempo a que la haga quien solo pasa por ahi un par de dias, y cambiarla a
 * mitad invalidaria la clasificacion de la semana que la gente ya compite.
 */
async function prepararDia() {
  // El dia en Madrid, que es como cuenta los dias todo el juego. Aqui se
  // publicaba con el dia UTC, que en horario de verano va dos horas por detras:
  // el navegador pedia las misiones con su dia y entre las 22:00 y las 00:00 el
  // documento no existia todavia, asi que la seccion desaparecia cada noche.
  const hoy = diaMadrid();
  const refMisiones = db.doc(`config/misiones/dias/${hoy}`);

  if (!(await refMisiones.get()).exists) {
    if (!SIMULAR) await refMisiones.set(misiones.generar(hoy));
    console.log(`Misiones del ${hoy} preparadas.`);
  }

  const refGeneral = db.doc('config/general');
  const general = await refGeneral.get();
  const datos = general.exists ? general.data() : {};

  // La semana se cuenta por su lunes (dia de Madrid).
  const semana = lunesDe(new Date());
  if (datos.rutaDestacadaSemana === semana) return;

  // Cuantos viajes tiene cada tramo, para descartar los que no mueve nadie.
  //
  // Sale del indice de rutas, que el worker ya deja escrito al reconstruir los
  // agregados: una lectura en vez de la coleccion de viajes ENTERA, que con
  // 15.000 acumulados era una de las tres cosas que quedaban leyendola entera.
  // Si el indice todavia no existe — proyecto recien estrenado — se cuenta a
  // mano una vez, que es exactamente lo que hacia antes siempre.
  // Primero el plan del año (data/rutas-destacadas.csv); sin plan para hoy,
  // entre los tramos con actividad, como antes.
  // El plan es de un tramo por dia: la semana se queda con el de su lunes, que
  // ya respeta no repetir tramo en meses.
  const planificada = rutasDestacadas.rutaPlanificada(semana);
  const porRuta = planificada ? null : await conteoPorRuta();

  const recientes = Array.isArray(datos.rutasHistoricas) ? datos.rutasHistoricas.slice(-8) : [];
  const elegida = planificada || misiones.rutaDelDia(porRuta, recientes, semana);

  if (!elegida) {
    console.log('Sin tramos con actividad suficiente: esta semana no hay ruta destacada.');
    return;
  }

  if (!SIMULAR) {
    await refGeneral.set({
      rutaDestacada: elegida,
      rutaDestacadaSemana: semana,
      rutaDestacadaDia: admin.firestore.FieldValue.delete(),
      // Las ya destacadas conservan un multiplicador menor, y ademas sirven
      // para no repetir tramo cada dos por tres.
      rutasHistoricas: admin.firestore.FieldValue.arrayUnion(elegida),
    }, { merge: true });
  }

  console.log(`Ruta de la semana del ${semana}: ${elegida}`);
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

    // Sin `catch`: borrar lo que no existe no falla, asi que solo podia
    // esconder un error real. Y aqui uno silencioso es de los caros: la
    // solicitud se queda dando vueltas en cada pasada, y esta coleccion la
    // escribe gente SIN SESION, o sea que es justo la que no debe acumular.
    if (!SIMULAR) await solicitud.ref.delete();
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
  const aprobadosAMano = [];
  for (const doc of pendientes.docs) {
    const viaje = doc.data();
    rutas.add(viaje.ruta);

    // Un viaje que la administracion APRUEBA desde la cola de revision tiene
    // que sumar como uno aprobado solo. No lo hacia: aqui solo se rehacia el
    // podio de la ruta, y `premiar` se llamaba unicamente desde la aprobacion
    // automatica. O sea que todo viaje que pasaba por revision —los records
    // grandes, las lecturas dudosas, las impugnaciones que se ganaban— contaba
    // en la clasificacion pero NO salvaba la racha, no sumaba kilometros, ni
    // misiones, ni insignias, ni puntos de temporada.
    //
    // `premiado` es la marca de que ya sumo, asi que no se paga dos veces si la
    // pasada se corta entre esto y quitar `recalculoPendiente`.
    if (viaje.verificado === true && viaje.premiado !== true) {
      if (!SIMULAR) {
        const sumados = await premiar(doc, viaje);
        await avisarPorPush(doc.id, viaje, 'aprobado', sumados);
      } else console.log(`  [${doc.id}] se premiaria el viaje aprobado a mano`);
      aprobadosAMano.push(doc);
    }

    // Un viaje que ya habia sumado y que deja de estar verificado hay que
    // deshacerlo, o el piloto se queda con los kilometros y los puntos de un
    // viaje anulado.
    if (viaje.premiado === true && viaje.verificado !== true) {
      if (!SIMULAR) await revertirPremio(doc, viaje);
      else console.log(`  [${doc.id}] se revertirian ${viaje.puntos || 0} puntos`);
    }

    // Rechazado a mano desde la cola, sin haber sumado nunca: se le dice, con
    // las palabras de quien lo ha revisado. Sin esto, el unico rechazo que
    // llegaba por correo era el automatico, y el que decide una persona —que
    // es el que mas explicacion merece— se quedaba en un cambio de color en el
    // historial. Sale una vez: `recalculoPendiente` se apaga justo debajo.
    if (viaje.estado === 'rechazado' && viaje.premiado !== true
      && viaje.revisadoPor && viaje.revisadoPor !== 'automatico') {
      await avisarPorCorreo(viaje.uid, 'viaje_rechazado', {
        ruta: viaje.ruta,
        motivo: viaje.motivoRevision || 'Quien lo ha revisado no ha podido darlo por bueno.',
        tiempoSegundos: viaje.tiempoSegundos ?? null,
        viajeId: doc.id,
        fecha: viaje.fechaViaje || null,
        distanciaMetros: viaje.distanciaMetros ?? null,
        dePersona: true,
        puedePedirRevision: false,
      });
    }

    // Rechazado por una persona es la ultima palabra: ya no hay revision que
    // pedir, asi que la captura sobra. Aprobado, se queda como cualquier otro.
    const finalRechazado = viaje.estado === 'rechazado'
      && viaje.revisadoPor && viaje.revisadoPor !== 'automatico';
    if (finalRechazado && !SIMULAR) {
      await borrarCapturaSiSobra(doc, viaje).catch((error) => {
        console.warn(`  [${doc.id}] no se ha podido borrar la captura:`, error.message);
      });
    }

    if (!SIMULAR) {
      await doc.ref.update({
        recalculoPendiente: false,
        ...(finalRechazado ? { capturaBorrada: true } : {}),
        ...('capturaCaduca' in viaje ? { capturaCaduca: admin.firestore.FieldValue.delete() } : {}),
      });
    }
  }

  if (!SIMULAR) {
    for (const ruta of rutas) {
      await puntuacion.recalcularRuta(ruta);
      apuntarEstaciones(ruta);
    }
    // Despues de rehacer las rutas. Los records grandes pasan TODOS por aqui
    // (`record_pulverizado` los manda a revision), asi que sin esto el aviso
    // solo saltaria con los records pequeños.
    for (const doc of aprobadosAMano) await avisarRecordPerdido(doc.id, doc.data());
  }

  console.log(`Recalculadas ${rutas.size} rutas tras decisiones manuales.`);
  return pendientes.size;
}

/**
 * "Te han quitado el record": el aviso que mas hace volver.
 *
 * La racha trae a quien ya viene. Esto trae a quien tenia algo y lo ha perdido,
 * con nombre y apellidos: quien se lo ha quitado y por cuanto. Es lo que
 * convierte una clasificacion en un pique, y un pique se resuelve saliendo a
 * pedalear.
 *
 * Coste: dos lecturas, y SOLO cuando el viaje aprobado es el nuevo mas rapido
 * de su ruta — el indice ya existe, es el del podio de `recalcularRuta` —, mas
 * la del perfil que hace `push.enviar`. Nada en el resto de aprobaciones.
 *
 * Se mira DESPUES de aprobar, y por eso funciona igual para la aprobacion
 * automatica y la manual: el primero de la ruta tiene que ser este viaje, y el
 * segundo es quien tenia el record. Si el segundo es de la misma persona, el
 * record ya era suyo y no hay a quien avisar. Con un empate, el primero sigue
 * siendo el viaje de antes, y tampoco: empatar no es quitar.
 *
 * Nunca lanza: un aviso que no sale no puede tumbar la verificacion.
 */
async function avisarRecordPerdido(viajeId, viaje) {
  try {
    const podio = await db.collection('tiempos_viaje')
      .where('ruta', '==', viaje.ruta)
      .where('verificado', '==', true)
      .orderBy('tiempoSegundos', 'asc')
      .limit(2)
      .get();

    const [primero, segundo] = podio.docs;
    if (!primero || primero.id !== viajeId || !segundo) return;

    const anterior = segundo.data();
    if (!anterior.uid || anterior.uid === viaje.uid) return;

    const [origen, destino] = String(viaje.ruta).split('-');
    const nombre = (id) => buscarEstacion(id)?.nombre || id;

    const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    const resultado = await push.enviar(anterior.uid, 'recordPerdido', {
      titulo: 'Te han quitado un récord',
      cuerpo: `${viaje.username || 'Alguien'} hizo ${nombre(origen)} → ${nombre(destino)} `
        + `en ${mmss(viaje.tiempoSegundos)}. Tu ${mmss(anterior.tiempoSegundos)} pasa a 2.º.`,
      url: `/clasificacion/?ruta=${encodeURIComponent(viaje.ruta)}`,
    }, { simular: SIMULAR });

    console.log(`  record de ${viaje.ruta} cambia de manos; aviso: ${resultado.enviados || 0} enviados`
      + `${resultado.motivo ? ` (${resultado.motivo})` : ''}`);
  } catch (error) {
    console.warn(`  aviso de record perdido no enviado (${viajeId}):`, error.message);
  }
}

/**
 * Avisa por push de que un trayecto se ha resuelto (#33).
 *
 * Llega antes que el correo y sin molestar: es lo que la persona esta esperando
 * desde que subio la captura. Nunca lanza — un fallo de push no puede tumbar la
 * verificacion — y no se envia nada a quien no lo haya aceptado: `push.enviar`
 * comprueba la suscripcion y el tipo de aviso.
 */
async function avisarPorPush(viajeId, viaje, decision, puntos = null) {
  // Titulo corto con el dato, cuerpo con la accion (07 · 7a).
  const [origen, destino] = String(viaje.ruta || '').split('-');
  const nombre = (id) => buscarEstacion(id)?.nombre || id;
  const tramo = origen && destino ? `${nombre(origen)} → ${nombre(destino)}` : 'Tu trayecto';
  const textos = {
    aprobado: {
      titulo: viaje.fueraDeCupo === true
        ? 'Verificado · sin puntos'
        : `Verificado${Number.isFinite(puntos) ? ` · +${puntos} pts` : ''}`,
      cuerpo: viaje.fueraDeCupo === true
        ? `${tramo}. Pasaba del cupo del día: suma a tus kilómetros.`
        : `${tramo}. Ya cuenta en la clasificación.`,
    },
    rechazado: { titulo: 'Este trayecto no cuenta', cuerpo: `${tramo}. Entra para ver por qué y qué hacer.` },
    revision: { titulo: 'Lo mira una persona', cuerpo: `${tramo}. No hace falta que hagas nada.` },
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
        titulo: `${usuario.racha} días en juego`,
        cuerpo: usuario.escudos > 0
          ? 'Hoy aún no has salido. Si no sales, se gasta un escudo.'
          : 'Hoy aún no has salido. Un trayecto corto antes de medianoche la salva.',
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
 * Resuelve a quien señala cada denuncia (#61).
 *
 * El navegador solo puede mandar el id del viaje. Averiguar de quien es exige
 * leer `tiempos_viaje`, que no lee nadie mas que su dueño y la administracion,
 * asi que ese paso es de aqui.
 *
 * TRES cosas se descartan sin llegar a la cola de nadie:
 *
 *   - el viaje no existe, o ya no
 *   - te estas denunciando a ti mismo. Esto lo comprobaba la regla, y dejo de
 *     poder hacerlo cuando el uid del denunciado salio del documento. Se
 *     comprueba mas tarde, pero no se pierde
 *   - ya habias denunciado ese mismo viaje. Sin esto, una persona sola llena la
 *     cola de la administracion con el mismo caso
 *
 * Lo descartado se marca y se queda, no se borra. La coleccion solo la lee la
 * administracion, asi que el motivo del descarte no es para quien denuncio: es
 * para no volver a mirar el mismo caso, y para que se vea si alguien esta
 * intentando llenar la cola.
 */
async function resolverDenuncias() {
  try {
    const sinResolver = await db.collection('reportes')
      .where('estado', '==', denuncias.ESTADOS.SIN_RESOLVER)
      .limit(50)
      .get();

    if (sinResolver.empty) return 0;

    let encoladas = 0;
    let descartadas = 0;

    for (const doc of sinResolver.docs) {
      const denuncia = doc.data();

      const [viaje, mismas] = await Promise.all([
        db.doc(`tiempos_viaje/${denuncia.viajeId}`).get(),
        db.collection('reportes')
          .where('viajeId', '==', denuncia.viajeId)
          .where('reportanteUid', '==', denuncia.reportanteUid)
          .get(),
      ]);

      const previas = mismas.docs.filter((d) => d.id !== doc.id).map((d) => d.data());
      const veredicto = denuncias.decidir(denuncia, viaje.exists ? viaje.data() : null, previas);

      if (!veredicto.encolar) {
        descartadas++;
        console.log(`  denuncia ${doc.id} descartada: ${veredicto.motivo}`);
        if (!SIMULAR) {
          await doc.ref.update({
            estado: denuncias.ESTADOS.DESCARTADA,
            motivoDescarte: veredicto.motivo,
          });
        }
        continue;
      }

      if (!SIMULAR) {
        await doc.ref.update({
          estado: denuncias.ESTADOS.PENDIENTE,
          reportadoUid: veredicto.reportadoUid,
          ruta: veredicto.ruta,
        });
      }
      encoladas++;
    }

    if (encoladas || descartadas) {
      console.log(`Denuncias: ${encoladas} a la cola, ${descartadas} descartada(s).`);
    }
    return encoladas;
  } catch (error) {
    console.warn('No se han podido resolver las denuncias:', error.message);
    return 0;
  }
}

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
/**
 * Manda un nombre a la cola de moderacion, si hace falta (#64).
 *
 * NO RENOMBRA A NADIE, y es a proposito. El filtro es por subcadena y se
 * equivoca —para eso existe la lista de excepciones de `badwords.js`— y
 * cambiarle el nombre a alguien por un falso positivo es peor que el problema.
 * Lo que sale de aqui lo mira una persona en el panel, que existe desde #61.
 *
 * EL ID DEL DOCUMENTO ES DETERMINISTA, y eso es lo que hace que esto se pueda
 * llamar todas las veces que haga falta: `create` falla con ALREADY_EXISTS si
 * ese nombre ya se reporto, asi que no se acumulan copias del mismo caso ni
 * hace falta leer antes para comprobarlo. Es el mismo truco que ya usa la
 * huella de captura.
 *
 * Nace en `pendiente` y no en `sin_resolver` porque `sin_resolver` es el estado
 * de lo que manda el navegador y todavia hay que averiguar a quien señala.
 * Aqui ya se sabe: lo escribe el worker.
 *
 * @returns {Promise<boolean>} si ha entrado en la cola AHORA
 */
async function revisarNombre(nombre, { uid, ambito, clanId = null }) {
  const veredicto = nombres.revisar(nombre, { ambito });
  if (veredicto.aceptable) return false;

  const id = ambito === 'clan' ? `nombre-clan-${clanId}` : `nombre-piloto-${uid}`;
  if (SIMULAR) {
    console.log(`  [simulacion] nombre a revisar: ${nombres.explicar(nombre, veredicto, ambito)}`);
    return true;
  }

  try {
    await db.collection('reportes').doc(id).create({
      tipo: 'nombre',
      ambito,
      reportadoUid: uid,
      clanId,
      // El nombre va LIMPIO: mandarlo tal cual meteria las marcas bidi en el
      // panel, que es justo donde no se quieren.
      nombre: veredicto.limpio,
      motivo: nombres.explicar(nombre, veredicto, ambito),
      estado: denuncias.ESTADOS.PENDIENTE,
      creado: AHORA(),
    });
    console.log(`  nombre a revisar: ${nombres.explicar(nombre, veredicto, ambito)}`);
    return true;
  } catch (error) {
    if (error.code === 6) return false;   // ya estaba reportado
    throw error;
  }
}

async function darBienvenidas() {
  try {
    const nuevos = await db.collection('usuarios')
      .where('bienvenidaEnviada', '==', false)
      .limit(20)
      .get();

    if (nuevos.empty) return 0;

    let saludados = 0;

    for (const doc of nuevos.docs) {
      // El nombre se mira AQUI y no en una pasada aparte, y no es casualidad:
      // las reglas no dejan cambiar `username` despues de crear el perfil, asi
      // que se escribe una sola vez y esta es la unica vez que el worker ve a
      // esta persona. Ademas el documento ya esta leido — cuesta cero (#64).
      await revisarNombre(doc.data().username, { uid: doc.id, ambito: 'piloto' })
        .catch((error) => {
          // Que no se pueda encolar el nombre no puede dejar a nadie sin
          // bienvenida, pero tampoco se calla: es una revision que no se hara
          // nunca mas, porque la marca de abajo se pone igual.
          console.error('::warning::No se ha podido revisar el nombre de'
            + ` ${doc.id}:`, error.message);
        });

      const enviado = await avisarPorCorreo(doc.id, 'bienvenida', {}, doc);

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
 * Los correos que no nacen en el worker: los pide alguien escribiendo un
 * documento, y el worker, que es el unico que sabe mandar correo, los envia.
 *
 * `mensajes_equipo` la escribe la administracion (reglas: solo con el claim):
 * un mensaje a un piloto o el aviso de que su cuenta queda suspendida.
 *
 * `avisos_seguridad/{uid}` la escribe cada uno para SI MISMO, justo despues de
 * cambiar la contraseña (/cuenta/). No basta con creerle: cualquiera podria
 * crear el documento sin haber cambiado nada y mandarse correos en bucle. Asi
 * que se comprueba contra Firebase Auth que la contraseña ha cambiado de verdad
 * hace poco (al cambiarla, Auth invalida las sesiones anteriores y anota
 * cuando), y ademas va como mucho un aviso por hora y persona.
 *
 * Los documentos se borran al enviarse. Si el envio falla y merece reintento,
 * `avisarPorCorreo` ya lo deja en `correos_pendientes`.
 *
 * Coste con las dos colecciones vacias, que es lo normal: dos lecturas.
 */
const VENTANA_CAMBIO_CLAVE_MS = 2 * 60 * 60 * 1000;
const ENTRE_AVISOS_CLAVE_MS = 60 * 60 * 1000;

async function enviarCorreosPedidos() {
  let enviados = 0;
  try {
    const mensajes = await db.collection('mensajes_equipo').orderBy('creado').limit(20).get();
    for (const doc of mensajes.docs) {
      const m = doc.data();
      if (m.uid && plantillas.POR_TIPO[m.tipo]) {
        const extra = m.tipo === 'cuenta_suspendida'
          ? { motivo: m.motivo || null, desde: fechaLegible(m.creado?.toDate?.()), hasta: m.hasta || null }
          : { asunto: m.asunto || null, texto: m.texto || '', sobre: m.sobre || null, firma: m.firma || undefined };
        if (await avisarPorCorreo(m.uid, m.tipo, extra)) enviados++;
      }
      if (!SIMULAR) await doc.ref.delete();
    }
  } catch (error) {
    console.warn('No se han podido enviar los mensajes del equipo:', error.message);
  }

  try {
    const avisos = await db.collection('avisos_seguridad').limit(20).get();
    for (const doc of avisos.docs) {
      const uid = doc.id;
      const aviso = doc.data();
      let valido = false;
      try {
        const cuenta = await admin.auth().getUser(uid);
        const desde = Date.parse(cuenta.tokensValidAfterTime || '');
        valido = Number.isFinite(desde) && Date.now() - desde < VENTANA_CAMBIO_CLAVE_MS;
        if (valido) {
          const perfil = await db.doc(`usuarios/${uid}`).get();
          const ultimo = perfil.data()?.ultimoAvisoClave?.toMillis?.() || 0;
          if (Date.now() - ultimo < ENTRE_AVISOS_CLAVE_MS) valido = false;
          else if (!SIMULAR && perfil.exists) {
            await perfil.ref.update({ ultimoAvisoClave: admin.firestore.FieldValue.serverTimestamp() });
          }
          if (valido && await avisarPorCorreo(uid, 'clave_cambiada', {
            cuando: fechaLegible(new Date(desde)),
            dispositivo: aviso.dispositivo || null,
          }, perfil)) enviados++;
        }
      } catch {
        valido = false; // cuenta borrada: no hay a quien avisar
      }
      if (!valido) console.log(`  aviso de seguridad de ${uid} descartado: no hay cambio reciente`);
      if (!SIMULAR) await doc.ref.delete();
    }
  } catch (error) {
    console.warn('No se han podido enviar los avisos de seguridad:', error.message);
  }

  if (enviados) console.log(`Correos pedidos: ${enviados} enviado(s).`);
  return enviados;
}

/** "martes 29 de septiembre, 18:02", en hora de Madrid. */
function fechaLegible(fecha) {
  if (!(fecha instanceof Date) || Number.isNaN(fecha.getTime())) return null;
  return fecha.toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit',
  });
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

      const enviado = await avisarPorCorreo(viaje.uid, 'revision_lenta', { ruta: viaje.ruta });

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

    // Las dos de clanes van aqui y no en cada pasada: leen `clanes` entera, y
    // ni un lider desaparece en cinco minutos ni una doble membresia se cura
    // sola. La limpieza va ANTES del rescate: si no, se podria elegir sucesor
    // entre gente que ya no esta en el clan.
    const dobles = await clanes.limpiarDoblesMembresias({ simular: SIMULAR });
    if (dobles) console.log(`Clanes: ${dobles} membresia(s) fantasma limpiada(s).`);

    const nombresClan = await revisarNombresDeClan();
    if (nombresClan) console.log(`Clanes: ${nombresClan} nombre(s) a revisar.`);

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

/**
 * Vacia la cola de correos que no pudieron salir (#65).
 *
 * Va en cada pasada, no en el trabajo diario: un aviso de viaje rechazado que
 * llega al dia siguiente ya no sirve de nada, y la consulta es indexada y
 * acotada — cuesta una lectura cuando la cola esta vacia, que es lo normal.
 *
 * El mensaje se vuelve a montar aqui, no se saca guardado: la cola solo lleva
 * el tipo y los datos de la plantilla, y la direccion se le pide a Firebase
 * Auth en el momento. Ver `cola-correo.js` para por que.
 *
 * `encolar: false` en el reintento es lo que evita el bucle: si volviera a
 * fallar, `avisarPorCorreo` crearia OTRA entrada y la cola se multiplicaria en
 * vez de agotarse. Los intentos los lleva la entrada que ya existe.
 */
async function reenviarCorreos() {
  try {
    const pendientes = await db.collection('correos_pendientes')
      .orderBy('reintentarTras')
      .limit(colaCorreo.POR_PASADA)
      .get();

    if (pendientes.empty) return 0;

    const cola = pendientes.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));

    // El cupo del dia sale de lo que lleve gastado el contador de cuota, que ya
    // cuenta los correos... no: cuenta lecturas y escrituras de Firestore, no
    // correos. Lo que se lleva enviado hoy no lo sabe nadie sin guardarlo, asi
    // que se cuenta lo que se manda en esta pasada y se deja el resto para la
    // siguiente. Con una pasada cada cinco minutos, el reparto por prioridad
    // sigue haciendo su trabajo dentro de cada tanda.
    const { ahora, esperan } = colaCorreo.tocaAhora(cola);
    if (!ahora.length) return 0;

    let enviados = 0;
    let rendidos = 0;

    for (const entrada of ahora) {
      if (correo.debeDejarDeIntentar(entrada)) {
        if (!SIMULAR) await entrada.ref.delete();
        rendidos++;
        continue;
      }

      const salio = await avisarPorCorreo(
        entrada.uid, entrada.tipo, entrada.extra || {}, null, { encolar: false });

      const veredicto = correo.decidirReintento(
        entrada,
        // `avisarPorCorreo` devuelve un booleano, no el resultado de Resend. Lo
        // que hace falta aqui es si merece otro intento, y eso ya se decidio al
        // encolar: si el correo sigue sin salir, se sigue reintentando hasta
        // agotar `MAX_INTENTOS`.
        { enviado: salio, reintentable: true });

      if (!SIMULAR) {
        if (veredicto.estado === 'enviado') {
          await entrada.ref.delete();
        } else if (veredicto.estado === 'fallido') {
          await entrada.ref.delete();
          console.warn(`  correo ${entrada.tipo} para ${entrada.uid} descartado: ${veredicto.error}`);
        } else {
          await entrada.ref.update({
            intentos: veredicto.intentos,
            reintentarTras: veredicto.reintentarTras,
            ultimoError: veredicto.error || null,
          });
        }
      }

      if (veredicto.estado === 'enviado') enviados++;
      if (veredicto.estado === 'fallido') rendidos++;
    }

    console.log(`Cola de correo: ${enviados} enviado(s), ${rendidos} descartado(s), `
      + `${esperan.length} esperando cupo.`);
    return enviados;
  } catch (error) {
    // Que falle la cola de correo no puede tumbar la verificacion de viajes.
    console.warn('No se ha podido vaciar la cola de correo:', error.message);
    return 0;
  }
}

/**
 * Los nombres de los clanes nuevos (#64).
 *
 * Solo los CREADOS EN LOS ULTIMOS DOS DIAS, no la coleccion entera. Las reglas
 * tampoco dejan cambiar el nombre de un clan despues de crearlo, asi que basta
 * con verlo una vez; y una consulta acotada por `creado` cuesta una lectura
 * cuando no hay clanes nuevos, que es lo normal.
 *
 * Dos dias y no uno: si una ejecucion diaria se salta —el cron falla, el
 * repositorio esta en mantenimiento— con un solo dia de ventana ese clan no se
 * miraria nunca. Repetir no cuesta nada porque el id del reporte es
 * determinista.
 */
async function revisarNombresDeClan() {
  const desde = new Date(Date.now() - 2 * 86400000);

  const nuevos = await db.collection('clanes').where('creado', '>=', desde).get();
  if (nuevos.empty) return 0;

  let encolados = 0;

  for (const doc of nuevos.docs) {
    const clan = doc.data();
    // `reportadoUid` es el lider: un clan no es una persona, y quien responde
    // del nombre es quien lo puso.
    const entrado = await revisarNombre(clan.nombre, {
      uid: clan.lider || null, ambito: 'clan', clanId: doc.id,
    });
    if (entrado) encolados++;
  }

  return encolados;
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
          // Lo que ha pasado esta noche, en la MISMA escritura: es lo que
          // cuenta Hoy la mañana siguiente (02 Hoy · 2f, "Ayer te cubrió un
          // escudo" / "Tu racha de 23 días terminó"). Sin coste extra.
          ultimoCierreRacha: {
            dia: diaMadrid(),
            escudosGastados: cierre.escudosGastados,
            rota: cierre.rota,
            rachaPrevia: datos.racha || 0,
          },
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

  const enviado = await enviarAAdmin(plantillas.cuotaEnPeligro({
    nivel: aviso.nivel,
    porcentaje: aviso.porcentaje,
    consumido: acumulado,
    proyeccion: cuota.estimar(acumulado),
    limites: cuota.LIMITES,
  }), `Cuota al ${Math.round(aviso.porcentaje)}%`);

  if (enviado) console.log(`  avisado a la administracion: nivel ${aviso.nivel}.`);
}

/**
 * Manda un mensaje ya montado a la administracion.
 *
 * El unico otro sitio del worker que llama a `correo.enviar` es
 * `avisarPorCorreo`, que es el de los pilotos. Son dos canales distintos a
 * proposito y no se pueden mezclar: al piloto hay que mirarle la preferencia y
 * meterle el enlace de baja; a la administracion no, porque estos avisos son la
 * unica forma de enterarse de algo que esta pasando ahora y darse de baja de
 * ellos es quedarse sin saberlo.
 *
 * Sin `CORREO_ADMIN` el aviso se queda en el registro del workflow, que es donde
 * no lo lee nadie hasta que ya es tarde. Se dice, para que se note que falta.
 */
async function enviarAAdmin(mensaje, resumenSiNoHayCorreo = '') {
  const destinatario = process.env.CORREO_ADMIN;

  if (!destinatario) {
    console.warn(`::warning::${resumenSiNoHayCorreo || mensaje.asunto}: `
      + 'sin CORREO_ADMIN no hay a quien avisar.');
    return false;
  }

  try {
    const resultado = await correo.enviar({
      ...mensaje,
      para: destinatario,
      remitente: REMITENTE,
      apiKey: process.env.RESEND_API_KEY,
      simular: SIMULAR,
    });

    if (resultado.error) {
      console.warn(`  aviso a la administracion no enviado: ${resultado.error}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn('  no se ha podido avisar a la administracion:', error.message);
    return false;
  }
}

/** Atajo para un aviso de una linea, sin plantilla propia. */
function avisarAdmin(asunto, cuerpo, enlace = null) {
  return enviarAAdmin(plantillas.avisoAdmin({ asunto, cuerpo, enlace }), `${asunto}: ${cuerpo}`);
}

/**
 * Si una sola persona ha llenado la tanda, se le tira lo que sobra de golpe.
 *
 * NO es el arreglo de #62 — eso hay que pararlo ANTES de la escritura y esta
 * por decidir — pero si arregla lo que pasaba mientras. Nada impide hoy que una
 * cuenta escriba miles de viajes: las reglas de Firestore no saben contar, y el
 * cupo de tres al dia se comprueba aqui, o sea cuando el documento ya existe.
 *
 * Y la cola es FIFO. Con mil viajes de una misma cuenta delante, los 25 de cada
 * pasada son suyos: quien sube su trayecto legitimo se queda detras durante
 * DIAS, aunque cada uno de esos mil se acabe rechazando. El problema no era solo
 * la cuota, era que la cola dejaba de avanzar para todos los demas.
 *
 * Rechazar en bloque no adelanta ningun veredicto: por definicion pasan del cupo
 * diario, que es lo mismo que iba a decidir `validarBasico` uno por uno. Solo
 * evita pagar una pasada entera por cada 25.
 *
 * No suspende a nadie: eso es una decision con una persona detras, y se toma en
 * el panel. Aqui se avisa y se sigue.
 */
async function despejarInundacion(cola) {
  const porUid = new Map();
  for (const doc of cola.docs) {
    const uid = doc.data().uid;
    if (uid) porUid.set(uid, (porUid.get(uid) || 0) + 1);
  }

  // Dominar la tanda entera es la señal. Con el cupo en tres al dia, alguien con
  // veinte pendientes a la vez no esta usando la web.
  const inunda = [...porUid.entries()]
    .filter(([, cuantos]) => cuantos >= Math.min(MAX_POR_TANDA, LIMITES.VIAJES_POR_DIA * 4));

  if (!inunda.length) return 0;

  let tirados = 0;

  for (const [uid, enLaTanda] of inunda) {
    // Acotado: si tiene diez mil, se van despejando por pasadas. Lo que importa
    // es que la cola vuelva a avanzar para los demas, no vaciarla de una vez.
    const suyos = await db.collection('tiempos_viaje')
      .where('uid', '==', uid)
      .where('estado', '==', 'pendiente')
      .limit(400)
      .get();

    console.log(`::warning::${uid} tiene ${suyos.size}+ viajes en cola (${enLaTanda} en esta tanda).`);

    if (SIMULAR) { tirados += suyos.size; continue; }

    // Se dejan los del cupo diario sin tocar: entre ellos puede estar el viaje
    // de verdad, y decidirlo es de `procesar`.
    const sobran = suyos.docs.slice(LIMITES.VIAJES_POR_DIA + LIMITES.VIAJES_SIN_PUNTOS_POR_DIA);

    for (let i = 0; i < sobran.length; i += 200) {
      const lote = db.batch();
      for (const doc of sobran.slice(i, i + 200)) {
        lote.update(doc.ref, {
          estado: 'rechazado',
          verificado: false,
          motivos: ['cupo_diario'],
          revisadoPor: 'automatico',
          revisadoEn: AHORA(),
        });
      }
      await lote.commit();
      tirados += Math.min(200, sobran.length - i);
    }

    // Las capturas son lo que ocupa: 700 KB cada una. Van aparte del lote
    // porque cada viaje puede compartirla con otros suyos.
    for (const doc of sobran) {
      // Aqui el `catch` SI tiene motivo — que falle una captura no puede parar
      // el despeje de las otras — pero hablando: son 700 KB cada una, y si
      // fallan todas en silencio el despeje deja de servir para lo que sirve.
      await borrarCapturaSiSobra(doc, doc.data())
        .catch((error) => console.warn(`  no se ha podido borrar la captura de ${doc.id}:`,
          error.message));
    }

    await avisarAdmin(
      `Cola inundada por ${uid}`,
      `${uid} ha dejado ${suyos.size}+ viajes pendientes. Se han rechazado ${sobran.length} `
      + 'por cupo diario y se han borrado sus capturas. Si se repite, la cuenta se '
      + 'suspende desde el panel.',
    ).catch((error) => {
      // Que no salga el correo no puede parar el despeje —lo importante es que
      // la cola quede libre para los demas— pero un aviso que se pierde EN
      // SILENCIO es lo peor de las dos opciones: la administracion no se entera
      // del abuso, y tampoco se entera de que no se ha enterado.
      console.error('::warning::No se ha podido avisar del flood a la administracion:',
        error.message);
    });
  }

  return tirados;
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

  // Antes de gastar una pasada entera en los viajes de una sola cuenta.
  if (cola.size >= MAX_POR_TANDA) {
    const tirados = await despejarInundacion(cola);
    if (tirados) {
      console.log(`Despejados ${tirados} viajes de la cola. La siguiente pasada ya avanza.`);
      return cola.size;
    }
  }

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
        // El mensaje del error va a la auditoria, no al viaje: es texto interno
        // — a veces con rutas de fichero dentro — y el viaje lo lee su dueño.
        // Estos dos `catch` si tienen motivo: se esta ya dentro del manejo de un
        // error, y si tambien falla mover el viaje a revision, lo que NO puede
        // pasar es tumbar la tanda entera y dejar sin procesar los viajes de los
        // demas. Pero se dice, porque un viaje que se queda pendiente para
        // siempre sin que nadie se entere es exactamente lo que este bloque
        // intenta evitar.
        await escribirAuditoria(doc.id, {
          resumen: 'El analisis automatico ha fallado. Requiere revision humana.',
          riesgo: 50,
          señales: [{ codigo: 'error_worker', gravedad: 50, mensaje: error.message }],
        }).catch((fallo) => console.error(`  [${doc.id}] tampoco se ha podido guardar `
          + `la auditoria del fallo:`, fallo.message));

        await doc.ref.update({
          estado: 'revision',
          avisoRevision: false,
          motivos: ['error_worker'],
          auditoria: admin.firestore.FieldValue.delete(),
        }).catch((fallo) => console.error(`  [${doc.id}] SE QUEDA PENDIENTE: tampoco se `
          + `ha podido pasar a revision:`, fallo.message));

        // Y se le dice a quien lo subio, que si no ve un trayecto "en revision"
        // sin saber por que. El texto dice que es cosa nuestra y que no lo
        // vuelva a subir; el error de verdad no sale del worker.
        const subido = doc.data();
        if (subido?.uid) {
          await avisarPorCorreo(subido.uid, 'error_procesar', {
            ruta: subido.ruta, subido: subido.creado?.toDate?.() || null,
          });
        }
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
  // En degradado tampoco: vigilar la cola en vacio cada 30 s gastaria justo lo
  // que queda de cuota, y la siguiente ejecucion ya mira una vez.
  const daVueltas = VENTANA_MS > 0 && !SIMULAR && !SOLO_UNO && !degradado;
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
  await caducarCapturasRechazadas();
  await procesarBajas();
  await procesarBorrados();
  await mantenerClanes();
  await procesarInvitaciones();
  await resolverDenuncias();
  await darBienvenidas();
  await enviarCorreosPedidos();
  await procesarValoraciones();
  // Despues de las bienvenidas a proposito: si una acaba de fallar y se ha
  // encolado, el primer reintento es dentro de un minuto, o sea en la pasada
  // siguiente. Ponerlo antes no adelantaria nada y haria una lectura de mas.
  await reenviarCorreos();
  await trabajoDiario();

  // Los agregados se reconstruyen UNA VEZ al final, no por viaje: es la
  // operacion mas cara que hace el worker (#36).
  //
  // `usuarios` y `tiempos_viaje` se cargan aqui una sola vez y se comparten con
  // el resumen de metricas, que necesita exactamente las mismas dos. Cuando las
  // dos cosas caen en la misma pasada — que es justo cuando ha habido
  // movimiento — leerlas por separado costaba el doble (#34).
  // Las decisiones manuales tambien mueven rutas y estaciones sin pasar por la
  // cola: sin contarlas aqui, una pasada que solo aplicara decisiones del panel
  // no las rehacia ni las apuntaba, y se perdian al morir el proceso.
  const huboMovimiento = cuenta.aprobado > 0 || cuenta.rechazado > 0
    || rutasTocadas.size > 0 || estacionesTocadas.size > 0;

  // Reconstruir los agregados lee las CUATRO colecciones enteras: es la
  // operacion mas cara que queda. Hacerlo en cada pasada con movimiento son
  // unas treinta veces al dia, y quince minutos de antiguedad no se notan —
  // el worker ya llega con 5-15 de retraso, asi que la clasificacion nunca ha
  // sido instantanea (docs/COSTE.md).
  //
  // Quien acaba de subir un trayecto ve su veredicto por el seguimiento en vivo
  // del propio viaje, que no pasa por los agregados.
  //
  // Y la cadencia se adapta a la cuota: si el dia va apretado, cada hora en vez
  // de cada cuarto de hora (`agregados.minutosEntreReconstrucciones`).
  const minutosAgregados = agregados.minutosEntreReconstrucciones(
    cuota.nivel(cuotaAlEmpezar), cuota.estimar(cuotaAlEmpezar), cuota.LIMITES.LECTURAS,
    cuota.UMBRALES.ATENCION);
  const rehacerAgregados = huboMovimiento
    && !SIMULAR
    && await agregados.tocaReconstruir(Date.now(), minutosAgregados).catch(() => true);

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

  if (rehacerPesado && rehacerAgregados) {
    // Lo de esta pasada MAS lo que quedo apuntado de las pasadas que el
    // limitador salto. Si no, una ruta o una estacion movidas durante esos
    // quince minutos se quedarian con el agregado viejo.
    const pendientes = await agregados.leerPendientes();
    const rutas = new Set([...rutasTocadas, ...pendientes.rutas]);
    const estaciones = new Set([...estacionesTocadas, ...pendientes.estaciones]);

    // El dominio de las estaciones, con la MISMA cadencia que los agregados y
    // no en cada pasada con viajes. Nadie lo ve si no es a traves del mapa, que
    // se rehace aqui mismo; calcularlo cada cinco minutos era pagar tres veces
    // la misma estacion para enseñarla una. Y como van juntas, una estacion
    // movida en una pasada que el limitador salto se recoge de lo pendiente,
    // igual que las rutas.
    //
    // Lo unico que lo lee entre medias es el bonus de territorio propio, y ese
    // puede ir un cuarto de hora por detras sin que nadie lo note.
    if (estaciones.size) {
      const cuantas = await puntuacion.recalcularEstaciones(estaciones);
      console.log(`Dominio recalculado en ${cuantas} estaciones.`);
    }

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
    // Con `catch` porque apuntar no puede tumbar la pasada, pero hablando: si
    // esto falla, las rutas y estaciones movidas se pierden al morir el proceso
    // y sus agregados se quedan viejos hasta que alguien vuelva a moverlas.
    await agregados.apuntarPendientes(rutasTocadas, estacionesTocadas)
      .catch((error) => console.warn('No se ha podido apuntar lo pendiente:', error.message));
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
  // TAMBIEN se salta en degradado, aunque sea la barata. Es barata en LECTURAS
  // —una consulta acotada a 450— pero poda el detalle viejo, y podar son
  // escrituras: hasta 450 por pasada.
  //
  // Y las escrituras son el recurso que aprieta en el caso que importa. Cualquiera
  // puede escribir en `sesiones_web` sin sesion (#67), asi que una inundacion
  // pone al worker a gastar el dia entero borrando basura mientras los viajes
  // de verdad se quedan en la cola. `cuota.nivel` mira las dos cuotas y se
  // queda con la que mas apriete, asi que en ese caso `degradado` ya esta
  // encendido: solo faltaba mirarlo aqui.
  //
  // Lo que se pierde es que el detalle se acumule un rato mas. Lo que se
  // protege es lo unico que la gente esta esperando de verdad.
  if (!SIMULAR && !degradado) {
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

  // Si esto falla no pasa nada grave: la siguiente ejecucion recupera de la
  // coleccion lo que falte. Pero se dice, que una ventana que nunca se guarda
  // es volver a pagar 150 lecturas por ejecucion sin enterarse.
  await guardarVentana().catch((error) => {
    console.warn('No se ha podido guardar la ventana de huellas:', error.message);
  });

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
