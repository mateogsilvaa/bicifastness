#!/usr/bin/env node
/**
 * Siembra un proyecto de pruebas con datos realistas (#56).
 *
 * Para que sirve: el cierre de temporada, el cambio semanal de division y el
 * decaimiento del mapa tocan a TODOS los usuarios y ponen contadores a cero. No
 * pueden estrenarse en produccion el dia 1.
 *
 * El ENSAYO en si corre sin red y sin credenciales, en
 * `backend/test/ensayo.test.js`: ejecuta las operaciones periodicas de verdad
 * contra un Firestore en memoria que cuenta lecturas y escrituras. Eso ya dice
 * si terminan, si dejan los datos coherentes y cuanta cuota se comen.
 *
 * Este script es para lo que aquello NO puede responder: como se comporta
 * Firestore de verdad con este volumen, si los indices declarados bastan, y si
 * las pantallas aguantan 5.000 viajes en un movil normal.
 *
 * NUNCA contra produccion. Pide una confirmacion explicita justamente por eso.
 *
 * Uso, contra el emulador:
 *   firebase emulators:start --only firestore
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 node scripts/generar-datos.js --aplicar
 *
 * Contra un proyecto aparte:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/ruta/serviceAccountKey-PRUEBAS.json
 *   node scripts/generar-datos.js --aplicar --proyecto bicifastness-pruebas
 *
 * Opciones:
 *   --usuarios N  --clanes N  --viajes N  --meses N  --semilla N
 *   --limpiar     borra lo que haya antes de sembrar
 */

// `firebase-admin` se carga solo al escribir. Vive en `backend/node_modules`,
// asi que pedirlo arriba haria que ni la simulacion funcionase desde la raiz —
// y la simulacion es justo la que se lanza primero y la que no necesita nada.
const { generar } = require('./lib/generador');

const argumentos = process.argv.slice(2);
const APLICAR = argumentos.includes('--aplicar');
const LIMPIAR = argumentos.includes('--limpiar');

function opcion(nombre, porDefecto) {
  const i = argumentos.indexOf(`--${nombre}`);
  if (i === -1) return porDefecto;
  const valor = argumentos[i + 1];
  return Number.isFinite(Number(valor)) ? Number(valor) : valor;
}

const PROYECTO = opcion('proyecto', process.env.GCLOUD_PROJECT || 'bicifastness-pruebas');

/**
 * La comprobacion que impide el accidente.
 *
 * Sembrar 200 usuarios de mentira encima de produccion no se deshace con un
 * ctrl+z: habria que distinguirlos uno a uno de los de verdad. Solo se admite
 * el emulador o un proyecto cuyo nombre diga a las claras que es de pruebas.
 */
function comprobarDestino() {
  const emulador = process.env.FIRESTORE_EMULATOR_HOST;
  if (emulador) {
    console.log(`Destino: emulador en ${emulador}`);
    return;
  }

  if (!/pruebas|test|dev|staging/i.test(PROYECTO)) {
    console.error(`\nEl proyecto "${PROYECTO}" no parece de pruebas.`);
    console.error('Esto siembra 200 usuarios y 5.000 viajes falsos, y separarlos');
    console.error('despues de los de verdad no es viable.\n');
    console.error('Usa el emulador (FIRESTORE_EMULATOR_HOST) o un proyecto cuyo');
    console.error('nombre lleve "pruebas", "test", "dev" o "staging".');
    process.exit(1);
  }
  console.log(`Destino: proyecto ${PROYECTO}`);
}

const COLECCIONES = ['usuarios', 'clanes', 'tiempos_viaje', 'estaciones_stats', 'agregados'];

async function limpiar(db) {
  for (const nombre of COLECCIONES) {
    let borrados = 0;
    for (;;) {
      const snap = await db.collection(nombre).limit(400).get();
      if (snap.empty) break;
      const lote = db.batch();
      for (const doc of snap.docs) lote.delete(doc.ref);
      await lote.commit();
      borrados += snap.size;
    }
    if (borrados) console.log(`  ${nombre}: ${borrados} borrados`);
  }
}

/** Escribe en lotes de 400: el maximo de Firestore es 500. */
async function sembrar(db, coleccion, documentos, clave = 'id') {
  for (let i = 0; i < documentos.length; i += 400) {
    const lote = db.batch();
    for (const d of documentos.slice(i, i + 400)) {
      const { [clave]: id, ...resto } = d;
      lote.set(db.doc(`${coleccion}/${id}`), resto);
    }
    await lote.commit();
  }
  console.log(`  ${coleccion}: ${documentos.length}`);
}

async function main() {
  const opciones = {
    usuarios: opcion('usuarios', 200),
    clanes: opcion('clanes', 20),
    viajes: opcion('viajes', 5000),
    meses: opcion('meses', 3),
    semilla: opcion('semilla', 42),
  };

  console.log('=== Generador de datos de prueba ===\n');
  console.log(`${opciones.usuarios} usuarios, ${opciones.clanes} clanes, `
    + `${opciones.viajes} viajes en ${opciones.meses} meses (semilla ${opciones.semilla})\n`);

  const datos = generar(opciones);

  const verificados = datos.viajes.filter((v) => v.verificado).length;
  const activos = [...datos.usuarios].sort((a, b) => b.viajesVerificados - a.viajesVerificados);
  console.log('Reparto:');
  console.log(`  verificados: ${verificados} (${Math.round(verificados / datos.viajes.length * 100)}%)`);
  console.log(`  rutas distintas: ${new Set(datos.viajes.map((v) => v.ruta)).size}`);
  console.log(`  el mas activo: ${activos[0].viajesVerificados} viajes; `
    + `la mediana: ${activos[Math.floor(activos.length / 2)].viajesVerificados}`);
  console.log(`  sin clan: ${datos.usuarios.filter((u) => !u.clanId).length}`);
  console.log(`  estaciones con actividad: ${datos.estadisticas.length}\n`);

  if (!APLICAR) {
    console.log('SIMULACION: no se ha escrito nada. Repite con --aplicar.');
    console.log('El ensayo sobre estos datos, sin red: cd backend && node --test test/ensayo.test.js');
    process.exit(0);
  }

  comprobarDestino();

  const admin = require('firebase-admin');
  admin.initializeApp(process.env.FIRESTORE_EMULATOR_HOST
    ? { projectId: PROYECTO }
    : { credential: admin.credential.applicationDefault(), projectId: PROYECTO });
  const db = admin.firestore();

  if (LIMPIAR) {
    console.log('\nLimpiando:');
    await limpiar(db);
  }

  console.log('\nSembrando:');
  await sembrar(db, 'usuarios', datos.usuarios, 'uid');
  await sembrar(db, 'clanes', datos.clanes);
  await sembrar(db, 'tiempos_viaje', datos.viajes);
  await sembrar(db, 'estaciones_stats', datos.estadisticas);

  console.log('\nListo. Ahora, y en este orden:');
  console.log('  1. node backend/periodicas.js divisiones --simular');
  console.log('  2. node backend/periodicas.js temporada  --simular');
  console.log('  3. Repite los dos con --aplicar y compara la salida');
  console.log('  4. Abre las pantallas en un movil de verdad y mira si tiran');
  console.log('  5. Contrasta las lecturas de la consola de Firebase con docs/COSTE.md');
  process.exit(0);
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
