/**
 * El "banner" de un clan: su trozo de Madrid. Sustituye a assets/js/mapa-clan.js
 * con la MISMA firma (mapaClan({ color, tema, suyas, foco })) + un parametro
 * opcional `vecinas`.
 *
 * Cambios respecto a la version anterior:
 * - Los halos van en un <g opacity> con relleno opaco: al solaparse forman UNA
 *   mancha de territorio, sin zonas mas oscuras donde se cruzan.
 * - Halo mas grande (~450 m) para que las estaciones vecinas se fundan.
 * - Nucleo con borde del color de fondo: se separa del halo.
 * - Vecinas: estaciones de otros clanes en su color, sin halo (se lee la frontera).
 * - Sin territorio: anillo discontinuo + punto en las estaciones de `foco`.
 * - Encuadre mas cerrado y centrado algo por encima (el escudo tapa la parte baja).
 */

import { ESTACIONES } from '/assets/data/estaciones.js';
import { colorSeguroClan } from '/assets/js/escudo-clan.js';

const NS = 'http://www.w3.org/2000/svg';
const K = Math.cos((40.42 * Math.PI) / 180);
const PROPORCION = 2.6;
const ANCHO_MINIMO = 0.03;

export const TEMAS = {
  oscuro: { nombre: 'Oscuro', fondo: '#0E0F10', red: '#2C2E32', halo: 0.26 },
  claro: { nombre: 'Claro', fondo: '#ECEAE4', red: '#CBC7BD', halo: 0.3 },
};

let puntos = null;
function proyectadas() {
  puntos ||= new Map(Object.entries(ESTACIONES)
    .filter(([, e]) => Number.isFinite(e.lat) && Number.isFinite(e.lon))
    .map(([n, e]) => [n, { x: e.lon * K, y: -e.lat }]));
  return puntos;
}
const clave = (n) => String(n).replace(/^0+(?=\d)/, '');

function encuadre(lista) {
  const base = lista.length ? lista : [...proyectadas().values()];
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const p of base) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  let w = Math.max(x1 - x0, ANCHO_MINIMO) * 1.3;
  let h = Math.max(y1 - y0, ANCHO_MINIMO / PROPORCION) * 1.45;
  if (w / h < PROPORCION) w = h * PROPORCION; else h = w / PROPORCION;
  // Centro un 8 % por encima: abajo a la izquierda va el escudo.
  return { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h * 0.58, w, h };
}

function nodo(tipo, attrs) {
  const n = document.createElementNS(NS, tipo);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

/**
 * @param {object} o
 * @param {string} o.color
 * @param {'oscuro'|'claro'} [o.tema]
 * @param {Array<string>} [o.suyas]   estaciones que controla
 * @param {Array<string>} [o.foco]    si no controla ninguna: las habituales de quien lo crea
 * @param {number} [o.ancho]  ancho en px donde se pinta (390 móvil, 720 escritorio): limita el tamaño del halo
 * @param {Array<{n:string,color:string}>} [o.vecinas]  estaciones de otros clanes dentro del encuadre
 */
export function mapaClan({ color, tema = 'oscuro', suyas = [], foco = [], vecinas = [], ancho: caja0 = 390 } = {}) {
  const T = TEMAS[tema] || TEMAS.oscuro;
  const todas = proyectadas();
  const propias = suyas.map(clave).filter((n) => todas.has(n));
  const cerca = propias.length ? [] : foco.map(clave).filter((n) => todas.has(n));
  const v = encuadre((propias.length ? propias : cerca).map((n) => todas.get(n)));
  const tinta = colorSeguroClan(color) || '#8A8F98';
  // 1 px a 390 de ancho; en cabeceras más anchas los tamaños no crecen más de 1,25×
  const u = (v.w / 390) * Math.min(1, 1.25 * 390 / Math.max(390, caja0 || 390));

  const svg = nodo('svg', { viewBox: `${v.x} ${v.y} ${v.w} ${v.h}`, preserveAspectRatio: 'xMidYMid slice', 'aria-hidden': 'true', focusable: 'false' });
  svg.append(nodo('rect', { x: v.x - v.w, y: v.y - v.h, width: v.w * 3, height: v.h * 3, fill: T.fondo }));

  const dentro = (p) => p.x > v.x - v.w * 0.1 && p.x < v.x + v.w * 1.1 && p.y > v.y - v.h * 0.3 && p.y < v.y + v.h * 1.3;
  const ocupadas = new Set([...propias, ...vecinas.map((x) => clave(x.n))]);

  const red = nodo('g', { fill: T.red });
  for (const [n, p] of todas) if (dentro(p) && !ocupadas.has(n)) red.append(nodo('circle', { cx: p.x, cy: p.y, r: 2 * u }));
  svg.append(red);

  const otras = nodo('g', { opacity: tema === 'claro' ? 0.6 : 0.75 });
  for (const { n, color: c } of vecinas) {
    const p = todas.get(clave(n));
    if (p && dentro(p)) otras.append(nodo('circle', { cx: p.x, cy: p.y, r: 2.6 * u, fill: colorSeguroClan(c) || T.red }));
  }
  svg.append(otras);

  if (propias.length) {
    const halo = nodo('g', { fill: tinta, opacity: T.halo });
    const nucleo = nodo('g', { fill: tinta, stroke: T.fondo, 'stroke-width': 1.4 * u });
    for (const n of propias) {
      const p = todas.get(n);
      halo.append(nodo('circle', { cx: p.x, cy: p.y, r: Math.max(24 * u, 0.0045) }));
      nucleo.append(nodo('circle', { cx: p.x, cy: p.y, r: 3.6 * u }));
    }
    svg.append(halo, nucleo);
  } else if (cerca.length) {
    const g = nodo('g', {});
    for (const n of cerca) {
      const p = todas.get(n);
      g.append(nodo('circle', { cx: p.x, cy: p.y, r: 9 * u, fill: 'none', stroke: tinta, 'stroke-width': 1.6 * u, 'stroke-dasharray': `${3 * u} ${3 * u}` }));
      g.append(nodo('circle', { cx: p.x, cy: p.y, r: 3.6 * u, fill: tinta }));
    }
    svg.append(g);
  }

  const caja = document.createElement('div');
  caja.className = `mapa-clan ${TEMAS[tema] ? tema : 'oscuro'}`;
  caja.setAttribute('aria-hidden', 'true');
  caja.append(svg);
  return caja;
}
