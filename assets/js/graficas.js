/**
 * Graficas de barras sencillas para el panel (/admin/metricas/): una serie,
 * un eje, el valor al pasar el dedo o el raton. SVG construido sin innerHTML.
 *
 * Una sola serie a proposito: dos medidas distintas van en dos graficas, no
 * en una con dos ejes.
 */

import { el } from './dom.js';

const SVG = 'http://www.w3.org/2000/svg';
const nodo = (tag, attrs = {}) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

/**
 * @param {Array<{etiqueta: string, valor: number, detalle?: string}>} puntos
 * @param {object} [o]
 * @param {(v: number) => string} [o.formato]  como se escribe un valor
 * @param {number} [o.alto]
 * @param {string} [o.titulo]  para lectores de pantalla
 */
export function barras(puntos, { formato = String, alto = 160, titulo = '' } = {}) {
  const ancho = Math.max(320, puntos.length * 22);
  const pie = 22;
  const max = Math.max(1, ...puntos.map((p) => p.valor || 0));
  const paso = ancho / Math.max(1, puntos.length);
  const grueso = Math.max(4, Math.min(28, paso - 4));
  const svg = nodo('svg', { viewBox: `0 0 ${ancho} ${alto + pie}`, class: 'grafica-svg', role: 'img', 'aria-label': titulo });
  // Linea base y una guia a la mitad, discretas.
  svg.append(nodo('line', { x1: 0, x2: ancho, y1: alto, y2: alto, class: 'grafica-base' }));
  svg.append(nodo('line', { x1: 0, x2: ancho, y1: alto / 2, y2: alto / 2, class: 'grafica-guia' }));
  const consejo = el('div', { clase: 'grafica-consejo oculto', attrs: { role: 'status' } });
  const cada = Math.ceil(puntos.length / 8);
  puntos.forEach((p, i) => {
    const h = p.valor ? Math.max(2, (p.valor / max) * (alto - 14)) : 0;
    const x = i * paso + (paso - grueso) / 2;
    const g = nodo('g', { class: 'grafica-columna', tabindex: 0 });
    // Zona de toque mas grande que la barra.
    g.append(nodo('rect', { x: i * paso, y: 0, width: paso, height: alto, class: 'grafica-toque' }));
    if (h) g.append(nodo('rect', { x, y: alto - h, width: grueso, height: h, rx: Math.min(4, grueso / 2), class: 'grafica-barra' }));
    if (i % cada === 0 || i === puntos.length - 1) {
      // Las de los extremos, pegadas al borde: centradas se salian del dibujo.
      const ancla = i === 0 ? 'start' : i === puntos.length - 1 ? 'end' : 'middle';
      const xt = i === 0 ? i * paso + 1 : i === puntos.length - 1 ? (i + 1) * paso - 1 : i * paso + paso / 2;
      const t = nodo('text', { x: xt, y: alto + 16, class: 'grafica-eje', 'text-anchor': ancla });
      t.textContent = p.etiqueta;
      g.append(t);
    }
    const mostrar = () => {
      consejo.textContent = `${p.detalle || p.etiqueta}: ${formato(p.valor || 0)}`;
      consejo.classList.remove('oculto');
      consejo.style.left = `${Math.min(85, Math.max(5, ((i + 0.5) / puntos.length) * 100))}%`;
    };
    g.addEventListener('pointerenter', mostrar);
    g.addEventListener('focus', mostrar);
    g.addEventListener('click', mostrar);
    svg.append(g);
  });
  svg.addEventListener('pointerleave', () => consejo.classList.add('oculto'));
  return el('div', { clase: 'grafica' }, [el('div', { clase: 'grafica-lienzo' }, [svg]), consejo]);
}
