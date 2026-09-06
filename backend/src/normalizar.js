'use strict';

/**
 * Normalizacion de capturas antes de leerlas.
 *
 * La app de BiciMAD no se ve igual en todas partes:
 *
 *   - Android e iOS tienen tipografia, alturas de barra y densidad distintas
 *   - cada movil manda su resolucion: 1080x2400, 1284x2778, 750x1334...
 *   - mucha gente RECORTA para quitar la barra de estado
 *   - o la manda por WhatsApp y llega recomprimida y reescalada
 *   - modo claro y modo oscuro invierten el contraste
 *
 * Todo eso llegaba tal cual al OCR, que acierta menos cuanto mas rara es la
 * imagen. Aqui se deja todo en la misma forma antes de leer.
 *
 * ORDEN CRITICO: esto se ejecuta DESPUES de calcular las huellas.
 *
 * `hashExacto` y `hashPerceptual` se calculan sobre el fichero TAL COMO lo subio
 * la persona. Si se hashease lo normalizado, dos capturas distintas reducidas al
 * mismo tamaño y en gris podrian colisionar, y la deteccion de duplicados
 * empezaria a rechazar viajes legitimos.
 */

let sharp = null;
try {
  sharp = require('sharp');
} catch {
  // Sin sharp no se normaliza; el OCR recibira la imagen tal cual.
}

/** Ancho al que se lleva todo. Suficiente para leer texto de interfaz movil. */
const ANCHO = 1400;

/**
 * Por debajo de esta luminancia media, la captura es de modo oscuro.
 *
 * Tesseract acierta bastante mas con texto oscuro sobre fondo claro, asi que
 * las oscuras se invierten.
 */
const UMBRAL_OSCURO = 110;

/** Tolerancia de color para considerar que una fila es margen uniforme. */
const TOLERANCIA_MARGEN = 12;

/**
 * Clasifica de donde viene la captura.
 *
 * No decide nada por si sola: se guarda en el viaje para poder MEDIR despues
 * donde falla la extraccion. Sin esto, "el OCR falla a veces" no se puede
 * convertir en "el OCR falla en capturas recortadas de iPhone".
 */
function clasificar(meta) {
  if (!meta?.width || !meta?.height) return 'desconocida';

  const proporcion = meta.height / meta.width;

  // Una captura de movil entera es alargada. Por debajo de 1,5 casi siempre es
  // un recorte, y hay que saberlo porque ahi es donde el OCR se pierde.
  if (proporcion < 1.5) return 'recortada';

  // Las de iPhone tienen proporciones muy concretas por sus pantallas.
  if (proporcion > 2.1) return 'ios';
  return 'android';
}

/**
 * Detecta cuantas filas de margen uniforme hay arriba y abajo.
 *
 * Es lo que quita la barra de estado y las bandas negras del recorte, que son
 * ruido puro para el OCR y ademas descolocan las proporciones.
 *
 * @param {Buffer} pixeles  en escala de grises, UN byte por pixel y `ancho`
 *   bytes por fila. Si llega un buffer con mas canales (RGBA), esta funcion
 *   leeria un cuarto de la imagen creyendo que la lee entera: por eso
 *   `preparar` fuerza el espacio de color antes de llamarla.
 */
function margenesUniformes(pixeles, ancho, alto) {
  const filaUniforme = (y) => {
    const base = y * ancho;
    const primero = pixeles[base];
    for (let x = 1; x < ancho; x++) {
      if (Math.abs(pixeles[base + x] - primero) > TOLERANCIA_MARGEN) return false;
    }
    return true;
  };

  let arriba = 0;
  while (arriba < alto && filaUniforme(arriba)) arriba++;

  let abajo = 0;
  while (abajo < alto - arriba && filaUniforme(alto - 1 - abajo)) abajo++;

  // La guarda mira cuanto CONTENIDO queda, no cuanto margen hay.
  //
  // Si quedara casi nada, la deteccion se ha equivocado: una captura no es
  // margen al 90%. Recortarla asi dejaria al OCR sin nada que leer, y con cero
  // filas `extract` directamente revienta.
  const util = alto - arriba - abajo;
  if (util < 8 || util < alto * 0.1) return { arriba: 0, abajo: 0 };

  return { arriba, abajo };
}

/** Luminancia media de un buffer en escala de grises. */
function luminanciaMedia(pixeles) {
  if (!pixeles.length) return 255;
  let suma = 0;
  // Se muestrea uno de cada 16: con cientos de miles de pixeles, la media no
  // cambia y el calculo baja de milisegundos a microsegundos.
  let n = 0;
  for (let i = 0; i < pixeles.length; i += 16) { suma += pixeles[i]; n++; }
  return suma / n;
}

/**
 * Deja la captura lista para el OCR.
 *
 * Devuelve `{ buffer, variante, oscura, recortado }`, o null si la imagen no se
 * puede decodificar: eso significa que tampoco la va a poder leer tesseract, y
 * darsela igualmente es lo que hacia que reventara.
 */
async function preparar(entrada) {
  if (!sharp) return { buffer: entrada, variante: 'desconocida', oscura: false, recortado: 0 };

  try {
    // `flatten` NO es cosmetico y aqui es lo primero por un motivo concreto:
    // mientras la imagen conserve canal alfa, `negate()` lo invierte TAMBIEN.
    // Una captura de modo oscuro salia de aqui con alfa 0, es decir,
    // completamente transparente, y tesseract leia una imagen en blanco: cero
    // texto, confianza cero, y el viaje a revision manual. Con las capturas que
    // manda hoy el navegador (JPEG, que no tiene alfa) no se notaba, pero las
    // reglas admiten PNG y WEBP, que si lo tienen.
    //
    // Aplanando contra blanco desaparece el canal y con el la trampa entera.
    const imagen = sharp(entrada)
      .rotate() // aplica la orientacion EXIF
      .flatten({ background: { r: 255, g: 255, b: 255 } });

    const meta = await imagen.metadata();
    const variante = clasificar(meta);

    // 1. A gris, para medir margenes y luminancia sobre un solo canal.
    //    `toColourspace('b-w')` fuerza UN canal: sin el, `greyscale()` puede
    //    devolver tres iguales y el buffer crudo saldria interleavado, con lo
    //    que la deteccion de margenes leeria basura.
    const gris = await imagen.clone().greyscale().toColourspace('b-w')
      .raw().toBuffer({ resolveWithObject: true });
    const { width, height } = gris.info;

    if (gris.info.channels !== 1) {
      throw new Error(`se esperaba un canal y han llegado ${gris.info.channels}`);
    }

    // 2. Fuera los margenes uniformes.
    const { arriba, abajo } = margenesUniformes(gris.data, width, height);
    const altoUtil = height - arriba - abajo;

    let trabajo = imagen.clone().greyscale().toColourspace('b-w');
    if (altoUtil > 0 && (arriba || abajo)) {
      trabajo = trabajo.extract({ left: 0, top: arriba, width, height: altoUtil });
    }

    // 3. Modo oscuro: se invierte. Tesseract acierta mas con texto oscuro sobre
    //    fondo claro, y la mitad de la gente lleva el movil en oscuro.
    const oscura = luminanciaMedia(gris.data) < UMBRAL_OSCURO;
    // `alpha: false` es cinturon ademas de tirantes: aqui ya no queda alfa que
    // invertir gracias al `flatten` de arriba, pero dejarlo escrito evita que
    // el dia que alguien quite el flatten vuelva el fallo mudo.
    if (oscura) trabajo = trabajo.negate({ alpha: false });

    // 4. Tamaño unico y contraste normalizado. `withoutEnlargement: false`
    //    porque una captura pequeña hay que AMPLIARLA: es justo el caso en que
    //    el OCR falla.
    const buffer = await trabajo
      .resize({ width: ANCHO, withoutEnlargement: false })
      .normalise()
      .sharpen()
      .png()
      .toBuffer();

    return { buffer, variante, oscura, recortado: arriba + abajo };
  } catch (error) {
    console.warn('La captura no se puede decodificar:', error.message);
    return null;
  }
}

module.exports = {
  preparar,
  clasificar,
  margenesUniformes,
  luminanciaMedia,
  ANCHO,
  UMBRAL_OSCURO,
};
