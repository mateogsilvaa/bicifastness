'use strict';

/**
 * Revision de nombres de piloto y de clan (#64).
 *
 * POR QUE EXISTE ESTE FICHERO. El proyecto tenia dos piezas escritas para esto
 * —`badwords.contienePalabrasProhibidas` y `util.limpiarTexto`— y no las
 * llamaba nadie: su unico llamante era `src/clanes.js`, que era de la epoca de
 * Cloud Functions y se borro por muerto. O sea que los nombres de piloto y de
 * clan no los miraba nada, y los dos salen en clasificaciones publicas.
 *
 * POR QUE EN EL WORKER Y NO EN LAS REGLAS. Las reglas de Firestore son quien
 * autoriza en este proyecto, pero aqui no llegan:
 *
 *   - no pueden recorrer una lista de 169 palabras
 *   - para los caracteres invisibles harian falta clases Unicode en `matches()`,
 *     y sin emulador no hay forma de comprobar que RE2 las entiende ahi. Si no
 *     las entendiera, la regla rechazaria TODOS los registros
 *
 * El navegador tampoco vale: no es seguridad, cualquiera abre la consola.
 *
 * Asi que lo hace el worker, y por eso esto es una funcion pura — entra un
 * nombre, sale un veredicto — con el mismo reparto que `denuncias.js`,
 * `rachas.js` y `misiones.js`: aqui la decision, alli el leer y el escribir.
 *
 * LO QUE NO HACE: renombrar a nadie. Un filtro por subcadena se equivoca (para
 * eso existe la lista de excepciones de `badwords.js`), y cambiarle el nombre a
 * alguien por un falso positivo es peor que el problema. Lo que sale de aqui va
 * a la cola de moderacion, que ya tiene panel desde #61.
 */

const { limpiarTexto } = require('./util');
const { contienePalabrasProhibidas } = require('./badwords');

/** Largo maximo, el mismo que exigen las reglas al crear el perfil. */
const MAX_PILOTO = 24;
/** Y el de un clan. */
const MAX_CLAN = 28;

/**
 * Revisa un nombre.
 *
 * @param {string} nombre
 * @param {{ambito?: 'piloto'|'clan'}} opciones
 * @returns {{limpio: string, invisibles: boolean, prohibido: boolean,
 *            aceptable: boolean, motivo: string|null}}
 */
function revisar(nombre, { ambito = 'piloto' } = {}) {
  const original = String(nombre ?? '');
  const limpio = limpiarTexto(original, ambito === 'clan' ? MAX_CLAN : MAX_PILOTO);

  // `limpiarTexto` quita controles, espacios de ancho cero y marcas bidi. Si al
  // quitarlas el texto cambia mas alla de los espacios de los bordes, es que
  // llevaba dentro algo que no se ve.
  const invisibles = limpio !== original.trim().slice(0, ambito === 'clan' ? MAX_CLAN : MAX_PILOTO);

  // Se mira sobre el LIMPIO, no sobre el original: si no, meter un espacio de
  // ancho cero en medio de una palabra la esconde del filtro.
  const prohibido = contienePalabrasProhibidas(limpio);

  if (invisibles && prohibido) {
    return { limpio, invisibles, prohibido, aceptable: false, motivo: MOTIVOS.AMBOS };
  }
  if (invisibles) return { limpio, invisibles, prohibido, aceptable: false, motivo: MOTIVOS.INVISIBLES };
  if (prohibido) return { limpio, invisibles, prohibido, aceptable: false, motivo: MOTIVOS.PROHIBIDO };

  return { limpio, invisibles, prohibido, aceptable: true, motivo: null };
}

/** Los motivos, para que el panel y las pruebas hablen el mismo idioma. */
const MOTIVOS = {
  INVISIBLES: 'lleva caracteres invisibles',
  PROHIBIDO: 'contiene una palabra de la lista',
  AMBOS: 'lleva caracteres invisibles y contiene una palabra de la lista',
};

/** El texto que va a la cola de moderacion. Lo lee una persona. */
function explicar(nombre, veredicto, ambito = 'piloto') {
  const que = ambito === 'clan' ? 'El nombre de clan' : 'El nombre de piloto';

  // El nombre se manda LIMPIO. Mandar el original meteria las marcas bidi en el
  // panel, que es justo donde no se quieren: le darian la vuelta al texto que
  // esta leyendo quien revisa.
  return `${que} "${veredicto.limpio}" ${veredicto.motivo}.`
    + (veredicto.invisibles ? ` Tal y como se escribio ocupa ${String(nombre).length} caracteres.` : '');
}

module.exports = { revisar, explicar, MOTIVOS, MAX_PILOTO, MAX_CLAN };
