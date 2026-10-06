// Modulo de la pagina /admin/redes/ (diseño 13 · Piezas para Instagram, 13f).
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// CADA PIEZA ES EL MARCADO DEL DISEÑO 13, TAL CUAL, con los datos reales
// donde el diseño pone los de ejemplo. Se pinta como HTML en la vista previa
// y, al descargar, ese mismo HTML se mete en un SVG (<foreignObject>) con la
// letra Archivo y las insignias incrustadas, se dibuja en un <canvas> y sale
// en PNG. Asi lo que se ve es exactamente lo que se descarga, y nada se pide
// fuera de la web.
//
// Lo que el diseño no trae y aqui se resuelve con datos de verdad:
//   - El mapa (`MapaMadrid` en el diseño) son las estaciones reales de BiciMAD
//     sobre fondo oscuro; la ruta se traza entre sus dos estaciones de verdad.
//   - Donde el ejemplo usa una cifra que la web no guarda (estaciones ganadas
//     en el mes, % que vuelve al dia siguiente...), va la mas cercana que si
//     existe, y se dice en la nota de la vista previa.

import {
  db, doc, getDoc, getDocs, collection, query, orderBy, limit,
} from '/assets/js/firebase.js';
import { iniciarPagina, nombreEstacion, formatearTiempo, miles } from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';
import { montarCabeceraAdmin, exigirAdmin } from '/assets/js/admin-cabecera.js';
import { NIVELES, NOMBRES as DIVISIONES, fechaCorta } from '/assets/js/ligas.js';
import { diaMadrid, lunesDeLaSemana, sumarDias } from '/assets/js/dia.js';
import { ESTACIONES } from '/assets/data/estaciones.js';

iniciarPagina('admin');
montarCabeceraAdmin('redes');

// --- Utilidades ----------------------------------------------------------------------

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const coma = (n, d = 1) => Number(n).toFixed(d).replace('.', ',');
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const mayus = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const corto = (n) => String(n || '').replace(/^Metro /, '').split(' - ')[0];
const nombreDe = (cod) => nombreEstacion(cod) || cod;
const tramoDe = (ruta) => String(ruta || '').split('-');

/** Los pilotos que no quieren salir: se tachan en todas las piezas. */
const ocultos = new Set();
const piloto = (n) => (ocultos.has(n) ? 'Piloto anónimo' : n);

// --- El mapa (en el diseño, `MapaMadrid`) --------------------------------------------

const PUNTOS = Object.entries(ESTACIONES).filter(([, e]) => Number.isFinite(e.lat) && Number.isFinite(e.lon));
const LIM = PUNTOS.reduce((a, [, e]) => ({
  la0: Math.min(a.la0, e.lat), la1: Math.max(a.la1, e.lat), lo0: Math.min(a.lo0, e.lon), lo1: Math.max(a.lo1, e.lon),
}), { la0: 90, la1: -90, lo0: 180, lo1: -180 });

/**
 * Las estaciones de Madrid sobre oscuro, encajadas en w x h. Con `ruta`, el
 * trazo entre sus dos estaciones (salida circulo azul, meta cuadrado claro,
 * como el diseño); con `colores`, cada estacion del color de su clan.
 */
function mapa(w, h, { ruta = null, colores = null, fondo = '#0E0F10', margen = 60, etiquetas = false } = {}) {
  const k = Math.cos((40.42 * Math.PI) / 180);
  const anchoGeo = (LIM.lo1 - LIM.lo0) * k;
  const altoGeo = LIM.la1 - LIM.la0;
  let escala = Math.max((w - margen * 2) / anchoGeo, (h - margen * 2) / altoGeo);
  // Con ruta, el encuadre va a la ruta (como un mapa de barrio), no a la ciudad.
  let cx = (LIM.lo0 + LIM.lo1) / 2;
  let cy = (LIM.la0 + LIM.la1) / 2;
  const [a, b] = ruta ? tramoDe(ruta).map((c) => ESTACIONES[c] || ESTACIONES[String(Number(c))]) : [];
  if (a && b) {
    cx = (a.lon + b.lon) / 2;
    cy = (a.lat + b.lat) / 2;
    const d = Math.max(Math.abs(a.lon - b.lon) * k, Math.abs(a.lat - b.lat), 0.004);
    escala = Math.min(w, h) * 0.55 / d;
  }
  const px = (e) => [w / 2 + (e.lon - cx) * k * escala, h / 2 - (e.lat - cy) * escala];
  const puntos = PUNTOS.map(([cod, e]) => {
    const [x, y] = px(e);
    if (x < -10 || y < -10 || x > w + 10 || y > h + 10) return '';
    const color = colores?.[cod] || colores?.[String(Number(cod))] || '#3A3B3E';
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${colores ? 7 : 5}" fill="${color}"/>`;
  }).join('');
  let trazo = '';
  if (a && b) {
    const [x1, y1] = px(a);
    const [x2, y2] = px(b);
    const mx = (x1 + x2) / 2 + (y2 - y1) * 0.18;
    const my = (y1 + y2) / 2 - (x2 - x1) * 0.18;
    trazo = `<path d="M${x1} ${y1} Q ${mx} ${my}, ${x2} ${y2}" fill="none" stroke="#1B80E5" stroke-width="16" stroke-linecap="round"/>`
      + `<circle cx="${x1}" cy="${y1}" r="24" fill="#1B80E5" stroke="${fondo}" stroke-width="8"/>`
      + `<rect x="${x2 - 22}" y="${y2 - 22}" width="44" height="44" rx="6" fill="#F2F1EE" stroke="${fondo}" stroke-width="8"/>`
      + (etiquetas ? `<text x="${x1 + 30}" y="${y1 + 60}" fill="#F2F1EE" style="font-size:30px; font-weight:700; font-family:Archivo,sans-serif;">${esc(corto(nombreDe(tramoDe(ruta)[0])))}</text>`
        + `<text x="${x2 - 30}" y="${y2 + 70}" text-anchor="end" fill="#F2F1EE" style="font-size:30px; font-weight:700; font-family:Archivo,sans-serif;">${esc(corto(nombreDe(tramoDe(ruta)[1])))}</text>` : '');
  }
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="position:absolute; inset:0;"><rect width="${w}" height="${h}" fill="${fondo}"/>${puntos}${trazo}</svg>`;
}

// --- Las piezas del diseño 13 ---------------------------------------------------------

const FLECHA = (color, t) => `<svg width="${t}" height="${t}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
const INSIGNIA = (k, ancho) => `<span style="position:relative; display:block; width:${ancho};"><span style="position:absolute; left:22%; top:22%; width:56%; height:56%; border-radius:50%; background:#111110;"></span><img src="${INSIGNIAS[k] || `/assets/img/divisiones/${k}-oscuro.svg`}" alt="" style="position:relative; width:100%; display:block;"/></span>`;
let INSIGNIAS = {};

/** Cada pieza: titulo, formato, y una lista de laminas {w, h, html}. */
const PIEZAS = {
  campeones: {
    titulo: 'Campeones', formato: '9:16',
    laminas: (d) => [{ w: 1080, h: 1920, html: `
      <div style="width:1080px; height:1920px; background:#1B80E5; color:#fff; display:flex; flex-direction:column; padding:120px 84px 110px; box-sizing:border-box; position:relative; overflow:hidden; isolation:isolate;">
        <svg width="1080" height="1920" viewBox="0 0 1080 1920" style="position:absolute; inset:0; pointer-events:none; z-index:-1;"><path d="M820 520 A420 420 0 1 1 456 730" fill="none" stroke="#3F95EA" stroke-width="90" stroke-linecap="round"/><circle cx="456" cy="730" r="76" fill="#3F95EA"/></svg>
        <span style="position:absolute; right:70px; top:690px; transform:rotate(-6deg); border:5px solid #fff; border-radius:16px; padding:14px 26px; font-size:40px; font-weight:800; letter-spacing:.02em;">${d.cerrada ? 'TEMPORADA CERRADA' : 'TEMPORADA EN JUEGO'}</span>
        <div style="position:relative; display:flex; align-items:center; justify-content:space-between;">
          <svg width="76" height="76" viewBox="0 0 24 24"><path d="M12 5 A7 7 0 1 1 5.94 8.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="5.94" cy="8.5" r="1.9" fill="#fff"/></svg>
          <span style="font-size:34px; font-weight:700;">Temporada · ${esc(d.mes)} ${d.anio}</span>
        </div>
        <span style="font-size:190px; font-weight:800; font-stretch:68%; letter-spacing:-.03em; line-height:.82; margin-top:90px; position:relative;">Los tres<br/>de ${esc(d.mes)}</span>
        <div style="flex:1;"></div>
        ${d.campeones.map((c) => `
          <div style="border-top:3px solid #fff; padding:34px 0 40px; display:grid; grid-template-columns:1fr auto; gap:6px 24px; align-items:end;">
            <span style="font-size:34px; font-weight:700; opacity:.85;">${esc(c.modo)}</span>
            <span style="font-size:34px; font-weight:700; opacity:.85; text-align:right;">${esc(c.uni)}</span>
            <span style="font-size:84px; font-weight:800; font-stretch:88%; letter-spacing:-.035em; line-height:1;">${esc(c.n)}</span>
            <span style="font-size:150px; font-weight:800; font-stretch:68%; line-height:.8; font-variant-numeric:tabular-nums;">${esc(c.v)}</span>
          </div>`).join('')}
        <div style="border-top:3px solid #fff; padding-top:30px; display:flex; justify-content:space-between; font-size:32px; font-weight:700;"><span>bicifastness.es</span><span style="opacity:.85;">${esc(d.cierre)}</span></div>
      </div>` }],
  },

  viaje: {
    titulo: 'El viaje del mes', formato: '9:16',
    laminas: (d) => {
      const v = d.viaje;
      if (!v) return [vacia(1080, 1920, 'Todavía no hay trayectos verificados en este periodo.')];
      const [o, m] = tramoDe(v.ruta);
      return [{ w: 1080, h: 1920, html: `
      <div style="width:1080px; height:1920px; background:#111110; color:#F2F1EE; display:flex; flex-direction:column; padding:120px 84px 110px; box-sizing:border-box;">
        <span style="font-size:34px; font-weight:700; color:#B3B2AE;">El trayecto que más puntuó en ${esc(d.mes)}</span>
        <span style="font-size:400px; font-weight:800; font-stretch:64%; letter-spacing:-.04em; line-height:.8; color:#1B80E5; margin-top:60px; font-variant-numeric:tabular-nums;">+${esc(miles(v.puntos))}</span>
        <span style="font-size:44px; font-weight:700; margin-top:24px;">puntos en un solo viaje</span>
        <div style="flex:1; margin:50px -84px 40px; position:relative; overflow:hidden;">
          ${mapa(1080, 560, { ruta: v.ruta, fondo: '#111110', etiquetas: true })}
        </div>
        <div style="background:#F3F1EC; color:#111110; border-radius:44px; overflow:hidden;">
          <div style="padding:56px 56px 48px; display:grid; grid-template-columns:40px 1fr; gap:0 28px;">
            <span style="width:28px; height:28px; border-radius:50%; background:#1B80E5; margin:14px 6px 0;"></span>
            <span style="display:flex; flex-direction:column;"><span style="font-size:28px; color:#6E6C66;">Salida · ${esc(o)}</span><span style="font-size:52px; font-weight:800; letter-spacing:-.02em;">${esc(corto(nombreDe(o)))}</span></span>
            <span style="width:4px; height:64px; margin:10px 18px; background-image:linear-gradient(#9CC4EE 50%, transparent 50%); background-size:4px 14px;"></span><span></span>
            <span style="width:28px; height:28px; border-radius:6px; background:#111110; margin:14px 6px 0;"></span>
            <span style="display:flex; flex-direction:column;"><span style="font-size:28px; color:#6E6C66;">Meta · ${esc(m)}</span><span style="font-size:52px; font-weight:800; letter-spacing:-.02em;">${esc(corto(nombreDe(m)))}</span></span>
          </div>
          <div style="border-top:4px dashed #D6D2C8; margin:0 40px;"></div>
          <div style="padding:44px 56px 56px; display:flex; align-items:flex-end; justify-content:space-between;">
            <span style="display:flex; flex-direction:column;"><span style="font-size:28px; color:#6E6C66;">${esc(piloto(v.username || 'Piloto'))}${v.x2 ? ' · ruta de la semana ×2' : ''}</span><span style="font-size:150px; font-weight:800; font-stretch:68%; line-height:.82;">${esc(formatearTiempo(v.tiempoSegundos))}</span></span>
            <span style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; font-size:34px; color:#55534D;"><span><strong style="color:#111110;">${v.distanciaMetros ? coma(v.distanciaMetros / 1000) : '—'}</strong> km</span><span><strong style="color:#111110;">${v.velocidadKmh ? coma(v.velocidadKmh) : '—'}</strong> km/h</span><span><strong style="color:#111110;">${esc(fechaCorta(String(v.fechaViaje).slice(0, 10)).replace(/^\S+ /, ''))}</strong></span></span>
          </div>
        </div>
        <div style="padding-top:56px; display:flex; justify-content:space-between; font-size:32px; font-weight:700;"><span>bicifastness.es</span><span style="color:#B3B2AE;">Respeta los semáforos</span></div>
      </div>` }];
    },
  },

  rutas: {
    titulo: 'Dueños de las rutas', formato: '9:16',
    laminas: (d) => [{ w: 1080, h: 1920, html: `
      <div style="width:1080px; height:1920px; background:#F3F1EC; color:#111110; display:flex; flex-direction:column; padding:120px 84px 110px; box-sizing:border-box;">
        <div style="display:flex; justify-content:space-between; align-items:center;"><span style="font-size:34px; font-weight:700; color:#55534D;">${esc(d.semana)}</span><span style="padding:10px 20px; border-radius:14px; background:#1B80E5; color:#fff; font-size:30px; font-weight:800;">Récords</span></div>
        <span style="font-size:170px; font-weight:800; font-stretch:68%; letter-spacing:-.03em; line-height:.82; margin-top:70px;">Las rutas<br/>tienen dueño</span>
        <div style="flex:1;"></div>
        ${d.rutas.slice(0, 5).map((r) => `
          <div style="border-top:2px solid #111110; padding:30px 0; display:grid; grid-template-columns:1fr auto; gap:8px 24px; align-items:center;">
            <span style="font-size:42px; font-weight:800; letter-spacing:-.02em; line-height:1.1;">${esc(r.a)}<span style="color:#1B80E5;"> → </span>${esc(r.b)}</span>
            <span style="grid-row:span 2; font-size:124px; font-weight:800; font-stretch:68%; line-height:.8; font-variant-numeric:tabular-nums;">${esc(r.t)}</span>
            <span style="font-size:30px; color:#55534D;">${esc(r.n)} · <strong style="color:${r.nuevo ? '#1466C2' : '#55534D'};">${esc(r.d)}</strong></span>
          </div>`).join('')}
        <div style="border-top:2px solid #111110; padding-top:30px; display:flex; justify-content:space-between; font-size:32px; font-weight:700;"><span>bicifastness.es</span><span style="color:#55534D;">¿Cuánto tardas tú?</span></div>
      </div>` }],
  },

  top10: {
    titulo: 'Top 10', formato: '9:16',
    laminas: (d) => {
      const [p1, ...resto] = d.top;
      return [{ w: 1080, h: 1920, html: `
      <div style="width:1080px; height:1920px; background:#F3F1EC; display:flex; flex-direction:column; box-sizing:border-box;">
        <div style="background:#1B80E5; color:#fff; padding:120px 84px 60px; display:flex; flex-direction:column; gap:30px;">
          <span style="font-size:34px; font-weight:700; opacity:.9;">BiciRating · ${esc(d.mes)} ${d.anio} · ${esc(miles(d.pilotos))} pilotos</span>
          <div style="display:flex; align-items:flex-end; justify-content:space-between;">
            <span style="font-size:250px; font-weight:800; font-stretch:64%; letter-spacing:-.04em; line-height:.78;">Top 10</span>
            <span style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;"><span style="font-size:32px; font-weight:700; opacity:.9;">1.º</span><span style="font-size:64px; font-weight:800; letter-spacing:-.03em;">${esc(p1?.n || '—')}</span><span style="font-size:104px; font-weight:800; font-stretch:68%; line-height:.85;">${esc(p1?.v || '')}</span></span>
          </div>
        </div>
        <div style="flex:1; padding:30px 84px 0; display:flex; flex-direction:column;">
          ${resto.slice(0, 9).map((t) => `
            <div style="display:grid; grid-template-columns:90px 1fr auto auto; gap:24px; align-items:center; height:128px; border-bottom:2px solid #E0DDD5;">
              <span style="font-size:64px; font-weight:800; font-stretch:72%; color:#1466C2;">${esc(t.p)}</span>
              <span style="font-size:46px; font-weight:700; letter-spacing:-.02em;">${esc(t.n)}</span>
              <span style="width:20px; height:20px; border-radius:50%; background:${t.c};"></span>
              <span style="font-size:58px; font-weight:800; font-stretch:80%; font-variant-numeric:tabular-nums; width:170px; text-align:right;">${esc(t.v)}</span>
            </div>`).join('')}
        </div>
        <div style="padding:40px 84px 110px; display:flex; justify-content:space-between; font-size:32px; font-weight:700;"><span>bicifastness.es</span><span style="color:#55534D;">Todos empiezan de cero el día 1</span></div>
      </div>` }];
    },
  },

  ligas: {
    titulo: 'Ganadores de liga', formato: '3 × 3:4',
    nota: 'Una sola imagen de 3240 × 1440 cortada en tres de 1080 × 1440: al deslizar se sigue la carretera.',
    laminas: (d) => {
      const X = [270, 790, 1290, 1630, 1970, 2430, 2850];
      const Y = [1060, 960, 880, 760, 640, 470, 330];
      const SZ = [200, 220, 230, 240, 250, 260, 290];
      const pts = [[-40, 1150], ...X.map((x, i) => [x, Y[i]]), [3280, 260]];
      let road = `M${pts[0][0]} ${pts[0][1]}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)]; const p1 = pts[i]; const p2 = pts[i + 1]; const p3 = pts[Math.min(pts.length - 1, i + 2)];
        road += ` C${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6}, ${p2[0] - (p3[0] - p1[0]) / 6} ${p2[1] - (p3[1] - p1[1]) / 6}, ${p2[0]} ${p2[1]}`;
      }
      const ligas = NIVELES.map((k, i) => {
        const g = d.ganadores[k];
        return `
          <div style="position:absolute; left:${X[i] - 150}px; top:${Y[i] - SZ[i] / 2}px; width:300px; display:flex; flex-direction:column; align-items:center; gap:10px; text-align:center;">
            ${INSIGNIA(k, `${SZ[i]}px`)}
            <span style="font-size:30px; font-weight:700; color:#B3B2AE; margin-top:8px;">${esc(DIVISIONES[k])}</span>
            <span style="font-size:48px; font-weight:800; letter-spacing:-.02em;">${esc(g ? g.n : '—')}</span>
            <span style="font-size:64px; font-weight:800; font-stretch:68%; line-height:.9; color:${i === 6 ? '#5AA8F2' : '#F2F1EE'};">${g ? `${esc(g.v)} pts` : ''}</span>
          </div>`;
      }).join('');
      const html = `
        <div style="width:3240px; height:1440px; background:#111110; color:#F2F1EE; position:relative;">
          <svg width="3240" height="1440" viewBox="0 0 3240 1440" style="position:absolute; inset:0;">
            <path d="${road}" fill="none" stroke="#1B80E5" stroke-width="18" stroke-linecap="round"/>
            <path d="${road}" fill="none" stroke="#F2F1EE" stroke-width="3" stroke-dasharray="26 22"/>
          </svg>
          <div style="position:absolute; left:84px; top:110px; display:flex; flex-direction:column; gap:20px; width:900px;">
            <span style="font-size:34px; font-weight:700; color:#B3B2AE;">${esc(mayus(d.mes))} ${d.anio} · las 7 ligas</span>
            <span style="font-size:170px; font-weight:800; font-stretch:68%; letter-spacing:-.03em; line-height:.82;">De cobre<br/>a diamante</span>
            <span style="font-size:36px; color:#B3B2AE; display:flex; align-items:center; gap:14px;">Desliza${FLECHA('#1B80E5', 40)}</span>
          </div>
          ${ligas}
          <div style="position:absolute; right:84px; bottom:100px; display:flex; flex-direction:column; align-items:flex-end; gap:10px;">
            <span style="font-size:36px; color:#B3B2AE;">Cada dos semanas se sube y se baja.</span>
            <span style="font-size:44px; font-weight:800;">bicifastness.es</span>
          </div>
        </div>`;
      return [{ w: 3240, h: 1440, html, cortes: 3 }];
    },
  },

  ruta: {
    titulo: 'Ruta destacada', formato: '9:16',
    laminas: (d) => {
      const r = d.rutaSemana;
      if (!r) return [vacia(1080, 1920, 'Esta semana todavía no hay ruta destacada.')];
      const [o, m] = tramoDe(r.ruta);
      const s = { bg: '#1B80E5', ink: '#fff', acc: '#111110', line: 'rgba(255,255,255,.35)', tagBg: '#fff', tagInk: '#1466C2' };
      return [{ w: 1080, h: 1920, html: `
        <div style="width:1080px; height:1920px; background:${s.bg}; color:${s.ink}; display:grid; grid-template-rows:auto 1fr auto auto;">
          <div style="padding:110px 72px 40px; display:flex; flex-direction:column; gap:26px;">
            <div style="display:flex; justify-content:space-between; align-items:center;"><span style="padding:12px 22px; border-radius:14px; background:${s.tagBg}; color:${s.tagInk}; font-size:34px; font-weight:800;">Ruta de la semana · ×2</span><span style="font-size:32px; font-weight:700; opacity:.85;">Hasta el domingo</span></div>
            <span style="font-size:150px; font-weight:800; font-stretch:66%; letter-spacing:-.035em; line-height:.84;">${esc(corto(nombreDe(o)))}<br/><span style="color:${s.acc};">→</span> ${esc(corto(nombreDe(m)))}</span>
            <span style="font-size:34px; font-weight:700; opacity:.85;">Puntúa doble toda la semana. La tabla empieza vacía el lunes.</span>
          </div>
          <div style="position:relative; overflow:hidden;">
            ${mapa(1080, 760, { ruta: r.ruta })}
            ${r.km ? `<span style="position:absolute; right:72px; bottom:40px; padding:14px 22px; border-radius:16px; background:#0E0F10; color:#F2F1EE; font-size:32px; font-weight:700;">${esc(r.km)}</span>` : ''}
          </div>
          <div style="padding:48px 72px 40px; display:grid; grid-template-columns:1fr 1fr; gap:0 48px;">
            <div style="display:flex; flex-direction:column; gap:6px;"><span style="font-size:32px; opacity:.8;">Récord histórico</span><span style="font-size:230px; font-weight:800; font-stretch:60%; line-height:.8; color:${s.acc};">${esc(r.rec || '—')}</span><span style="font-size:36px; font-weight:800;">${esc(r.recN || 'Sin récord todavía')}</span></div>
            <div style="display:flex; flex-direction:column;">
              ${r.top.slice(0, 4).map((t) => `<div style="display:grid; grid-template-columns:44px 1fr auto; gap:14px; align-items:center; height:90px; border-bottom:2px solid ${s.line}; font-size:34px;"><span style="font-weight:800; opacity:.6;">${esc(t.p)}</span><span style="font-weight:600;">${esc(t.n)}</span><strong>${esc(t.t)}</strong></div>`).join('')}
            </div>
          </div>
          <div style="padding:40px 72px 120px; display:flex; align-items:center; justify-content:space-between; font-size:34px; font-weight:800; border-top:2px solid ${s.line};"><span>bicifastness.es</span><span style="opacity:.85; font-weight:700;">${r.rec ? `¿La bajas de ${esc(r.rec)}?` : 'Pon tú el primer tiempo'}</span></div>
        </div>` }];
    },
  },

  resumen: {
    titulo: 'Resumen de temporada', formato: '9 × 3:4',
    nota: 'El carrusel del día 1 de cada mes, 9 láminas de 1080 × 1440.',
    laminas: (d) => laminasResumen(d),
  },

  horizontal: {
    titulo: 'Resumen horizontal', formato: '6 × 1,91:1',
    nota: 'El formato apaisado: 6 láminas de 1080 × 566.',
    laminas: (d) => laminasHorizontales(d),
  },
};

function vacia(w, h, texto) {
  return { w, h, html: `<div style="width:${w}px; height:${h}px; background:#111110; color:#B3B2AE; display:flex; align-items:center; justify-content:center; padding:84px; box-sizing:border-box; font-size:44px; font-weight:700; text-align:center;">${esc(texto)}</div>` };
}

const cab = (izq, num, total, color = '#8B8A87') => `<div style="display:flex; justify-content:space-between; font-size:34px; font-weight:700;"><span>${esc(izq)}</span><span style="color:${color};">${String(num).padStart(2, '0')}/${String(total).padStart(2, '0')}</span></div>`;

/** 13g · Carrusel de 9, 1080 x 1440. */
function laminasResumen(d) {
  const L = (html) => ({ w: 1080, h: 1440, html });
  const pad = 'padding:90px 84px; box-sizing:border-box;';
  return [
    L(`<div style="width:1080px; height:1440px; background:#1B80E5; color:#fff; ${pad} display:flex; flex-direction:column; position:relative; overflow:hidden; isolation:isolate;">
        <svg width="1080" height="1440" viewBox="0 0 1080 1440" style="position:absolute; inset:0; z-index:-1;"><path d="M760 380 A470 470 0 1 1 352 615" fill="none" stroke="#3F95EA" stroke-width="110" stroke-linecap="round"/><circle cx="352" cy="615" r="92" fill="#3F95EA"/></svg>
        <div style="display:flex; justify-content:space-between; font-size:34px; font-weight:700;"><span>bicifastness</span><span>01/09</span></div>
        <div style="flex:1;"></div>
        <span style="font-size:40px; font-weight:700;">Resumen de temporada</span>
        <span style="font-size:262px; font-weight:800; font-stretch:62%; letter-spacing:-.045em; line-height:.78; margin-top:16px;">${esc(mayus(d.mes))}</span>
        <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-top:40px; font-size:36px; font-weight:700;"><span>${esc(d.periodoTexto)}</span><span style="display:flex; align-items:center; gap:12px;">Desliza${FLECHA('#fff', 44)}</span></div>
      </div>`),
    L(`<div style="width:1080px; height:1440px; background:#F3F1EC; color:#111110; ${pad} display:flex; flex-direction:column;">
        ${cab(`Madrid en ${d.mes}`, 2, 9, '#6E6C66')}
        <div style="flex:1; display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1.25fr 1fr 1fr; margin-top:60px; border-top:3px solid #111110;">
          <div style="grid-column:1/-1; display:flex; flex-direction:column; justify-content:center; border-bottom:3px solid #111110;"><span style="font-size:260px; font-weight:800; font-stretch:62%; letter-spacing:-.04em; line-height:.8; color:#1466C2;">${esc(miles(d.km))} km</span><span style="font-size:40px; font-weight:700; margin-top:18px;">pedaleados entre todos.${d.km > 40075 ? ' Más de una vuelta al mundo.' : ''}</span></div>
          ${d.cifras.map((c, i) => `<div style="display:flex; flex-direction:column; justify-content:center; gap:10px; border-bottom:3px solid #111110; border-left:${i % 2 ? '3px solid #111110' : 'none'}; padding-left:${i % 2 ? '40px' : '0'};"><span style="font-size:130px; font-weight:800; font-stretch:68%; line-height:.82;">${esc(c.v)}</span><span style="font-size:34px; color:#55534D; line-height:1.2;">${esc(c.t)}</span></div>`).join('')}
        </div>
      </div>`),
    L(`<div style="width:1080px; height:1440px; background:#111110; color:#F2F1EE; ${pad} display:flex; flex-direction:column;">
        ${cab('Campeones por modo', 3, 9)}
        <div style="flex:1;"></div>
        ${d.campeones.map((c) => `<div style="border-top:3px solid #3A3B3E; padding:36px 0 40px; display:grid; grid-template-columns:1fr auto; gap:8px 24px; align-items:end;">
            <span style="font-size:32px; font-weight:700; color:#5AA8F2;">${esc(c.modo)}</span><span style="font-size:32px; color:#B3B2AE; text-align:right;">${esc(c.uni)}</span>
            <span style="font-size:80px; font-weight:800; font-stretch:88%; letter-spacing:-.035em; line-height:1;">${esc(c.n)}</span><span style="font-size:150px; font-weight:800; font-stretch:64%; line-height:.8;">${esc(c.v)}</span>
            <span style="grid-column:1/-1; font-size:30px; color:#B3B2AE;">${esc(c.extra)}</span>
          </div>`).join('')}
      </div>`),
    L(`<div style="width:1080px; height:1440px; background:#0E0F10; color:#F2F1EE; box-sizing:border-box; display:flex; flex-direction:column; position:relative;">
        <div style="position:absolute; left:0; right:0; top:0; height:900px;">${mapa(1080, 900, { colores: d.coloresMapa })}</div>
        <div style="position:relative; padding:90px 84px 0;">${cab('Quién manda en el mapa', 4, 9)}</div>
        <div style="flex:1;"></div>
        <div style="position:relative; background:#0E0F10; padding:50px 84px 90px; display:flex; flex-direction:column; gap:26px;">
          <div style="display:flex; height:36px; gap:4px;">${d.clanes.map((c) => `<span style="flex:${Math.max(1, c.v)}; background:${c.c};"></span>`).join('')}<span style="flex:${Math.max(1, d.libres)}; background:#3A3B3E;"></span></div>
          <div style="display:flex; align-items:flex-end; justify-content:space-between;"><span style="display:flex; flex-direction:column;"><span style="font-size:34px; color:#B3B2AE;">Clan campeón</span><span style="font-size:96px; font-weight:800; font-stretch:84%; letter-spacing:-.035em; line-height:1;">${esc(d.clanes[0]?.n || '—')}</span></span><span style="font-size:150px; font-weight:800; font-stretch:64%; line-height:.8; color:${d.clanes[0]?.c || '#F2F1EE'};">${esc(d.clanes[0]?.v ?? 0)}</span></div>
          <span style="font-size:34px; color:#B3B2AE;">estaciones de ${esc(d.totalEstaciones)} · ${esc(d.numClanes)} clanes se reparten ${esc(d.dominadas)}</span>
        </div>
      </div>`),
    L(`<div style="width:1080px; height:1440px; background:#F3F1EC; color:#111110; ${pad} display:flex; flex-direction:column; gap:40px; justify-content:space-between;">
        <div style="margin-bottom:60px;">${cab('Clanes · cómo van', 5, 9, '#6E6C66')}</div>
        ${d.clanMov.map((c) => `<div style="border-top:3px solid #111110; padding-top:30px; display:grid; grid-template-columns:auto 1fr; gap:6px 30px; align-items:center;">
            <span style="grid-row:span 2; width:120px; height:120px; border-radius:30px; background:${c.c}; color:#fff; display:flex; align-items:center; justify-content:center; font-size:44px; font-weight:800;">${esc(c.ini)}</span>
            <span style="font-size:34px; color:#55534D;">${esc(c.t)}</span>
            <span style="font-size:60px; font-weight:800; letter-spacing:-.03em; line-height:1.05;">${esc(c.n)} <span style="color:${c.c};">${esc(c.v)}</span></span>
          </div>`).join('')}
        <div style="flex:1;"></div>
        <span style="font-size:34px; color:#55534D; line-height:1.35;">${d.disputadas ? `Estaciones en disputa ahora mismo: <strong style="color:#111110;">${esc(d.disputadas)}</strong>.` : 'Ninguna estación en disputa ahora mismo.'}</span>
      </div>`),
    L(`<div style="width:1080px; height:1440px; background:#111110; color:#F2F1EE; ${pad} display:flex; flex-direction:column;">
        ${cab('Ganadores de cada liga', 6, 9)}
        <div style="flex:1;"></div>
        ${[...NIVELES].reverse().map((k, i) => {
    const g = d.ganadores[k];
    return `<div style="display:grid; grid-template-columns:110px 1fr auto; gap:28px; align-items:center; height:150px; border-top:2px solid #2D2E31;">
            ${INSIGNIA(k, '100px')}
            <span style="display:flex; flex-direction:column;"><span style="font-size:28px; color:#B3B2AE;">${esc(DIVISIONES[k])}</span><span style="font-size:52px; font-weight:800; letter-spacing:-.02em;">${esc(g ? g.n : '—')}</span></span>
            <span style="font-size:76px; font-weight:800; font-stretch:68%; color:${i === 0 ? '#5AA8F2' : '#F2F1EE'};">${esc(g ? g.v : '')}</span>
          </div>`;
  }).join('')}
      </div>`),
    L(`<div style="width:1080px; height:1440px; background:#1B80E5; color:#fff; ${pad} display:flex; flex-direction:column;">
        ${cab('Las rutas más peleadas', 7, 9, '#fff')}
        <div style="flex:1;"></div>
        ${d.rutasMes.slice(0, 4).map((r) => `<div style="border-top:3px solid #fff; padding:30px 0 34px; display:grid; grid-template-columns:1fr auto; gap:8px 24px; align-items:end;">
            <span style="font-size:52px; font-weight:800; letter-spacing:-.02em; line-height:1.05;">${esc(r.a)} → ${esc(r.b)}</span>
            <span style="grid-row:span 2; font-size:130px; font-weight:800; font-stretch:64%; line-height:.8;">${esc(r.t)}</span>
            <span style="font-size:30px;">${esc(r.info)}</span>
          </div>`).join('')}
      </div>`),
    L(`<div style="width:1080px; height:1440px; background:#F3F1EC; color:#111110; ${pad} display:flex; flex-direction:column;">
        ${cab(`Los momentos de ${d.mes}`, 8, 9, '#6E6C66')}
        <div style="flex:1; display:grid; grid-template-columns:1fr 1fr; gap:24px; margin-top:60px;">
          <div style="grid-column:1/-1; background:#111110; color:#F2F1EE; border-radius:36px; padding:44px; display:flex; justify-content:space-between; align-items:flex-end;"><span style="display:flex; flex-direction:column; gap:8px;"><span style="font-size:32px; color:#B3B2AE;">El viaje con más puntos</span><span style="font-size:52px; font-weight:800;">${esc(d.viaje ? piloto(d.viaje.username || 'Piloto') : '—')}</span><span style="font-size:30px; color:#B3B2AE;">${d.viaje ? `${esc(corto(nombreDe(tramoDe(d.viaje.ruta)[0])))} → ${esc(corto(nombreDe(tramoDe(d.viaje.ruta)[1])))} · ${esc(formatearTiempo(d.viaje.tiempoSegundos))}` : ''}</span></span><span style="font-size:180px; font-weight:800; font-stretch:62%; line-height:.8; color:#5AA8F2;">${d.viaje ? `+${esc(miles(d.viaje.puntos))}` : ''}</span></div>
          ${d.hitos.map((h) => `<div style="background:#fff; border-radius:36px; padding:40px; display:flex; flex-direction:column; justify-content:space-between;"><span style="font-size:30px; color:#55534D; line-height:1.25;">${esc(h.t)}</span><span style="display:flex; flex-direction:column; gap:6px;"><span style="font-size:110px; font-weight:800; font-stretch:64%; line-height:.82;">${esc(h.v)}</span><span style="font-size:32px; font-weight:700;">${esc(h.n)}</span></span></div>`).join('')}
        </div>
      </div>`),
    L(`<div style="width:1080px; height:1440px; background:#111110; color:#F2F1EE; ${pad} display:flex; flex-direction:column;">
        ${cab('Top 5 BiciRating', 9, 9)}
        <div style="margin-top:50px; display:flex; flex-direction:column;">
          ${d.top.slice(0, 5).map((t) => `<div style="display:grid; grid-template-columns:100px 1fr auto; gap:20px; align-items:center; height:126px; border-bottom:2px solid #2D2E31;"><span style="font-size:76px; font-weight:800; font-stretch:68%; color:#5AA8F2;">${esc(t.p)}</span><span style="font-size:52px; font-weight:700;">${esc(t.n)}</span><span style="font-size:64px; font-weight:800; font-stretch:72%;">${esc(t.v)}</span></div>`).join('')}
        </div>
        <div style="flex:1;"></div>
        <div style="background:#1B80E5; color:#fff; border-radius:36px; padding:44px; display:flex; flex-direction:column; gap:10px;"><span style="font-size:72px; font-weight:800; font-stretch:84%; letter-spacing:-.035em; line-height:1;">${esc(mayus(d.mesSiguiente))} empieza de cero.</span><span style="font-size:36px;">Todos a 0 puntos. Sube tu primer trayecto en bicifastness.es</span></div>
      </div>`),
  ];
}

/** 13h · Carrusel horizontal de 6, 1080 x 566. */
function laminasHorizontales(d) {
  const H = (html) => ({ w: 1080, h: 566, html });
  const hCifras = [
    { v: `${miles(d.km)} km`, t: 'pedaleados entre todos', col: '#5AA8F2' },
    ...d.cifras.slice(0, 3).map((c) => ({ v: c.v, t: c.t, col: '#F2F1EE' })),
  ];
  return [
    H(`<div style="width:1080px; height:566px; display:grid; grid-template-columns:600px 1fr; background:#111110;">
        <div style="background:#1B80E5; color:#fff; padding:44px 48px; display:flex; flex-direction:column; justify-content:space-between; position:relative; overflow:hidden; isolation:isolate;">
          <svg width="600" height="566" viewBox="0 0 600 566" style="position:absolute; inset:0; z-index:-1;"><path d="M470 120 A300 300 0 1 1 210 270" fill="none" stroke="#3F95EA" stroke-width="70" stroke-linecap="round"/><circle cx="210" cy="270" r="58" fill="#3F95EA"/></svg>
          <div style="display:flex; justify-content:space-between; font-size:24px; font-weight:700;"><span>bicifastness</span><span>01/06</span></div>
          <div style="display:flex; flex-direction:column; gap:10px;"><span style="font-size:26px; font-weight:700;">Resumen de temporada</span><span style="font-size:142px; font-weight:800; font-stretch:62%; letter-spacing:-.045em; line-height:.78;">${esc(mayus(d.mes))}</span><span style="font-size:24px; font-weight:700; margin-top:8px;">${esc(d.periodoTexto)} · desliza →</span></div>
        </div>
        <div style="color:#F2F1EE; display:grid; grid-template-rows:repeat(4,1fr);">
          ${hCifras.map((c) => `<div style="padding:0 40px; display:flex; flex-direction:column; justify-content:center; border-bottom:2px solid #2D2E31;"><span style="font-size:68px; font-weight:800; font-stretch:66%; line-height:.85; color:${c.col};">${esc(c.v)}</span><span style="font-size:20px; color:#B3B2AE;">${esc(c.t)}</span></div>`).join('')}
        </div>
      </div>`),
    H(`<div style="width:1080px; height:566px; background:#111110; color:#F2F1EE; display:grid; grid-template-columns:repeat(3,1fr); gap:2px;">
        ${d.campeones.map((c) => `<div style="background:#18191B; padding:40px 36px; display:flex; flex-direction:column; justify-content:space-between;">
            <div style="display:flex; justify-content:space-between; font-size:22px; font-weight:700;"><span style="color:#5AA8F2;">${esc(c.modo)}</span></div>
            <div style="display:flex; flex-direction:column; gap:8px;"><span style="font-size:150px; font-weight:800; font-stretch:62%; line-height:.8;">${esc(c.v)}</span><span style="font-size:22px; color:#B3B2AE;">${esc(c.uni)}</span></div>
            <div style="display:flex; flex-direction:column; gap:6px; border-top:2px solid #2D2E31; padding-top:18px;"><span style="font-size:40px; font-weight:800; letter-spacing:-.03em;">${esc(c.n)}</span><span style="font-size:19px; color:#B3B2AE;">${esc(c.extra)}</span></div>
          </div>`).join('')}
      </div>`),
    H(`<div style="width:1080px; height:566px; background:#0E0F10; color:#F2F1EE; display:grid; grid-template-columns:520px 1fr;">
        <div style="position:relative;">${mapa(520, 566, { colores: d.coloresMapa, margen: 20 })}<span style="position:absolute; left:36px; top:36px; font-size:24px; font-weight:700; background:#0E0F10; padding:8px 14px; border-radius:10px;">Quién manda en el mapa</span></div>
        <div style="padding:36px 40px; display:grid; grid-template-rows:auto repeat(5,1fr); align-items:center;">
          <div style="display:flex; justify-content:space-between; font-size:22px; color:#B3B2AE; padding-bottom:10px;"><span>Clanes · estaciones de ${esc(d.totalEstaciones)}</span><span>03/06</span></div>
          ${[...d.clanes.slice(0, 5), ...Array(Math.max(0, 5 - d.clanes.length)).fill(null)].map((c, i) => (c ? `<div style="display:grid; grid-template-columns:30px 1fr auto; gap:14px; align-items:center; height:100%; border-top:2px solid #2D2E31;">
              <span style="font-size:30px; font-weight:800; font-stretch:72%; color:#8B8A87;">${i + 1}</span>
              <span style="display:flex; flex-direction:column; gap:6px;"><span style="font-size:28px; font-weight:${i === 0 ? 800 : 600};">${esc(c.n)}</span><span style="display:block; height:8px; width:${(c.v / Math.max(1, d.clanes[0].v)) * 100}%; background:${c.c};"></span></span>
              <span style="font-size:54px; font-weight:800; font-stretch:66%; color:${c.c};">${esc(c.v)}</span>
            </div>` : '<div style="border-top:2px solid #2D2E31; height:100%;"></div>')).join('')}
        </div>
      </div>`),
    H(`<div style="width:1080px; height:566px; background:#111110; color:#F2F1EE; display:grid; grid-template-columns:repeat(7,1fr); gap:2px;">
        ${NIVELES.map((k, i) => {
    const g = d.ganadores[k];
    return `<div style="background:${i === 6 ? '#13263D' : '#18191B'}; padding:34px 16px; display:flex; flex-direction:column; align-items:center; justify-content:space-between; text-align:center;">
            <span style="font-size:20px; font-weight:700; color:#B3B2AE;">${esc(DIVISIONES[k])}</span>
            ${INSIGNIA(k, '118px')}
            <span style="display:flex; flex-direction:column; gap:6px;"><span style="font-size:19px; font-weight:800; letter-spacing:-.02em; overflow-wrap:anywhere; line-height:1.15;">${esc(g ? g.n : '—')}</span><span style="font-size:44px; font-weight:800; font-stretch:66%; color:${i === 6 ? '#5AA8F2' : '#F2F1EE'};">${esc(g ? g.v : '')}</span></span>
          </div>`;
  }).join('')}
      </div>`),
    H(`<div style="width:1080px; height:566px; background:#1B80E5; color:#fff; display:grid; grid-template-columns:repeat(4,1fr);">
        ${d.rutasMes.slice(0, 4).map((r) => `<div style="padding:40px 30px; display:flex; flex-direction:column; justify-content:space-between; border-left:2px solid rgba(255,255,255,.35);">
            <span style="font-size:20px; font-weight:700;">Ruta más peleada</span>
            <span style="font-size:34px; font-weight:800; letter-spacing:-.02em; line-height:1.05;">${esc(r.a)}<br/>→ ${esc(r.b)}</span>
            <span style="font-size:96px; font-weight:800; font-stretch:62%; letter-spacing:-.02em; line-height:.8;">${esc(r.t)}</span>
            <span style="font-size:19px; line-height:1.3;">${esc(r.info)}</span>
          </div>`).join('')}
      </div>`),
    H(`<div style="width:1080px; height:566px; background:#F3F1EC; color:#111110; display:grid; grid-template-columns:1.25fr 1fr 1fr; grid-template-rows:1fr 1fr; gap:14px; padding:14px; box-sizing:border-box;">
        <div style="grid-row:span 2; background:#111110; color:#F2F1EE; border-radius:24px; padding:34px; display:flex; flex-direction:column; justify-content:space-between;"><span style="font-size:22px; color:#B3B2AE;">El viaje con más puntos</span><span style="font-size:170px; font-weight:800; font-stretch:60%; line-height:.8; color:#5AA8F2;">${d.viaje ? `+${esc(miles(d.viaje.puntos))}` : '—'}</span><span style="display:flex; flex-direction:column; gap:4px;"><span style="font-size:36px; font-weight:800;">${esc(d.viaje ? piloto(d.viaje.username || 'Piloto') : '')}</span><span style="font-size:20px; color:#B3B2AE;">${d.viaje ? `${esc(corto(nombreDe(tramoDe(d.viaje.ruta)[0])))} → ${esc(corto(nombreDe(tramoDe(d.viaje.ruta)[1])))} · ${esc(formatearTiempo(d.viaje.tiempoSegundos))}` : ''}</span></span></div>
        ${d.hitos.map((h) => `<div style="background:#fff; border-radius:24px; padding:26px; display:flex; flex-direction:column; justify-content:space-between;"><span style="font-size:19px; color:#55534D; line-height:1.25;">${esc(h.t)}</span><span style="display:flex; flex-direction:column; gap:2px;"><span style="font-size:70px; font-weight:800; font-stretch:62%; line-height:.82;">${esc(h.v)}</span><span style="font-size:20px; font-weight:700;">${esc(h.n)}</span></span></div>`).join('')}
      </div>`),
  ];
}

// --- Datos ------------------------------------------------------------------------------

async function leer(ruta) {
  try {
    const snap = await getDoc(doc(db, ...ruta.split('/')));
    return snap.exists() ? snap.data() : null;
  } catch {
    return null;
  }
}

let crudo = null;

async function cargarCrudo() {
  const modos = ['general', 'sprint', 'fondo', 'constancia'];
  const [rk, ligas, general, indice, mapaAg, portada] = await Promise.all([
    Promise.all(modos.map((m) => leer(`agregados/ranking-${m}`))),
    leer('agregados/ligas'),
    leer('config/general'),
    leer('agregados/rutas'),
    leer('agregados/mapa'),
    leer('agregados/portada'),
  ]);
  const rankings = Object.fromEntries(modos.map((m, i) => [m, rk[i]?.filas || []]));

  // Las rutas con mas tiempos, con su record.
  const populares = Object.entries(indice?.viajesPorRuta || {}).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const rutas = (await Promise.all(populares.map(async ([ruta, n]) => {
    const ag = await leer(`agregados/ruta-${ruta}`);
    return ag?.filas?.[0] ? { ruta, n, filas: ag.filas } : null;
  }))).filter(Boolean);

  // El trayecto con mas puntos del mes en curso (los 60 con mas puntos de
  // siempre y, de esos, el primero verificado este mes).
  let viajes = [];
  try {
    const snap = await getDocs(query(collection(db, 'tiempos_viaje'), orderBy('puntos', 'desc'), limit(60)));
    viajes = snap.docs.map((d) => d.data()).filter((v) => v.estado === 'aprobado');
  } catch (error) {
    console.debug('Sin viajes', error);
  }

  let rutaSemana = null;
  if (general?.rutaDestacada) rutaSemana = { ruta: general.rutaDestacada, ag: await leer(`agregados/ruta-${general.rutaDestacada}`) };

  crudo = { rankings, ligas, general, rutas, viajes, mapa: mapaAg, portada, rutaSemana };
}

/** Lo que pintan las piezas, con los pilotos ocultos ya tachados. */
function datosDePiezas() {
  const hoy = diaMadrid();
  const [anio, mesN] = hoy.split('-').map(Number);
  const mes = MESES[mesN - 1];
  const ultimo = new Date(Date.UTC(anio, mesN, 0)).getUTCDate();
  const clanesInfo = crudo.mapa?.clanes || {};
  const colorClan = (id) => (/^#[0-9a-f]{6}$/i.test(clanesInfo[id]?.color || '') ? clanesInfo[id].color : '#B3AFA5');
  const r = crudo.rankings;
  const n = (f) => piloto(f?.nombre || '—');

  const campeones = [
    { m: 'sprint', modo: 'Sprint · el más rápido', uni: 'puntos de sprint', v: (f) => miles(f.puntos) },
    { m: 'fondo', modo: 'Fondo · el que más rueda', uni: `km en ${mes}`, v: (f) => miles(f.puntos) },
    { m: 'constancia', modo: 'Constancia · quien nunca falla', uni: 'días seguidos', v: (f) => String(f.puntos) },
  ].map((c) => {
    const f = r[c.m][0];
    return { modo: c.modo, uni: c.uni, n: f ? n(f) : '—', v: f ? c.v(f) : '0', extra: f?.viajes ? `${miles(f.viajes)} trayectos verificados` : '' };
  });

  const top = r.general.slice(0, 10).map((f, i) => ({ p: String(i + 1), n: n(f), c: colorClan(f.clan), v: miles(f.puntos) }));

  const mesTexto = hoy.slice(0, 7);
  const v = crudo.viajes.find((x) => String(x.fechaViaje || '').startsWith(mesTexto)) || null;
  const viaje = v ? { ...v, x2: v.ruta === crudo.general?.rutaDestacada } : null;

  const lunes = lunesDeLaSemana();
  const domingo = sumarDias(lunes, 6);
  const fc = (f) => `${Number(f.slice(8))} ${MESES_CORTOS[Number(f.slice(5, 7)) - 1]}`;
  const numSemana = Math.ceil(((Date.parse(`${lunes}T12:00:00Z`) - Date.UTC(anio, 0, 1)) / 864e5 + new Date(Date.UTC(anio, 0, 1)).getUTCDay() + 1) / 7);

  const rutas = crudo.rutas.map((x) => {
    const [o, d] = tramoDe(x.ruta);
    const rec = x.filas[0];
    const nuevo = rec.fecha && rec.fecha >= lunes;
    const semanas = rec.fecha ? Math.max(1, Math.round((Date.parse(`${hoy}T12:00:00Z`) - Date.parse(`${rec.fecha}T12:00:00Z`)) / (7 * 864e5))) : null;
    return {
      a: corto(nombreDe(o)), b: corto(nombreDe(d)), t: formatearTiempo(rec.marca), n: piloto(rec.nombre), nuevo,
      d: nuevo ? 'récord de esta semana' : semanas ? `aguanta ${semanas} ${semanas === 1 ? 'semana' : 'semanas'}` : 'récord',
      info: `${miles(x.n)} tiempos · ${piloto(rec.nombre)}`,
    };
  });

  const ganadores = {};
  for (const k of NIVELES) {
    const nivel = crudo.ligas?.niveles?.find((x) => x.nivel === k);
    const p = nivel?.grupos?.[0]?.podio?.[0];
    if (p) ganadores[k] = { n: piloto(p.nombre), v: miles(p.puntos) };
  }

  // Clanes y mapa.
  const est = crudo.mapa?.estaciones || {};
  const porClan = {};
  let disputadas = 0;
  const coloresMapa = {};
  for (const [cod, e] of Object.entries(est)) {
    if (e.disputa) disputadas++;
    if (e.clan) { porClan[e.clan] = (porClan[e.clan] || 0) + 1; coloresMapa[cod] = colorClan(e.clan); }
  }
  const clanes = Object.entries(porClan).sort((a, b) => b[1] - a[1]).map(([cid, v2]) => ({ n: clanesInfo[cid]?.nombre || 'Clan', c: colorClan(cid), v: v2, id: cid }));
  const totalEstaciones = Object.keys(ESTACIONES).length;
  const dominadas = clanes.reduce((t, c) => t + c.v, 0);
  const iniciales = (t) => String(t).split(/\s+/).map((p) => p[0] || '').join('').slice(0, 2).toUpperCase();
  const clanMov = clanes.slice(0, 3).map((c, i) => ({
    ini: iniciales(c.n), c: c.c, n: c.n,
    t: ['Más estaciones en su poder', 'Segundo en el mapa', 'Tercero en el mapa'][i], v: String(c.v),
  }));

  // Momentos (los que existen de verdad en la web).
  const rec = {};
  for (const x of crudo.rutas) rec[x.filas[0].nombre] = (rec[x.filas[0].nombre] || 0) + 1;
  const masRecords = Object.entries(rec).sort((a, b) => b[1] - a[1])[0];
  const masViajes = [...r.general].sort((a, b) => (b.viajes || 0) - (a.viajes || 0))[0];
  const hitos = [
    { t: 'La racha más larga sigue viva', v: r.constancia[0] ? `${r.constancia[0].puntos} días` : '—', n: n(r.constancia[0]) },
    { t: 'Más rutas con récord a su nombre', v: masRecords ? String(masRecords[1]) : '—', n: masRecords ? piloto(masRecords[0]) : '—' },
    { t: 'Más kilómetros este mes', v: r.fondo[0] ? `${miles(r.fondo[0].puntos)} km` : '—', n: n(r.fondo[0]) },
    { t: 'Más trayectos verificados', v: masViajes?.viajes ? miles(masViajes.viajes) : '—', n: n(masViajes) },
  ];

  const km = r.fondo.reduce((t, f) => t + (Number(f.puntos) || 0), 0);
  const cifras = [
    { v: miles(crudo.portada?.viajes || 0), t: 'trayectos verificados' },
    { v: miles(crudo.portada?.pilotos || 0), t: `pilotos compitiendo · ${miles(crudo.portada?.usuarios || 0)} cuentas` },
    { v: miles(Object.keys(est).length), t: `de ${totalEstaciones} estaciones con dueño o en disputa` },
    { v: miles(crudo.portada?.rutas || 0), t: 'rutas distintas con tiempo' },
  ];

  let rutaSemana = null;
  if (crudo.rutaSemana) {
    const ag = crudo.rutaSemana.ag;
    const filas = ag?.semanaDesde === lunes ? ag.semana || [] : [];
    const recH = ag?.filas?.[0];
    const [o, d] = tramoDe(crudo.rutaSemana.ruta);
    const a = ESTACIONES[o] || ESTACIONES[String(Number(o))];
    const b = ESTACIONES[d] || ESTACIONES[String(Number(d))];
    const kmR = a && b ? (Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 85) * 1.35) : null;
    rutaSemana = {
      ruta: crudo.rutaSemana.ruta,
      km: kmR ? `${coma(kmR)} km` : null,
      rec: recH ? formatearTiempo(recH.marca) : null,
      recN: recH ? piloto(recH.nombre) : null,
      top: (filas.length ? filas : ag?.filas?.slice(1) || []).slice(0, 4).map((f, i) => ({ p: String(filas.length ? i + 1 : i + 2), n: piloto(f.nombre), t: formatearTiempo(f.marca) })),
    };
  }

  return {
    mes, anio, mesSiguiente: MESES[mesN % 12],
    cerrada: false,
    cierre: `${mayus(MESES[mesN % 12])} empieza el día 1`,
    periodoTexto: `1 – ${ultimo} ${MESES_CORTOS[mesN - 1]} ${anio}`,
    semana: `Semana ${numSemana} · ${fc(lunes)} – ${fc(domingo)}`,
    campeones, top, viaje, rutas, rutasMes: rutas, ganadores, hitos, km, cifras,
    pilotos: crudo.portada?.pilotos || 0,
    clanes, clanMov, coloresMapa, totalEstaciones, numClanes: Object.keys(clanesInfo).length, dominadas, disputadas,
    libres: Math.max(0, totalEstaciones - dominadas),
    rutaSemana,
  };
}

/** Los nombres que salen en alguna pieza, para poder ocultarlos. */
function pilotosQueSalen() {
  const r = crudo.rankings;
  const nombres = new Set();
  for (const m of ['sprint', 'fondo', 'constancia']) if (r[m][0]) nombres.add(r[m][0].nombre);
  r.general.slice(0, 10).forEach((f) => nombres.add(f.nombre));
  crudo.rutas.forEach((x) => nombres.add(x.filas[0].nombre));
  crudo.ligas?.niveles?.forEach((n) => { const p = n.grupos?.[0]?.podio?.[0]; if (p) nombres.add(p.nombre); });
  if (crudo.viajes[0]?.username) nombres.add(crudo.viajes[0].username);
  return [...nombres].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

// --- Vista previa y PNG ------------------------------------------------------------------

let piezaActiva = 'campeones';
let laminas = [];

function pintarControles() {
  reemplazar(id('piezas'), Object.entries(PIEZAS).map(([clave, p]) => el('button', {
    clase: 'redes-pieza', attrs: { type: 'button', 'aria-pressed': String(clave === piezaActiva) },
    on: { click: () => { piezaActiva = clave; pintarControles(); pintar(); } },
  }, [el('span', { texto: p.titulo }), el('span', { clase: 'redes-formato', texto: p.formato })])));
  reemplazar(id('pilotos'), pilotosQueSalen().map((nombre) => el('label', { clase: 'redes-piloto' }, [
    el('input', {
      attrs: { type: 'checkbox', ...(ocultos.has(nombre) ? {} : { checked: '' }) },
      on: { change: (e) => { if (e.target.checked) ocultos.delete(nombre); else ocultos.add(nombre); pintar(); } },
    }),
    el('span', { texto: nombre }),
  ])));
}

function pintar() {
  const pieza = PIEZAS[piezaActiva];
  laminas = pieza.laminas(datosDePiezas());
  const total = laminas.reduce((t, l) => t + (l.cortes || 1), 0);
  id('vista-titulo').textContent = `Vista previa · ${pieza.titulo.toLowerCase()}`;
  const [l0] = laminas;
  id('vista-medida').textContent = l0.cortes
    ? `${l0.w} × ${l0.h} · se corta en ${l0.cortes}`
    : `${total > 1 ? `${total} × ` : ''}${l0.w} × ${l0.h}`;
  id('vista-nota').textContent = pieza.nota || '';
  id('btn-descargar').textContent = total > 1 ? `Descargar ${total} PNG (zip)` : 'Descargar PNG';
  const lienzo = id('lienzo');
  lienzo.replaceChildren();
  const ancho = Math.min(lienzo.clientWidth || 900, 1200) - 40;
  for (const l of laminas) {
    const escala = Math.min(l.cortes ? ancho / l.w : Math.min(ancho / l.w, 640 / l.h), 1);
    const caja = document.createElement('div');
    caja.className = 'redes-lamina';
    caja.style.width = `${l.w * escala}px`;
    caja.style.height = `${l.h * escala}px`;
    const dentro = document.createElement('div');
    dentro.style.cssText = `width:${l.w}px; height:${l.h}px; transform:scale(${escala}); transform-origin:0 0;`;
    // El HTML de la pieza escapa cada dato con esc(); se monta como fragmento.
    dentro.replaceChildren(document.createRange().createContextualFragment(l.html));
    caja.append(dentro);
    if (l.cortes) {
      for (let i = 1; i < l.cortes; i++) {
        const corte = document.createElement('span');
        corte.className = 'redes-corte';
        corte.style.left = `${(l.w * escala * i) / l.cortes}px`;
        caja.append(corte);
      }
    }
    lienzo.append(caja);
  }
}

/** Fichero -> data: URL, para que el SVG lo lleve dentro. */
async function aDataUrl(url, tipo) {
  const r = await fetch(url);
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${tipo};base64,${btoa(bin)}`;
}

let fuenteDatos = null;
async function prepararRecursos() {
  fuenteDatos = await aDataUrl('/assets/fonts/archivo-latin.woff2', 'font/woff2');
  const pares = await Promise.all(NIVELES.map(async (k) => [k, await aDataUrl(`/assets/img/divisiones/${k}-oscuro.svg`, 'image/svg+xml')]));
  INSIGNIAS = Object.fromEntries(pares);
}

/** Una lamina (HTML) a PNG del tamaño real, via SVG <foreignObject>. */
async function aPng(l) {
  // Dentro de <foreignObject> (XHTML) un <svg> sin su espacio de nombres no
  // se dibuja: el anillo de fondo y el logo se quedaban fuera del PNG.
  const xhtml = l.html.replace(/&nbsp;/g, '&#160;').replace(/<svg (?!xmlns)/g, '<svg xmlns="http://www.w3.org/2000/svg" ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${l.w}" height="${l.h}"><foreignObject width="100%" height="100%">`
    + `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${l.w}px; height:${l.h}px; font-family:Archivo,system-ui,sans-serif; -webkit-font-smoothing:antialiased;">`
    + `<style>@font-face{font-family:'Archivo';src:url(${fuenteDatos}) format('woff2');font-weight:100 900;font-stretch:62% 125%;}*{box-sizing:border-box}</style>`
    + `${xhtml}</div></foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  // El navegador a veces pinta antes de aplicar la letra incrustada: una pausa
  // corta y se vuelve a dibujar es lo que la deja bien siempre.
  await new Promise((ok) => setTimeout(ok, 120));
  const lienzo = document.createElement('canvas');
  lienzo.width = l.w;
  lienzo.height = l.h;
  const ctx = lienzo.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const trozos = l.cortes || 1;
  const salida = [];
  for (let i = 0; i < trozos; i++) {
    const c = document.createElement('canvas');
    c.width = l.w / trozos;
    c.height = l.h;
    c.getContext('2d').drawImage(lienzo, (l.w / trozos) * i, 0, c.width, c.height, 0, 0, c.width, c.height);
    salida.push(await new Promise((ok) => c.toBlob(ok, 'image/png')));
  }
  return salida;
}

// --- Zip sin compresion (los PNG ya van comprimidos) ---------------------------------------

const TABLA_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (const b of bytes) c = TABLA_CRC[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
async function zip(ficheros) {
  const partes = [];
  const central = [];
  let desplaz = 0;
  const enc = new TextEncoder();
  for (const { nombre, blob } of ficheros) {
    const datos = new Uint8Array(await blob.arrayBuffer());
    const n = enc.encode(nombre);
    const crc = crc32(datos);
    const cab = new DataView(new ArrayBuffer(30));
    cab.setUint32(0, 0x04034b50, true); cab.setUint16(4, 20, true); cab.setUint32(14, crc, true);
    cab.setUint32(18, datos.length, true); cab.setUint32(22, datos.length, true); cab.setUint16(26, n.length, true);
    partes.push(new Uint8Array(cab.buffer), n, datos);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint32(16, crc, true);
    cen.setUint32(20, datos.length, true); cen.setUint32(24, datos.length, true); cen.setUint16(28, n.length, true); cen.setUint32(42, desplaz, true);
    central.push(new Uint8Array(cen.buffer), n);
    desplaz += 30 + n.length + datos.length;
  }
  const tamCentral = central.reduce((t, p) => t + p.length, 0);
  const fin = new DataView(new ArrayBuffer(22));
  fin.setUint32(0, 0x06054b50, true); fin.setUint16(8, ficheros.length, true); fin.setUint16(10, ficheros.length, true);
  fin.setUint32(12, tamCentral, true); fin.setUint32(16, desplaz, true);
  return new Blob([...partes, ...central, new Uint8Array(fin.buffer)], { type: 'application/zip' });
}

function bajar(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { attrs: { href: url, download: nombre } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function descargar() {
  const boton = id('btn-descargar');
  boton.disabled = true;
  const texto = boton.textContent;
  boton.textContent = 'Preparando…';
  try {
    const base = `bicifastness-${piezaActiva}-${diaMadrid()}`;
    const pngs = (await Promise.all(laminas.map(aPng))).flat();
    if (pngs.length === 1) bajar(pngs[0], `${base}.png`);
    else bajar(await zip(pngs.map((blob, i) => ({ nombre: `${base}-${String(i + 1).padStart(2, '0')}.png`, blob }))), `${base}.zip`);
  } catch (error) {
    estado(id('mensaje'), 'No se ha podido generar el PNG en este navegador. Prueba con Chrome.', 'error');
    console.debug(error);
  } finally {
    boton.disabled = false;
    boton.textContent = texto;
  }
}

id('btn-descargar').addEventListener('click', descargar);
window.addEventListener('resize', () => { if (crudo) pintar(); });

exigirAdmin('redes').then(async () => {
  await Promise.all([document.fonts.load('800 100px Archivo'), cargarCrudo(), prepararRecursos()]);
  const [anio, mes] = diaMadrid().split('-').map(Number);
  reemplazar(id('periodo'), [el('span', { texto: `${mayus(MESES[mes - 1])} ${anio} · temporada en juego` })]);
  pintarControles();
  pintar();
}).catch((error) => {
  estado(id('mensaje'), 'No se han podido cargar los datos.', 'error');
  console.debug(error);
});
