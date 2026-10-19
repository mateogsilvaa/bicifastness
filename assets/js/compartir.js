/**
 * Compartir: genera la imagen en el navegador (canvas, sin servidor) y la
 * comparte con la Web Share API. Referencia visual: 17 Compartir.dc.html.
 *
 *   import { abrirCompartir } from '/assets/js/compartir.js';
 *   abrirCompartir({ tipo: 'ruta', datos: {...} });   // abre la hoja (17a)
 *
 * O directamente:
 *   const blob = await generarImagen({ tipo, formato, tema, datos });
 *   await compartir({ blob, texto, url });
 *
 * Sin dependencias. Respeta la CSP (sin inline). Fuente: Archivo autoalojada.
 *
 * Diseño: 17 Compartir (Claude Design). La hoja se construye con `el()` y no
 * con innerHTML, y los avisos van por el toast de la app (`avisar`).
 */

import { el, avisar } from './dom.js';

export const FORMATOS = {
  historia: { w: 1080, h: 1920, nombre: 'Historia', para: 'Instagram, estados de WhatsApp, TikTok' },
  mensaje: { w: 1200, h: 630, nombre: 'Mensaje', para: 'WhatsApp, Telegram, X, vista previa de enlace' },
  cuadrado: { w: 1080, h: 1080, nombre: 'Cuadrado', para: 'Publicación, Strava, grupos' },
};

export const TEMAS = {
  azul: { box: 'rgba(0,0,0,.16)', bg: '#1B80E5', ink: '#FFFFFF', ink2: 'rgba(255,255,255,.82)', big: '#FFFFFF', arc: '#3F95EA', tile: '#FFFFFF', tileInk: '#1B80E5', tagBg: '#FFFFFF', tagInk: '#1466C2', line: 'rgba(255,255,255,.4)' },
  oscuro: { box: '#1C1D1F', bg: '#111110', ink: '#F2F1EE', ink2: '#B3B2AE', big: '#5AA8F2', arc: '#1A1B1D', tile: '#1B80E5', tileInk: '#FFFFFF', tagBg: '#1B80E5', tagInk: '#FFFFFF', line: '#2D2E31' },
  claro: { box: '#FFFFFF', bg: '#F3F1EC', ink: '#111110', ink2: '#55534D', big: '#1466C2', arc: '#E9E6DF', tile: '#1B80E5', tileInk: '#FFFFFF', tagBg: '#111110', tagInk: '#FFFFFF', line: '#D6D2C8' },
};

const fmtMin = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const n = (x, d = 0) => Number(x).toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
const ord = (x) => `${n(x)}.º`;
const BASE = 'https://bicifastness.es';

/**
 * De los datos de la app al contenido de la tarjeta + texto + enlace.
 * Cada tipo recibe lo que ya tiene la pantalla desde la que se abre.
 */
export const TIPOS = {
  ruta: {
    nombre: 'Tiempo en ruta',
    tarjeta: (d) => ({ tag: 'Mi tiempo', eye: `${d.origen} → ${d.destino}`, tit: d.puesto ? `${ord(d.puesto)} de ${n(d.total)} pilotos` : 'Trayecto verificado', big: fmtMin(d.segundos), sub: d.faltaPodio ? `a ${d.faltaPodio} s del podio` : (d.puesto && d.puesto <= 3 ? 'en el podio' : ''), stats: [[`${n(d.km || 0, 1)} km`, 'distancia'], [n(d.kmh || 0, 1), 'km/h de media'], d.record ? [fmtMin(d.record), 'récord'] : [`+${n(d.puntos || 0)}`, 'puntos']] }),
    texto: (d) => `${fmtMin(d.segundos)} de ${d.origen} a ${d.destino}.${d.puesto ? ` ${ord(d.puesto)} de ${n(d.total)}.` : ''} ¿Quién me baja?`,
    url: (d) => `${BASE}/clasificacion/?ruta=${d.rutaId}`,
  },
  record: {
    nombre: 'Récord',
    tarjeta: (d) => ({ tag: 'Récord', eye: 'Nuevo récord de ruta', tit: `${d.origen} → ${d.destino}`, big: fmtMin(d.segundos), sub: d.mejora ? `${d.mejora} s menos que el anterior` : 'primer tiempo de la ruta', stats: [[`${n(d.km, 1)} km`, 'distancia'], [n(d.kmh, 1), 'km/h de media'], [n(d.pilotos), 'pilotos la hacen']] }),
    texto: (d) => `Récord de ${d.origen} a ${d.destino}: ${fmtMin(d.segundos)}. A ver cuánto dura.`,
    url: (d) => `${BASE}/clasificacion/?ruta=${d.rutaId}`,
  },
  posicion: {
    nombre: 'Puesto',
    tarjeta: (d) => ({ tag: 'Ranking', eye: `${d.ambito} · ${d.modo}`, tit: d.cambio > 0 ? `Subo ${d.cambio} puestos esta semana` : 'Mi puesto hoy', big: ord(d.puesto), sub: `de ${n(d.total)} pilotos`, barra: true, stats: [[n(d.rating), 'BiciRating'], [`+${n(d.hoy)}`, 'hoy'], [`Top ${Math.max(1, Math.round(d.puesto / d.total * 100))} %`, `de ${d.ambito}`]] }),
    texto: (d) => `Voy ${ord(d.puesto)} de ${n(d.total)} en ${d.ambito}. Súbete tú también.`,
    url: (d) => `${BASE}/clasificacion/?piloto=${encodeURIComponent(d.piloto || '')}`,
  },
  temporada: {
    nombre: 'Temporada',
    tarjeta: (d) => ({ tag: 'Temporada', eye: `Mi ${d.mes} en BiciMAD`, tit: 'Esta temporada he hecho', big: `${n(d.puntos)} pts`, sub: [`${n(d.km)} km`, `${n(d.trayectos)} trayectos`, d.puesto ? `${ord(d.puesto)} de Madrid` : null].filter(Boolean).join(' · '), escala: 0.78,
      mejor: d.mejorViaje && { t: 'Mi viaje con más puntos', r: `${d.mejorViaje.origen} → ${d.mejorViaje.destino}`, v: `+${n(d.mejorViaje.puntos)}`, i: `${fmtMin(d.mejorViaje.segundos)} · ${n(d.mejorViaje.km, 1)} km · ${n(d.mejorViaje.kmh, 1)} km/h` },
      stats: [[`${n(d.km)} km`, 'recorridos'], [`${n(d.racha)} días`, 'mejor racha'], [n(d.records), 'récords']] }),
    texto: (d) => `Esta temporada he hecho ${n(d.puntos)} puntos y ${n(d.km)} km en BiciMAD.${d.mejorViaje ? ` Mi mejor viaje: ${d.mejorViaje.origen} → ${d.mejorViaje.destino}, +${n(d.mejorViaje.puntos)}.` : ''}`,
    url: (d) => `${BASE}/clasificacion/?piloto=${encodeURIComponent(d.piloto || '')}`,
  },
  liga: {
    nombre: 'Liga',
    tarjeta: (d) => ({ tag: 'Liga', eye: `Semana ${d.semana} · grupo ${d.grupo}`, tit: d.sube ? `Subo a ${d.ligaNueva}` : d.baja ? `Bajo a ${d.ligaNueva}` : `Sigo en ${d.liga}`, big: ord(d.puesto), sub: `de 30 en ${d.liga}`, img: `/images/divisiones/${(d.sube || d.baja ? d.ligaNueva : d.liga).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')}-oscuro.svg`, stats: [[n(d.puntos), 'pts de la semana'], [`${d.dias}/7`, 'días pedaleados'], [`${n(d.km)} km`, 'en la semana']] }),
    texto: (d) => d.sube ? `Subo a ${d.ligaNueva} en bicifastness.` : `${ord(d.puesto)} de mi grupo en ${d.liga}.`,
    url: (d) => `${BASE}/clasificacion/?piloto=${encodeURIComponent(d.piloto || '')}`,
  },
  racha: {
    nombre: 'Racha',
    tarjeta: (d) => ({ tag: 'Racha', eye: `Cada día en bici desde el ${d.desde}`, tit: 'Sin fallar ni uno', big: `${n(d.dias)} días`, sub: `seguidos · ×${n(d.mult, 2)} en puntos`, stats: [[n(d.escudos), 'escudos'], [n(d.trayectos), 'trayectos'], [n(d.mejor), 'mejor racha']] }),
    texto: (d) => `${n(d.dias)} días seguidos yendo en BiciMAD.`,
    url: (d) => `${BASE}/clasificacion/?piloto=${encodeURIComponent(d.piloto || '')}`,
  },
};

/* ---------------- Dibujo ---------------- */

const fuente = (px, peso = 800, ancho = 100) => `${ancho === 100 ? '' : `${ancho}% `}${peso} ${px}px Archivo, system-ui, sans-serif`;
// font-stretch en canvas: ctx.fontStretch ('ultra-condensed'…). Archivo 62 % ≈ 'extra-condensed'.
const STRETCH = { 62: 'extra-condensed', 68: 'condensed', 86: 'semi-condensed', 100: 'normal', 112: 'semi-expanded' };

function texto(ctx, t, x, y, { px, peso = 800, ancho = 100, color, align = 'left', base = 'alphabetic', max } = {}) {
  ctx.font = fuente(px, peso);
  if ('fontStretch' in ctx) ctx.fontStretch = STRETCH[ancho] || 'normal';
  ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = base;
  let s = String(t);
  if (max) while (ctx.measureText(s).width > max && s.length > 1) s = s.slice(0, -2) + '…';
  ctx.fillText(s, x, y);
  return ctx.measureText(s).width;
}

function ajustar(ctx, t, max, px, peso, ancho) {
  // baja el tamaño hasta que quepa
  let p = px;
  for (; p > px * 0.5; p -= 4) {
    ctx.font = fuente(p, peso); if ('fontStretch' in ctx) ctx.fontStretch = STRETCH[ancho] || 'normal';
    if (ctx.measureText(t).width <= max) break;
  }
  return p;
}

function lineas(ctx, t, max, px, peso, ancho) {
  ctx.font = fuente(px, peso); if ('fontStretch' in ctx) ctx.fontStretch = STRETCH[ancho] || 'normal';
  const out = []; let l = '';
  for (const w of t.split(' ')) { const p = l ? `${l} ${w}` : w; if (ctx.measureText(p).width > max && l) { out.push(l); l = w; } else l = p; }
  if (l) out.push(l); return out.slice(0, 2);
}

function logo(ctx, x, y, s, c) {
  const k = s / 24; ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
  ctx.fillStyle = c.tile; ctx.beginPath(); ctx.roundRect(0, 0, 24, 24, 6.5); ctx.fill();
  ctx.strokeStyle = c.tileInk; ctx.lineWidth = 2.6; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(12, 12, 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (300 / 360)); ctx.stroke();
  ctx.fillStyle = c.tileInk; ctx.beginPath(); ctx.arc(5.94, 8.5, 2.1, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

const cargarImg = (src) => new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = mal; i.src = src; });

/**
 * @returns {Promise<Blob>} PNG
 */
export async function generarImagen({ tipo, formato = 'historia', tema = 'azul', datos, piloto }) {
  await document.fonts.load(fuente(80, 800)); await document.fonts.load(fuente(40, 700));
  const F = FORMATOS[formato], c = TEMAS[tema], T = TIPOS[tipo].tarjeta(datos);
  const W = F.w, H = F.h, story = formato === 'historia', wide = formato === 'mensaje';
  const k = story ? 1 : wide ? 0.62 : 0.82, P = story ? 84 : wide ? 52 : 70;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // Fondo + anillo del logo en grande (sangra por el borde)
  ctx.fillStyle = c.bg; ctx.fillRect(0, 0, W, H);
  const A = story ? [640, 900, 520, 110, 70] : wide ? [900, 390, 330, 64, 40] : [760, 640, 420, 90, 56];
  ctx.strokeStyle = c.arc; ctx.lineWidth = A[3]; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(A[0], A[1], A[2], -Math.PI / 2 + 0.24, -Math.PI / 2 + 0.24 + Math.PI * 2 * (300 / 360)); ctx.stroke();

  // Cabecera
  const lg = Math.round(52 * k); logo(ctx, P, P, lg, c);
  texto(ctx, 'bicifastness', P + lg + 18 * k, P + lg * 0.72, { px: 40 * k, ancho: 112, color: c.ink });
  ctx.font = fuente(30 * k, 800); const tw = ctx.measureText(T.tag).width + 40 * k, th = 52 * k;
  ctx.fillStyle = c.tagBg; ctx.beginPath(); ctx.roundRect(W - P - tw, P + (lg - th) / 2, tw, th, 14 * k); ctx.fill();
  texto(ctx, T.tag, W - P - tw / 2, P + lg / 2, { px: 30 * k, color: c.tagInk, align: 'center', base: 'middle' });

  // Pie
  const footY = H - P;
  ctx.fillStyle = c.line; ctx.fillRect(P, footY - 80 * k, W - 2 * P, Math.max(2, 3 * k));
  const av = 52 * k; ctx.fillStyle = piloto?.color || '#13A89E'; ctx.beginPath(); ctx.arc(P + av / 2, footY - av / 2, av / 2, 0, Math.PI * 2); ctx.fill();
  texto(ctx, (piloto?.nombre || '?')[0].toUpperCase(), P + av / 2, footY - av / 2, { px: 26 * k, color: '#fff', align: 'center', base: 'middle' });
  texto(ctx, piloto?.nombre || '', P + av + 16 * k, footY - av / 2, { px: 32 * k, peso: 700, color: c.ink, base: 'middle' });
  texto(ctx, 'bicifastness.es', W - P, footY - av / 2, { px: 32 * k, peso: 700, color: c.ink2, align: 'right', base: 'middle' });

  // Cuerpo
  const top = P + lg + (story ? 140 : wide ? 40 : 70), colW = wide ? W - 2 * P - 340 : W - 2 * P;
  let y = top;
  texto(ctx, T.eye, P, y, { px: 36 * k, peso: 700, color: c.ink2, max: colW }); y += 36 * k + 16 * k;
  const tp = (story ? 80 : 64) * k;
  for (const l of lineas(ctx, T.tit, colW, tp, 800, 86)) { y += tp; texto(ctx, l, P, y, { px: tp, ancho: 86, color: c.ink }); y += 4; }
  if (T.img) { try { const im = await cargarImg(T.img); const s = story ? 230 : wide ? 110 : 150; y += 18 * k; ctx.drawImage(im, P, y, s, s * (84 / 80)); y += s * (84 / 80); } catch { /* sin insignia */ } }
  const bp = ajustar(ctx, T.big, colW, (T.escala || 1) * (story ? 330 : wide ? 190 : 230), 800, 62);
  y += bp * 0.86; texto(ctx, T.big, P - bp * 0.03, y, { px: bp, ancho: 62, color: c.big });
  y += 40 * k + 18 * k; if (T.sub) texto(ctx, T.sub, P, y, { px: 40 * k, peso: 700, color: c.ink });

  if (T.mejor) { // caja "Mi viaje con más puntos"
    y += 26 * k; const bx = P, bw = colW, pad = (wide ? 18 : 30) * k, bh = pad * 2 + (28 + 46 + 28) * k + 16 * k;
    ctx.fillStyle = c.box || 'rgba(0,0,0,.16)'; ctx.beginPath(); ctx.roundRect(bx, y, bw, bh, 28 * k); ctx.fill();
    const vp = (story ? 130 : wide ? 70 : 100) * k;
    texto(ctx, T.mejor.v, bx + bw - pad, y + bh / 2 + vp * 0.36, { px: vp, ancho: 62, color: c.big, align: 'right' });
    ctx.font = fuente(vp, 800); const vw = ctx.measureText(T.mejor.v).width + 20 * k, mw = bw - pad * 2 - vw;
    texto(ctx, T.mejor.t, bx + pad, y + pad + 28 * k, { px: 28 * k, peso: 700, color: c.ink2, max: mw });
    texto(ctx, T.mejor.r, bx + pad, y + pad + 28 * k + 8 * k + 46 * k, { px: (story ? 46 : 40) * k, color: c.ink, max: mw });
    texto(ctx, T.mejor.i, bx + pad, y + bh - pad, { px: 28 * k, peso: 400, color: c.ink2, max: mw });
    y += bh;
  }
  if (T.barra) { // tu sitio entre 30
    y += 30 * k; const bh = 90 * k, gw = (colW - 29 * 4) / 30;
    for (let i = 0; i < 30; i++) { const me = i === 7, h = me ? bh : bh * (0.7 - i * 0.014); ctx.fillStyle = me ? c.big : c.line; ctx.beginPath(); ctx.roundRect(P + i * (gw + 4), y + bh - h, gw, h, 3); ctx.fill(); }
  }

  // Historia: tabla de detalle (datos.filas: [{ p, n, v, yo }], hasta 5) encima de las cifras
  if (story && datos.filas?.length) {
    const fl = datos.filas.slice(0, 5), rh = 84, bh = 14 + 50 + fl.length * rh + 14;
    const by = footY - 80 * k - 260 * k - 50 - bh;
    ctx.fillStyle = c.box; ctx.beginPath(); ctx.roundRect(P, by, W - 2 * P, bh, 32); ctx.fill();
    texto(ctx, datos.filasTitulo || '', P + 34, by + 14 + 38, { px: 28, peso: 700, color: c.ink2 });
    fl.forEach((f, i) => {
      const yy = by + 14 + 50 + i * rh, col = f.yo ? c.big : c.ink;
      if (i) { ctx.fillStyle = c.line; ctx.fillRect(P + 34, yy, W - 2 * P - 68, 2); }
      texto(ctx, f.p, P + 34, yy + rh / 2, { px: 36, ancho: 68, color: col, base: 'middle' });
      texto(ctx, f.yo ? 'Yo' : f.n, P + 34 + 82, yy + rh / 2, { px: 36, peso: f.yo ? 800 : 500, color: col, base: 'middle', max: W - 2 * P - 340 });
      texto(ctx, f.v, W - P - 34, yy + rh / 2, { px: 36, ancho: 86, color: col, align: 'right', base: 'middle' });
    });
  }

  // Cifras: fila de 3 (historia/cuadrado) o columna a la derecha (mensaje)
  const st = T.stats;
  if (wide) {
    const x = W - P - 300, h = (footY - 110 * k - top) / 3;
    st.forEach(([v, l], i) => { const yy = top + i * h; ctx.fillStyle = c.line; ctx.fillRect(x, yy, 300, 2); texto(ctx, v, x, yy + 20 + 66 * k, { px: 66 * k, ancho: 68, color: c.ink }); texto(ctx, l, x, yy + 20 + 66 * k + 34 * k, { px: 28 * k, peso: 400, color: c.ink2 }); });
  } else {
    const yy = footY - 80 * k - (story ? 260 : 190) * k, cw = (W - 2 * P - 2 * 28 * k) / 3, sp = (story ? 84 : 66) * k;
    st.forEach(([v, l], i) => { const x = P + i * (cw + 28 * k); ctx.fillStyle = c.line; ctx.fillRect(x, yy, cw, Math.max(2, 3 * k)); texto(ctx, v, x, yy + 20 * k + sp, { px: sp, ancho: 68, color: c.ink, max: cw }); texto(ctx, l, x, yy + 20 * k + sp + 38 * k, { px: 28 * k, peso: 400, color: c.ink2, max: cw }); });
  }

  return new Promise((ok) => cv.toBlob(ok, 'image/png'));
}

/* ---------------- Compartir ---------------- */

/** ¿Este navegador puede mandar la imagen al menu del movil? */
export const puedeCompartirImagen = (blob) => {
  try { return Boolean(navigator.share && navigator.canShare?.({ files: [new File([blob], 'x.png', { type: 'image/png' })] })); } catch { return false; }
};

/** Descarga el PNG. El enlace tiene que estar en la pagina: si no, Firefox e iOS lo ignoran. */
export function descargar(blob, nombre) {
  const a = el('a', { attrs: { href: URL.createObjectURL(blob), download: nombre } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/**
 * La imagen al menu del movil (Instagram, WhatsApp...). SOLO la imagen: con
 * imagen + texto, iOS deja fuera a Instagram y WhatsApp se queda a veces con el
 * texto y sin la foto. El texto se copia antes (sin esperar: el menu tiene que
 * abrirse dentro del mismo toque) para pegarlo si se quiere.
 * Sin menu (ordenador), se descarga y se copia el texto.
 */
export async function compartir({ blob, texto: t, url, nombre = 'bicifastness.png' }) {
  const conTexto = `${t}\n${url}`;
  const copiado = navigator.clipboard?.writeText(conTexto).then(() => true, () => false) ?? Promise.resolve(false);
  if (puedeCompartirImagen(blob)) {
    try {
      await navigator.share({ files: [new File([blob], nombre, { type: 'image/png' })] });
      return (await copiado) ? 'compartido-y-copiado' : 'compartido';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelado';
      // Cualquier otro fallo del menu: se descarga, que al menos la tiene.
    }
  }
  descargar(blob, nombre);
  return (await copiado) ? 'descargado-y-copiado' : 'descargado';
}

/** Solo texto + enlace a WhatsApp (escritorio, o si no hay Web Share con archivos). */
export const enlaceWhatsApp = (t, url) => `https://wa.me/?text=${encodeURIComponent(`${t}\n${url}`)}`;

export async function copiarEnlace(url) { await navigator.clipboard.writeText(url); }

/* ---------------- Hoja (17a) ---------------- */
/**
 * Abre la hoja de compartir. `tipo` viene elegido según la pantalla; `extra`
 * permite ofrecer otros tipos en los chips (p. ej. desde Verificado: ruta + racha).
 * La hoja usa .hoja-compartir de compartir.css. Pinta la vista previa con
 * generarImagen y un <img> (no un canvas visible) para que pese poco.
 */
export function abrirCompartir({ tipo, datos, extra = {}, piloto, alCerrar }) {
  const disponibles = { [tipo]: datos, ...extra };
  const leer = (k, def) => { try { return localStorage.getItem(k) || def; } catch { return def; } };
  const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento: no se recuerda */ } };
  const estado = { tipo, formato: FORMATOS[leer('compartir.formato')] ? leer('compartir.formato') : 'historia', tema: TEMAS[leer('compartir.tema')] ? leer('compartir.tema') : 'azul' };
  const destino = (accion, ic, texto) => el('button', { attrs: { type: 'button', 'data-a': accion } }, [el('span', {}, [icono(ic)]), texto]);
  const hoja = el('div', { clase: 'hoja-compartir', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Compartir' } }, [
    el('div', { clase: 'velo' }),
    el('div', { clase: 'panel' }, [
      el('span', { clase: 'asa' }),
      el('div', { clase: 'chips', attrs: { role: 'tablist' } }),
      el('div', { clase: 'previa' }, [el('img', { attrs: { alt: 'Vista previa' } })]),
      el('div', { clase: 'segmento formatos', attrs: { role: 'tablist' } }),
      el('div', { clase: 'temas', attrs: { role: 'radiogroup', 'aria-label': 'Fondo' } }),
      el('div', { clase: 'destinos' }, [
        destino('historia', 'imagen', 'Historia'),
        destino('whatsapp', 'correo', 'WhatsApp'),
        destino('guardar', 'descargar', 'Guardar'),
        destino('enlace', 'enlace', 'Copiar enlace'),
        destino('mas', 'mas-h', 'Más'),
      ]),
    ]),
  ]);
  const $ = (s) => hoja.querySelector(s);
  let blob = null;

  const pintar = async () => {
    $('.chips').replaceChildren(...Object.keys(disponibles).map((k) => boton(TIPOS[k].nombre, k === estado.tipo, () => { estado.tipo = k; pintar(); })));
    $('.formatos').replaceChildren(...Object.entries(FORMATOS).map(([k, f]) => boton(f.nombre, k === estado.formato, () => { estado.formato = k; guardar('compartir.formato', k); pintar(); })));
    $('.temas').replaceChildren(...Object.keys(TEMAS).map((k) => { const b = boton('', k === estado.tema, () => { estado.tema = k; guardar('compartir.tema', k); pintar(); }); b.className = `tema ${k}`; b.setAttribute('aria-label', k); return b; }));
    $('.previa').dataset.formato = estado.formato;
    blob = await generarImagen({ ...estado, datos: disponibles[estado.tipo], piloto });
    const img = $('.previa img'); URL.revokeObjectURL(img.src); img.src = URL.createObjectURL(blob);
  };

  hoja.addEventListener('click', async (e) => {
    if (e.target.classList.contains('velo')) return cerrar();
    const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
    if (!blob) { aviso('Un momento, se está preparando la imagen…'); return; }
    const T = TIPOS[estado.tipo], d = disponibles[estado.tipo], txt = T.texto(d), url = T.url(d);
    if (a === 'whatsapp' && !puedeCompartirImagen(blob)) return window.open(enlaceWhatsApp(txt, url), '_blank', 'noopener');
    if (a === 'enlace') { try { await copiarEnlace(url); aviso('Enlace copiado'); } catch { aviso('No se ha podido copiar'); } return; }
    const nombre = `bicifastness-${estado.tipo}.png`;
    // En el movil, "Guardar" va por el menu (ahi esta "Guardar imagen"): en una
    // app instalada de iOS una descarga abre una vista sin salida.
    if (a === 'guardar' && !puedeCompartirImagen(blob)) { descargar(blob, nombre); aviso('Imagen guardada'); return; }
    const r = await compartir({ blob, texto: txt, url, nombre });
    const AVISOS = {
      'compartido-y-copiado': 'Texto copiado: pégalo si quieres acompañar la imagen',
      'descargado-y-copiado': 'Imagen guardada y texto copiado',
      descargado: 'Imagen guardada',
    };
    if (AVISOS[r]) aviso(AVISOS[r]);
  });

  const teclas = (e) => { if (e.key === 'Escape') cerrar(); };
  const cerrar = () => { hoja.remove(); document.removeEventListener('keydown', teclas); alCerrar?.(); };
  document.addEventListener('keydown', teclas);
  document.body.append(hoja); pintar().catch(() => aviso('No se ha podido crear la imagen'));
  return cerrar;
}

function boton(t, on, fn) { return el('button', { texto: t, attrs: { type: 'button', 'aria-selected': String(on), 'aria-pressed': String(on) }, on: { click: fn } }); }
function icono(id) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('width', '24'); s.setAttribute('height', '24'); s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(NS, 'use');
  u.setAttribute('href', `/assets/img/iconos.svg#${id}`);
  s.append(u);
  return s;
}
function aviso(t) { avisar(t, 'exito'); }

/** Boton "Compartir" de las pantallas. `preparar()` devuelve { tipo, datos, extra, piloto }. */
export function botonCompartir(preparar, { clase = '', texto: rotulo = 'Compartir' } = {}) {
  return el('button', {
    clase: `boton-compartir ${clase}`.trim(), attrs: { type: 'button', 'aria-label': rotulo },
    on: { click: () => abrirCompartir(preparar()) },
  }, [icono('compartir'), el('span', { texto: 'Compartir' })]);
}
