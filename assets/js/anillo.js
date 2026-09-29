/**
 * El anillo de la semana (02 Hoy): siete tramos, de lunes a domingo, y el
 * numero de la racha dentro.
 *
 * Cada tramo dice una cosa y solo una: hecho, hoy (pendiente), escudo gastado,
 * perdido o todavia por llegar. Se calcula con lo que ya trae el perfil
 * (`racha`, `ultimoDiaActivo`, `ultimoCierreRacha`), sin leer ni un viaje.
 */

import { el } from '/assets/js/dom.js';
import { diaMadrid } from '/assets/js/dia.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const R = 52;
const C = 2 * Math.PI * R;
const TRAMO = C / 7;
const HUECO = (C * 5) / 360;

/** 'YYYY-MM-DD' de un instante, en Madrid. */
const dia = (ms) => diaMadrid(new Date(ms));

/** Suma dias a una fecha 'YYYY-MM-DD' (a mediodia UTC, sin lios de horario). */
export function sumarDias(fecha, n) {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Las siete fechas de esta semana, de lunes a domingo, en Madrid. */
export function semanaDe(hoy = diaMadrid()) {
  const d = new Date(`${hoy}T12:00:00Z`);
  const desdeLunes = (d.getUTCDay() + 6) % 7;
  const lunes = sumarDias(hoy, -desdeLunes);
  return Array.from({ length: 7 }, (_, i) => sumarDias(lunes, i));
}

/** ¿Ha salido hoy? `ultimoDiaActivo` es el inicio del dia en Madrid, en ms. */
export function activoHoy(perfil, hoy = diaMadrid()) {
  return Boolean(perfil?.ultimoDiaActivo) && dia(perfil.ultimoDiaActivo) === hoy;
}

/**
 * El estado de cada dia de la semana.
 * @returns {Array<'hecho'|'hoy'|'escudo'|'perdido'|'futuro'>}
 */
export function estadosSemana(perfil, hoy = diaMadrid()) {
  const racha = perfil?.racha || 0;
  const ultimo = perfil?.ultimoDiaActivo ? dia(perfil.ultimoDiaActivo) : null;
  const cierre = perfil?.ultimoCierreRacha;

  // Los dias de la racha viva: del ultimo dia activo hacia atras, tantos como
  // diga la racha. Un dia cubierto por escudo no suma racha, asi que se marca
  // aparte y se corre el tramo.
  const hechos = new Set();
  const escudos = new Set();
  if (cierre?.dia === hoy && cierre.escudosGastados > 0 && !cierre.rota) {
    for (let i = 1; i <= cierre.escudosGastados; i++) escudos.add(sumarDias(hoy, -i));
  }
  if (ultimo && racha > 0) {
    let cursor = ultimo;
    let quedan = racha;
    while (quedan > 0) {
      if (escudos.has(cursor)) { cursor = sumarDias(cursor, -1); continue; }
      hechos.add(cursor);
      quedan--;
      cursor = sumarDias(cursor, -1);
    }
  }

  return semanaDe(hoy).map((f) => {
    if (f > hoy) return 'futuro';
    if (hechos.has(f)) return 'hecho';
    if (escudos.has(f)) return 'escudo';
    if (f === hoy) return 'hoy';
    return 'perdido';
  });
}

/**
 * El SVG del anillo.
 * @param {Array<string>} estados  los de `estadosSemana`
 * @param {object} [opciones]
 * @param {number} [opciones.tam]    lado en px
 * @param {string} [opciones.numero] lo que va dentro
 * @param {string} [opciones.pie]    "dias", debajo del numero
 * @param {string} [opciones.variante] 'normal' | 'riesgo' | 'salvado'
 */
export function anilloSemana(estados, { tam = 120, numero = '', pie = '', variante = 'normal' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120');
  svg.setAttribute('width', String(tam));
  svg.setAttribute('height', String(tam));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'anillo-svg');

  estados.forEach((estado, i) => {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', '60');
    c.setAttribute('cy', '60');
    c.setAttribute('r', String(R));
    c.setAttribute('stroke-width', tam < 100 ? '12' : '10');
    c.setAttribute('stroke-dasharray', `${TRAMO - HUECO} ${C - TRAMO + HUECO}`);
    c.setAttribute('stroke-dashoffset', String(-(TRAMO * i + HUECO / 2)));
    c.setAttribute('class', `tramo ${estado}${variante === 'riesgo' && estado === 'hoy' ? ' riesgo' : ''}`);
    svg.append(c);
  });

  return el('div', {
    clase: `anillo ${variante} ${tam < 80 ? 'peque' : tam < 100 ? 'medio' : 'grande'}`,
    estilo: { width: `${tam}px`, height: `${tam}px` },
  }, [
    svg,
    el('div', { clase: 'anillo-centro' }, [
      el('span', { clase: 'anillo-numero', texto: numero }),
      pie ? el('span', { clase: 'anillo-pie', texto: pie }) : null,
    ]),
  ]);
}
