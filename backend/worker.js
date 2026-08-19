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
 * tarda entre 5 y 10 minutos en resolverse en vez de segundos. A cambio, la
 * clave de Gemini y las credenciales de administrador NUNCA tocan el navegador,
 * que es lo que provoco el compromiso anterior.
 *
 * Variables de entorno (GitHub Secrets):
 *   FIREBASE_SERVICE_ACCOUNT  JSON de la cuenta de servicio
 *   GEMINI_API_KEY            clave de la API de Gemini
 *
 * Uso:
 *   node backend/worker.js              procesa la cola
 *   node backend/worker.js --once       procesa como mucho un viaje (pruebas)
 *   node backend/worker.js --simular    analiza pero no escribe nada
 */

const admin = require('firebase-admin');

const { LIMITES, TIEMPO } = require('./src/config');
const { construirRuta, inicioDelDiaMadrid } = require('./src/util');
const imagen = require('./src/imagen');
const { auditarCaptura } = require('./src/gemini');
const { evaluar, distanciaCalleMetros } = require('./src/verificacion');
const puntuacion = require('./src/puntuacion');

const SIMULAR = process.argv.includes('--simular');
const SOLO_UNO = process.argv.includes('--once');

// Cuantos viajes se procesan por ejecucion. Con una ejecucion cada 5 minutos
// esto da holgura de sobra y evita agotar la cuota diaria de Firestore del plan
// gratuito (50.000 lecturas y 20.000 escrituras al dia).
const MAX_POR_TANDA = SOLO_UNO ? 1 : 25;

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

const db = arrancar();
const AHORA = () => admin.firestore.FieldValue.serverTimestamp();

/**
 * Comprueba lo que el navegador no puede garantizar por si solo.
 *
 * Las reglas de Firestore validan la forma del documento y que el dueno sea
 * quien dice ser, pero no saben contar cuantos viajes ha subido alguien hoy ni
 * si la ruta existe de verdad. Eso se comprueba aqui, y lo que no cuadra se
 * rechaza sin llegar a gastar una llamada a Gemini.
 */
async function validarBasico(viaje, uid) {
  try {
    construirRuta(...String(viaje.ruta || '').split('-'));
  } catch {
    return 'La ruta declarada no existe.';
  }

  if (!Number.isInteger(viaje.tiempoSegundos)
    || viaje.tiempoSegundos < TIEMPO.MIN_SEGUNDOS
    || viaje.tiempoSegundos > TIEMPO.MAX_SEGUNDOS) {
    return 'El tiempo declarado esta fuera de rango.';
  }

  const fecha = new Date(`${String(viaje.fechaViaje).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(fecha.getTime())) return 'La fecha del viaje no es valida.';

  const ahora = Date.now();
  if (fecha.getTime() > ahora + 864e5) return 'No se pueden registrar viajes futuros.';
  if (ahora - fecha.getTime() > LIMITES.DIAS_MAX_ANTIGUEDAD * 864e5) {
    return `Solo se admiten viajes de los ultimos ${LIMITES.DIAS_MAX_ANTIGUEDAD} dias.`;
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
    return `Limite de ${LIMITES.VIAJES_POR_DIA} viajes al dia superado.`;
  }

  return null;
}

/** Contexto competitivo y estadistico que alimenta al motor. */
async function reunirContexto(viaje, uid) {
  const [rutaSnap, propiosSnap, huellasSnap] = await Promise.all([
    db.collection('tiempos_viaje')
      .where('ruta', '==', viaje.ruta).where('verificado', '==', true)
      .orderBy('tiempoSegundos', 'asc').limit(200).get(),
    db.collection('tiempos_viaje')
      .where('uid', '==', uid).where('verificado', '==', true)
      .orderBy('creado', 'desc').limit(40).get(),
    db.collection('huellas_captura').orderBy('creado', 'desc').limit(400).get(),
  ]);

  const tiemposRuta = rutaSnap.docs.map((d) => d.data().tiempoSegundos);
  const propios = propiosSnap.docs.map((d) => d.data());

  return {
    tiemposRuta,
    mejorTiempoRuta: tiemposRuta.length ? tiemposRuta[0] : null,
    mejorTiempoPropio: propios
      .filter((v) => v.ruta === viaje.ruta)
      .reduce((mejor, v) => (mejor === null || v.tiempoSegundos < mejor ? v.tiempoSegundos : mejor), null),
    velocidadesPrevias: propios
      .map((v) => {
        const metros = distanciaCalleMetros(...String(v.ruta || '').split('-'));
        return metros && v.tiempoSegundos ? (metros / v.tiempoSegundos) * 3.6 : null;
      })
      .filter(Boolean),
    shaPrevios: huellasSnap.docs.map((d) => ({ sha: d.data().sha, tripId: d.data().tripId, uid: d.data().uid })),
    hashesPrevios: huellasSnap.docs.map((d) => ({ dhash: d.data().dhash, tripId: d.data().tripId })),
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
    console.log(`  rechazado: ${problema}`);
    if (!SIMULAR) await resolver(doc, { decision: 'rechazado', resumen: problema, riesgo: 100, señales: [] });
    return 'rechazado';
  }

  // 2. La captura vive en su propia coleccion, que el cliente no puede leer.
  const capturaSnap = await db.doc(`capturas/${doc.id}`).get();
  if (!capturaSnap.exists) {
    console.log('  rechazado: no hay captura asociada');
    if (!SIMULAR) {
      await resolver(doc, { decision: 'rechazado', resumen: 'No se ha recibido la captura.', riesgo: 100, señales: [] });
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
      await resolver(doc, { decision: 'rechazado', resumen: 'La captura no es una imagen valida.', riesgo: 100, señales: [] });
    }
    return 'rechazado';
  }

  // 3. Huellas y metadatos.
  const [hashSha, hashPerceptual, inspeccion] = await Promise.all([
    Promise.resolve(imagen.hashExacto(buffer)),
    imagen.hashPerceptual(buffer),
    imagen.inspeccionar(buffer),
  ]);

  // 4. Contexto y auditoria con IA.
  const contexto = await reunirContexto(viaje, uid);
  const ia = await auditarCaptura({ buffer, mime, apiKey: process.env.GEMINI_API_KEY });

  // 5. Veredicto.
  const veredicto = evaluar({
    ruta: viaje.ruta,
    tiempoSegundos: viaje.tiempoSegundos,
    ia,
    hashSha,
    hashPerceptual,
    edicionSospechosa: inspeccion.sospechaEdicion,
    software: inspeccion.software,
    ...contexto,
  });

  console.log(`  -> ${veredicto.decision} (riesgo ${veredicto.riesgo}): ${veredicto.resumen}`);
  for (const s of veredicto.señales) console.log(`     [${s.gravedad}] ${s.mensaje}`);

  if (SIMULAR) return veredicto.decision;

  // 6. Guardar la huella para que la captura no se pueda reutilizar. `create`
  // y no `set`: si ya existe hay que conservar la del viaje original.
  await db.collection('huellas_captura').doc(hashSha).create({
    sha: hashSha, dhash: hashPerceptual, tripId: doc.id, uid, creado: AHORA(),
  }).catch((error) => {
    if (error.code !== 6) throw error; // 6 = ALREADY_EXISTS
  });

  await resolver(doc, veredicto);
  return veredicto.decision;
}

/** Escribe el veredicto y, si procede, recalcula la clasificacion. */
async function resolver(doc, veredicto) {
  const viaje = doc.data();
  const aprobado = veredicto.decision === 'aprobado';

  await doc.ref.update({
    estado: veredicto.decision,
    verificado: aprobado,
    auditoria: veredicto,
    revisadoPor: 'automatico',
    revisadoEn: AHORA(),
  });

  if (aprobado) {
    await db.doc(`usuarios/${viaje.uid}`).update({
      viajesVerificados: admin.firestore.FieldValue.increment(1),
    });
    await puntuacion.recalcularTrasCambio(viaje.ruta);
  }

  // Las capturas rechazadas no aportan nada y ocupan cuota: el hash ya impide
  // reutilizar la imagen, asi que el fichero en si sobra.
  if (veredicto.decision === 'rechazado') {
    await db.doc(`capturas/${doc.id}`).delete().catch(() => {});
  }
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
    if (!SIMULAR) await doc.ref.update({ recalculoPendiente: false });
  }

  if (!SIMULAR) {
    for (const ruta of rutas) await puntuacion.recalcularTrasCambio(ruta);
  }

  console.log(`Recalculadas ${rutas.size} rutas tras decisiones manuales.`);
  return pendientes.size;
}

async function main() {
  console.log(SIMULAR ? '=== SIMULACION: no se escribe nada ===' : '=== Worker de verificacion ===');

  const cola = await db.collection('tiempos_viaje')
    .where('estado', '==', 'pendiente')
    .orderBy('creado', 'asc')
    .limit(MAX_POR_TANDA)
    .get();

  console.log(`Viajes en cola: ${cola.size}`);

  const cuenta = { aprobado: 0, rechazado: 0, revision: 0, error: 0 };

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
          auditoria: {
            resumen: 'El analisis automatico ha fallado. Requiere revision humana.',
            riesgo: 50,
            señales: [{ codigo: 'error_worker', gravedad: 50, mensaje: error.message }],
          },
        }).catch(() => {});
      }
    }
  }

  await aplicarDecisionesManuales();

  console.log(`\nResumen: ${cuenta.aprobado} aprobados, ${cuenta.rechazado} rechazados, `
    + `${cuenta.revision} a revision, ${cuenta.error} con error.`);
  process.exit(0);
}

main().catch((error) => {
  console.error('Fallo del worker:', error);
  process.exit(1);
});
