#!/usr/bin/env node
/**
 * Copia a `assets/ocr/` lo que necesita el OCR del NAVEGADOR (issue #8).
 *
 * POR QUE AUTOALOJADO Y NO DESDE UN CDN. tesseract.js, por defecto, se baja el
 * motor y el modelo de idioma de jsdelivr. Aqui eso no vale por dos razones:
 *
 *   1. La CSP declara `connect-src 'self'` y `script-src` sin jsdelivr. Abrirla
 *      para esto seria dar permiso de ejecucion a un tercero en la pagina donde
 *      la gente sube sus capturas.
 *   2. Un CDN que cambia una version por debajo cambia el OCR sin que nadie lo
 *      decida, y el extractor es la pieza de la que cuelga el hito entero.
 *
 * QUE PESA ESTO. Alrededor de 6 MB la primera vez que alguien sube un viaje, y
 * cero las siguientes (lo cachea el navegador). Es mucho, y se acepta a
 * sabiendas: a cambio, la confirmacion es inmediata en vez de esperar a que el
 * worker despierte. Si el OCR no arranca, la pagina cae al formulario manual.
 *
 * De todas las variantes del motor solo se copia UNA, la de SIMD con LSTM:
 * llevarlas todas serian mas de 11 MB en el repositorio. SIMD lo soportan todos
 * los navegadores desde 2021; el que no, se va al formulario manual.
 *
 * Uso: node scripts/build-ocr.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RAIZ = path.join(__dirname, '..');
const MODULOS = path.join(RAIZ, 'backend/node_modules');
const DESTINO = path.join(RAIZ, 'assets/ocr');

/**
 * El modelo de idioma no viene en node_modules: tesseract se lo baja la primera
 * vez que corre. El worker ya lo tiene cacheado ahi.
 */
const IDIOMA = path.join(RAIZ, 'backend/.tesseract/spa.traineddata');

const COPIAS = [
  // La biblioteca, en version modulo ES, que es como la importa el navegador.
  ['tesseract.js/dist/tesseract.esm.min.js', 'tesseract.esm.min.js'],
  // El script del worker de tesseract. Servirlo desde aqui evita el origen
  // ajeno, pero NO evita el `blob:` de la CSP: tesseract se lo descarga y lo
  // arranca envuelto en un Blob de todas formas.
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  // El motor, en la variante que lleva el wasm INCRUSTADO en el propio .js.
  //
  // La otra (un cargador de 87 KB mas el .wasm aparte) pesa un mega menos, y no
  // sirve: tesseract arranca su worker desde un `blob:`, y desde ahi el
  // cargador de Emscripten no puede resolver la ruta relativa de su .wasm
  // ("Failed to parse URL from tesseract-core-simd-lstm.wasm"). Con el wasm
  // dentro no hay nada que resolver.
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
];

function principal() {
  if (!fs.existsSync(IDIOMA)) {
    console.error(`Falta ${path.relative(RAIZ, IDIOMA)}.`);
    console.error('Ejecuta primero cualquier cosa que use el OCR del worker (por ejemplo');
    console.error('`cd backend && npm test`), que lo deja cacheado ahi.');
    process.exit(1);
  }

  fs.mkdirSync(DESTINO, { recursive: true });

  let total = 0;
  for (const [origen, nombre] of COPIAS) {
    const entrada = path.join(MODULOS, origen);
    if (!fs.existsSync(entrada)) {
      console.error(`Falta ${origen}. Instala las dependencias del worker: cd backend && npm ci`);
      process.exit(1);
    }
    const bytes = fs.readFileSync(entrada);
    fs.writeFileSync(path.join(DESTINO, nombre), bytes);
    total += bytes.length;
    console.log(`${nombre.padEnd(34)} ${(bytes.length / 1024).toFixed(0).padStart(6)} KB`);
  }

  // El modelo va comprimido: tesseract.js lo descomprime al vuelo y asi no se
  // arrastran tres megas y medio por la red ni por el repositorio.
  const comprimido = zlib.gzipSync(fs.readFileSync(IDIOMA), { level: 9 });
  fs.writeFileSync(path.join(DESTINO, 'spa.traineddata.gz'), comprimido);
  total += comprimido.length;
  console.log(`${'spa.traineddata.gz'.padEnd(34)} ${(comprimido.length / 1024).toFixed(0).padStart(6)} KB`);

  console.log(`\nOK: ${(total / 1024 / 1024).toFixed(1)} MB en assets/ocr/`);
  console.log('Recuerda: esto se baja UNA vez por navegador, y solo al subir un viaje.');
}

principal();
