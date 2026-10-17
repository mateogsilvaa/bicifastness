/**
 * Compartir: una imagen vertical (1080 x 1920, la de una historia de
 * Instagram) con un trayecto, la temporada o tu puesto en una ruta, para
 * mandarla por WhatsApp, subirla a Instagram o guardarla.
 *
 * Se pinta como SVG con las mismas piezas que el diseño de la tienda
 * (assets/js/tienda-diseno.js): `linea` mide y encoge cada texto para que no
 * se salga y `limpiar` quita lo que no se puede pintar. Despues se pasa a PNG
 * en un <canvas> y se abre el menu de compartir del movil (Web Share con
 * ficheros). Donde no lo hay (escritorio, navegadores viejos), se descarga.
 *
 * No lee nada de la base de datos: cada pantalla le pasa lo que ya tiene.
 */

import { linea, limpiar } from './tienda-diseno.js';
import { el, icono, abrirHoja } from './dom.js';

const W = 1080;
const H = 1920;
const M = 96;
const ANCHO = W - M * 2;
const C = {
  fondo: '#111110', tinta: '#F2F1EE', tinta2: '#A9A7A1', azul: '#1B80E5', azulClaro: '#5AA8F2', lima: '#E8FF3A',
};

// --- Las piezas comunes ------------------------------------------------------------

/** El anillo del logo (la vuelta sin cerrar). */
function anillo(x, y, tam, color, grosor = 2.6) {
  const s = tam / 24;
  return `<g transform="translate(${x} ${y}) scale(${s})"><path d="M12 5 A7 7 0 1 1 5.94 8.5" fill="none" stroke="${color}"`
    + ` stroke-width="${grosor}" stroke-linecap="round"/><circle cx="5.94" cy="8.5" r="${grosor * 0.8}" fill="${color}"/></g>`;
}

/**
 * El marco de todas: fondo, el anillo grande de adorno, la marca arriba y el
 * piloto abajo. Lo importante va entre y=250 y y=1670, lo que no tapa
 * Instagram en una historia.
 */
function marco(rotulo, cuerpo, piloto) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
    + `<rect width="${W}" height="${H}" fill="${C.fondo}"/>`
    + anillo(420, 980, 1100, 'rgba(27,128,229,.16)', 1.1)
    + anillo(M, 256, 72, C.azul)
    + linea('bicifastness', { x: M + 92, y: 312, ancho: 520, max: 50, color: C.tinta, peso: 800 })
    + linea(rotulo, { x: W - M, y: 310, ancho: 360, max: 30, color: C.tinta2, peso: 700, ancla: 'end', mayusculas: true, espaciado: 3 })
    + cuerpo
    + `<rect x="${M}" y="1520" width="${ANCHO}" height="3" fill="${C.tinta2}" opacity=".35"/>`
    + linea(piloto || 'Piloto', { x: M, y: 1600, ancho: 600, max: 52, min: 30, color: C.tinta, peso: 800 })
    + linea('bicifastness.es', { x: W - M, y: 1600, ancho: 330, max: 34, color: C.azulClaro, peso: 700, ancla: 'end' })
    + linea('Madrid es el circuito.', { x: M, y: 1650, ancho: 600, max: 30, color: C.tinta2, peso: 500 })
    + '</svg>';
}

/** Una cifra pequeña con su etiqueta debajo, para la fila de datos. */
function dato(valor, etiqueta, x, y, ancho) {
  return linea(valor, { x, y, ancho, max: 76, min: 40, color: C.tinta, peso: 900 })
    + linea(etiqueta, { x, y: y + 52, ancho, max: 30, color: C.tinta2, peso: 600 });
}

const coma = (n, dec = 1) => Number(n).toFixed(dec).replace('.', ',');
const miles = (n) => Number(n || 0).toLocaleString('es-ES');

// --- Las tres tarjetas -----------------------------------------------------------------

/**
 * Un trayecto verificado.
 * @param {object} d  { piloto, tiempo: "12:29", origen, destino, km, kmh, puntos, fecha: "17 oct 2026" }
 */
export function tarjetaViaje(d) {
  const origen = limpiar(d.origen, 34);
  const destino = limpiar(d.destino, 34);
  const datos = [
    Number.isFinite(d.km) && d.km > 0 ? [coma(d.km), 'km'] : null,
    Number.isFinite(d.kmh) && d.kmh > 0 ? [coma(d.kmh), 'km/h'] : null,
    Number.isFinite(d.puntos) && d.puntos > 0 ? [`+${miles(d.puntos)}`, 'puntos'] : null,
  ].filter(Boolean);
  const col = ANCHO / Math.max(datos.length, 1);
  const cuerpo = linea('Mi tiempo', { x: M, y: 560, ancho: ANCHO, max: 40, color: C.azulClaro, peso: 800, mayusculas: true, espaciado: 6 })
    + linea(d.tiempo || '—', { x: M - 10, y: 860, ancho: ANCHO, max: 330, min: 120, color: C.tinta, peso: 900, espaciado: -8 })
    + (origen ? linea(`${origen} →`, { x: M, y: 990, ancho: ANCHO, max: 58, min: 32, color: C.tinta, peso: 700 }) : '')
    + (destino ? linea(destino, { x: M, y: 1062, ancho: ANCHO, max: 58, min: 32, color: C.tinta, peso: 700 }) : '')
    + datos.map(([v, e], i) => dato(v, e, M + i * col, 1250, col - 24)).join('')
    + (d.fecha ? linea(limpiar(d.fecha, 30), { x: M, y: 1420, ancho: ANCHO, max: 34, color: C.tinta2, peso: 600 }) : '');
  return marco('Trayecto verificado', cuerpo, limpiar(d.piloto, 22));
}

/**
 * La temporada (un mes).
 * @param {object} d  { piloto, mes: "Octubre 2026", puntos, puesto, total, division: "Plata", viajes }
 */
export function tarjetaTemporada(d) {
  const [mes, anio] = String(d.mes || '').split(' ');
  const puesto = Number.isInteger(d.puesto) && d.puesto > 0 ? d.puesto : null;
  const cuerpo = linea('Mi temporada', { x: M, y: 560, ancho: ANCHO, max: 40, color: C.azulClaro, peso: 800, mayusculas: true, espaciado: 6 })
    + linea(limpiar(mes, 12) || 'Este mes', { x: M - 6, y: 760, ancho: ANCHO, max: 210, min: 90, color: C.tinta, peso: 900, mayusculas: true, espaciado: -4 })
    + (anio ? linea(limpiar(anio, 4), { x: M, y: 850, ancho: ANCHO, max: 56, color: C.tinta2, peso: 700 }) : '')
    + linea(miles(d.puntos), { x: M - 6, y: 1110, ancho: ANCHO * 0.7, max: 240, min: 90, color: C.azul, peso: 900, espaciado: -6 })
    + linea('puntos', { x: M, y: 1175, ancho: ANCHO, max: 40, color: C.tinta2, peso: 600 })
    + (puesto ? dato(`${miles(puesto)}.º`, d.total ? `de ${miles(d.total)} en el general` : 'en el general', M, 1330, ANCHO / 2 - 24) : '')
    + (d.division ? dato(limpiar(d.division, 14), 'división', M + ANCHO / 2, 1330, ANCHO / 2 - 24) : '');
  return marco('Temporada', cuerpo, limpiar(d.piloto, 22));
}

/**
 * Tu puesto en una ruta.
 * @param {object} d  { piloto, origen, destino, puesto, total, tiempo: "12:29", km }
 */
export function tarjetaRuta(d) {
  const origen = limpiar(d.origen, 34);
  const destino = limpiar(d.destino, 34);
  const puesto = Number.isInteger(d.puesto) && d.puesto > 0 ? d.puesto : null;
  const cuerpo = linea('Mi puesto en la ruta', { x: M, y: 560, ancho: ANCHO, max: 40, color: C.azulClaro, peso: 800, mayusculas: true, espaciado: 6 })
    + (origen ? linea(`${origen} →`, { x: M, y: 650, ancho: ANCHO, max: 58, min: 32, color: C.tinta, peso: 700 }) : '')
    + (destino ? linea(destino, { x: M, y: 722, ancho: ANCHO, max: 58, min: 32, color: C.tinta, peso: 700 }) : '')
    + linea(puesto ? `${miles(puesto)}.º` : '—', { x: M - 10, y: 1040, ancho: ANCHO, max: 320, min: 120, color: C.azul, peso: 900, espaciado: -8 })
    + linea(d.total ? `de ${miles(d.total)} pilotos` : 'en esta ruta', { x: M, y: 1120, ancho: ANCHO, max: 48, color: C.tinta2, peso: 600 })
    + (d.tiempo ? dato(d.tiempo, 'mi mejor tiempo', M, 1300, ANCHO / 2 - 24) : '')
    + (Number.isFinite(d.km) && d.km > 0 ? dato(coma(d.km), 'km', M + ANCHO / 2, 1300, ANCHO / 2 - 24) : '');
  return marco('Ranking de ruta', cuerpo, limpiar(d.piloto, 22));
}

// --- De SVG a PNG ------------------------------------------------------------------------

let fuente = null;

/**
 * La letra de la web, metida en el SVG: una imagen SVG no ve las fuentes de
 * la pagina, y sin esto saldria en la de reserva del movil.
 */
function fuenteEmbebida() {
  fuente = fuente || fetch('/assets/fonts/archivo-latin.woff2')
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('sin fuente'))))
    .then((buffer) => {
      let binario = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.length; i += 0x8000) binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return `<style>@font-face{font-family:Archivo;src:url(data:font/woff2;base64,${btoa(binario)}) format('woff2');`
        + 'font-weight:100 900;font-stretch:62% 125%}</style>';
    })
    .catch(() => '');
  return fuente;
}

/** El SVG como PNG de 1080 x 1920. */
export async function aPng(svg) {
  const estilo = await fuenteEmbebida();
  const conFuente = svg.replace(/^<svg([^>]*)>/, `<svg$1>${estilo}`);
  const url = URL.createObjectURL(new Blob([conFuente], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const lienzo = document.createElement('canvas');
    lienzo.width = W;
    lienzo.height = H;
    lienzo.getContext('2d').drawImage(img, 0, 0, W, H);
    return await new Promise((ok, mal) => lienzo.toBlob((b) => (b ? ok(b) : mal(new Error('No se ha podido crear la imagen.'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// --- La hoja de compartir --------------------------------------------------------------

/** ¿El navegador sabe compartir ficheros (el menu del movil)? */
function puedeCompartir(fichero) {
  try {
    return Boolean(navigator.canShare && navigator.share && navigator.canShare({ files: [fichero] }));
  } catch {
    return false;
  }
}

function descargar(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { attrs: { href: url, download: nombre } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Abre la hoja con la vista previa y los botones.
 * @param {object} o
 * @param {string} o.svg       la tarjeta (tarjetaViaje, tarjetaTemporada, tarjetaRuta)
 * @param {string} o.fichero   nombre del PNG, sin extension
 * @param {string} o.texto     lo que acompaña a la imagen al compartir
 */
export async function abrirCompartir({ svg, fichero, texto }) {
  const vista = el('div', { clase: 'compartir-vista esqueleto' });
  const compartir = el('button', { clase: 'btn', attrs: { type: 'button', disabled: '' } }, [icono('compartir', 'icono peq'), el('span', { texto: 'Compartir' })]);
  const guardar = el('button', { clase: 'btn secundario', attrs: { type: 'button', disabled: '' } }, [icono('descargar', 'icono peq'), el('span', { texto: 'Guardar imagen' })]);
  const nota = el('p', { clase: 'menor apagado', attrs: { 'aria-live': 'polite' } });
  const { cerrar } = abrirHoja([
    el('h2', { texto: 'Compartir' }),
    vista,
    el('div', { clase: 'compartir-botones' }, [compartir, guardar]),
    nota,
  ], { etiqueta: 'Compartir', clase: 'hoja-compartir dialogo-escritorio' });

  let blob;
  try {
    blob = await aPng(svg);
  } catch (error) {
    vista.classList.remove('esqueleto');
    nota.textContent = error.message || 'No se ha podido crear la imagen.';
    return cerrar;
  }
  const nombre = `${String(fichero || 'bicifastness').replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.png`;
  const archivo = new File([blob], nombre, { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  vista.classList.remove('esqueleto');
  vista.append(el('img', { attrs: { src: url, alt: 'La imagen que vas a compartir' } }));

  const conMenu = puedeCompartir(archivo);
  compartir.classList.toggle('oculto', !conMenu);
  compartir.disabled = false;
  guardar.disabled = false;
  if (!conMenu) {
    guardar.className = 'btn';
    nota.textContent = 'Guárdala y súbela a tu historia o mándala por WhatsApp.';
  }

  compartir.addEventListener('click', async () => {
    try {
      await navigator.share({ files: [archivo], text: texto });
    } catch (error) {
      // Cerrar el menu sin elegir nada no es un error.
      if (error?.name !== 'AbortError') nota.textContent = 'No se ha podido abrir el menú de compartir. Guarda la imagen y súbela tú.';
    }
  });
  guardar.addEventListener('click', () => descargar(blob, nombre));
  return cerrar;
}

/** El boton que abre todo lo anterior. `preparar` devuelve { svg, fichero, texto }. */
export function botonCompartir(preparar, { clase = 'btn secundario', texto = 'Compartir' } = {}) {
  return el('button', {
    clase: `${clase} boton-compartir`,
    attrs: { type: 'button' },
    on: { click: () => abrirCompartir(preparar()) },
  }, [icono('compartir', 'icono peq'), el('span', { texto })]);
}
