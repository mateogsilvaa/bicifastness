/**
 * La captura que espera a que /subir/ la lea.
 *
 * Una captura puede llegar desde cuatro sitios que NO son la pagina de subir:
 * pegandola (Ctrl/⌘+V en cualquier pantalla), arrastrandola sobre la ventana,
 * compartiendola desde Fotos (share_target del manifiesto, que la recibe el
 * service worker) o con el + de la barra, que abre el selector de fotos en la
 * propia pantalla donde estas (03 Subir: "el + abre directamente el selector").
 *
 * En los cuatro casos hay que cambiar de pagina, y un fichero no sobrevive a
 * una navegacion. Se deja aqui, en IndexedDB del propio navegador, y /subir/ lo
 * recoge nada mas cargar. Es local: no sale del movil hasta que se pulsa Subir.
 *
 * `sw.js` escribe en esta misma base con su propia copia de estas dos funciones
 * (un service worker no puede importar modulos de la pagina). Si cambia el
 * nombre de la base o del almacen, hay que cambiarlo en los dos sitios.
 */

export const BASE = 'bf-capturas';
export const ALMACEN = 'pendiente';
const CLAVE = 'actual';

function abrir() {
  return new Promise((resolver, rechazar) => {
    const peticion = indexedDB.open(BASE, 1);
    peticion.onupgradeneeded = () => peticion.result.createObjectStore(ALMACEN);
    peticion.onsuccess = () => resolver(peticion.result);
    peticion.onerror = () => rechazar(peticion.error);
  });
}

/** Guarda una o varias imagenes para /subir/. */
export async function guardarPendiente(ficheros) {
  const lista = [...ficheros].filter((f) => f && /^image\//.test(f.type || 'image/'));
  if (!lista.length) return false;
  const bd = await abrir();
  await new Promise((resolver, rechazar) => {
    const tx = bd.transaction(ALMACEN, 'readwrite');
    tx.objectStore(ALMACEN).put(lista, CLAVE);
    tx.oncomplete = resolver;
    tx.onerror = () => rechazar(tx.error);
  });
  bd.close();
  return true;
}

/** La recoge (y la borra: se lee una sola vez). Devuelve [] si no hay nada. */
export async function tomarPendiente() {
  try {
    const bd = await abrir();
    const lista = await new Promise((resolver, rechazar) => {
      const tx = bd.transaction(ALMACEN, 'readwrite');
      const almacen = tx.objectStore(ALMACEN);
      const peticion = almacen.get(CLAVE);
      peticion.onsuccess = () => { almacen.delete(CLAVE); resolver(peticion.result || []); };
      peticion.onerror = () => rechazar(peticion.error);
    });
    bd.close();
    return Array.isArray(lista) ? lista : [];
  } catch {
    // Sin IndexedDB (algun modo privado) no hay captura pendiente: se elige a
    // mano desde /subir/, que es lo de siempre.
    return [];
  }
}

/** Las imagenes de un evento de pegar o de soltar. */
export function imagenesDe(transferencia) {
  if (!transferencia) return [];
  const desdeFicheros = [...(transferencia.files || [])];
  if (desdeFicheros.length) return desdeFicheros.filter((f) => /^image\//.test(f.type));
  return [...(transferencia.items || [])]
    .filter((i) => i.kind === 'file' && /^image\//.test(i.type))
    .map((i) => i.getAsFile())
    .filter(Boolean);
}
