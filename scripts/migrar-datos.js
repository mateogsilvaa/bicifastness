#!/usr/bin/env node
/**
 * Migracion del modelo de datos antiguo al nuevo.
 *
 * Cambios principales que resuelve:
 *   - `usuarios` pasa de estar indexado por EMAIL a estarlo por UID. Usar el
 *     email como id del documento fue una de las causas de la escalada de
 *     privilegios: cualquiera podia adivinar y escribir el documento de otro.
 *   - Los nombres de campo pasan a camelCase coherente
 *     (viajes_verificados_totales -> viajesVerificados, etc.).
 *   - Las capturas salen del documento de Firestore (iban en base64) y pasan a
 *     Cloud Storage.
 *
 * Uso:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/ruta/serviceAccountKey.json
 *   node scripts/migrar-datos.js --simular    # no escribe nada, solo informa
 *   node scripts/migrar-datos.js --aplicar
 */

const admin = require('firebase-admin');

const SIMULAR = !process.argv.includes('--aplicar');

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const bucket = admin.storage().bucket();

/** email -> uid, resolviendo contra Firebase Auth. */
async function mapaEmailUid() {
  const mapa = new Map();
  let pagina = await admin.auth().listUsers(1000);
  while (true) {
    for (const u of pagina.users) {
      if (u.email) mapa.set(u.email.toLowerCase(), u.uid);
    }
    if (!pagina.pageToken) break;
    pagina = await admin.auth().listUsers(1000, pagina.pageToken);
  }
  return mapa;
}

async function migrarUsuarios(emailAUid) {
  const antiguos = await db.collection('usuarios').get();
  let migrados = 0;
  let huerfanos = 0;

  for (const doc of antiguos.docs) {
    const datos = doc.data();
    const email = (datos.email || doc.id).toLowerCase();
    const uid = emailAUid.get(email);

    // Si el id ya es un uid valido, este documento ya esta migrado.
    if (!email.includes('@')) continue;

    if (!uid) {
      console.warn(`  sin cuenta de Auth: ${email} (se omite)`);
      huerfanos++;
      continue;
    }

    const nuevo = {
      uid,
      email,
      username: datos.username || email.split('@')[0],
      usernameLower: (datos.username || email.split('@')[0]).toLowerCase(),
      avatarUrl: typeof datos.avatar === 'string' && datos.avatar.startsWith('http') ? datos.avatar : null,
      biciRating: datos.biciRating || 0,
      viajesVerificados: datos.viajes_verificados_totales || 0,
      puntosPorRuta: datos.puntos_por_ruta || {},
      logros: datos.logros || [],
      clanId: datos.clanId || null,
      favoritas: datos.favoriteRoutes || [],
      suspendido: false,
      migradoDesde: doc.id,
      // isAdmin NO se migra a proposito: el rol es ahora un custom claim y se
      // concede a mano con scripts/set-admin.js.
    };

    console.log(`  ${email} -> ${uid}`);
    if (!SIMULAR) {
      await db.doc(`usuarios/${uid}`).set(nuevo, { merge: true });
      await db.doc(`nombres_usuario/${nuevo.usernameLower}`).set({ uid, creado: new Date() });
      await doc.ref.delete();
    }
    migrados++;
  }

  return { migrados, huerfanos };
}

async function migrarViajes(emailAUid) {
  const antiguos = await db.collection('tiempos_viaje').get();
  let migrados = 0;
  let sinDuenyo = 0;

  for (const doc of antiguos.docs) {
    const datos = doc.data();
    if (datos.uid && datos.tiempoSegundos !== undefined) continue; // ya migrado

    const email = (datos.email_real || '').toLowerCase();
    const uid = emailAUid.get(email);
    if (!uid) { sinDuenyo++; continue; }

    let capturaPath = null;
    // Las capturas iban en base64 dentro del documento: las sacamos a Storage.
    if (typeof datos.foto_url === 'string' && datos.foto_url.startsWith('data:image/')) {
      const [, mime, base64] = datos.foto_url.match(/^data:([^;]+);base64,(.+)$/) || [];
      if (base64) {
        capturaPath = `capturas/${uid}/${doc.id}.jpg`;
        if (!SIMULAR) {
          await bucket().file(capturaPath).save(Buffer.from(base64, 'base64'), { contentType: mime });
        }
      }
    }

    const nuevo = {
      uid,
      username: datos.nombre_usuario || 'Piloto',
      ruta: datos.ruta,
      tiempoSegundos: datos.tiempo_segundos,
      tiempoFormateado: datos.tiempo_formateado || '',
      fechaViaje: String(datos.fecha || '').slice(0, 10),
      capturaPath,
      estado: datos.verificado ? 'aprobado' : 'revision',
      verificado: datos.verificado === true,
      revisadoPor: datos.verificado ? 'migracion' : null,
      auditoria: { resumen: 'Viaje anterior a la verificacion automatica.', riesgo: 0, señales: [] },
      creado: datos.uploaded_at ? new Date(datos.uploaded_at) : new Date(),
    };

    if (!SIMULAR) {
      await doc.ref.set(nuevo);
    }
    migrados++;
  }

  return { migrados, sinDuenyo };
}

async function limpiarSecretos() {
  const secretos = await db.collection('secrets').get();
  if (secretos.empty) return 0;

  console.log(`  ATENCION: hay ${secretos.size} documento(s) en 'secrets' con claves expuestas.`);
  console.log("  Rota TODAS esas credenciales antes de borrarlas: han sido legibles por cualquier usuario registrado.");

  if (!SIMULAR) {
    for (const doc of secretos.docs) await doc.ref.delete();
  }
  return secretos.size;
}

async function main() {
  console.log(SIMULAR
    ? '=== SIMULACION (no se escribe nada). Usa --aplicar para ejecutar de verdad ===\n'
    : '=== APLICANDO CAMBIOS ===\n');

  const emailAUid = await mapaEmailUid();
  console.log(`Cuentas en Firebase Auth: ${emailAUid.size}\n`);

  console.log('Usuarios:');
  const usuarios = await migrarUsuarios(emailAUid);
  console.log(`  migrados: ${usuarios.migrados}, sin cuenta de Auth: ${usuarios.huerfanos}\n`);

  console.log('Viajes:');
  const viajes = await migrarViajes(emailAUid);
  console.log(`  migrados: ${viajes.migrados}, sin dueno identificable: ${viajes.sinDuenyo}\n`);

  console.log('Secretos:');
  const secretos = await limpiarSecretos();
  console.log(`  documentos: ${secretos}\n`);

  if (SIMULAR) {
    console.log('Nada se ha modificado. Revisa la salida y vuelve a lanzarlo con --aplicar.');
  } else {
    console.log('Migracion terminada. Recuerda:');
    console.log('  1. Volver a conceder el rol de admin con scripts/set-admin.js');
    console.log('  2. Lanzar un recalculo de puntuaciones destacando de nuevo la ruta actual');
  }
  process.exit(0);
}

main().catch((error) => {
  console.error('Error en la migracion:', error);
  process.exit(1);
});
