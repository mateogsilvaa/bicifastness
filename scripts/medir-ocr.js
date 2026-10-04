#!/usr/bin/env node
/**
 * Mide cuanto acierta el OCR sobre las capturas REALES que ya hay en Firestore.
 *
 * Por que asi y no con un banco de imagenes en el repositorio: esas capturas
 * son trayectos de personas reales, o sea datos personales. Meterlas en un
 * repositorio que va a ser publico no se arregla con recortarles el nombre. La
 * medicion corre donde ya viven los datos, y de aqui **solo sale un informe con
 * numeros**: ninguna imagen y ningun texto leido salen de la base.
 *
 * Referencia contra la que se compara: los campos del propio viaje ya
 * verificado (`ruta` y `tiempoSegundos`). No es una referencia perfecta, pero
 * es la unica que existe y esta bien: esos viajes se dieron por buenos
 * habiendo contrastado la captura en su momento.
 *
 * Uso:
 *   FIREBASE_SERVICE_ACCOUNT=... node scripts/medir-ocr.js [--limite 40] [--salida informe.json]
 *     [--todos]   tambien los rechazados y los de revision, los mas recientes
 *                 primero, y con el veredicto que les daria HOY el motor
 *
 * Con `--todos` la referencia ya no es de confianza (un viaje rechazado puede
 * llevar una ruta mal escrita), asi que lo que importa es la otra parte del
 * informe: con que decision se guardo cada viaje y cual le daria el lector de
 * ahora. Es lo que dice si un cambio deja de rechazar capturas buenas.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const imagen = require(path.join(RAIZ, 'backend/src/imagen'));
const ocr = require(path.join(RAIZ, 'backend/src/ocr'));

const args = process.argv.slice(2);
const valor = (bandera, defecto) => {
  const i = args.indexOf(bandera);
  return i === -1 ? defecto : args[i + 1];
};

const LIMITE = Number(valor('--limite', 40));
const SALIDA = valor('--salida', null);
const TODOS = args.includes('--todos');
const { evaluar } = require(path.join(RAIZ, 'backend/src/verificacion'));

/** Normaliza un id de estacion igual que el resto del proyecto: 3 digitos. */
function normalizar(raw) {
  const v = String(raw ?? '').trim().toUpperCase();
  const m = v.match(/^(\d+)([A-Z]?)$/);
  return m ? m[1].padStart(3, '0') + (m[2] || '') : v;
}

async function principal() {
  const credenciales = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!credenciales) {
    console.error('Falta FIREBASE_SERVICE_ACCOUNT.');
    process.exit(1);
  }

  const admin = require('./lib/firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(credenciales)) });
  const db = admin.firestore();

  // Sin `--todos`, solo viajes verificados: son los que traen una referencia
  // de confianza. Con `--todos`, los mas recientes, decida lo que decidiera.
  const viajes = TODOS
    ? await db.collection('tiempos_viaje').orderBy('creado', 'desc').limit(LIMITE).get()
    : await db.collection('tiempos_viaje').where('verificado', '==', true).limit(LIMITE).get();

  if (viajes.empty) {
    console.log('No hay viajes verificados con los que medir.');
    return;
  }

  console.log(`Midiendo sobre ${viajes.size} capturas...\n`);

  const conteo = {
    total: 0,
    sinCaptura: 0,
    ocrFallido: 0,
    noReconocidaComoBicimad: 0,
    origenOk: 0,
    destinoOk: 0,
    rutaCompletaOk: 0,
    duracionLeida: 0,
    duracionOk: 0,
    horasLeidas: 0,
  };
  const confianzas = [];
  const fallos = [];
  // Decision guardada -> decision de hoy, y que señales salen hoy.
  const cambios = {};
  const señalesHoy = {};
  const deRechazoAOtra = [];
  const deAprobadoAOtra = [];
  // Una captura sostiene varios viajes: se lee una vez.
  const lecturasDe = new Map();

  for (const doc of viajes.docs) {
    const viaje = doc.data();

    // La captura va por `capturaId`: una captura con varios trayectos se guarda
    // UNA vez y cada viaje apunta a ella. Por el id del viaje solo se
    // encontraba la del primero, y el resto contaban como "sin captura".
    const capturaId = viaje.capturaId || doc.id;
    if (!lecturasDe.has(capturaId)) {
      const capturaSnap = await db.doc(`capturas/${capturaId}`).get();
      let buffer = null;
      try {
        if (capturaSnap.exists) ({ buffer } = imagen.decodificarDataUrl(capturaSnap.data().datos));
      } catch { buffer = null; }
      lecturasDe.set(capturaId, buffer
        ? { primera: await ocr.leerCaptura({ buffer }), segunda: await ocr.releerCaptura({ buffer }) }
        : null);
    }
    const leidas = lecturasDe.get(capturaId);
    if (!leidas) { conteo.sinCaptura++; continue; }

    conteo.total++;
    const cual = { tiempoSegundos: viaje.tiempoSegundos, fecha: String(viaje.fechaViaje || '').slice(0, 10) };
    const lectura = ocr.elegirTrayecto(leidas.primera, viaje.ruta, cual);

    // El veredicto de HOY sobre el contenido de la captura: la misma
    // evaluacion que hace el worker, sin el historial (duplicados, records,
    // ritmo del piloto), que no es lo que mide esto.
    const hoy = evaluar({
      ruta: viaje.ruta,
      tiempoSegundos: viaje.tiempoSegundos,
      lectura,
      segundaLectura: lectura.disponible && lectura.esBicimad ? ocr.elegirTrayecto(leidas.segunda, viaje.ruta, cual) : null,
      hashSha: null, hashPerceptual: null, shaPrevios: [], hashesPrevios: [],
      fechaViaje: viaje.fechaViaje,
      subidoEn: viaje.creado?.toDate?.() || null,
    });
    const antes = viaje.estado || 'desconocido';
    const clave = `${antes} -> ${hoy.decision}`;
    cambios[clave] = (cambios[clave] || 0) + 1;
    for (const s of hoy.señales) señalesHoy[s.codigo] = (señalesHoy[s.codigo] || 0) + 1;
    // Solo identificadores y codigos: nada de lo leido.
    const motivosHoy = hoy.señales.map((s) => s.codigo);
    if (antes === 'rechazado' && hoy.decision !== 'rechazado') {
      deRechazoAOtra.push({ id: doc.id, antes: viaje.motivos || null, hoy: hoy.decision, motivosHoy });
    }
    if (antes === 'aprobado' && hoy.decision !== 'aprobado') {
      deAprobadoAOtra.push({ id: doc.id, hoy: hoy.decision, motivosHoy });
    }

    if (!lectura.disponible) {
      conteo.ocrFallido++;
      // El motivo si es seguro publicarlo: describe el fallo, no el contenido.
      fallos.push({ id: doc.id, fallo: 'ocr', motivo: lectura.error });
      continue;
    }

    confianzas.push(lectura.confianza);
    if (!lectura.esBicimad) conteo.noReconocidaComoBicimad++;

    const [origenReal, destinoReal] = String(viaje.ruta).split('-').map(normalizar);
    const origenOk = normalizar(lectura.origen) === origenReal;
    const destinoOk = normalizar(lectura.destino) === destinoReal;

    if (origenOk) conteo.origenOk++;
    if (destinoOk) conteo.destinoOk++;
    if (origenOk && destinoOk) conteo.rutaCompletaOk++;

    if (lectura.horaSalida && lectura.horaLlegada) conteo.horasLeidas++;

    if (lectura.segundosDuracion !== null) {
      conteo.duracionLeida++;
      // 5 s es la tolerancia que ya usa el motor de decision.
      if (Math.abs(lectura.segundosDuracion - viaje.tiempoSegundos) <= 5) conteo.duracionOk++;
    }

    // Que fallo, sin decir QUE se leyo: el texto leido es el trayecto de una
    // persona.
    if (!origenOk || !destinoOk) {
      fallos.push({
        id: doc.id,
        fallo: 'ruta',
        origenOk,
        destinoOk,
        confianza: lectura.confianza,
      });
    }
  }

  const pct = (n) => (conteo.total ? `${((n / conteo.total) * 100).toFixed(1)}%` : '—');
  const media = confianzas.length
    ? Math.round(confianzas.reduce((a, b) => a + b, 0) / confianzas.length)
    : 0;

  const informe = {
    fecha: new Date().toISOString(),
    capturasMedidas: conteo.total,
    sinCaptura: conteo.sinCaptura,
    confianzaMedia: media,
    aciertos: {
      ruta: pct(conteo.rutaCompletaOk),
      origen: pct(conteo.origenOk),
      destino: pct(conteo.destinoOk),
      duracionLeida: pct(conteo.duracionLeida),
      duracionCorrecta: pct(conteo.duracionOk),
      horasLeidas: pct(conteo.horasLeidas),
    },
    problemas: {
      ocrFallido: conteo.ocrFallido,
      noReconocidaComoBicimad: conteo.noReconocidaComoBicimad,
    },
    fallos: fallos.slice(0, 25),
    // Con que decision se guardo cada viaje y cual le daria hoy el motor.
    decisiones: cambios,
    señalesHoy,
    deRechazoAOtra: deRechazoAOtra.slice(0, 60),
    deAprobadoAOtra: deAprobadoAOtra.slice(0, 60),
  };

  console.log('--- Informe -------------------------------------------------');
  console.log(`Capturas medidas      ${conteo.total}`);
  console.log(`Confianza media       ${media}%`);
  console.log('');
  console.log(`Ruta completa         ${informe.aciertos.ruta}`);
  console.log(`  origen              ${informe.aciertos.origen}`);
  console.log(`  destino             ${informe.aciertos.destino}`);
  console.log(`Duracion legible      ${informe.aciertos.duracionLeida}`);
  console.log(`Duracion correcta     ${informe.aciertos.duracionCorrecta}`);
  console.log(`Dos horas legibles    ${informe.aciertos.horasLeidas}`);
  console.log('');
  console.log(`OCR fallido           ${conteo.ocrFallido}`);
  console.log(`No parece BiciMAD     ${conteo.noReconocidaComoBicimad}`);
  console.log('');
  console.log('Decision guardada -> decision de hoy');
  for (const [k, n] of Object.entries(cambios).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${n}`);
  console.log('');
  console.log('Señales que salen hoy');
  for (const [k, n] of Object.entries(señalesHoy).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${n}`);
  console.log('-------------------------------------------------------------');
  console.log('');
  console.log('Como leer esto: si "Ruta completa" no pasa del 90%, el OCR todavia');
  console.log('no puede ser la unica fuente de la subida (issue #8). Si "No parece');
  console.log('BiciMAD" no es 0, hay que revisar los marcadores de src/ocr.js,');
  console.log('porque esa señal RECHAZA el viaje sola.');

  if (SALIDA) {
    fs.writeFileSync(SALIDA, `${JSON.stringify(informe, null, 2)}\n`, 'utf8');
    console.log(`\nInforme en ${SALIDA}`);
  }
}

principal().catch((err) => {
  console.error(err);
  process.exit(1);
});
