/**
 * "Te hemos regalado un lema". Para quien ya tenia cuenta antes del reinicio
 * (scripts/borrar-viajes-y-clanes.js le da `estuve-aqui`). Sale una vez por
 * dispositivo, y nunca encima de otro dialogo.
 */

import { el, abrirHoja } from './dom.js';
import { lema } from './perfil-publico.js';

const REGALO = 'estuve-aqui';
const CLAVE = 'bf_regalo_estuve_aqui';

export function avisarRegalo(perfil) {
  if (!(perfil?.recompensas || []).includes(REGALO)) return;
  try { if (localStorage.getItem(CLAVE)) return; } catch { return; }
  if (document.querySelector('[role="dialog"]')) return;
  try { localStorage.setItem(CLAVE, '1'); } catch { /* sale esta vez */ }
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
