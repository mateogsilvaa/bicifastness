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
  const partes = trocear(gris, ancho, alto);
  if (!partes) return [];
  return partes.trozos.map(([a, b]) => {
    const { y0, y1 } = alturaDe(partes.tinta, ancho, alto, a, b);
    return reescalar(partes.tinta, ancho, a, y0, b - a, Math.max(1, y1 - y0));
  });
}

/** La tinta (1 donde hay trazo) y las columnas de cada glifo; `null` sin contraste. */
function trocear(gris, ancho, alto) {
  let min = 255;
  let max = 0;
  let suma = 0;
  for (const v of gris) { min = Math.min(min, v); max = Math.max(max, v); suma += v; }
  if (max - min < 40) return null;
  const umbral = (min + max) / 2;
  const fondoClaro = suma / gris.length > umbral;
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
  return { tinta, trozos: trozos.filter(([a, b]) => b - a >= 1) };
}

/** Las filas que ocupa la tinta entre dos columnas. */
function alturaDe(tinta, ancho, alto, a, b) {
  let y0 = alto;
  let y1 = 0;
  for (let y = 0; y < alto; y++) {
    for (let x = a; x < b; x++) if (tinta[y * ancho + x]) { y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1); }
  }
  return { y0, y1 };
}

/**
 * Huecos cerrados de un glifo: las zonas sin tinta que no llegan al borde.
 * Las que no alcanzan `minimo` pixeles son ruido del suavizado.
 */
function huecosCerrados(tinta, ancho, a, b, y0, y1, minimo) {
  const w = b - a + 2;
  const h = y1 - y0 + 2;
  // Con un marco vacio alrededor, todo lo que toca fuera queda conectado.
  const hayTinta = (x, y) => x > 0 && y > 0 && x < w - 1 && y < h - 1
    && tinta[(y0 + y - 1) * ancho + a + x - 1] === 1;
  const visto = new Uint8Array(w * h);
  const rellenar = (x0, yInicio) => {
    const pila = [[x0, yInicio]];
    let area = 0;
    visto[yInicio * w + x0] = 1;
    while (pila.length) {
      const [x, y] = pila.pop();
      area++;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || visto[ny * w + nx] || hayTinta(nx, ny)) continue;
        visto[ny * w + nx] = 1;
        pila.push([nx, ny]);
      }
    }
    return area;
  };
  rellenar(0, 0);
  let huecos = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!visto[y * w + x] && !hayTinta(x, y) && rellenar(x, y) >= minimo) huecos++;
    }
  }
  return huecos;
}

/**
 * Sin hueco, ¿es un 1? Si es estrecho, si. Si es ancho (un 1 con pie), solo si
 * el centro tiene tinta, que es su palo, y no es una mancha: un 0 con el aro
 * roto tiene el centro vacio, y uno tapado por el suavizado es casi todo tinta.
 */
function pareceUno(tinta, ancho, a, b, y0, y1) {
  const w = b - a;
  const h = Math.max(1, y1 - y0);
  if (w / h < 0.55) return true;
  let llena = 0;
  for (let y = y0; y < y1; y++) for (let x = a; x < b; x++) llena += tinta[y * ancho + x];
  let centro = 0;
  const fila = Math.floor((y0 + y1) / 2);
  for (let x = a + Math.floor(w / 3); x < b - Math.floor(w / 3); x++) centro += tinta[fila * ancho + x];
  return centro > 0 && llena / (w * h) < 0.6;
}

/**
 * Corrige los 0 y 1 cambiados mirando la forma de cada glifo: un 0 encierra un
 * hueco y un 1 no. No depende de la letra de la app ni de ningun entrenamiento.
 *
 * Solo toca 0 y 1, y solo si hay un glifo por caracter: si no se puede saber
 * que glifo es de cada caracter, el texto se queda como estaba.
 */
function corregirCeroUno(gris, ancho, alto, texto) {
  const leido = String(texto || '');
  const partes = trocear(gris, ancho, alto);
  if (!partes || partes.trozos.length !== leido.length) return leido;
  return [...leido].map((caracter, i) => {
    if (caracter !== '0' && caracter !== '1') return caracter;
    const [a, b] = partes.trozos[i];
    const { y0, y1 } = alturaDe(partes.tinta, ancho, alto, a, b);
    const area = (b - a) * (y1 - y0);
    const huecos = huecosCerrados(partes.tinta, ancho, a, b, y0, y1, Math.max(3, Math.round(area * 0.02)));
    if (huecos > 0) return '0';
    return pareceUno(partes.tinta, ancho, a, b, y0, y1) ? '1' : caracter;
  }).join('');
}

/** Lo mismo sobre un recorte (PNG). Nunca lanza: ante cualquier duda, `texto`. */
async function afinarCeroUno(png, texto) {
  try {
    const sharp = require('sharp');
    const { data, info } = await grisDe(sharp, png, 64);
    if (info.channels !== 1) return texto;
    return corregirCeroUno(data, info.width, info.height, texto);
  } catch {
    return texto;
  }
}

/**
 * Un pixel, un valor. Con canal alfa `raw` da dos valores por pixel, y todo lo
 * que se analice despues sale desalineado sin que nada falle.
 */
function grisDe(sharp, png, alto) {
  return sharp(png).flatten({ background: '#ffffff' }).resize({ height: alto })
    .greyscale().raw().toBuffer({ resolveWithObject: true });
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
  const { data, info } = await grisDe(sharp, png, 32);
  const glifos = segmentar(Array.from(data), info.width, info.height);
  if (!glifos.length || glifos.length > 10) return null;
  return glifos.map((g) => clasificar(g, m)).join('');
}

module.exports = { leerRecorte, segmentar, clasificar, corregirCeroUno, afinarCeroUno, ANCHO, ALTO, hayModelo: () => Boolean(cargar()) };
