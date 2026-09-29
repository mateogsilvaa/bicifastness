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
 *   - Cada viaje historico recibe `distanciaMetros` y `velocidadKmh`, que en la
 *     v1 no existian. Sin ellos el modo Fondo y las insignias de kilometros
 *     empiezan como si nadie hubiera pedaleado nunca (#6, #17).
 *   - Los puntos de la v1 se archivan como temporada `v1` y NO se suman a la
 *     temporada en curso: son de otro juego, con otras reglas, y arrastrarlos
 *     daria ventaja de salida a quien ya estaba. Se conservan porque perder el
 *     historial de alguien es otra forma de romperle la cuenta.
 *
 * Uso:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/ruta/serviceAccountKey.json
 *   node scripts/migrar-datos.js --copia salida.json  # copia de seguridad ANTES
 *   node scripts/migrar-datos.js --simular      # no escribe nada, solo informa
 *   node scripts/migrar-datos.js --comprobar    # solo dice cuanto queda sucio
 *   node scripts/migrar-datos.js --aplicar
 *
 * El orden no es decorativo: `--copia` primero, `--simular` despues y solo
 * entonces `--aplicar`. `migrarViajes` hace `set` SIN merge, que reemplaza el
 * documento entero: es lo que borra `email_real` y `foto_url`, y tambien lo que
 * hace que no haya vuelta atras sin la copia. El camino de vuelta esta en
 * `docs/MIGRACION.md`.
 */

const fs = require('fs');
const admin = require('firebase-admin');

// El mismo modulo que usa el worker: si algun dia cambia la forma de medir, los
// viajes migrados y los nuevos siguen contando lo mismo.
const distancias = require('../backend/src/distancias');

const SIMULAR = !process.argv.includes('--aplicar');
const SOLO_COMPROBAR = process.argv.includes('--comprobar');
const COPIA = (() => {
  const i = process.argv.indexOf('--copia');
  return i === -1 ? null : (process.argv[i + 1] || 'copia-migracion.json');
})();

/**
 * Identificador de la temporada donde se archivan los puntos de la v1.
 *
 * No es un mes, a proposito: las temporadas de la v2 son meses naturales
 * (`2026-08`) y esto no lo es. Un identificador que no puede colisionar con
 * ninguno real deja claro, al mirar el historial de cualquiera, que esos puntos
 * vienen de otro juego.
 */
const TEMPORADA_V1 = 'v1';

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
  let archivados = 0;

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
      // La temporada en curso empieza a cero para todo el mundo. Lo de la v1
      // esta archivado aparte, no sumado aqui.
      puntosTemporada: 0,
      creado: datos.creado || admin.firestore.FieldValue.serverTimestamp(),
    };

    // Los puntos de la v1 se archivan, no se tiran ni se suman.
    //
    // Sumarlos daria ventaja de salida a quien ya estaba, y encima medida con
    // otras reglas: la v1 solo puntuaba ir rapido. Tirarlos es peor de otra
    // manera — a alguien con dos años de viajes le estariamos diciendo que no
    // cuentan. Archivarlos como una temporada mas los deja visibles en el perfil
    // sin que valgan para la clasificacion de hoy.
    //
    // Va en la subcoleccion del propio usuario, igual que hace `temporadas.js`
    // al cerrar un mes: asi el historial se borra con su cuenta y no hay que ir
    // a buscarlo a otro sitio cuando alguien ejerce el derecho de supresion.
    const archivo = {
      temporada: TEMPORADA_V1,
      puntos: Number(datos.biciRating) || 0,
      posicion: null,
      viajes: Number(datos.viajes_verificados_totales ?? datos.viajesVerificados) || 0,
      metros: 0,
      mejorRacha: 0,
      division: null,
      puntosPorRuta: datos.puntos_por_ruta || datos.puntosPorRuta || {},
      // Sin esto, dentro de un año nadie sabe de donde salio esta temporada.
      origen: 'migracion v1',
      cerrada: admin.firestore.FieldValue.serverTimestamp(),
    };

    const tienePasado = archivo.puntos > 0 || archivo.viajes > 0;

    if (!SIMULAR) {
      await db.doc(`usuarios/${uid}`).set(nuevo, { merge: true });
      if (tienePasado) {
        await db.doc(`usuarios/${uid}/temporadas/${TEMPORADA_V1}`).set(archivo);
      }
      await doc.ref.delete();
    }
    migrados++;
    if (tienePasado) archivados++;
  }

  return { migrados, huerfanos, archivados };
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
    distanciaMedida: 0, distanciaEstimada: 0, sinDistancia: 0,
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
    const segundos = Number.isFinite(tiempo) ? tiempo : 0;

    // Distancia y velocidad, que en la v1 no existian.
    //
    // Sin esto, el modo Fondo y las insignias de kilometros arrancan como si
    // nadie hubiera pedaleado nunca: alguien con doscientos viajes a la espalda
    // tendria cero kilometros. `distancias.resolver` usa la tabla precalculada
    // (#6) cuando el par esta, y cae a la estimacion de linea recta por el
    // factor de trama urbana cuando no.
    //
    // `distanciaEstimada` importa que quede marcado: es la diferencia entre un
    // kilometraje medido y uno deducido, y quien mire su perfil tiene derecho a
    // saber cual de los dos esta viendo.
    const [origen, destino] = String(datos.ruta || '').split('-');
    const medida = origen && destino ? distancias.resolver(origen, destino) : null;
    const metros = medida ? medida.metros : null;
    const kmh = distancias.velocidadKmh(metros, segundos);

    if (medida) {
      if (medida.estimada) cuenta.distanciaEstimada++;
      else cuenta.distanciaMedida++;
    } else {
      cuenta.sinDistancia++;
    }

    const nuevo = {
      uid,
      // Sin cuenta de Auth el viaje se conserva anonimo: asi el ranking de la
      // ruta no se queda con huecos, que es lo que promete `legal/privacidad`.
      username: uid ? (datos.nombre_usuario || 'Piloto') : 'Piloto retirado',
      ruta: String(datos.ruta || ''),
      tiempoSegundos: segundos,
      distanciaMetros: metros,
      distanciaEstimada: medida ? medida.estimada : true,
      velocidadKmh: kmh === null ? null : Number(kmh.toFixed(2)),
      // Los viajes de la v1 no reparten puntos de la temporada en curso: sus
      // puntos estan archivados en la temporada `v1`. `premiado` en true impide
      // que el worker vuelva a contarlos si algun dia recorre la coleccion.
      premiado: true,
      temporada: TEMPORADA_V1,
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

/**
 * Copia de seguridad de lo que la migracion va a reemplazar.
 *
 * Hace falta porque `migrarViajes` usa `set` SIN merge: reemplaza el documento
 * entero, que es justo lo que hace desaparecer `email_real` y `foto_url`. Sin
 * copia, esa parte no tiene vuelta atras.
 *
 * OJO CON EL FICHERO QUE SALE DE AQUI: lleva dentro los 1.022 correos y las
 * capturas en base64. Es exactamente el material de la brecha, en un fichero
 * suelto. Guardalo cifrado, fuera del repositorio, y borralo en cuanto la
 * migracion este dada por buena. No lo dejes en Descargas.
 */
async function copiaDeSeguridad(destino) {
  const [usuarios, viajes] = await Promise.all([
    db.collection('usuarios').get(),
    db.collection('tiempos_viaje').get(),
  ]);

  const volcado = {
    hecha: new Date().toISOString(),
    aviso: 'CONTIENE DATOS PERSONALES: correos y capturas. Cifrar y borrar tras la migracion.',
    usuarios: usuarios.docs.map((d) => ({ id: d.id, datos: d.data() })),
    tiempos_viaje: viajes.docs.map((d) => ({ id: d.id, datos: d.data() })),
  };

  // `wx`: falla si el fichero ya existe. Sobrescribir una copia de seguridad
  // por lanzar el comando dos veces es la forma tonta de quedarse sin ella.
  fs.writeFileSync(destino, JSON.stringify(volcado, null, 2), { flag: 'wx' });

  return { usuarios: usuarios.size, viajes: viajes.size, destino };
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
  if (COPIA) {
    console.log(`=== COPIA DE SEGURIDAD en ${COPIA} ===\n`);
    const hecha = await copiaDeSeguridad(COPIA);
    console.log(`  usuarios: ${hecha.usuarios}`);
    console.log(`  viajes:   ${hecha.viajes}\n`);
    console.log('CONTIENE DATOS PERSONALES: correos y capturas en base64.');
    console.log('Cifralo, guardalo fuera del repositorio y borralo cuando la');
    console.log('migracion este dada por buena.\n');
    console.log('Camino de vuelta y siguiente paso: docs/MIGRACION.md');
    process.exit(0);
  }

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
  console.log(`  migrados: ${usuarios.migrados}, sin cuenta de Auth: ${usuarios.huerfanos}`);
  console.log(`  con historial de la v1 archivado como temporada '${TEMPORADA_V1}': ${usuarios.archivados}\n`);

  console.log('Viajes:');
  const viajes = await migrarViajes(emailAUid);
  console.log(`  migrados con dueño: ${viajes.migrados}`);
  console.log(`  anonimizados (sin cuenta): ${viajes.anonimizados}`);
  console.log(`  ya estaban limpios: ${viajes.yaLimpios}`);
  console.log(`  capturas guardadas: ${viajes.capturasGuardadas}`);
  console.log(`  capturas descartadas: ${viajes.capturasDescartadas}`);
  console.log(`  distancia de tabla: ${viajes.distanciaMedida}`);
  console.log(`  distancia estimada: ${viajes.distanciaEstimada}`);
  console.log(`  sin distancia (ruta ilegible): ${viajes.sinDistancia}\n`);

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
    console.log('  3. Avisar a los usuarios de la v1 de que su historial sigue ahi:');
    console.log('     node scripts/avisar-migracion.js --simular');
    console.log('     node scripts/avisar-migracion.js --enviar');
    console.log('  4. Borrar la copia de seguridad cuando esto se de por bueno:');
    console.log('     lleva dentro los correos y las capturas');
  }
  process.exit(0);
}

main().catch((error) => {
  console.error('Error en la migracion:', error);
  process.exit(1);
});
