/**
 * El escudo de un clan: su color, y dentro un emblema o sus siglas.
 *
 * Todo sale de aqui para que el clan se vea igual en el mapa, en el ranking, en
 * Hoy y en su propia ficha. Los datos llegan de la base de datos (los escribe
 * el lider), asi que se validan antes de pintarlos: un emblema que no esta en
 * la lista o unas siglas raras se quedan en las iniciales del nombre.
 */

import { el } from './dom.js';
import { PALABRAS_PROHIBIDAS } from '../data/palabras-prohibidas.js';
import { EMBLEMAS, piezasEscudo } from '../data/emblemas-clan.js';

// Las reglas admiten exactamente estas claves (firestore.rules, `clanes`).
export { EMBLEMAS, FORMAS, PATRONES, COLORES_CLAN, COLORES_PRINCIPALES } from '../data/emblemas-clan.js';

const NS = 'http://www.w3.org/2000/svg';

export const MAX_LEMA = 80;
/** La presentacion de la ficha del clan y su barrio (firestore.rules, `clanes`). */
export const MAX_PRESENTACION = 200;
export const MAX_ZONA = 30;

const COLOR = /^#[0-9a-fA-F]{6}$/;
const SIGLAS = /^[A-Z0-9ÑÁÉÍÓÚ]{1,3}$/;

export const colorSeguroClan = (c) => (typeof c === 'string' && COLOR.test(c) ? c : null);

export function inicialesDe(nombre) {
  return String(nombre || '').split(/\s+/).filter(Boolean).map((p) => [...p][0]).join('').slice(0, 3).toUpperCase();
}

/** Lo que va dentro del escudo: `{emblema}` o `{texto}`. */
export function contenidoEscudo(clan = {}) {
  if (clan.emblema && EMBLEMAS[clan.emblema]) return { emblema: clan.emblema };
  const siglas = typeof clan.siglas === 'string' && SIGLAS.test(clan.siglas) ? clan.siglas : null;
  return { texto: siglas || inicialesDe(clan.nombre) };
}

export function svgEmblema(clave, tam = 20) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(tam));
  svg.setAttribute('height', String(tam));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', EMBLEMAS[clave].d);
  svg.append(path);
  return svg;
}

let instancias = 0;

function nodo(tipo, attrs = {}) {
  const n = document.createElementNS(NS, tipo);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  return n;
}

/**
 * El escudo como un SVG de 100 x 100 (16 Clanes, EscudoClan): la silueta
 * recorta el color, el patron del segundo color y un brillo; encima, el
 * emblema o las siglas con un halo para que se lean sobre cualquier color.
 *
 * `clase` se suma a la del sitio donde va (`escudo-clan`, `escudo-clan grande`,
 * `insignia-clan`…): el tamaño lo pone el CSS de cada sitio.
 *
 * @param {object} [o]
 * @param {string|null} [o.aro]  un aro alrededor del color de fondo (la ficha)
 * @param {number} [o.grosorAro]
 */
export function escudoClan(clan = {}, { clase = 'escudo-clan', aro = null, grosorAro = 10 } = {}) {
  const e = piezasEscudo(clan, inicialesDe(clan.nombre));
  const id = `escudo-${++instancias}`;
  const svg = nodo('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true', focusable: 'false' });
  const recorte = nodo('clipPath', { id });
  recorte.append(nodo('path', { d: e.silueta }));
  const defs = nodo('defs');
  defs.append(recorte);
  svg.append(defs);
  if (aro) svg.append(nodo('path', { d: e.silueta, fill: 'none', stroke: aro, 'stroke-width': grosorAro, 'stroke-linejoin': 'round' }));

  const dentro = nodo('g', { 'clip-path': `url(#${id})` });
  dentro.append(nodo('rect', { width: 100, height: 100, fill: e.c1 }));
  if (e.patron) dentro.append(nodo('path', { d: e.patron, fill: e.c2 }));
  if (e.aro) dentro.append(nodo('path', { d: e.silueta, fill: 'none', stroke: e.c2, 'stroke-width': 16 }));
  dentro.append(nodo('path', { d: 'M0 0 H100 V44 C70 36 30 36 0 44 Z', fill: '#FFFFFF', opacity: '.1' }));
  svg.append(dentro);

  if (e.emblema) {
    const g = nodo('g', { transform: e.transformEmblema });
    const trazo = { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    g.append(nodo('path', { d: e.emblema, stroke: e.halo, 'stroke-width': 5.4, ...trazo }));
    g.append(nodo('path', { d: e.emblema, stroke: e.tinta, 'stroke-width': 2.3, ...trazo }));
    svg.append(g);
  } else if (e.siglas) {
    const t = nodo('text', {
      x: 50, y: e.ySiglas, 'text-anchor': 'middle', fill: e.tinta, stroke: e.halo, 'stroke-width': 5,
      'paint-order': 'stroke', class: 'siglas-escudo', 'font-size': e.tamSiglas,
    });
    t.textContent = e.siglas;
    svg.append(t);
  }

  return el('span', { clase, attrs: { title: clan.nombre || null } }, [svg]);
}

/** El lema que se publica: texto plano, sin enlaces y con tope. */
export function lemaSeguro(texto, tope = MAX_LEMA) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim().slice(0, tope);
  return /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|es|net|org|io|me|ly|link|xyz|info|app|gg|co|tk|ru|cat|eu)\b)/i.test(t) ? '' : t;
}

const normalizar = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
let prohibidas = null;

/**
 * ¿Lleva el lema una palabra de la lista? Palabra a palabra, como el nombre de
 * piloto en la portada. El worker lo vuelve a mirar al publicarlo.
 */
export function contienePalabrasProhibidas(texto) {
  prohibidas ||= new Set(PALABRAS_PROHIBIDAS.map(normalizar));
  const limpio = normalizar(texto);
  const palabras = limpio.split(/[^a-z0-9ñ]+/).filter(Boolean);
  return palabras.some((p) => prohibidas.has(p))
    || [...prohibidas].some((f) => f.includes(' ') && limpio.includes(f));
}
