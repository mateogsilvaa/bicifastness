/**
 * Foto de perfil, al menor coste posible para la base de datos.
 *
 * - Se recorta y comprime EN EL NAVEGADOR a 128x128 (WebP, o JPEG donde no
 *   haya WebP): entre 4 y 10 KB. Nunca sale de aqui la foto original.
 * - Vive aparte, en `fotos/{nombre}`, y no dentro del perfil: asi los rankings
 *   y la portada no la arrastran en cada lectura, y quien no tiene foto no
 *   cuesta nada.
 * - Cambiarla es UNA escritura. Verla es UNA lectura, y solo en dos sitios: tu
 *   pagina (para traerla a este dispositivo) y la ficha de un piloto al
 *   abrirla. La barra lateral y Hoy tiran de la copia local.
 * - Los rankings siguen con la inicial: una foto por fila serian decenas de
 *   lecturas por pantalla.
 */

import { db, doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp } from './firebase.js';
import { guardarPropia, fotoPropiaLocal } from './foto-local.js';

const LADO = 128;
// Las reglas dicen lo mismo (firestore.rules, `fotos`).
export const MAX_FOTO = 14000;
// La miniatura de los rankings (va en el perfil y en `agregados/fotos-mini`).
const MINI_LADO = 40;
const MAX_MINI = 3000;

/** Recorta al centro, reduce y comprime hasta que quepa. */
export async function prepararFoto(fichero) {
  const mapa = await leerImagen(fichero);
  try {
    return {
      img: comprimir(mapa, [[LADO, 0.8], [LADO, 0.65], [112, 0.6], [96, 0.55]], MAX_FOTO),
      mini: comprimir(mapa, [[MINI_LADO, 0.7], [MINI_LADO, 0.5], [32, 0.5]], MAX_MINI),
    };
  } finally {
    mapa.close?.();
  }
}

async function leerImagen(fichero) {
  if (!fichero || !/^image\//.test(fichero.type)) throw new Error('Elige una imagen.');
  if (fichero.size > 15 * 1024 * 1024) throw new Error('La imagen es demasiado grande.');
  return createImageBitmap(fichero);
}

/** La primera version que cabe, de mas calidad a menos. */
function comprimir(mapa, intentos, maximo) {
  const corte = Math.min(mapa.width, mapa.height);
  for (const [lado, calidad] of intentos) {
    const lienzo = document.createElement('canvas');
    lienzo.width = lado;
    lienzo.height = lado;
    lienzo.getContext('2d').drawImage(mapa, (mapa.width - corte) / 2, (mapa.height - corte) / 2, corte, corte, 0, 0, lado, lado);
    let url = lienzo.toDataURL('image/webp', calidad);
    // Safari antiguo devuelve PNG cuando no sabe hacer WebP: entonces JPEG.
    if (!url.startsWith('data:image/webp')) url = lienzo.toDataURL('image/jpeg', calidad);
    if (url.length <= maximo) return url;
  }
  throw new Error('No se ha podido reducir la imagen lo bastante.');
}

const claveDe = (perfil) => String(perfil?.usernameLower || perfil?.username || '').toLowerCase();

export async function subirFoto(perfil, { img, mini }) {
  await setDoc(doc(db, 'fotos', claveDe(perfil)), { uid: perfil.uid, img, actualizado: serverTimestamp() });
  // La miniatura va al perfil: el worker ya lo lee para los rankings, asi que
  // publicarla alli no le cuesta ninguna lectura mas.
  await updateDoc(doc(db, 'usuarios', perfil.uid), { fotoMini: mini });
  guardarPropia(img);
}

export async function quitarFoto(perfil) {
  await deleteDoc(doc(db, 'fotos', claveDe(perfil)));
  await updateDoc(doc(db, 'usuarios', perfil.uid), { fotoMini: null });
  guardarPropia(null);
}

const enMemoria = new Map();

/**
 * La foto de un piloto por su nombre. Una lectura la primera vez en esta
 * pagina; despues, de memoria. `null` si no tiene.
 */
export async function leerFoto(nombre, { propia = false } = {}) {
  const clave = String(nombre || '').toLowerCase();
  if (!clave) return null;
  if (enMemoria.has(clave)) return enMemoria.get(clave);
  let img = null;
  try {
    const snap = await getDoc(doc(db, 'fotos', clave));
    img = snap.exists() ? snap.data().img || null : null;
  } catch {
    // Sin red o sin permiso: la inicial vale igual.
    img = propia ? fotoPropiaLocal() : null;
  }
  enMemoria.set(clave, img);
  if (propia) guardarPropia(img);
  return img;
}
