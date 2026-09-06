/**
 * Lectura de los documentos agregados, con cache de sesion.
 *
 * Los agregados son lo que el navegador lee en vez de recorrer colecciones: el
 * worker los precalcula y una pantalla pasa de cientos de lecturas a una. Ver
 * `backend/src/agregados.js`.
 *
 * Este modulo existe para que ese "una" sea de verdad una, y no una por
 * pantalla que lo necesite: la cache de sesion (`cache.js`) se la ahorra
 * mientras el dato siga siendo reciente.
 */

import { db, doc, getDoc } from '/assets/js/firebase.js';
import { leerCache, guardarCache } from '/assets/js/cache.js';

/** Agregados ya pedidos en esta carga de pagina. */
const enMemoria = new Map();

/**
 * Trae un agregado. Devuelve `null` si todavia no existe.
 *
 * Que no exista es normal y no es un error: el worker los crea la primera vez
 * que aprueba algo. Ese `null` tambien se cachea, para no volver a preguntar
 * por el en cada pantalla.
 *
 * Lanza si la lectura falla, para que cada pantalla decida que enseñar.
 */
export async function traerAgregado(nombre) {
  if (enMemoria.has(nombre)) return enMemoria.get(nombre);

  const guardado = leerCache(nombre);
  if (guardado !== undefined) {
    enMemoria.set(nombre, guardado);
    return guardado;
  }

  const snap = await getDoc(doc(db, 'agregados', nombre));
  const datos = snap.exists() ? snap.data() : null;

  enMemoria.set(nombre, datos);
  guardarCache(nombre, datos);
  return datos;
}

/**
 * Puesto de un tiempo dentro del ranking de una ruta.
 *
 * Sale del agregado, que ya viene ordenado y con una fila por piloto (solo su
 * mejor marca). Un agregado NO lleva uid — solo va lo que se pinta (#60) —, asi
 * que la fila propia se localiza por la marca. Con un empate sale el mismo
 * puesto que enseña la clasificacion, que es justo lo que queremos: dos
 * pantallas que digan cosas distintas es peor que un empate mal desempatado.
 *
 * Devuelve `{ puesto, total }`, con `puesto` a 0 si no aparece. No aparecer es
 * posible: un agregado se parte en paginas de 200 y aqui solo se mira la
 * primera. En una ruta con mas de 200 pilotos, quien este por debajo del puesto
 * 200 sale sin puesto. Enseñar "—" es preferible a enseñar un numero inventado.
 */
export function puestoPorMarca(agregado, marca) {
  const filas = agregado?.filas || [];
  const total = agregado?.total ?? filas.length;

  const fila = filas.find((f) => f.marca === marca);
  return { puesto: fila?.pos || 0, total };
}
