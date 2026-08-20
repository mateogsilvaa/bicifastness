'use strict';

/**
 * Distancia recorrida en un trayecto, que es el dato del que cuelgan el modo
 * Fondo y todo el calculo de velocidad (ver docs/JUEGO.md).
 *
 * El usuario NO la declara: se deduce del par de estaciones. Eso es
 * deliberado, porque significa que anadir distancia y velocidad al juego no
 * abre superficie nueva de fraude.
 *
 * Tres fuentes, en orden:
 *
 *   1. `lib/distancias.json`  ruta ciclable real, precalculada con OSRM por
 *                             `scripts/build-distancias.js`
 *   2. cache en Firestore     pares que resolvio el worker sobre la marcha
 *   3. estimacion             linea recta por FACTOR_CALLEJERO
 *
 * La estimacion existia ya en `verificacion.js` y sirve para lo que fue
 * pensada: descartar imposibles fisicos. Para PUNTUAR se queda corta, porque el
 * 1,35 es un factor fijo y el error se dispara justo donde hay un obstaculo
 * grande de por medio: dos estaciones a los lados del Retiro o del Manzanares
 * estan cerca en linea recta y lejos en bici. Ahi el usuario nota que los
 * kilometros que le contamos no son los que ha hecho.
 *
 * Por eso todo trayecto resuelto por estimacion queda marcado con
 * `estimada: true`, y eso viaja hasta el documento del viaje.
 */

const { buscarEstacion, normalizarEstacion, distanciaMetros } = require('./util');
const { FISICA } = require('./config');

// La tabla es opcional: hasta que alguien lance el script de generacion no
// existe, y el sistema tiene que seguir funcionando con la estimacion.
let TABLA = {};
try {
  TABLA = require('../lib/distancias.json');
} catch {
  // Sin tabla precalculada. No es un error: se degrada a estimacion.
}

/** Clave de la tabla. Direccional, igual que los ids de ruta del proyecto. */
function clave(origen, destino) {
  return `${normalizarEstacion(origen)}-${normalizarEstacion(destino)}`;
}

/**
 * Distancia estimada: linea recta corregida por el factor de trama urbana.
 * Devuelve null si falta alguna coordenada.
 */
function estimar(origen, destino) {
  const a = buscarEstacion(origen);
  const b = buscarEstacion(destino);
  if (!a || !b) return null;
  return Math.round(distanciaMetros(a, b) * FISICA.FACTOR_CALLEJERO);
}

/**
 * Resuelve la distancia sin salir a la red ni tocar Firestore.
 *
 * @returns {{metros: number, estimada: boolean, fuente: string}|null}
 */
function resolver(origen, destino) {
  const precalculada = TABLA[clave(origen, destino)];
  if (Number.isFinite(precalculada)) {
    return { metros: precalculada, estimada: false, fuente: 'tabla' };
  }

  const estimada = estimar(origen, destino);
  if (estimada === null) return null;

  return { metros: estimada, estimada: true, fuente: 'estimacion' };
}

/**
 * Igual que `resolver`, pero mirando antes una cache externa (Firestore) y
 * guardando en ella lo que resuelva.
 *
 * La cache se inyecta en vez de importar Firestore aqui para que este modulo
 * se pueda probar sin levantar nada.
 *
 * @param {{leer: (ruta: string) => Promise<number|null>,
 *          escribir: (ruta: string, metros: number) => Promise<void>}} [cache]
 */
async function resolverConCache(origen, destino, cache) {
  const ruta = clave(origen, destino);

  const precalculada = TABLA[ruta];
  if (Number.isFinite(precalculada)) {
    return { metros: precalculada, estimada: false, fuente: 'tabla' };
  }

  if (cache) {
    try {
      const guardada = await cache.leer(ruta);
      if (Number.isFinite(guardada)) {
        return { metros: guardada, estimada: false, fuente: 'cache' };
      }
    } catch (err) {
      // Que la cache falle no puede tumbar la verificacion de un viaje.
      console.warn(`No se ha podido leer la distancia de ${ruta}:`, err.message);
    }
  }

  const estimada = estimar(origen, destino);
  if (estimada === null) return null;

  return { metros: estimada, estimada: true, fuente: 'estimacion' };
}

/** Velocidad media en km/h. null si falta algun dato. */
function velocidadKmh(metros, segundos) {
  if (!metros || !segundos) return null;
  return (metros / segundos) * 3.6;
}

/** Cuantos pares hay precalculados. Para el panel y los tests. */
function cobertura() {
  return Object.keys(TABLA).length;
}

module.exports = {
  clave,
  estimar,
  resolver,
  resolverConCache,
  velocidadKmh,
  cobertura,
  // Solo para pruebas: permite inyectar una tabla sin tocar el disco.
  _usarTabla: (tabla) => { TABLA = tabla; },
};
