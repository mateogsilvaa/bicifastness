/**
 * La vitrina: el banner y el lema que lleva puestos cada piloto.
 *
 * Vive en `vitrinas/{nombre}` y no en el perfil, igual que la foto: el perfil
 * es privado, y esto lo tiene que poder leer cualquiera que abra tu ficha. Es
 * UNA lectura al abrir una ficha, y una escritura cuando cambias algo.
 *
 * Lo escribe el propio piloto, pero no con cualquier cosa: las reglas solo
 * dejan un banner o un lema `libre-*` o uno de tu lista de recompensas
 * (`assets/data/recompensas.js`). Quien se lo invente desde la consola se
 * queda con un error, no con el banner.
 */

import { db, doc, getDoc, setDoc, serverTimestamp } from './firebase.js';
import { BANNERS, LEMAS } from '../data/recompensas.js';

const claveDe = (nombre) => String(nombre || '').toLowerCase();
const enMemoria = new Map();

/** Lo que lleva puesto un piloto. `{ banner: null, lema: null }` si nada. */
export async function leerVitrina(nombre) {
  const clave = claveDe(nombre);
  if (!clave) return { banner: null, lema: null };
  if (enMemoria.has(clave)) return enMemoria.get(clave);
  let vitrina = { banner: null, lema: null };
  try {
    const snap = await getDoc(doc(db, 'vitrinas', clave));
    if (snap.exists()) {
      const d = snap.data();
      // Lo que no este en el catalogo no se pinta: puede ser de una version
      // nueva, o algo que ya no existe.
      vitrina = {
        banner: BANNERS[d.banner] ? d.banner : null,
        lema: LEMAS[d.lema] ? d.lema : null,
      };
    }
  } catch {
    // Sin red o sin reglas desplegadas: la ficha sale con el banner de serie.
  }
  enMemoria.set(clave, vitrina);
  return vitrina;
}

export async function guardarVitrina(perfil, { banner = null, lema = null }) {
  const clave = claveDe(perfil?.usernameLower || perfil?.username);
  await setDoc(doc(db, 'vitrinas', clave), {
    uid: perfil.uid, banner, lema, actualizado: serverTimestamp(),
  });
  enMemoria.set(clave, { banner, lema });
}
