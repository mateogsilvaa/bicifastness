#!/usr/bin/env node
/**
 * Migracion del modelo de datos de la v1 al de la v2.
 *
 * Esto NO es intendencia: es lo que cierra el issue #59. En produccion los
 * viajes siguen teniendo la forma vieja, y ahi dentro va `email_real` y
 * `foto_url` con la captura entera en base64. La regla "un viaje verificado es
 * publico" es correcta para el modelo v2, donde el viaje no lleva datos
 * personales, pero aplicada a estos documentos publica el correo y la captura
 * de cada persona. Hasta que esto termine, la lectura publica esta cerrada.
 *
 * Forma real de la v1, comprobada contra produccion:
 *   email_real, ruta, nombre_usuario, fecha, foto_url,
 *   uploaded_at, tiempo_formateado, tiempo_segundos, verificado
 *
 * Que hace:
 *   - `usuarios` pasa de estar indexado por EMAIL a estarlo por UID. Usar el
 *     email como id del documento fue una de las causas de la escalada de
 *     privilegios: cualquiera podia adivinar y escribir el documento de otro.
 *   - Los campos pasan a la forma v2 (camelCase).
 *   - La captura sale del viaje y se guarda en `capturas`, que solo lee la
 *     administracion.
 *   - Los viajes SIN dueño identificable tambien se limpian. Es el detalle que
 *     importa: si se dejaran como estan, seguirian publicando un correo y una
 *     captura, y la fuga no se cerraria del todo.
 *
 * Uso:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/ruta/serviceAccountKey.json
 *   node scripts/migrar-datos.js --simular      # no escribe nada, solo informa
 *   node scripts/migrar-datos.js --comprobar    # solo dice cuanto queda sucio
 *   node scripts/migrar-datos.js --aplicar
 */

const admin = require('firebase-admin');

const SIMULAR = !process.argv.includes('--aplicar');
const SOLO_COMPROBAR = process.argv.includes('--comprobar');

/**
 * Campos de la v1 que llevan datos personales dentro del viaje. Mientras
 * cualquier documento conserve uno de estos, la lectura publica NO se puede
 * restaurar.
 */
const CAMPOS_SUCIOS = ['email_real', 'foto_url'];

// Cloud Storage NO se usa: exige el plan Blaze (tarjeta). Las capturas van a
// una coleccion de Firestore que solo lee la administracion, que es como
// funciona la v2 entera.
const MAX_BASE64 = 900 * 1024; // margen sobre el tope duro de 1 MiB por documento

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

/** email -> uid, resolviendo contra Firebase Auth. */
async function mapaEmailUid() {
  const mapa = new Map();
  let pagina = await admin.auth().listUsers(1000);
  for (;;) {
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
    const email = String(datos.email || doc.id).toLowerCase();

    // Si el id no es un email, este documento ya esta migrado.
    if (!email.includes('@')) continue;

    const uid = emailAUid.get(email);
    if (!uid) { huerfanos++; continue; }

    const nuevo = {
      uid,
      // El correo NO se copia: vive en Firebase Auth. Meterlo aqui es lo que
      // publicaba 175 direcciones, porque esta coleccion alimenta los rankings.
      username: datos.username || datos.nombre_usuario || 'Piloto',
      usernameLower: String(datos.username || datos.nombre_usuario || 'piloto').toLowerCase(),
      avatarUrl: datos.avatarUrl || null,
      clanId: datos.clanId || datos.clan || null,
      // Los contadores los recalcula el worker: copiarlos de la v1 arrastraria
      // cualquier numero inflado que hubiera quedado del compromiso anterior.
      biciRating: 0,
      viajesVerificados: 0,
      puntosPorRuta: {},
      creado: datos.creado || admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!SIMULAR) {
      await db.doc(`usuarios/${uid}`).set(nuevo, { merge: true });
      await doc.ref.delete();
    }
    migrados++;
  }

  return { migrados, huerfanos };
}

/** Extrae el base64 de un data URL. Devuelve null si no lo es. */
function partirDataUrl(valor) {
  if (typeof valor !== 'string' || !valor.startsWith('data:image/')) return null;
  const m = valor.match(/^data:([^;]+);base64,(.+)$/);
  return m ? { mime: m[1], base64: m[2] } : null;
}

async function migrarViajes(emailAUid) {
  const antiguos = await db.collection('tiempos_viaje').get();
  const cuenta = {
    migrados: 0, anonimizados: 0, yaLimpios: 0,
    capturasGuardadas: 0, capturasDescartadas: 0,
  };

  for (const doc of antiguos.docs) {
    const datos = doc.data();

    const sucio = CAMPOS_SUCIOS.some((c) => datos[c] !== undefined);
    if (!sucio && datos.uid && datos.tiempoSegundos !== undefined) {
      cuenta.yaLimpios++;
      continue;
    }

    const email = String(datos.email_real || '').toLowerCase();
    const uid = emailAUid.get(email) || null;

    // La captura sale del viaje SIEMPRE, haya dueño o no.
    let capturaGuardada = false;
    const captura = partirDataUrl(datos.foto_url);

    if (captura && uid) {
      if (captura.base64.length > MAX_BASE64) {
        // Mejor perder una captura vieja que dejarla publicada. El viaje ya
        // esta verificado; la imagen solo servia como prueba.
        cuenta.capturasDescartadas++;
      } else {
        if (!SIMULAR) {
          await db.doc(`capturas/${doc.id}`).set({
            uid,
            datos: `data:${captura.mime};base64,${captura.base64}`,
            creado: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        capturaGuardada = true;
        cuenta.capturasGuardadas++;
      }
    } else if (captura) {
      // Sin dueño no hay a quien atribuirla, y guardarla solo prolongaria el
      // problema.
      cuenta.capturasDescartadas++;
    }

    const tiempo = Number(datos.tiempo_segundos ?? datos.tiempoSegundos);

    const nuevo = {
      uid,
      // Sin cuenta de Auth el viaje se conserva anonimo: asi el ranking de la
      // ruta no se queda con huecos, que es lo que promete `legal/privacidad`.
      username: uid ? (datos.nombre_usuario || 'Piloto') : 'Piloto retirado',
      ruta: String(datos.ruta || ''),
      tiempoSegundos: Number.isFinite(tiempo) ? tiempo : 0,
      tiempoFormateado: datos.tiempo_formateado || '',
      fechaViaje: String(datos.fecha || datos.fechaViaje || '').slice(0, 10),
      estado: datos.verificado ? 'aprobado' : 'revision',
      verificado: datos.verificado === true,
      revisadoPor: 'migracion',
      revisadoEn: datos.uploaded_at ? new Date(datos.uploaded_at) : new Date(),
      auditoria: {
        resumen: 'Viaje anterior a la verificacion automatica.',
        riesgo: 0,
        señales: [],
      },
      capturaGuardada,
      creado: datos.uploaded_at ? new Date(datos.uploaded_at) : new Date(),
    };

    // `set` sin merge REEMPLAZA el documento entero: es lo que hace desaparecer
    // `email_real` y `foto_url`. Con merge se quedarian ahi, y la fuga con
    // ellos.
    if (!SIMULAR) await doc.ref.set(nuevo);

    if (uid) cuenta.migrados++;
    else cuenta.anonimizados++;
  }

  return cuenta;
}

/**
 * Cuenta lo que sigue sucio. Es la comprobacion que dice si ya se puede
 * restaurar la lectura publica de `tiempos_viaje`.
 */
async function comprobarLimpieza() {
  const viajes = await db.collection('tiempos_viaje').get();
  const sucios = {};
  for (const campo of CAMPOS_SUCIOS) sucios[campo] = 0;

  for (const doc of viajes.docs) {
    const datos = doc.data();
    for (const campo of CAMPOS_SUCIOS) if (datos[campo] !== undefined) sucios[campo]++;
  }

  const total = Object.values(sucios).reduce((a, b) => a + b, 0);
  return { revisados: viajes.size, sucios, total };
}

async function limpiarSecretos() {
  const secretos = await db.collection('secrets').get();
  if (secretos.empty) return 0;

  console.log(`  ATENCION: hay ${secretos.size} documento(s) en 'secrets' con claves expuestas.`);
  console.log('  Rota TODAS esas credenciales antes de borrarlas: han sido legibles');
  console.log('  por cualquier usuario registrado.');

  if (!SIMULAR) {
    for (const doc of secretos.docs) await doc.ref.delete();
  }
  return secretos.size;
}

async function main() {
  if (SOLO_COMPROBAR) {
    const estado = await comprobarLimpieza();
    console.log(`Viajes revisados: ${estado.revisados}`);
    for (const [campo, n] of Object.entries(estado.sucios)) {
      console.log(`  con ${campo}: ${n}`);
    }
    console.log('');
    console.log(estado.total === 0
      ? 'LIMPIO. Ya se puede restaurar la lectura publica en firestore.rules (#59).'
      : `Quedan ${estado.total} campos con datos personales. NO restaures la lectura publica.`);
    process.exit(estado.total === 0 ? 0 : 1);
  }

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
  console.log(`  migrados con dueño: ${viajes.migrados}`);
  console.log(`  anonimizados (sin cuenta): ${viajes.anonimizados}`);
  console.log(`  ya estaban limpios: ${viajes.yaLimpios}`);
  console.log(`  capturas guardadas: ${viajes.capturasGuardadas}`);
  console.log(`  capturas descartadas: ${viajes.capturasDescartadas}\n`);

  console.log('Secretos:');
  const secretos = await limpiarSecretos();
  console.log(`  documentos: ${secretos}\n`);

  if (SIMULAR) {
    console.log('Nada se ha modificado. Revisa la salida y vuelve a lanzarlo con --aplicar.');
  } else {
    const estado = await comprobarLimpieza();
    console.log(estado.total === 0
      ? 'Sin datos personales en tiempos_viaje. Ya se puede restaurar la lectura publica (#59).'
      : `CUIDADO: quedan ${estado.total} campos sucios. NO restaures la lectura publica.`);
    console.log('');
    console.log('Ademas:');
    console.log('  1. Volver a conceder el rol de admin con scripts/set-admin.js');
    console.log('  2. Lanzar el worker para que recalcule puntuaciones desde cero');
  }
  process.exit(0);
}

main().catch((error) => {
  console.error('Error en la migracion:', error);
  process.exit(1);
});
