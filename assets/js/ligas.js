// Las ligas (divisiones) en el navegador: nombres, el calendario de dos
// semanas y el emblema de cada una.
//
// GEMELO de `backend/src/divisiones.js` en lo que importa: `ANCLA_LIGA` y
// `DIAS_POR_LIGA`. Un test los compara. Si solo se movieran alli, la web diria
// "cambia el lunes 12" y el cambio caeria el 19.

import { diaMadrid, sumarDias } from './dia.js';

export const NIVELES = ['hierro', 'bronce', 'plata', 'oro', 'platino', 'leyenda'];

export const NOMBRES = {
  hierro: 'Hierro', bronce: 'Bronce', plata: 'Plata', oro: 'Oro', platino: 'Platino', leyenda: 'Leyenda',
};

/** Cuantos dias dura una liga. */
export const DIAS_POR_LIGA = 14;

/** El lunes en que empezo la primera liga de dos semanas. */
export const ANCLA_LIGA = '2026-10-05';

const diasEntre = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);

/** El lunes en que empezo la liga en juego el dia dado. */
export function inicioLiga(dia = diaMadrid()) {
  const vueltas = Math.floor(diasEntre(ANCLA_LIGA, dia) / DIAS_POR_LIGA);
  return sumarDias(ANCLA_LIGA, vueltas * DIAS_POR_LIGA);
}

/** El lunes en que se cierra la liga en juego (y empieza la siguiente). */
export function proximoCambio(dia = diaMadrid()) {
  return sumarDias(inicioLiga(dia), DIAS_POR_LIGA);
}

/** Dias que quedan hasta el cambio de liga. */
export function diasHastaCambio(dia = diaMadrid()) {
  return diasEntre(dia, proximoCambio(dia));
}

/** "lunes 19 oct" */
export function fechaCorta(dia) {
  return new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(`${dia}T12:00:00Z`)).replace(',', '').replace('.', '');
}

/** "el lunes 19 oct", "mañana", "el lunes que viene". Para frases del tipo "suben …". */
export function cuandoCambia(dia = diaMadrid()) {
  const quedan = diasHastaCambio(dia);
  if (quedan <= 1) return 'mañana';
  return `el ${fechaCorta(proximoCambio(dia))}`;
}

/** "Hierro · grupo 2" */
export function nombreGrupo(clave) {
  const [nivel, n] = String(clave).split('-');
  return `${NOMBRES[nivel] || nivel} · grupo ${n}`;
}

const SVG = 'http://www.w3.org/2000/svg';
function nodo(tipo, attrs) {
  const n = document.createElementNS(SVG, tipo);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/**
 * Emblema de una liga: un escudo de su color con tantas marcas como niveles
 * ha subido (Hierro, una barra; Leyenda, la estrella). Que se distingan por la
 * FORMA y no solo por el color es lo que los hace legibles a quien no ve bien
 * los colores.
 *
 * @param {string} nivel
 * @param {{tamano?: number, apagado?: boolean}} opciones
 */
export function emblemaLiga(nivel, { tamano = 32, apagado = false } = {}) {
  const i = Math.max(0, NIVELES.indexOf(nivel));
  const svg = nodo('svg', {
    viewBox: '0 0 32 36', width: tamano, height: Math.round(tamano * 1.125),
    class: `emblema-liga liga-${NIVELES[i]}${apagado ? ' apagado' : ''}`,
    'aria-hidden': 'true', focusable: 'false',
  });
  svg.append(nodo('path', { class: 'escudo', d: 'M16 1.5 29 6v11.2c0 8-5.6 14.3-13 17.3C8.6 31.5 3 25.2 3 17.2V6z' }));
  svg.append(nodo('path', { class: 'brillo', d: 'M16 4.6 26 8.1v9.1c0 6.4-4.3 11.6-10 14.2z' }));
  const marca = { class: 'marca', fill: 'none', 'stroke-width': 2.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  if (i === 0) {
    svg.append(nodo('path', { ...marca, d: 'M11 18h10' }));
  } else if (i === 5) {
    svg.append(nodo('path', { class: 'marca relleno', d: 'm16 9.5 2.2 4.6 5 .6-3.7 3.4 1 5-4.5-2.5-4.5 2.5 1-5-3.7-3.4 5-.6z' }));
  } else {
    const cuantas = Math.min(i, 3);
    const y0 = 18 - (cuantas - 1) * 2.8;
    for (let k = 0; k < cuantas; k++) {
      const y = y0 + k * 5.6;
      svg.append(nodo('path', { ...marca, d: `M10.5 ${y - 2.2} 16 ${y + 2} 21.5 ${y - 2.2}` }));
    }
    if (i === 4) svg.append(nodo('circle', { class: 'marca relleno', cx: 16, cy: 8.6, r: 1.9 }));
  }
  return svg;
}
