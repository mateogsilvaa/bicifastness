/**
 * Lector de cifras propio: un clasificador de 11 clases (0-9 y ":") entrenado
 * con los recortes de capturas de verdad (`dataset_cifras`, que guarda el
 * worker de cada viaje aprobado con captura impecable).
 *
 * Solo tiene que distinguir once glifos en el MISMO render de la app de
 * BiciMAD, asi que acierta casi siempre. Pega: si BiciMAD cambia la letra, se
 * queda viejo; por eso es la lupa sobre Tesseract y no lo unico que lee.
 *
 * El modelo es una regresion logistica: una matriz de pesos en
 * `backend/lib/cifras.json` (scripts/entrenar-cifras.py). Sin motor ni
 * dependencias: un producto de matrices. Si el fichero no esta, no hace nada.
 *
 * La segmentacion es GEMELA de la de scripts/entrenar-cifras.py: si cambia una,
 * hay que cambiar la otra (lo comprueba un test).
 */

const fs = require('fs');
const path = require('path');

const ANCHO = 12;
const ALTO = 16;
const FICHERO = path.join(__dirname, '..', 'lib', 'cifras.json');

let modelo;
function cargar() {
  if (modelo !== undefined) return modelo;
  try {
    modelo = JSON.parse(fs.readFileSync(FICHERO, 'utf8'));
    if (!Array.isArray(modelo?.pesos) || !Array.isArray(modelo?.clases)) modelo = null;
  } catch {
    modelo = null;
  }
  return modelo;
}

/** Media de un rectangulo de la imagen (reescalado por area). */
function reescalar(pix, ancho, x0, y0, w, h) {
  const salida = new Array(ANCHO * ALTO).fill(0);
  for (let j = 0; j < ALTO; j++) {
    for (let i = 0; i < ANCHO; i++) {
      const xa = x0 + (i * w) / ANCHO;
      const xb = x0 + ((i + 1) * w) / ANCHO;
      const ya = y0 + (j * h) / ALTO;
      const yb = y0 + ((j + 1) * h) / ALTO;
      let suma = 0;
      let n = 0;
      for (let y = Math.floor(ya); y < Math.max(Math.floor(ya) + 1, Math.ceil(yb)); y++) {
        for (let x = Math.floor(xa); x < Math.max(Math.floor(xa) + 1, Math.ceil(xb)); x++) {
          suma += pix[y * ancho + x];
          n++;
        }
      }
      salida[j * ANCHO + i] = n ? suma / n : 0;
    }
  }
  return salida;
}

/**
 * Trocea un recorte en glifos. `gris`: valores 0-255, fila a fila.
 * Devuelve un vector de ANCHO*ALTO (tinta 0..1) por glifo, de izquierda a derecha.
 */
function segmentar(gris, ancho, alto) {
  let min = 255;
  let max = 0;
  let suma = 0;
  for (const v of gris) { min = Math.min(min, v); max = Math.max(max, v); suma += v; }
  if (max - min < 40) return [];
  const umbral = (min + max) / 2;
  const fondoClaro = suma / gris.length > umbral;
  // Tinta: 1 donde hay trazo.
  const tinta = Array.from(gris, (v) => ((fondoClaro ? v < umbral : v > umbral) ? 1 : 0));
  const columnas = [];
  for (let x = 0; x < ancho; x++) {
    let c = 0;
    for (let y = 0; y < alto; y++) c += tinta[y * ancho + x];
    columnas.push(c);
  }
  const trozos = [];
  let desde = -1;
  for (let x = 0; x <= ancho; x++) {
    const hay = x < ancho && columnas[x] > 0;
    if (hay && desde < 0) desde = x;
    if (!hay && desde >= 0) { trozos.push([desde, x]); desde = -1; }
  }
  return trozos.filter(([a, b]) => b - a >= 1).map(([a, b]) => {
    let y0 = alto;
    let y1 = 0;
    for (let y = 0; y < alto; y++) {
      for (let x = a; x < b; x++) if (tinta[y * ancho + x]) { y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1); }
    }
    return reescalar(tinta, ancho, a, y0, b - a, Math.max(1, y1 - y0));
  });
}

/** La clase de un glifo con el modelo. */
function clasificar(vector, m) {
  let mejor = -Infinity;
  let clase = '';
  for (let k = 0; k < m.clases.length; k++) {
    let z = m.sesgos[k];
    const w = m.pesos[k];
    for (let i = 0; i < vector.length; i++) z += w[i] * vector[i];
    if (z > mejor) { mejor = z; clase = m.clases[k]; }
  }
  return clase;
}

/**
 * Lee un recorte (PNG) con el clasificador. `null` si no hay modelo o el
 * recorte no se deja trocear.
 */
async function leerRecorte(png) {
  const m = cargar();
  if (!m) return null;
  const sharp = require('sharp');
  const { data, info } = await sharp(png).resize({ height: 32 }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const glifos = segmentar(Array.from(data), info.width, info.height);
  if (!glifos.length || glifos.length > 10) return null;
  return glifos.map((g) => clasificar(g, m)).join('');
}

module.exports = { leerRecorte, segmentar, clasificar, ANCHO, ALTO, hayModelo: () => Boolean(cargar()) };
