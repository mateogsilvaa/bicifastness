/**
 * El mapa de fondo de la portada sin sesion (01 Acceso, 1a).
 *
 * "El mapa real de fondo cuenta el juego sin texto": las estaciones de verdad,
 * en su sitio, con el color del clan que las domina HOY. Nada inventado: las
 * posiciones salen del catalogo que ya viaja con la web (cero lecturas) y los
 * colores del agregado publico del mapa (una lectura, guardada en la sesion).
 * Si todavia no hay clanes, se ven los puntos neutros, que es la verdad.
 *
 * SVG plano y sin Leaflet: es decorado de fondo, no un mapa que se toque, y
 * cargar teselas para eso costaria megas y una peticion a terceros por visita.
 */

import { ESTACIONES } from '../data/estaciones.js';

const NS = 'http://www.w3.org/2000/svg';

// El centro de Madrid, donde hay mas estaciones juntas (el encuadre del diseño).
const CAJA = { la0: 40.395, la1: 40.445, lo0: -3.728, lo1: -3.668 };

const colorSeguro = (c) => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : null);

function nodo(etiqueta, atributos) {
  const n = document.createElementNS(NS, etiqueta);
  for (const [k, v] of Object.entries(atributos)) n.setAttribute(k, String(v));
  return n;
}

/**
 * @param {HTMLElement} contenedor
 * @param {object|null} mapa  el agregado `agregados/mapa`, o null
 */
export function pintarMapaFondo(contenedor, mapa, { w = 390, h = 420 } = {}) {
  const svg = nodo('svg', {
    class: 'mapa-fondo', viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'xMidYMid slice',
    'aria-hidden': 'true', focusable: 'false',
  });

  // Rejilla: siete lineas en cada sentido, como las manzanas de un plano.
  for (let i = 1; i < 8; i++) {
    svg.append(nodo('line', { x1: 0, y1: (h * i) / 8, x2: w, y2: (h * i) / 8 }));
    svg.append(nodo('line', { x1: (w * i) / 8, y1: 0, x2: (w * i) / 8, y2: h }));
  }

  // Misma proporcion que el diseño: se abre la longitud segun el aspecto.
  const midLo = (CAJA.lo0 + CAJA.lo1) / 2;
  const spanLa = CAJA.la1 - CAJA.la0;
  const spanLo = (spanLa * (w / h)) / 0.76;
  const lo0 = midLo - spanLo / 2;

  const estaciones = mapa?.estaciones || {};
  const clanes = mapa?.clanes || {};
  const colorDe = (clanId) => colorSeguro(clanes[clanId]?.color);

  for (const [id, e] of Object.entries(ESTACIONES)) {
    const x = ((e.lon - lo0) / spanLo) * w;
    const y = ((CAJA.la1 - e.lat) / spanLa) * h;
    if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue;

    const entrada = estaciones[id];
    const dueno = entrada?.clan ? colorDe(entrada.clan) : null;
    const lider = entrada?.lider ? colorDe(entrada.lider) : null;

    if (dueno) {
      // Con dueño: punto lleno del color del clan.
      svg.append(nodo('circle', { cx: x, cy: y, r: 4.2, fill: dueno }));
    } else if (entrada?.disputa && lider) {
      // En disputa: anillo del color de quien va primero. Ahi hay algo que hacer.
      svg.append(nodo('circle', { cx: x, cy: y, r: 3.6, class: 'anillo', stroke: lider, 'stroke-width': 1.6 }));
    } else {
      svg.append(nodo('circle', { cx: x, cy: y, r: 3, class: 'neutra' }));
    }
  }

  contenedor.replaceChildren(svg);
}
