/**
 * Leer del EXIF lo justo, ANTES de que el lienzo lo borre (#66).
 *
 * EL PROBLEMA QUE RESUELVE. El antifraude daba 45 puntos —la señal mas pesada
 * de su funcion despues del record pulverizado— a una captura con rastros de
 * editor en el EXIF. Y esa señal no podia saltar NUNCA: el navegador comprime
 * toda captura dibujandola en un `<canvas>`, un lienzo solo guarda pixeles, y
 * al recodificar el EXIF entero desaparece antes de salir del movil.
 *
 * Asi que lo que se lea tiene que leerse aqui, del fichero original, antes de
 * comprimir.
 *
 * QUE SE LEE, Y POR QUE SOLO ESO. Dos etiquetas: `Software` y `Make`. NADA MAS,
 * y desde luego no las de GPS. El EXIF de una foto lleva DONDE se hizo, y las
 * capturas se guardan en Firestore — fueron parte de la fuga de #59. La lista
 * es cerrada a proposito: leer el bloque entero y mandarlo "por si acaso" es
 * como se acaba publicando la casa de la gente.
 *
 * ESTO NO ES UNA PRUEBA, ES UNA PISTA. Lo declara el navegador, asi que quien
 * sepa lo que hace no lo manda y se acabo. Por eso la señal que alimenta pesa
 * 15 y no 45 (ver `backend/src/verificacion.js`): sirve para el que edita una
 * captura sin pensar, que es el caso corriente, no para el que va en serio.
 *
 * Y no puede hacer daño a nadie mas: cada quien solo declara sobre su propia
 * subida. Lo peor que puede pasar es que no lo mande, que es exactamente donde
 * estabamos.
 *
 * Este fichero no importa nada a proposito, para que los tests puedan cargarlo
 * sin navegador.
 */

/** Las unicas etiquetas que salen de aqui. */
const ETIQUETAS = {
  0x010f: 'marca',      // Make: "Apple", "samsung"
  0x0131: 'software',   // Software: "Adobe Photoshop 25.0", "Snapseed"
};

/** Cuanto texto se acepta por etiqueta. Mas que esto no es un nombre de programa. */
const MAX_TEXTO = 40;

/**
 * Saca `{ software, marca }` de un JPEG. Devuelve `{}` si no hay EXIF o si la
 * imagen no es un JPEG — un PNG o un WEBP no llevan este bloque.
 *
 * @param {ArrayBuffer} buffer  los primeros bytes del fichero bastan
 */
export function leerExif(buffer) {
  const datos = new DataView(buffer);
  if (datos.byteLength < 4 || datos.getUint16(0) !== 0xffd8) return {};   // no es JPEG

  let i = 2;

  // Los marcadores van seguidos: FFxx, longitud de 2 bytes, contenido.
  while (i + 4 <= datos.byteLength) {
    if (datos.getUint8(i) !== 0xff) return {};   // fuera de sitio: se deja estar

    const marcador = datos.getUint8(i + 1);
    const largo = datos.getUint16(i + 2);
    if (largo < 2) return {};

    // FFE1 es APP1, que es donde vive el EXIF.
    if (marcador === 0xffe1 - 0xff00) {
      return enApp1(datos, i + 4, Math.min(i + 2 + largo, datos.byteLength));
    }
    // FFDA es el principio de los datos de imagen: a partir de ahi no hay nada
    // que buscar y seguir leyendo seria recorrer megas para nada.
    if (marcador === 0xda) return {};

    i += 2 + largo;
  }

  return {};
}

/** El contenido de un APP1, si de verdad es EXIF. */
function enApp1(datos, inicio, fin) {
  // "Exif\0\0"
  const cabecera = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  if (inicio + cabecera.length > fin) return {};
  for (let k = 0; k < cabecera.length; k++) {
    if (datos.getUint8(inicio + k) !== cabecera[k]) return {};
  }

  const tiff = inicio + cabecera.length;
  if (tiff + 8 > fin) return {};

  // "II" (little endian) o "MM" (big endian). Cualquier otra cosa no es TIFF.
  const orden = datos.getUint16(tiff);
  if (orden !== 0x4949 && orden !== 0x4d4d) return {};
  const pequeño = orden === 0x4949;

  if (datos.getUint16(tiff + 2, pequeño) !== 0x002a) return {};

  const ifd0 = tiff + datos.getUint32(tiff + 4, pequeño);
  if (ifd0 + 2 > fin) return {};

  const entradas = datos.getUint16(ifd0, pequeño);
  const salida = {};

  // Un IFD con miles de entradas es basura o un intento de hacernos recorrer el
  // fichero entero. Con las dos primeras decenas sobra: van ordenadas por tag.
  for (let n = 0; n < Math.min(entradas, 64); n++) {
    const entrada = ifd0 + 2 + n * 12;
    if (entrada + 12 > fin) break;

    const nombre = ETIQUETAS[datos.getUint16(entrada, pequeño)];
    if (!nombre) continue;

    // Tipo 2 es ASCII. Cualquier otro no es un nombre de programa.
    if (datos.getUint16(entrada + 2, pequeño) !== 2) continue;

    const largo = datos.getUint32(entrada + 4, pequeño);
    if (!largo || largo > 512) continue;

    // Hasta cuatro bytes caben en el propio hueco; a partir de ahi es un
    // desplazamiento desde el principio del TIFF.
    const donde = largo <= 4 ? entrada + 8 : tiff + datos.getUint32(entrada + 8, pequeño);
    const texto = ascii(datos, donde, Math.min(donde + largo, fin));

    if (texto) salida[nombre] = texto;
  }

  return salida;
}

/** Texto ASCII imprimible, sin el cero final y sin pasarse de largo. */
function ascii(datos, desde, hasta) {
  let salida = '';
  for (let k = desde; k < hasta && salida.length < MAX_TEXTO; k++) {
    const c = datos.getUint8(k);
    if (c === 0) break;
    // Solo imprimible. Un EXIF con caracteres de control dentro no es un nombre
    // de programa, es alguien probando cosas.
    if (c < 0x20 || c > 0x7e) return '';
    salida += String.fromCharCode(c);
  }
  return salida.trim();
}
