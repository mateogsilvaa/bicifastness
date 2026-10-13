/**
 * El diseño de los productos de la tienda, como SVG.
 *
 * El MISMO codigo pinta la vista previa en el navegador y el fichero que se
 * imprime: el worker lo carga, pasa el SVG por sharp y lo sube. Asi lo que la
 * persona ve al comprar es lo que le llega, sin una plantilla en un servicio
 * externo que se pueda desincronizar.
 *
 * Sin imports a proposito: lo carga tambien Node (backend/src/tienda.js), y el
 * emblema del clan llega ya resuelto (`clan.emblemaD`, de
 * assets/data/emblemas-clan.js).
 *
 * Los textos vienen de la base de datos (el nombre de piloto, el del clan, las
 * estaciones) y pueden ser cualquier cosa. Por eso todo pasa por `limpiar`
 * (fuera emojis y caracteres raros, con tope de largo) y por `linea`, que
 * encoge la letra hasta que cabe y, si ni al minimo cabe, recorta con "…" y
 * ademas fija `textLength`: un texto NUNCA se sale de su hueco.
 */

/** Medidas de impresion (px a 300 ppp) y la caja de dibujo de cada producto. */
export const PRODUCTOS_DISENO = {
  camiseta: {
    nombre: 'Camiseta',
    // Area de impresion frontal de 12x16 pulgadas a 300 ppp.
    ancho: 3600, alto: 4800, caja: [1200, 1600],
    // Se imprime sobre camiseta negra: tinta clara, fondo transparente.
    tinta: '#F2F1EE', tinta2: '#B3B2AE', acento: '#E8FF3A', fondo: null,
  },
  taza: {
    nombre: 'Taza',
    // Taza de 11 oz: la vuelta entera, 9 x 3,5 pulgadas a 300 ppp.
    ancho: 2700, alto: 1050, caja: [2700, 1050],
    tinta: '#111110', tinta2: '#55534D', acento: '#1B80E5', fondo: '#FFFFFF',
  },
};

/** Lo largo que puede ser cada texto antes de recortarlo, en caracteres. */
export const LARGOS = { nombre: 22, clan: 26, estacion: 34 };

/**
 * Texto apto para imprimir: normalizado, sin emojis ni caracteres de control
 * (la imprenta no tiene esas fuentes y saldrian cuadraditos), espacios
 * colapsados y como mucho `max` caracteres, con "…" si se corta.
 */
export function limpiar(texto, max = 30) {
  const limpio = String(texto ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N} .,:;'’·\-_/#&()!?+→]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const letras = [...limpio];
  return letras.length > max ? `${letras.slice(0, max - 1).join('').trimEnd()}…` : limpio;
}

/** Para meter texto en el SVG sin que pueda cerrar etiquetas ni atributos. */
export function escaparXml(texto) {
  return String(texto ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[c]);
}

/**
 * Ancho aproximado de un texto, en unidades de la letra (x tamaño). Por lo
 * alto a proposito: la imprenta no tiene Archivo y usa una de reserva, que
 * puede ser mas ancha. Mejor que sobre hueco a que falte.
 */
export function anchoEstimado(texto, tam, peso = 800) {
  let unidades = 0;
  for (const c of String(texto)) {
    if (/[MWmw@]/.test(c)) unidades += 0.95;
    else if (/[il1.,:;'’|!·]/.test(c)) unidades += 0.32;
    else if (c === ' ') unidades += 0.3;
    else if (/[\p{Lu}]/u.test(c)) unidades += 0.74;
    else if (/\p{N}/u.test(c)) unidades += 0.64;
    else unidades += 0.6;
  }
  // La negrita gorda (900) abre bastante mas que la normal.
  return unidades * tam * (peso >= 900 ? 1.14 : 1);
}

/**
 * Una linea de texto que cabe en `ancho`: encoge la letra de `max` a `min` y,
 * si ni asi, recorta. `textLength` es el seguro final: si la estimacion se
 * queda corta, el renderizador aprieta la linea en vez de desbordarla.
 */
export function linea(texto, {
  x, y, ancho, max, min = Math.round(max * 0.45), peso = 800, color, ancla = 'start',
  familia = "Archivo, 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif", espaciado = 0, mayusculas = false,
}) {
  let t = mayusculas ? String(texto).toUpperCase() : String(texto);
  // El espaciado entre letras va en unidades del dibujo, no de la letra.
  const medir = (cadena, tam) => anchoEstimado(cadena, tam, peso) + espaciado * Math.max(0, [...cadena].length - 1);
  let tam = max;
  if (medir(t, tam) > ancho) {
    const huecos = espaciado * Math.max(0, [...t].length - 1);
    tam = Math.max(min, Math.floor((ancho - huecos) / anchoEstimado(t, 1, peso)));
  }
  while (medir(t, tam) > ancho && [...t].length > 2) {
    t = `${[...t].slice(0, -2).join('').trimEnd()}…`;
  }
  const estimado = medir(t, tam);
  const ajuste = estimado > ancho * 0.8
    ? ` textLength="${Math.round(Math.min(estimado, ancho))}" lengthAdjust="spacingAndGlyphs"` : '';
  return `<text x="${x}" y="${y}" font-family="${escaparXml(familia)}" font-size="${tam}" font-weight="${peso}"`
    + ` fill="${color}" text-anchor="${ancla}" letter-spacing="${espaciado}"${ajuste}>${escaparXml(t)}</text>`;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

/** El escudo del clan: cuadrado redondeado de su color con el emblema o las siglas. */
function escudo(clan, { x, y, tam }) {
  const color = COLOR.test(String(clan?.color || '')) ? clan.color : '#5B6470';
  const radio = Math.round(tam * 0.27);
  const fondo = `<rect x="${x}" y="${y}" width="${tam}" height="${tam}" rx="${radio}" fill="${color}"/>`;
  if (clan?.emblemaD && /^[MmLlHhVvCcSsQqTtAaZz0-9 .,\-]+$/.test(clan.emblemaD)) {
    const escala = (tam * 0.62) / 24;
    const dx = x + tam * 0.19;
    const dy = y + tam * 0.19;
    return `${fondo}<g transform="translate(${dx} ${dy}) scale(${escala})" fill="none" stroke="#FFFFFF"`
      + ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${clan.emblemaD}"/></g>`;
  }
  const siglas = limpiar(clan?.texto || '', 3).replace('…', '');
  return fondo + linea(siglas, {
    x: x + tam / 2, y: y + tam * 0.64, ancho: tam * 0.8, max: Math.round(tam * 0.42), color: '#FFFFFF', ancla: 'middle', peso: 900,
  });
}

/** El anillo del logo, en la tinta del producto. */
function logo(x, y, tam, color) {
  const s = tam / 24;
  return `<g transform="translate(${x} ${y}) scale(${s})"><path d="M12 5 A7 7 0 1 1 5.94 8.5" fill="none" stroke="${color}"`
    + ` stroke-width="2.6" stroke-linecap="round"/><circle cx="5.94" cy="8.5" r="2.1" fill="${color}"/></g>`;
}

/**
 * Los datos ya preparados para pintar. Todo lo que no se sepa se queda fuera
 * del diseño en vez de salir como "undefined".
 *
 * @param {object} d
 * @param {string} d.nombre      nombre de piloto
 * @param {object} [d.clan]      { nombre, color, emblemaD, texto }
 * @param {string} [d.tiempo]    "12:29"
 * @param {string} [d.origen]    nombre de la estacion de salida
 * @param {string} [d.destino]   nombre de la estacion de llegada
 * @param {number} [d.puesto]    puesto en el ranking general
 * @param {number} [d.total]     pilotos en el ranking
 * @param {string} [d.temporada] "Temporada 2026"
 */
export function prepararDatos(d = {}) {
  const puesto = Number.isInteger(d.puesto) && d.puesto > 0 ? d.puesto : null;
  return {
    nombre: limpiar(d.nombre, LARGOS.nombre) || 'Piloto',
    clan: d.clan && limpiar(d.clan.nombre, LARGOS.clan)
      ? { ...d.clan, nombre: limpiar(d.clan.nombre, LARGOS.clan) } : null,
    tiempo: /^\d{1,3}:\d{2}(:\d{2})?$/.test(String(d.tiempo || '')) ? d.tiempo : null,
    origen: limpiar(d.origen, LARGOS.estacion),
    destino: limpiar(d.destino, LARGOS.estacion),
    puesto,
    total: puesto && Number.isInteger(d.total) && d.total >= puesto ? d.total : null,
    temporada: limpiar(d.temporada || `Madrid · ${new Date().getFullYear()}`, 30),
  };
}

function camiseta(p, d) {
  const [W] = p.caja;
  const m = 90;
  const ancho = W - m * 2;
  const partes = [
    logo(m, 70, 120, p.acento),
    linea('bicifastness', { x: m + 140, y: 152, ancho: 600, max: 64, color: p.tinta, peso: 800 }),
    linea(d.temporada, { x: W - m, y: 152, ancho: 380, max: 36, color: p.tinta2, peso: 600, ancla: 'end' }),
    linea(d.nombre, { x: m, y: 400, ancho, max: 190, min: 70, color: p.tinta, peso: 900, espaciado: -2 }),
  ];
  // Con todos los bloques puestos, el mas bajo acaba en 1500 de 1600. Si
  // falta alguno, lo de debajo sube.
  let y = 470;
  if (d.clan) {
    partes.push(escudo(d.clan, { x: m, y, tam: 150 }));
    partes.push(linea(d.clan.nombre, { x: m + 185, y: y + 100, ancho: ancho - 185, max: 72, color: p.tinta2, peso: 700 }));
    y += 190;
  }
  y += 40;
  if (d.tiempo) {
    partes.push(linea('Mejor tiempo', { x: m, y: y + 50, ancho, max: 46, color: p.acento, peso: 800, mayusculas: true, espaciado: 6 }));
    // El tiempo no se recorta nunca: encoge lo que haga falta.
    partes.push(linea(d.tiempo, { x: m - 8, y: y + 300, ancho, max: 300, min: 60, color: p.tinta, peso: 900, espaciado: -6 }));
    y += 340;
    if (d.origen && d.destino) {
      partes.push(linea(`${d.origen} →`, { x: m, y: y + 60, ancho, max: 60, min: 32, color: p.tinta2, peso: 700 }));
      partes.push(linea(d.destino, { x: m, y: y + 135, ancho, max: 60, min: 32, color: p.tinta2, peso: 700 }));
      y += 170;
    }
  }
  if (d.puesto) {
    y += 50;
    partes.push(`<rect x="${m}" y="${y}" width="${ancho}" height="4" fill="${p.tinta2}" opacity=".5"/>`);
    partes.push(linea(`#${d.puesto}`, { x: m, y: y + 150, ancho, max: 140, min: 60, color: p.acento, peso: 900 }));
    partes.push(linea(d.total ? `de ${d.total} en el ranking general` : 'en el ranking general', {
      x: m, y: y + 235, ancho, max: 56, min: 30, color: p.tinta, peso: 700,
    }));
  }
  return partes.join('');
}

function taza(p, d) {
  const [W, H] = p.caja;
  // La taza enseña dos caras: el piloto a un lado del asa y la marca al otro.
  const mitad = W / 2;
  const m = 110;
  const partes = [
    logo(m, 110, 110, p.acento),
    linea('bicifastness', { x: m + 130, y: 190, ancho: mitad - m - 160, max: 60, color: p.tinta, peso: 800 }),
    linea(d.nombre, { x: m, y: 470, ancho: mitad - m * 2, max: 170, min: 64, color: p.tinta, peso: 900, espaciado: -2 }),
  ];
  if (d.clan) {
    partes.push(escudo(d.clan, { x: m, y: 560, tam: 130 }));
    partes.push(linea(d.clan.nombre, { x: m + 160, y: 650, ancho: mitad - m * 2 - 160, max: 62, color: p.tinta2, peso: 700 }));
  }
  if (d.puesto) {
    partes.push(linea(d.total ? `#${d.puesto} de ${d.total} · ranking general` : `#${d.puesto} en el ranking general`, {
      x: m, y: H - 150, ancho: mitad - m * 2, max: 56, min: 30, color: p.acento, peso: 800,
    }));
  }
  const x2 = mitad + m;
  const ancho2 = mitad - m * 2;
  if (d.tiempo) {
    partes.push(linea('Mejor tiempo', { x: x2, y: 230, ancho: ancho2, max: 46, color: p.acento, peso: 800, mayusculas: true, espaciado: 6 }));
    partes.push(linea(d.tiempo, { x: x2 - 6, y: 560, ancho: ancho2, max: 330, min: 60, color: p.tinta, peso: 900, espaciado: -6 }));
    if (d.origen && d.destino) {
      partes.push(linea(`${d.origen} →`, { x: x2, y: 690, ancho: ancho2, max: 60, min: 30, color: p.tinta2, peso: 700 }));
      partes.push(linea(d.destino, { x: x2, y: 770, ancho: ancho2, max: 60, min: 30, color: p.tinta2, peso: 700 }));
    }
  } else {
    partes.push(linea('Pedaleando Madrid', { x: x2, y: 560, ancho: ancho2, max: 150, min: 60, color: p.tinta, peso: 900 }));
  }
  partes.push(linea(d.temporada, { x: x2, y: H - 150, ancho: ancho2, max: 44, color: p.tinta2, peso: 600 }));
  return partes.join('');
}

/**
 * El diseño completo de un producto.
 *
 * @param {'camiseta'|'taza'} producto
 * @param {object} datos  ver `prepararDatos`
 * @param {object} [opciones]
 * @param {boolean} [opciones.muestra]  con el color de la prenda de fondo, para la vista previa
 * @returns {string} SVG
 */
export function disenoSVG(producto, datos, { muestra = false } = {}) {
  const p = PRODUCTOS_DISENO[producto];
  if (!p) throw new Error(`Producto desconocido: ${producto}`);
  const d = prepararDatos(datos);
  const [W, H] = p.caja;
  const fondo = p.fondo || (muestra ? '#18191B' : null);
  const cuerpo = producto === 'taza' ? taza(p, d) : camiseta(p, d);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${p.ancho}" height="${p.alto}">`
    + (fondo ? `<rect width="${W}" height="${H}" fill="${fondo}"/>` : '')
    + `${cuerpo}</svg>`;
}
