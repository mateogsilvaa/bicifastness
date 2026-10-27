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
import { redesValidas } from './redes.js';

const claveDe = (nombre) => String(nombre || '').toLowerCase();
const enMemoria = new Map();

/**
 * Lo que lleva puesto un piloto: banner, lema, sus redes y desde cuando esta.
 * `{ banner: null, lema: null, redes: {}, desde: null }` si nada.
 */
export async function leerVitrina(nombre) {
  const clave = claveDe(nombre);
  const vacia = { banner: null, lema: null, redes: {}, desde: null };
  if (!clave) return vacia;
  if (enMemoria.has(clave)) return enMemoria.get(clave);
  let vitrina = vacia;
  try {
    const snap = await getDoc(doc(db, 'vitrinas', clave));
    if (snap.exists()) {
      const d = snap.data();
      // Lo que no este en el catalogo no se pinta: puede ser de una version
      // nueva, o algo que ya no existe.
      vitrina = {
        banner: BANNERS[d.banner] ? d.banner : null,
        lema: LEMAS[d.lema] ? d.lema : null,
        redes: redesValidas(d.redes),
        desde: d.desde || null,
      };
    }
  } catch {
    // Sin red o sin reglas desplegadas: la ficha sale con el banner de serie.
  }
  enMemoria.set(clave, vitrina);
  return vitrina;
}

/**
 * `desde` es la fecha de alta, y las reglas solo dejan copiar la de TU perfil
 * (`usuarios/{uid}.creado`): nadie puede ponerse mas antiguedad de la que tiene.
 */
export async function guardarVitrina(perfil, { banner = null, lema = null, redes = {} }) {
  const clave = claveDe(perfil?.usernameLower || perfil?.username);
  const desde = perfil?.creado?.toDate ? perfil.creado : null;
  const limpias = redesValidas(redes);
  await setDoc(doc(db, 'vitrinas', clave), {
    uid: perfil.uid, banner, lema, redes: limpias, desde, actualizado: serverTimestamp(),
  });
  enMemoria.set(clave, { banner, lema, redes: limpias, desde });
}

let configEnMemoria = null;

/**
 * Como se consigue cada recompensa (`config/recompensas`, que pone la
 * administracion): una lectura por pagina. Sin ella, todo es "a mano".
 */
export async function leerConfigRecompensas() {
  if (configEnMemoria) return configEnMemoria;
  let config = { items: {} };
  try {
    const snap = await getDoc(doc(db, 'config', 'recompensas'));
    if (snap.exists() && snap.data().items && typeof snap.data().items === 'object') config = { items: snap.data().items };
  } catch {
    // Sin red o reglas sin desplegar: se enseña todo como "a mano".
  }
  configEnMemoria = config;
  return config;
}
