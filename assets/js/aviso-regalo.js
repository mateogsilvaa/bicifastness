/**
 * "Te hemos regalado un lema". Para quien ya tenia cuenta antes del reinicio
 * (scripts/borrar-viajes-y-clanes.js le da `estuve-aqui`), y nunca encima de
 * otro dialogo.
 *
 * UNA VEZ POR CUENTA, no por dispositivo. Antes solo se apuntaba en este
 * navegador (localStorage), y volvia a salir en la app instalada, en otro
 * movil o al borrar datos, aunque ya se lo hubiera puesto. Ahora se marca en
 * el perfil (`usuarios/{uid}.regaloVisto`, que las reglas dejan escribir solo a
 * `true`) en cuanto se abre, igual que el tutorial. Y a quien ya lo lleva
 * puesto no se le ofrece.
 */

import { el, abrirHoja } from './dom.js';
import { db, doc, updateDoc } from './firebase.js';
import { lema } from './perfil-publico.js';
import { leerVitrina } from './vitrina.js';

const REGALO = 'estuve-aqui';
const CLAVE = 'bf_regalo_estuve_aqui';

const vistoAqui = () => { try { return localStorage.getItem(CLAVE) !== null; } catch { return false; } };

function marcarVisto(uid) {
  try { localStorage.setItem(CLAVE, '1'); } catch { /* modo privado */ }
  if (uid) updateDoc(doc(db, 'usuarios', uid), { regaloVisto: true }).catch(() => { /* queda la marca local */ });
}

export async function avisarRegalo(perfil, uid) {
  if (!(perfil?.recompensas || []).includes(REGALO)) return;
  if (perfil.regaloVisto === true) return;
  // Visto en este dispositivo pero no en el perfil (de antes del cambio): se
  // sube la marca para que no salga en los demas.
  if (vistoAqui()) { marcarVisto(uid); return; }
  // Ya se lo ha puesto: no hay nada que ofrecer.
  if ((await leerVitrina(perfil.username)).lema === REGALO) { marcarVisto(uid); return; }
  if (document.querySelector('[role="dialog"]')) return;
  marcarVisto(uid);
  let cerrar = null;
  ({ cerrar } = abrirHoja([
    el('h2', { texto: 'Empezamos de cero, y tú estabas aquí' }),
    el('p', { clase: 'apagado', texto: 'BiciFastness arranca de nuevo: rankings, viajes y clanes vuelven a cero. Por haber estado desde el principio, te regalamos un lema para tu perfil:' }),
    el('p', { clase: 'regalo-lema' }, [lema(REGALO)]),
    el('div', { clase: 'dos-botones-hoja' }, [
      el('a', { clase: 'btn', texto: 'Ponérmelo', attrs: { href: '/yo/#perfil' } }),
      el('button', { clase: 'btn plano', texto: 'Luego', attrs: { type: 'button' }, on: { click: () => cerrar() } }),
    ]),
  ], { etiqueta: 'Te hemos regalado un lema' }));
}
