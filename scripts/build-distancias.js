#!/usr/bin/env node
/**
 * Calcula la distancia ciclable real entre pares de estaciones y la deja en
 * `backend/lib/distancias.json`.
 *
 * Por que no la matriz completa: son 631 estaciones, o sea 397.000 pares. Ni
 * cabe en un fichero razonable ni tiene sentido, porque la inmensa mayoria no
 * los va a hacer nadie. Se calculan SOLO los pares que aparecen en viajes
 * reales, y el resto se resuelve por estimacion hasta que alguien los use.
 *
 * De donde salen los pares:
 *   --pendientes          los pares que ESTAN puntuando con distancia estimada
 *   --rutas fichero.txt   una ruta por linea, formato "002-110"
 *   --firestore           los pares que ya existen en `tiempos_viaje`
 *
 * Uso:
 *   node scripts/build-distancias.js --pendientes
 *   node scripts/build-distancias.js --rutas rutas.txt
 *   node scripts/build-distancias.js --firestore
 *   node scripts/build-distancias.js --rutas rutas.txt --simular
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ESTACIONES = require(path.join(RAIZ, 'backend/lib/estaciones.json'));
const DESTINO = path.join(RAIZ, 'backend/lib/distancias.json');

// Instancia publica de demostracion de OSRM. No tiene acuerdo de servicio y
// limita por IP, de ahi la espera entre peticiones. Para un calculo masivo,
// levantar una instancia propia con un extracto de Madrid.
const OSRM = 'https://router.project-osrm.org/route/v1/cycling';
const ESPERA_MS = 1200;
const REINTENTOS = 3;

const args = process.argv.slice(2);
const SIMULAR = args.includes('--simular');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizar(raw) {
  const val = String(raw ?? '').trim().toUpperCase();
  const m = val.match(/^(\d+)([A-Z]?)$/);
  return m ? m[1].padStart(3, '0') + (m[2] || '') : val;
}

/** Lee las rutas del fichero indicado, descartando lo que no sea valido. */
function rutasDeFichero(fichero) {
  const lineas = fs.readFileSync(fichero, 'utf8').split('\n');
  const rutas = new Set();

  for (const linea of lineas) {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith('#')) continue;

    const [origen, destino] = limpia.split('-');
    const a = normalizar(origen);
    const b = normalizar(destino);

    if (!ESTACIONES[a] || !ESTACIONES[b]) {
      console.warn(`  omitida "${limpia}": alguna estacion no existe`);
      continue;
    }
    if (a === b) continue;
    rutas.add(`${a}-${b}`);
  }
  return [...rutas];
}

/** Arranca el Admin SDK. Comun a los dos modos que hablan con Firestore. */
function firestore() {
  const admin = require('firebase-admin');
  const credenciales = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!credenciales) {
    console.error('Falta FIREBASE_SERVICE_ACCOUNT para leer las rutas.');
    process.exit(1);
  }

  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(credenciales)) });
  return admin.firestore();
}

/** Los pares que ya se han recorrido de verdad. Requiere credenciales. */
async function rutasDeFirestore() {
  const snapshot = await firestore().collection('tiempos_viaje').select('ruta').get();

  const rutas = new Set();
  for (const doc of snapshot.docs) {
    const ruta = doc.data().ruta;
    if (typeof ruta === 'string' && ruta.includes('-')) rutas.add(ruta);
  }
  return [...rutas];
}

/**
 * Los pares que ESTAN PUNTUANDO con distancia estimada. Requiere credenciales.
 *
 * Es el modo de la revision mensual (`docs/MANTENIMIENTO.md`) y el que hay que
 * usar casi siempre: `--firestore` trae TODOS los pares recorridos, y la mayoria
 * ya estan en la tabla. Esto trae solo los que le faltan al juego.
 *
 * Sale de `distanciaEstimada`, que el worker ya escribe en cada viaje que
 * resuelve por estimacion. No hace falta ninguna coleccion aparte ni ninguna
 * escritura extra: el dato ya esta, solo habia que preguntarlo.
 */
async function rutasEstimadas() {
  const snapshot = await firestore().collection('tiempos_viaje')
    .where('distanciaEstimada', '==', true)
    .select('ruta')
    .get();

  const rutas = new Set();
  for (const doc of snapshot.docs) {
    const ruta = doc.data().ruta;
    if (typeof ruta === 'string' && ruta.includes('-')) rutas.add(ruta);
  }

  console.log(`${snapshot.size} viajes puntuando con distancia estimada, `
    + `en ${rutas.size} tramo(s) distinto(s).`);
  return [...rutas];
}

/**
 * Pregunta a OSRM por la distancia de un par. Devuelve metros o null.
 * Nunca lanza: un par que falla se deja sin calcular y se resolvera por
 * estimacion, que es justo el comportamiento previsto.
 */
async function consultar(origen, destino) {
  const a = ESTACIONES[origen];
  const b = ESTACIONES[destino];
  const url = `${OSRM}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;

  for (let intento = 1; intento <= REINTENTOS; intento++) {
    try {
      const respuesta = await fetch(url, { signal: AbortSignal.timeout(15000) });

      // 429 es limite de peticiones: esperar mas y reintentar.
      if (respuesta.status === 429) {
        await dormir(ESPERA_MS * 5 * intento);
        continue;
      }
      if (!respuesta.ok) return null;

      const datos = await respuesta.json();
      const metros = datos?.routes?.[0]?.distance;
      return Number.isFinite(metros) ? Math.round(metros) : null;
    } catch {
      if (intento === REINTENTOS) return null;
      await dormir(ESPERA_MS * intento);
    }
  }
  return null;
}

async function principal() {
  let rutas;
  const indiceFichero = args.indexOf('--rutas');

  if (indiceFichero !== -1) {
    rutas = rutasDeFichero(args[indiceFichero + 1]);
  } else if (args.includes('--pendientes')) {
    rutas = await rutasEstimadas();
  } else if (args.includes('--firestore')) {
    rutas = await rutasDeFirestore();
  } else {
    console.error('Indica de donde salen los pares:');
    console.error('  --pendientes          los que estan puntuando con distancia estimada');
    console.error('  --firestore           todos los pares recorridos alguna vez');
    console.error('  --rutas <fichero>     una ruta por linea');
    process.exit(1);
  }

  // Lo ya calculado no se vuelve a pedir: el script es reanudable, que importa
  // cuando son miles de peticiones a 1,2 s cada una.
  const tabla = fs.existsSync(DESTINO) ? JSON.parse(fs.readFileSync(DESTINO, 'utf8')) : {};
  const pendientes = rutas.filter((r) => !Number.isFinite(tabla[r]));

  console.log(`${rutas.length} rutas, ${pendientes.length} sin calcular.`);
  if (SIMULAR) {
    console.log('Simulacion: no se consulta nada.');
    return;
  }
  if (!pendientes.length) return;

  const minutos = Math.ceil((pendientes.length * ESPERA_MS) / 60000);
  console.log(`Esto va a tardar unos ${minutos} min por el limite de peticiones.\n`);

  let resueltas = 0;
  let fallidas = 0;

  for (const [indice, ruta] of pendientes.entries()) {
    const [origen, destino] = ruta.split('-');
    const metros = await consultar(origen, destino);

    if (metros === null) {
      fallidas++;
      console.warn(`  ${ruta}: sin respuesta, se queda en estimacion`);
    } else {
      tabla[ruta] = metros;
      resueltas++;
    }

    // Se guarda sobre la marcha: si esto se corta a la mitad, no se pierde.
    if (resueltas && resueltas % 25 === 0) {
      fs.writeFileSync(DESTINO, `${JSON.stringify(tabla, null, 0)}\n`, 'utf8');
      console.log(`  ${indice + 1}/${pendientes.length}...`);
    }

    await dormir(ESPERA_MS);
  }

  // Claves ordenadas: sin esto el fichero genera diffs enormes por nada.
  const ordenada = Object.fromEntries(Object.entries(tabla).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(DESTINO, `${JSON.stringify(ordenada, null, 0)}\n`, 'utf8');

  console.log(`\n${resueltas} resueltas, ${fallidas} fallidas. Total en tabla: ${Object.keys(ordenada).length}.`);
}

principal().catch((err) => {
  console.error(err);
  process.exit(1);
});
