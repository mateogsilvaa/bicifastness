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

const NS = 'http://www.w3.org/2000/svg';

/** Las reglas admiten exactamente estas claves (firestore.rules, `clanes`). */
export const EMBLEMAS = {
  rayo: { nombre: 'Rayo', d: 'M13 2 4 14h7l-1 8 9-12h-7z' },
  llama: { nombre: 'Llama', d: 'M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3 0-4 1-6 1-9z' },
  corona: { nombre: 'Corona', d: 'M3 18h18M4 8l4 4 4-7 4 7 4-4-2 10H6z' },
  estrella: { nombre: 'Estrella', d: 'm12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z' },
  montana: { nombre: 'Montaña', d: 'm2 20 7-12 4 6 3-4 6 10z' },
  rueda: { nombre: 'Rueda', d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 6v6m-3-3h6M12 12l4-4m-4 4-4 4' },
  ola: { nombre: 'Ola', d: 'M2 15c3 0 3-3 6-3s3 3 6 3 3-3 6-3M2 20c3 0 3-3 6-3s3 3 6 3 3-3 6-3M10 9c0-3 3-5 6-5' },
  diana: { nombre: 'Diana', d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 4a1 1 0 1 0 0 2 1 1 0 0 0 0-2z' },
  flecha: { nombre: 'Flecha', d: 'M4 20 20 4m0 0h-8m8 0v8' },
  escudo: { nombre: 'Escudo', d: 'M12 3 4 6v6c0 5 4 8 8 9 4-1 8-4 8-9V6z' },
  calavera: { nombre: 'Calavera', d: 'M12 3a8 8 0 0 0-8 8c0 3 2 5 3 6v3h10v-3c1-1 3-3 3-6a8 8 0 0 0-8-8zM9 11h.01M15 11h.01M10 20v-2m4 2v-2' },
  oso: { nombre: 'Oso', d: 'M7 4a3 3 0 1 0 0 6M17 4a3 3 0 1 1 0 6M12 7a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm-2 7h.01M14 14h.01M11 17h2' },
};

/** 16 colores con buen contraste con el blanco del emblema. */
export const COLORES_CLAN = [
  '#FF5A1F', '#E23D8C', '#13A89E', '#8B5CF6', '#E0A800', '#3D8B37', '#8A5A3C', '#5B6470',
  '#D7263D', '#1B80E5', '#0B7A75', '#6D28D9', '#C2410C', '#4D7C0F', '#BE185D', '#111110',
];

export const MAX_LEMA = 80;

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
  return el('span', {
    clase: `${clase}${emblema ? ' con-emblema' : ''}`,
    estilo: { background: colorSeguroClan(clan.color) || 'var(--tinta-3)' },
    texto: emblema ? undefined : texto,
    attrs: { title: clan.nombre || null },
  }, emblema ? [svgEmblema(emblema, tam)] : []);
}

/** El lema que se publica: texto plano, sin enlaces y con tope. */
export function lemaSeguro(texto) {
  const t = String(texto || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEMA);
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
