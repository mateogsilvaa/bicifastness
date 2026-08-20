'use strict';

/**
 * Normalizacion de capturas.
 *
 * Estos tests SI ejecutan el procesado de imagen de verdad, sobre imagenes
 * generadas al vuelo. Es la unica forma de comprobar que el recorte de margenes
 * y la inversion de modo oscuro hacen lo que dicen: mirando el codigo no se ve.
 */

const test = require('node:test');
const assert = require('node:assert');

const normalizar = require('../src/normalizar');

let sharp = null;
try {
  sharp = require('sharp');
} catch {
  // Sin sharp estos tests no aplican.
}

/**
 * Imagen de prueba: fondo liso con un bloque de contenido en medio.
 *
 * El bloque NO ocupa todo el ancho, y eso es deliberado. Una captura real tiene
 * filas con contenido variado; si la banda llegara de borde a borde, TODAS las
 * filas serian uniformes (unas del color del fondo y otras del de la banda) y
 * el detector de margenes se comeria la imagen entera. La primera version de
 * este fixture tenia justo ese fallo y hacia fallar un codigo correcto.
 */
async function imagen({ ancho, alto, fondo, banda = null }) {
  const base = sharp({
    create: { width: ancho, height: alto, channels: 3, background: fondo },
  });

  if (!banda) return base.png().toBuffer();

  const anchoBanda = Math.floor(ancho * 0.6);
  const franja = await sharp({
    create: { width: anchoBanda, height: banda.alto, channels: 3, background: banda.color },
  }).png().toBuffer();

  return base
    .composite([{ input: franja, top: banda.arriba, left: Math.floor((ancho - anchoBanda) / 2) }])
    .png().toBuffer();
}

// --- Clasificacion -----------------------------------------------------------

test('distingue captura entera de recorte', () => {
  // Importa poder distinguirlos: el recorte es donde el OCR se pierde, y sin
  // etiquetarlo "el OCR falla a veces" no se convierte nunca en algo accionable.
  assert.strictEqual(normalizar.clasificar({ width: 1080, height: 2400 }), 'ios');
  assert.strictEqual(normalizar.clasificar({ width: 1080, height: 1920 }), 'android');
  assert.strictEqual(normalizar.clasificar({ width: 1080, height: 700 }), 'recortada');
});

test('sin dimensiones no se inventa una variante', () => {
  assert.strictEqual(normalizar.clasificar({}), 'desconocida');
  assert.strictEqual(normalizar.clasificar(null), 'desconocida');
});

// --- Margenes ----------------------------------------------------------------

test('detecta los margenes uniformes de arriba y abajo', () => {
  const ancho = 10;
  const alto = 20;
  const pixeles = Buffer.alloc(ancho * alto, 0); // todo negro

  // Contenido en las filas 5 a 14.
  for (let y = 5; y < 15; y++) {
    for (let x = 0; x < ancho; x++) pixeles[y * ancho + x] = x * 20;
  }

  const { arriba, abajo } = normalizar.margenesUniformes(pixeles, ancho, alto);
  assert.strictEqual(arriba, 5);
  assert.strictEqual(abajo, 5);
});

test('una imagen sin contenido no se recorta a cero', () => {
  // Si "todo" es margen, devolver el alto entero dejaria un recorte de cero
  // pixeles y `extract` reventaria.
  const pixeles = Buffer.alloc(10 * 20, 128);
  const { arriba, abajo } = normalizar.margenesUniformes(pixeles, 10, 20);

  assert.strictEqual(arriba, 0);
  assert.strictEqual(abajo, 0);
});

// --- Luminancia --------------------------------------------------------------

test('distingue modo claro de modo oscuro', () => {
  assert.ok(normalizar.luminanciaMedia(Buffer.alloc(1000, 240)) > normalizar.UMBRAL_OSCURO);
  assert.ok(normalizar.luminanciaMedia(Buffer.alloc(1000, 20)) < normalizar.UMBRAL_OSCURO);
});

// --- Procesado completo ------------------------------------------------------

test('todo sale al mismo ancho, venga como venga', { skip: !sharp }, async () => {
  // Es el punto entero de normalizar: al OCR le llega siempre lo mismo.
  const grande = await normalizar.preparar(await imagen({ ancho: 1284, alto: 2778, fondo: '#fff', banda: { arriba: 800, alto: 400, color: '#111' } }));
  const pequena = await normalizar.preparar(await imagen({ ancho: 640, alto: 1400, fondo: '#fff', banda: { arriba: 400, alto: 200, color: '#111' } }));

  const anchoDe = async (b) => (await sharp(b).metadata()).width;

  assert.strictEqual(await anchoDe(grande.buffer), normalizar.ANCHO);
  assert.strictEqual(await anchoDe(pequena.buffer), normalizar.ANCHO,
    'una captura pequeña hay que AMPLIARLA, que es cuando el OCR falla');
});

test('el modo oscuro se invierte', { skip: !sharp }, async () => {
  const entrada = await imagen({
    ancho: 800, alto: 1600, fondo: '#111',
    banda: { arriba: 600, alto: 300, color: '#eee' },
  });

  const antes = normalizar.luminanciaMedia(await sharp(entrada).greyscale().raw().toBuffer());
  const oscura = await normalizar.preparar(entrada);
  const despues = normalizar.luminanciaMedia(await sharp(oscura.buffer).greyscale().raw().toBuffer());

  assert.strictEqual(oscura.oscura, true, 'no se ha detectado como oscura');

  // La propiedad que importa es que se ACLARA, no que supere un valor concreto:
  // cuanto acabe dependiendo del texto que lleve la captura, y aqui el "texto"
  // es un bloque solido que ocupa mucho mas de lo que ocuparia uno real.
  // Tesseract acierta mas con texto oscuro sobre fondo claro.
  assert.ok(despues > antes * 2,
    `la imagen no se ha aclarado: ${antes.toFixed(1)} -> ${despues.toFixed(1)}`);
});

test('el modo claro no se toca', { skip: !sharp }, async () => {
  const clara = await normalizar.preparar(
    await imagen({ ancho: 800, alto: 1600, fondo: '#fff', banda: { arriba: 600, alto: 300, color: '#111' } }));

  assert.strictEqual(clara.oscura, false);
});

test('se quitan las bandas uniformes de los bordes', { skip: !sharp }, async () => {
  // La barra de estado y las bandas del recorte son ruido puro para el OCR y
  // ademas descolocan las proporciones.
  const conBandas = await normalizar.preparar(
    await imagen({ ancho: 800, alto: 1600, fondo: '#000', banda: { arriba: 400, alto: 800, color: '#fff' } }));

  assert.ok(conBandas.recortado > 0, 'no se ha recortado nada');
});

test('una imagen ilegible devuelve null, no revienta', { skip: !sharp }, async () => {
  // Darle basura a tesseract es lo que tumbaba el proceso entero.
  assert.strictEqual(await normalizar.preparar(Buffer.from('esto no es una imagen')), null);
});
