#!/usr/bin/env node
/**
 * Genera el dataset canonico de estaciones a partir de data/emt.geojson.
 *
 * Antes, la lista de estaciones estaba pegada como un string gigante dentro de
 * subir/, ranking/ y profile/ (unos 15 KB duplicados en cada pagina, y sin
 * coordenadas). Ahora hay una unica fuente de verdad, con lat/lon, que usan
 * tanto el navegador como el worker de verificacion.
 *
 * Salidas:
 *   assets/data/estaciones.js    -> modulo ES para el frontend
 *   backend/lib/estaciones.json  -> datos para el worker de verificacion
 *
 * Uso: npm run build:estaciones
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GEOJSON = path.join(ROOT, 'data', 'emt.geojson');

/**
 * Normaliza un identificador de estacion al formato canonico de la app:
 * tres digitos con ceros a la izquierda, mas un sufijo opcional en mayusculas.
 * "2" -> "002", "25a" -> "025A", "80B" -> "080B".
 */
function normalizarId(raw) {
  const val = String(raw ?? '').trim().toUpperCase();
  const match = val.match(/^(\d+)([A-Z]?)$/);
  if (!match) return val;
  const [, num, sufijo] = match;
  return num.padStart(3, '0') + sufijo;
}

function limpiarNombre(nombreCompleto, numero) {
  let nombre = String(nombreCompleto ?? '').trim();
  // Los nombres vienen como "2 - Metro Callao"; quitamos el prefijo numerico.
  const prefijo = new RegExp(`^${numero}\\s*-\\s*`, 'i');
  nombre = nombre.replace(prefijo, '').trim();
  return nombre || nombreCompleto;
}

function main() {
  if (!fs.existsSync(GEOJSON)) {
    console.error(`No se encuentra ${GEOJSON}`);
    process.exit(1);
  }

  const geojson = JSON.parse(fs.readFileSync(GEOJSON, 'utf8'));
  const estaciones = {};

  for (const feature of geojson.features || []) {
    const props = feature.properties || {};
    const numero = props.number;
    if (!numero) continue;

    const id = normalizarId(numero);
    const coords = (feature.geometry && feature.geometry.coordinates) || [];
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    estaciones[id] = {
      nombre: limpiarNombre(props.Name, numero),
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
    };
  }

  const total = Object.keys(estaciones).length;
  if (total === 0) {
    console.error('El geojson no ha producido ninguna estacion. Abortando.');
    process.exit(1);
  }

  // Orden estable para que el diff del fichero generado sea legible.
  const ordenado = {};
  for (const id of Object.keys(estaciones).sort()) ordenado[id] = estaciones[id];

  const dirFront = path.join(ROOT, 'assets', 'data');
  const dirBack = path.join(ROOT, 'backend', 'lib');
  fs.mkdirSync(dirFront, { recursive: true });
  fs.mkdirSync(dirBack, { recursive: true });

  const cabecera = `// GENERADO AUTOMATICAMENTE por scripts/build-estaciones.js — no editar a mano.\n// Fuente: data/emt.geojson (${total} estaciones)\n`;

  fs.writeFileSync(
    path.join(dirFront, 'estaciones.js'),
    `${cabecera}export const ESTACIONES = ${JSON.stringify(ordenado, null, 0)};\n`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(dirBack, 'estaciones.json'),
    `${JSON.stringify(ordenado, null, 0)}\n`,
    'utf8'
  );

  console.log(`OK: ${total} estaciones escritas en assets/data/ y backend/lib/`);

  construirPalabras(dirFront, dirBack);
}

/**
 * Reparte la lista de palabras prohibidas a los dos lados desde su unica fuente
 * (shared/palabras-prohibidas.json), para que el filtro del navegador y el del
 * servidor no puedan divergir.
 */
function construirPalabras(dirFront, dirBack) {
  const origen = path.join(ROOT, 'shared', 'palabras-prohibidas.json');
  if (!fs.existsSync(origen)) {
    console.warn('Aviso: no existe shared/palabras-prohibidas.json, me lo salto.');
    return;
  }

  const palabras = JSON.parse(fs.readFileSync(origen, 'utf8'));
  fs.writeFileSync(path.join(dirBack, 'palabras-prohibidas.json'), `${JSON.stringify(palabras)}\n`, 'utf8');
  fs.writeFileSync(
    path.join(dirFront, 'palabras-prohibidas.js'),
    '// GENERADO AUTOMATICAMENTE por scripts/build-estaciones.js — no editar a mano.\n' +
    `// Fuente: shared/palabras-prohibidas.json (${palabras.length} entradas)\n` +
    `export const PALABRAS_PROHIBIDAS = ${JSON.stringify(palabras)};\n`,
    'utf8'
  );

  console.log(`OK: ${palabras.length} palabras prohibidas repartidas a ambos lados`);
}

main();
