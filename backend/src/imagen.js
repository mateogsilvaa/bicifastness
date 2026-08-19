'use strict';

const crypto = require('crypto');
const { ErrorApp } = require('./errores');
const { LIMITES } = require('./config');

// sharp trae binarios nativos. Si el entorno no lo tiene, seguimos funcionando
// con el hash exacto en vez de tirar el pipeline entero abajo.
let sharp = null;
try {
  sharp = require('sharp');
} catch {
  console.warn('sharp no disponible: se degrada a deteccion de duplicado exacto.');
}

/**
 * Decodifica un data URL "data:image/jpeg;base64,..." validando tipo y tamano.
 * Lanza ErrorApp si algo no cuadra: nunca confiamos en lo que manda el cliente.
 */
function decodificarDataUrl(dataUrl) {
  const texto = String(dataUrl ?? '');
  const match = texto.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) {
    throw new ErrorApp('invalid-argument', 'La captura no tiene un formato valido.');
  }

  const [, mime, base64] = match;
  if (!LIMITES.MIMES_IMAGEN.includes(mime.toLowerCase())) {
    throw new ErrorApp('invalid-argument', `Formato de imagen no admitido: ${mime}.`);
  }

  // Comprobamos el tamano ANTES de reservar el buffer.
  const bytesAprox = Math.floor((base64.length * 3) / 4);
  if (bytesAprox > LIMITES.MAX_BYTES_IMAGEN) {
    throw new ErrorApp('invalid-argument', 'La captura pesa demasiado.');
  }

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0) {
    throw new ErrorApp('invalid-argument', 'La captura esta vacia.');
  }

  // El mime declarado por el cliente no vale nada: verificamos los magic bytes.
  if (!coincideFirma(buffer, mime)) {
    throw new ErrorApp('invalid-argument', 'El contenido de la imagen no coincide con su formato.');
  }

  return { buffer, mime: mime.toLowerCase() };
}

/** Comprueba los primeros bytes contra la firma real del formato. */
function coincideFirma(buf, mime) {
  const tipo = mime.toLowerCase();
  if (tipo === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (tipo === 'image/png') {
    return buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (tipo === 'image/webp') {
    return buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

/** SHA-256 del fichero tal cual. Detecta el reenvio literal de una captura. */
function hashExacto(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * dHash perceptual de 64 bits.
 *
 * Reduce la imagen a 9x8 en gris y compara cada pixel con el de su derecha.
 * El resultado sobrevive a recomprimir, reescalar o cambiar el brillo, asi que
 * pilla la misma captura resubida "disimulada" — que es justo lo que hace quien
 * intenta reclamar dos veces el mismo trayecto.
 */
async function hashPerceptual(buffer) {
  if (!sharp) return null;
  try {
    const pixeles = await sharp(buffer)
      .greyscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer();

    let bits = '';
    for (let fila = 0; fila < 8; fila++) {
      for (let col = 0; col < 8; col++) {
        const izq = pixeles[fila * 9 + col];
        const der = pixeles[fila * 9 + col + 1];
        bits += izq > der ? '1' : '0';
      }
    }
    // 64 bits -> 16 caracteres hex.
    return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
  } catch (err) {
    console.warn('No se ha podido calcular el hash perceptual:', err.message);
    return null;
  }
}

/** Distancia de Hamming entre dos dHash hex. Devuelve 64 si alguno falta. */
function distanciaHamming(hexA, hexB) {
  if (!hexA || !hexB) return 64;
  let x = BigInt(`0x${hexA}`) ^ BigInt(`0x${hexB}`);
  let bits = 0;
  while (x > 0n) {
    bits += Number(x & 1n);
    x >>= 1n;
  }
  return bits;
}

/**
 * Metadatos utiles para la auditoria: dimensiones y si la imagen conserva EXIF.
 *
 * Una captura de pantalla autentica de un movil NO lleva datos de camara. Si
 * aparece marca/modelo o software de edicion, es que la imagen ha pasado por
 * otro sitio — normalmente un editor.
 */
async function inspeccionar(buffer) {
  if (!sharp) return { ancho: null, alto: null, sospechaEdicion: false, software: null };
  try {
    const meta = await sharp(buffer).metadata();
    let software = null;
    let sospechaEdicion = false;

    if (meta.exif) {
      // Basta con buscar las firmas de los editores habituales en el bloque EXIF.
      const texto = meta.exif.toString('latin1');
      const editores = ['Photoshop', 'GIMP', 'Snapseed', 'Picsart', 'Pixlr', 'Lightroom', 'Canva'];
      const encontrado = editores.find((e) => texto.includes(e));
      if (encontrado) {
        software = encontrado;
        sospechaEdicion = true;
      }
    }

    return { ancho: meta.width || null, alto: meta.height || null, sospechaEdicion, software };
  } catch {
    return { ancho: null, alto: null, sospechaEdicion: false, software: null };
  }
}

/**
 * Reescribe la imagen a JPEG limpio antes de guardarla.
 * Elimina EXIF (que puede llevar geolocalizacion del usuario: minimizacion de
 * datos del RGPD) y neutraliza cualquier payload escondido en los metadatos.
 */
async function normalizarParaGuardar(buffer) {
  if (!sharp) return buffer;
  try {
    return await sharp(buffer)
      .rotate() // aplica la orientacion EXIF antes de descartarla
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    console.warn('No se ha podido normalizar la imagen:', err.message);
    return buffer;
  }
}

module.exports = {
  decodificarDataUrl,
  hashExacto,
  hashPerceptual,
  distanciaHamming,
  inspeccionar,
  normalizarParaGuardar,
  sharpDisponible: () => sharp !== null,
};
