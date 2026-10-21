/**
 * El boton "Compartir" de las pantallas, sin cargar compartir.js hasta que se
 * pulsa.
 *
 * compartir.js (el dibujo de la imagen y la hoja) solo hace falta si alguien
 * comparte, que es una vez de cada muchas. Importarlo arriba lo metia en el
 * arranque de Ranking, Tu y el veredicto: un modulo mas que descargar antes de
 * pintar nada, y en cada despliegue (cambia la version) se vuelve a bajar.
 */

import { el, icono } from './dom.js';

let modulo = null;
const cargar = () => {
  modulo = modulo || import('./compartir.js');
  return modulo;
};

/** `preparar()` devuelve { tipo, datos, extra, piloto }. */
export function botonCompartir(preparar, { clase = '', texto: rotulo = 'Compartir' } = {}) {
  const boton = el('button', {
    clase: `boton-compartir ${clase}`.trim(),
    attrs: { type: 'button', 'aria-label': rotulo },
    on: {
      click: async () => {
        boton.disabled = true;
        try {
          (await cargar()).abrirCompartir(preparar());
        } finally {
          boton.disabled = false;
        }
      },
      // Al acercar el dedo o el raton se va bajando, para que el clic no espere.
      pointerenter: () => { cargar(); },
      touchstart: () => { cargar(); },
    },
  }, [icono('compartir'), el('span', { texto: 'Compartir' })]);
  return boton;
}
