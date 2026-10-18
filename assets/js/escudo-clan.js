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
import { EMBLEMAS, FORMAS, fondoEscudo } from '../data/emblemas-clan.js';

// Las reglas admiten exactamente estas claves (firestore.rules, `clanes`).
export { EMBLEMAS, FORMAS, PATRONES, COLORES_CLAN, fondoEscudo } from '../data/emblemas-clan.js';

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

/**
 * El escudo listo para pintar. `clase` se suma a la del sitio donde va
 * (`escudo-clan`, `escudo-clan grande`, `insignia-clan`…).
 */
export function escudoClan(clan = {}, { clase = 'escudo-clan', tam = 18 } = {}) {
  const { emblema, texto } = contenidoEscudo(clan);
  const forma = FORMAS[clan.forma] && clan.forma !== 'cuadro' ? ` forma-${clan.forma}` : '';
  return el('span', {
    clase: `${clase}${emblema ? ' con-emblema' : ''}${forma}`,
    estilo: { background: fondoEscudo(clan) },
    texto: emblema ? undefined : texto,
    attrs: { title: clan.nombre || null },
  }, emblema ? [svgEmblema(emblema, tam)] : []);
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
