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

  const admin = require('firebase-admin');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(credenciales)) });
  const db = admin.firestore();

  // Solo viajes verificados: son los que traen una referencia de confianza.
  const viajes = await db.collection('tiempos_viaje')
    .where('verificado', '==', true)
    .limit(LIMITE)
    .get();

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

  for (const doc of viajes.docs) {
    const viaje = doc.data();

    const capturaSnap = await db.doc(`capturas/${doc.id}`).get();
    if (!capturaSnap.exists) { conteo.sinCaptura++; continue; }

    let buffer;
    try {
      ({ buffer } = imagen.decodificarDataUrl(capturaSnap.data().datos));
    } catch { conteo.sinCaptura++; continue; }

    conteo.total++;
    const lectura = await ocr.leerCaptura({ buffer });

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
