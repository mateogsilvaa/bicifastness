/**
 * El "banner" de un clan: su trozo de Madrid. Las estaciones que controla, en
 * su color y con un halo que al juntarse dibuja el territorio, sobre el resto
 * de la red en gris. Sin teselas ni Leaflet: un SVG con las 685 estaciones de
 * `assets/data/estaciones.js`, que la pagina del mapa ya tiene cargadas.
 *
 * El clan elige el fondo: oscuro (como el mapa) o claro.
 */

import { ESTACIONES } from '/assets/data/estaciones.js';
import { colorSeguroClan } from '/assets/js/escudo-clan.js';

const NS = 'http://www.w3.org/2000/svg';
const LAT0 = 40.42;
const K = Math.cos((LAT0 * Math.PI) / 180);
/** El banner es apaisado: lo que se ve de la ciudad, tambien. */
const PROPORCION = 3;
/** Ni un barrio de dos calles: como poco, unos 2 km de ancho. */
const ANCHO_MINIMO = 0.024;

export const TEMAS = { oscuro: { nombre: 'Oscuro' }, claro: { nombre: 'Claro' } };

let puntos = null;
/** Todas las estaciones proyectadas una vez: x hacia el este, y hacia el sur. */
function proyectadas() {
  puntos ||= new Map(Object.entries(ESTACIONES)
    .filter(([, e]) => Number.isFinite(e.lat) && Number.isFinite(e.lon))
    .map(([n, e]) => [n, { x: e.lon * K, y: -e.lat }]));
  return puntos;
}

/** "0102" y "102" son la misma estacion. */
const clave = (n) => String(n).replace(/^0+(?=\d)/, '');

/** El encuadre: lo que importa, con margen y en la proporcion del banner. */
function encuadre(lista) {
  const todos = [...proyectadas().values()];
  const base = lista.length ? lista : todos;
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const p of base) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  let w = Math.max(x1 - x0, ANCHO_MINIMO) * 1.35;
  let h = Math.max(y1 - y0, ANCHO_MINIMO / PROPORCION) * 1.5;
  if (w / h < PROPORCION) w = h * PROPORCION; else h = w / PROPORCION;
  return { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h };
}

function nodo(tipo, attrs) {
  const n = document.createElementNS(NS, tipo);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/**
 * @param {object} o
 * @param {string} o.color  el color del clan
 * @param {'oscuro'|'claro'} [o.tema]
 * @param {Array<string>} [o.suyas]  estaciones que controla
 * @param {Array<string>} [o.foco]   si no controla ninguna: donde mirar (las de quien lo crea)
 */
export function mapaClan({ color, tema = 'oscuro', suyas = [], foco = [] } = {}) {
  const todas = proyectadas();
  const propias = suyas.map(clave).filter((n) => todas.has(n));
  const cerca = propias.length ? [] : foco.map(clave).filter((n) => todas.has(n));
  const v = encuadre((propias.length ? propias : cerca).map((n) => todas.get(n)));
  const tinta = colorSeguroClan(color) || '#8A8F98';

  const svg = nodo('svg', {
    viewBox: `${v.x} ${v.y} ${v.w} ${v.h}`, preserveAspectRatio: 'xMidYMid slice',
    'aria-hidden': 'true', focusable: 'false',
  });
  // Solo lo que cae en el encuadre (con margen), para no pintar 685 puntos fuera.
  const dentro = (p) => p.x > v.x - v.w * 0.1 && p.x < v.x + v.w * 1.1 && p.y > v.y - v.h * 0.3 && p.y < v.y + v.h * 1.3;
  const r = v.w / 260;
  const red = nodo('g', { class: 'red' });
  for (const p of todas.values()) if (dentro(p)) red.append(nodo('circle', { cx: p.x, cy: p.y, r }));
  svg.append(red);

  if (propias.length) {
    const halo = nodo('g', { fill: tinta, 'fill-opacity': '.2' });
    const nucleo = nodo('g', { fill: tinta, class: 'nucleo' });
    for (const n of propias) {
      const p = todas.get(n);
      // Unos 300 m como poco: estaciones vecinas se funden en una mancha.
      halo.append(nodo('circle', { cx: p.x, cy: p.y, r: Math.max(v.w / 30, 0.0034) }));
      nucleo.append(nodo('circle', { cx: p.x, cy: p.y, r: r * 2.4, 'stroke-width': r * 1.1 }));
    }
    svg.append(halo, nucleo);
  } else if (cerca.length) {
    const anillos = nodo('g', { fill: 'none', stroke: tinta, 'stroke-width': r * 1.2 });
    for (const n of cerca) {
      const p = todas.get(n);
      anillos.append(nodo('circle', { cx: p.x, cy: p.y, r: r * 3.2 }));
    }
    svg.append(anillos);
  }

  const caja = document.createElement('div');
  caja.className = `mapa-clan ${TEMAS[tema] ? tema : 'oscuro'}`;
  caja.setAttribute('aria-hidden', 'true');
  caja.append(svg);
  return caja;
}
