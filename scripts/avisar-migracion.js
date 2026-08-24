#!/usr/bin/env node
'use strict';

/**
 * Avisa por correo a los usuarios de la v1 de que su historial sigue ahi (#54).
 *
 * POR QUE EXISTE. Despues de migrar, la primera vez que alguien de la v1 entre
 * va a ver una clasificacion en la que no aparece. Sin este correo, la lectura
 * obvia es "me han borrado los viajes". No es cortesia: es evitar que la gente
 * se vaya por un malentendido que se arregla con un parrafo.
 *
 * POR QUE UN SCRIPT Y NO EL WORKER. Esto se manda UNA vez, despues de la
 * migracion. Meterlo en el worker seria dejar para siempre un caso que solo
 * ocurre un dia, y que ademas tendria que llevar su propia marca de "ya
 * enviado" en cada pasada.
 *
 * POR QUE NO A MANO DESDE UN CLIENTE DE CORREO. Porque asi se respeta lo mismo
 * que respeta el worker:
 *   - `avisosCorreo === false`, o sea quien se dio de baja
 *   - el token de baja, para que este correo tambien lleve su enlace
 *   - el cupo diario de Resend, con reintento al dia siguiente
 * Un envio masivo desde Gmail se salta las tres cosas, y la primera es la que
 * convierte un aviso util en una infraccion.
 *
 * ES IDEMPOTENTE: marca `avisadoMigracionV1` en el perfil y no repite. Se puede
 * relanzar sin miedo si se corta a la mitad.
 *
 * Uso:
 *   export FIREBASE_SERVICE_ACCOUNT="$(cat serviceAccountKey.json)"
 *   export RESEND_API_KEY=...
 *   node scripts/avisar-migracion.js --simular   # no envia nada, solo lista
 *   node scripts/avisar-migracion.js --enviar
 */

const admin = require('firebase-admin');

const correo = require('../backend/src/correo');
const plantillas = require('../backend/src/plantillas');

const SIMULAR = !process.argv.includes('--enviar');
const REMITENTE = 'BiciFastness <avisos@bicifastness.es>';
const TEMPORADA_V1 = 'v1';

function arrancar() {
  const credenciales = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!credenciales) {
    console.error('Falta FIREBASE_SERVICE_ACCOUNT.');
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(credenciales)) });
  return admin.firestore();
}

const db = arrancar();

/**
 * Los kilometros del historial de la v1, y cuantos son estimados.
 *
 * Se cuentan aqui y no en el archivo de temporada porque el archivo se escribe
 * antes de que los viajes tengan distancia: el orden de la migracion es
 * usuarios primero, viajes despues.
 */
async function historial(uid) {
  const viajes = await db.collection('tiempos_viaje')
    .where('uid', '==', uid)
    .where('temporada', '==', TEMPORADA_V1)
    .get();

  let metros = 0;
  let estimados = 0;
  for (const doc of viajes.docs) {
    const v = doc.data();
    metros += Number(v.distanciaMetros) || 0;
    if (v.distanciaEstimada) estimados++;
  }

  return { viajes: viajes.size, kilometros: metros / 1000, estimados };
}

async function main() {
  console.log(SIMULAR
    ? '=== SIMULACION: no se envia nada. Usa --enviar para mandarlos ===\n'
    : '=== ENVIANDO ===\n');

  const usuarios = await db.collection('usuarios').get();
  const cuenta = { enviados: 0, yaAvisados: 0, sinHistorial: 0, deBaja: 0, sinCorreo: 0, fallos: 0 };

  for (const doc of usuarios.docs) {
    const datos = doc.data();
    const uid = doc.id;

    if (datos.avisadoMigracionV1) { cuenta.yaAvisados++; continue; }

    // Solo a quien tenga historial de la v1 archivado. A quien se registro
    // despues, este correo no le dice nada.
    const archivo = await db.doc(`usuarios/${uid}/temporadas/${TEMPORADA_V1}`).get();
    if (!archivo.exists) { cuenta.sinHistorial++; continue; }

    if (datos.avisosCorreo === false) { cuenta.deBaja++; continue; }

    // El correo se pide a Firebase Auth, que es donde vive (#60). Si la cuenta
    // ya no existe, no hay a quien avisar.
    let destinatario = null;
    try {
      destinatario = (await admin.auth().getUser(uid)).email || null;
    } catch {
      cuenta.sinCorreo++;
      continue;
    }
    if (!destinatario) { cuenta.sinCorreo++; continue; }

    // El token de baja se crea la primera vez y se queda: si cambiara en cada
    // correo, un enlace de hace dos dias dejaria de funcionar, que es justo lo
    // que hace que la gente marque spam.
    let tokenBaja = datos.tokenBaja;
    if (!tokenBaja) {
      tokenBaja = correo.generarTokenBaja();
      if (!SIMULAR) await doc.ref.update({ tokenBaja });
    }

    const suyo = await historial(uid);

    const mensaje = plantillas.historialMigrado({
      nombre: datos.username || 'piloto',
      viajes: suyo.viajes || archivo.data().viajes || 0,
      puntos: archivo.data().puntos || 0,
      kilometros: suyo.kilometros,
      estimados: suyo.estimados,
      tokenBaja,
    });

    const resultado = await correo.enviar({
      ...mensaje,
      para: destinatario,
      remitente: REMITENTE,
      apiKey: process.env.RESEND_API_KEY,
      simular: SIMULAR,
    });

    if (resultado.error) {
      cuenta.fallos++;
      console.warn(`  fallo para ${datos.username || uid}: ${resultado.error}`);
      continue;
    }

    // La marca va DESPUES del envio. Al reves, un fallo a mitad dejaria gente
    // marcada como avisada sin haber recibido nada.
    if (!SIMULAR) await doc.ref.update({ avisadoMigracionV1: true });

    cuenta.enviados++;
    console.log(`  ${datos.username || uid}: ${suyo.viajes} viajes, `
      + `${suyo.kilometros.toFixed(0)} km${suyo.estimados ? ` (${suyo.estimados} estimados)` : ''}`);
  }

  console.log('');
  console.log(`Enviados:          ${cuenta.enviados}`);
  console.log(`Ya avisados antes: ${cuenta.yaAvisados}`);
  console.log(`Sin historial v1:  ${cuenta.sinHistorial}`);
  console.log(`De baja:           ${cuenta.deBaja}`);
  console.log(`Sin correo:        ${cuenta.sinCorreo}`);
  console.log(`Fallos:            ${cuenta.fallos}`);

  if (SIMULAR) {
    console.log('\nNada se ha enviado. Repasa la lista y vuelve con --enviar.');
  }
  process.exit(cuenta.fallos > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Error avisando de la migracion:', error);
  process.exit(1);
});
