/**
 * 3a · La hoja de subida, sobre la pantalla en la que se esta.
 *
 * Sale solo las dos primeras veces que se toca el +: despues el + abre el
 * selector de fotos directamente (ui.js). Elegir o pegar deja la imagen en
 * `captura-pendiente.js` y /subir/ la lee al cargar, igual que el resto de
 * atajos.
 */

import { el, icono, abrirHoja } from '/assets/js/dom.js';
import { auth, db, doc, getDoc } from '/assets/js/firebase.js';
import { LIMITES_CLIENTE } from '/assets/js/precheck.js';
import { guardarPendiente } from '/assets/js/captura-pendiente.js';
import { atajoCompartir } from '/assets/js/ui.js';

const CUPO = LIMITES_CLIENTE.VIAJES_POR_DIA;

async function irASubirCon(ficheros) {
  if (await guardarPendiente(ficheros)) window.location.href = '/subir/?pendiente=1';
}

/** Solo si el permiso ya esta dado: preguntar por el portapapeles al abrir no. */
async function imagenCopiada() {
  try {
    const permiso = await navigator.permissions?.query({ name: 'clipboard-read' });
    if (permiso?.state !== 'granted') return [];
    const ficheros = [];
    for (const item of await navigator.clipboard.read()) {
      const tipo = item.types.find((t) => t.startsWith('image/'));
      if (tipo) ficheros.push(new File([await item.getType(tipo)], 'captura.png', { type: tipo }));
    }
    return ficheros;
  } catch {
    return [];
  }
}

/** Los que lleva hoy, del contador de `cupos/{uid}` (el mismo que usa /subir/). */
async function usadosHoy() {
  const uid = auth.currentUser?.uid;
  if (!uid) return null;
  try {
    const snap = await getDoc(doc(db, 'cupos', uid));
    const previo = snap.exists() ? snap.data() : null;
    return previo && previo.dia === Math.floor(Date.now() / 86400000) ? previo.viajes || 0 : 0;
  } catch {
    return null;
  }
}

export function abrirHojaSubir() {
  const cuenta = el('span', { texto: `Puntúan ${CUPO} hoy` });
  usadosHoy().then((n) => {
    if (n !== null) cuenta.textContent = `Puntúan ${CUPO} hoy · ${n} ${n === 1 ? 'usado' : 'usados'}`;
  });

  const selector = el('input', {
    clase: 'solo-lectores',
    attrs: { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/*', multiple: '', tabindex: '-1', 'aria-hidden': 'true' },
  });
  selector.addEventListener('change', () => { if (selector.files?.length) irASubirCon([...selector.files]); });

  const pegar = el('button', { clase: 'subir-opcion tonal oculto', attrs: { type: 'button' } },
    [icono('pegar'), el('span', {}, [el('strong', { texto: 'Pegar' }), el('small', { texto: 'Hay una imagen copiada' })])]);
  let copiadas = [];
  imagenCopiada().then((f) => { copiadas = f; pegar.classList.toggle('oculto', !f.length); });
  pegar.addEventListener('click', () => { if (copiadas.length) irASubirCon(copiadas); });

  abrirHoja([
    el('div', { clase: 'subir-inicio-cabeza' }, [el('h2', { texto: 'Subir trayecto' }), cuenta]),
    el('div', { clase: 'subir-opciones' }, [
      el('button', {
        clase: 'subir-opcion azul', attrs: { type: 'button' },
        on: { click: () => selector.click() },
      }, [icono('imagen'), el('strong', { texto: 'Elegir captura' })]),
      pegar,
    ]),
    el('div', { clase: 'subir-ejemplo' }, [
      el('img', { attrs: { src: '/images/ejemplo.jpg', alt: 'Captura de ejemplo de la app de BiciMAD', loading: 'lazy' } }),
      el('div', { clase: 'subir-ejemplo-texto' }, [
        el('strong', { texto: 'La que sale al acabar' }),
        el('span', { clase: 'bien' }, [icono('check', 'icono peq'), el('span', { texto: 'Entera, sin recortar' })]),
        el('span', { clase: 'bien' }, [icono('check', 'icono peq'), el('span', { texto: 'Varios viajes a la vez, vale' })]),
        el('span', { clase: 'mal' }, [icono('cerrar', 'icono peq'), el('span', { texto: 'Reenviada por WhatsApp' })]),
      ]),
    ]),
    atajoCompartir() ? el('span', { clase: 'subir-truco' }, [icono('compartir', 'icono peq'), el('span', { texto: atajoCompartir().texto })]) : null,
    selector,
  ], { etiqueta: 'Subir trayecto', clase: 'hoja-subir' });
}
