'use strict';

/**
 * Filtro de nombres de piloto y de clan.
 *
 * Corrige un fallo de la version anterior: se normalizaba el texto de entrada
 * (minusculas, sin acentos, sin espacios) pero NO la lista de palabras, asi que
 * las 169 entradas con tilde o con espacio ("coño", "hija de puta", "pédé"...)
 * no llegaban a comprobarse nunca. Ahora se normalizan los dos lados.
 */

const LISTA = require('../lib/palabras-prohibidas.json');

/**
 * Palabras corrientes que contienen alguna prohibida como subcadena.
 * Sin esto, el filtro rechaza nombres perfectamente legitimos: "Cassandra" y
 * "Passenger" llevan "ass", "Titan" lleva "tit", "Sextante" lleva "sex".
 */
const EXCEPCIONES = [
  'cassandra', 'cassie', 'passenger', 'passing', 'compass', 'classic', 'assassin',
  'titan', 'titanic', 'title', 'competitivo', 'competition', 'constitucion',
  'sextante', 'sexto', 'sexta', 'essex', 'middlesex',
  'analisis', 'analitica', 'analog', 'canal', 'banal', 'analista',
  'cocktail', 'cockpit', 'peacock', 'shitake',
  'scunthorpe', 'penistone', 'lightwater',
];

/** Minusculas, sin acentos, sin separadores. Se aplica a lista y a entrada. */
function normalizar(texto) {
  return String(texto ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[\s\-_.]+/g, '');
}

// Se normaliza una sola vez al cargar el modulo.
const LISTA_NORMALIZADA = [...new Set(LISTA.map(normalizar))].filter(Boolean);
const EXCEPCIONES_NORMALIZADAS = EXCEPCIONES.map(normalizar);

/**
 * ¿El texto contiene alguna palabra prohibida?
 * Se comprueba por subcadena, para pillar los intentos de camuflaje tipo
 * "p-u-t-a" o "PuTa123".
 */
function contienePalabrasProhibidas(texto) {
  const limpio = normalizar(texto);
  if (!limpio) return false;

  // Si el nombre completo es una excepcion conocida, se deja pasar.
  if (EXCEPCIONES_NORMALIZADAS.some((e) => limpio === e || limpio.includes(e))) {
    // Solo exime si no queda nada mas sospechoso fuera de la excepcion.
    const restante = EXCEPCIONES_NORMALIZADAS.reduce((t, e) => t.split(e).join(''), limpio);
    return LISTA_NORMALIZADA.some((p) => restante.includes(p));
  }

  return LISTA_NORMALIZADA.some((palabra) => limpio.includes(palabra));
}

module.exports = { contienePalabrasProhibidas, normalizar, LISTA_NORMALIZADA };
