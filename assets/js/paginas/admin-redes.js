// Modulo de la pagina /admin/redes/: historias y posts para Instagram.
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// Todo se dibuja en un <canvas> con lo que ya es de la marca: la letra Archivo
// (la de la web, servida desde aqui), el anillo del logo, el azul, el papel y
// la tinta, y las insignias de division del diseño 12. Nada se pide fuera, asi
// que la imagen sale igual en cualquier ordenador y la CSP no se toca.
//
// Los datos son los de verdad y salen de los agregados que ya existen (una
// lectura cada uno), mas una consulta para el trayecto con mas puntos.
//
// Formatos: historia 1080x1920 (con margen arriba y abajo para lo que pinta
// Instagram encima) y post 1080x1350 (4:5).

import {
  db, doc, getDoc, getDocs, collection, query, orderBy, limit,
} from '/assets/js/firebase.js';
import { iniciarPagina, nombreEstacion, formatearTiempo, miles } from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';
import { montarCabeceraAdmin, exigirAdmin } from '/assets/js/admin-cabecera.js';
import { NOMBRES as DIVISIONES, fechaCorta } from '/assets/js/ligas.js';
import { diaMadrid, lunesDeLaSemana } from '/assets/js/dia.js';

iniciarPagina('admin');
montarCabeceraAdmin('redes');

// --- Marca ------------------------------------------------------------------------

const C = {
  papel: '#F3F1EC',
  blanco: '#FFFFFF',
  tinta: '#111110',
  tinta2: '#55534D',
  tinta3: '#8B8A87',
  azul: '#1B80E5',
  azulOscuro: '#1466C2',
  azulClaro: '#BFD9F7',
  lima: '#E8FF3A',
  linea: 'rgba(243, 241, 236, .14)',
};

const FORMATOS = {
  historia: { w: 1080, h: 1920, arriba: 210, abajo: 250, etiqueta: 'historia' },
  post: { w: 1080, h: 1350, arriba: 90, abajo: 90, etiqueta: 'post' },
};

let formato = 'historia';
let piezaActiva = 'campeones';
let datos = null;

// --- Lienzo ------------------------------------------------------------------------

const lienzo = id('lienzo');
const ctx = lienzo.getContext('2d');

/** Fuente de la marca: Archivo, con su anchura (80 condensada, 112 la del logo). */
function letra(peso, tam, anchura = 100) {
  ctx.font = `${peso} ${tam}px Archivo, system-ui, sans-serif`;
  if ('fontStretch' in ctx) {
    ctx.fontStretch = anchura <= 82 ? 'condensed' : anchura <= 90 ? 'semi-condensed' : anchura >= 110 ? 'semi-expanded' : 'normal';
  }
}

function texto(t, x, y, { color = C.papel, alinear = 'left', base = 'alphabetic', espaciado = 0 } = {}) {
  ctx.fillStyle = color;
  ctx.textAlign = alinear;
  ctx.textBaseline = base;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${espaciado}px`;
  ctx.fillText(String(t), x, y);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

/** Escribe `t` en una sola linea, bajando el tamaño hasta que quepa en `ancho`. */
function textoQueQuepa(t, x, y, ancho, { peso = 800, tam = 120, min = 40, anchura = 80, ...resto } = {}) {
  let tamano = tam;
  letra(peso, tamano, anchura);
  while (ctx.measureText(String(t)).width > ancho && tamano > min) {
    tamano -= 4;
    letra(peso, tamano, anchura);
  }
  texto(t, x, y, resto);
  return tamano;
}

/** Parte un texto en lineas que quepan en `ancho` con la fuente actual. */
function lineas(t, ancho) {
  const palabras = String(t).split(/\s+/);
  const salida = [];
  let actual = '';
  for (const p of palabras) {
    const prueba = actual ? `${actual} ${p}` : p;
    if (ctx.measureText(prueba).width > ancho && actual) { salida.push(actual); actual = p; } else actual = prueba;
  }
  if (actual) salida.push(actual);
  return salida;
}

function rect(x, y, w, h, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

/** El anillo del logo (24x24 en la web), a `tam` px. */
function anillo(x, y, tam, { fondo = C.azul, trazo = C.blanco } = {}) {
  const k = tam / 24;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.fillStyle = fondo;
  ctx.beginPath();
  ctx.roundRect(0, 0, 24, 24, 6.5);
  ctx.fill();
  ctx.strokeStyle = trazo;
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.stroke(new Path2D('M12 5 A7 7 0 1 1 5.94 8.5'));
  ctx.fillStyle = trazo;
  ctx.beginPath();
  ctx.arc(5.94, 8.5, 2.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * El arco del logo, enorme y a medio salir por una esquina: la firma grafica
 * de las piezas. Es el mismo trazo del anillo, no un adorno nuevo.
 */
function arcoDeFondo(f, color = C.azul, opacidad = 0.22) {
  ctx.save();
  ctx.globalAlpha = opacidad;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  const r = f.w * 0.62;
  const cx = f.w * 0.92;
  const cy = f.arriba + r * 0.35;
  ctx.lineWidth = r * 0.2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.35);
  ctx.stroke();
  ctx.fillStyle = color;
  const fin = Math.PI * 0.75;
  ctx.beginPath();
  ctx.arc(cx + r * Math.cos(fin), cy + r * Math.sin(fin), r * 0.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

const imagenes = new Map();
function imagen(src) {
  if (!imagenes.has(src)) {
    imagenes.set(src, new Promise((ok) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => ok(null);
      img.src = src;
    }));
  }
  return imagenes.get(src);
}
const insignia = (division, oscuro = true) => imagen(`/assets/img/divisiones/${division}${oscuro ? '-oscuro' : ''}.svg`);

/** Dibuja una insignia de alto `alto`, con su proporcion (80x84). */
async function dibujarInsignia(division, x, y, alto, oscuro = true) {
  const img = await insignia(division, oscuro);
  if (img) ctx.drawImage(img, x, y, alto * (80 / 84), alto);
}

// --- Partes comunes --------------------------------------------------------------

const MARGEN = 84;

/** Cabecera: logo y palabra a la izquierda, la etiqueta (temporada, liga) a la derecha. */
function cabecera(f, etiqueta, { claro = false, azul = false } = {}) {
  const y = f.arriba;
  // Sobre el azul, el anillo en tinta: azul sobre azul desaparece.
  anillo(MARGEN, y, 64, azul ? { fondo: C.tinta } : {});
  letra(800, 40, 112);
  texto('bicifastness', MARGEN + 84, y + 46, { color: claro ? C.tinta : C.papel, espaciado: -1.4 });
  if (etiqueta) {
    letra(700, 28);
    const ancho = ctx.measureText(etiqueta).width + 44;
    rect(f.w - MARGEN - ancho, y + 6, ancho, 52, 26, claro ? C.tinta : C.lima);
    texto(etiqueta, f.w - MARGEN - ancho / 2, y + 42, { color: claro ? C.papel : C.tinta, alinear: 'center' });
  }
  return y + 64;
}

/** Antetitulo azul en mayusculas y el titulo grande, condensado. Devuelve la y siguiente. */
function titular(f, antetitulo, titulo, y, { claro = false, azul = false, tam = 112 } = {}) {
  letra(800, 30, 112);
  texto(antetitulo.toUpperCase(), MARGEN, y, { color: azul ? C.lima : claro ? C.azulOscuro : C.azul, espaciado: 3 });
  letra(800, tam, 80);
  let yy = y + tam * 0.98;
  for (const l of lineas(titulo, f.w - MARGEN * 2)) {
    texto(l, MARGEN, yy, { color: azul ? C.blanco : claro ? C.tinta : C.papel, espaciado: -tam * 0.035 });
    yy += tam * 0.92;
  }
  return yy - tam * 0.92 + 44;
}

function pie(f, { claro = false, azul = false } = {}) {
  const y = f.h - f.abajo;
  ctx.fillStyle = azul ? 'rgba(255,255,255,.3)' : claro ? 'rgba(17,17,16,.12)' : C.linea;
  ctx.fillRect(MARGEN, y - 70, f.w - MARGEN * 2, 2);
  letra(600, 28);
  texto('Sube tu trayecto de BiciMAD y compite', MARGEN, y - 20, { color: azul ? 'rgba(255,255,255,.85)' : claro ? C.tinta2 : C.tinta3 });
  letra(800, 30, 112);
  texto('bicifastness.es', f.w - MARGEN, y - 20, { color: azul ? C.blanco : claro ? C.tinta : C.papel, alinear: 'right', espaciado: -1 });
}

function vacio(f, y, mensaje, claro = false) {
  letra(600, 40);
  for (const [i, l] of lineas(mensaje, f.w - MARGEN * 2).entries()) {
    texto(l, MARGEN, y + 60 + i * 52, { color: claro ? C.tinta2 : 'rgba(243,241,236,.75)' });
  }
}

const nombreMes = () => {
  const m = new Intl.DateTimeFormat('es-ES', { month: 'long', timeZone: 'UTC' }).format(new Date(`${diaMadrid()}T12:00:00Z`));
  return m.charAt(0).toUpperCase() + m.slice(1);
};
const tramo = (ruta) => {
  const [a, b] = String(ruta).split('-');
  return [nombreEstacion(a) || a, nombreEstacion(b) || b];
};

// --- Las piezas ---------------------------------------------------------------------

const PIEZAS = {
  /** Campeones de la temporada en los tres modos: Sprint, Fondo y Constancia. */
  async campeones(f) {
    fondo(f, C.tinta);
    arcoDeFondo(f);
    cabecera(f, `Temporada · ${nombreMes()}`);
    let y = titular(f, 'Campeones de la temporada', 'Rápidos, lejanos y constantes', f.arriba + 190, { tam: f.h > 1500 ? 116 : 92 });
    const modos = [
      { clave: 'sprint', nombre: 'Sprint', que: 'Velocidad', color: C.azul, tintaSobre: C.blanco, valor: (p) => `${miles(p)} pts` },
      { clave: 'fondo', nombre: 'Fondo', que: 'Distancia', color: C.papel, tintaSobre: C.tinta, valor: (p) => `${miles(p)} km` },
      { clave: 'constancia', nombre: 'Constancia', que: 'Racha', color: C.azulClaro, tintaSobre: C.tinta, valor: (p) => `${p} ${p === 1 ? 'día' : 'días'}` },
    ];
    const disponible = f.h - f.abajo - 110 - y;
    const alto = Math.min(330, (disponible - 2 * 24) / 3);
    for (const m of modos) {
      const filas = datos.rankings[m.clave] || [];
      const [p1, p2, p3] = filas;
      rect(MARGEN, y, f.w - MARGEN * 2, alto, 40, m.color);
      // En el post (4:5) las tarjetas son bajas: solo el campeon, sin el 2.º y
      // el 3.º, para que nada se monte.
      const compacta = alto < 280;
      letra(800, 28, 112);
      texto(`${m.nombre.toUpperCase()} · ${m.que.toLowerCase()}`, MARGEN + 44, y + 64, { color: m.tintaSobre, espaciado: 2 });
      if (p1) {
        const base = y + alto * (compacta ? 0.76 : 0.58);
        textoQueQuepa(p1.nombre, MARGEN + 44, base, f.w - MARGEN * 2 - 420, { tam: Math.min(alto * 0.3, 96), color: m.tintaSobre });
        textoQueQuepa(m.valor(p1.puntos), f.w - MARGEN - 44, base, 360, { tam: Math.min(alto * 0.24, 76), color: m.tintaSobre, alinear: 'right' });
        if (!compacta) {
          letra(600, 28);
          const resto = [p2, p3].filter(Boolean).map((p, i) => `${i + 2}. ${p.nombre} · ${m.valor(p.puntos)}`).join('    ');
          texto(resto, MARGEN + 44, y + alto - 44, { color: m.tintaSobre === C.blanco ? 'rgba(255,255,255,.8)' : C.tinta2 });
        }
      } else {
        letra(700, 40);
        texto('Todavía nadie: ¿serás tú?', MARGEN + 44, y + alto * 0.6, { color: m.tintaSobre });
      }
      y += alto + 24;
    }
    pie(f);
  },

  /** Los ganadores de las grandes ligas: el podio de Diamante y los lideres de Rubi. */
  async ligas(f) {
    fondo(f, C.tinta);
    arcoDeFondo(f, C.azul, 0.16);
    const l = datos.ligas;
    cabecera(f, l?.inicio ? `Liga ${fechaCorta(l.inicio).replace(/^\S+ /, '')} – ${fechaCorta(l.fin).replace(/^\S+ /, '')}` : 'Ligas');
    const diamante = l?.niveles?.find((n) => n.nivel === 'diamante');
    const rubi = l?.niveles?.find((n) => n.nivel === 'rubi');
    const arriba = diamante?.pilotos ? 'diamante' : (l?.niveles || []).find((n) => n.pilotos && n.nivel !== 'sin-clasificar')?.nivel;
    let y = f.arriba + 150;
    if (!arriba) {
      titular(f, 'Las grandes ligas', 'La escalera empieza ya', y + 40);
      vacio(f, y + 330, 'Las ligas se forman al cerrar la primera con trayectos. Sube los tuyos y entra en la escalera.');
      pie(f);
      return;
    }
    const grande = f.h > 1500 ? 300 : 220;
    await dibujarInsignia(arriba, (f.w - grande * (80 / 84)) / 2, y, grande);
    y += grande + 70;
    letra(800, 30, 112);
    texto('LA LIGA MÁS ALTA', f.w / 2, y, { color: C.azul, alinear: 'center', espaciado: 3 });
    letra(800, f.h > 1500 ? 132 : 104, 80);
    texto(DIVISIONES[arriba], f.w / 2, y + (f.h > 1500 ? 120 : 96), { alinear: 'center', espaciado: -4 });
    y += f.h > 1500 ? 180 : 140;
    const nivel = l.niveles.find((n) => n.nivel === arriba);
    const podio = nivel?.grupos?.[0]?.podio || [];
    for (const p of podio.slice(0, 3)) {
      const alto = f.h > 1500 ? 118 : 96;
      rect(MARGEN, y, f.w - MARGEN * 2, alto, 30, p.pos === 1 ? C.lima : 'rgba(243,241,236,.08)');
      const sobre = p.pos === 1 ? C.tinta : C.papel;
      letra(800, alto * 0.42, 80);
      texto(`${p.pos}`, MARGEN + 40, y + alto * 0.64, { color: sobre });
      textoQueQuepa(p.nombre, MARGEN + 110, y + alto * 0.64, f.w - MARGEN * 2 - 420, { tam: alto * 0.4, color: sobre, anchura: 100, peso: 700 });
      letra(800, alto * 0.36, 80);
      texto(`${miles(p.puntos)} pts`, f.w - MARGEN - 40, y + alto * 0.64, { color: sobre, alinear: 'right' });
      y += alto + 16;
    }
    if (arriba === 'diamante' && rubi?.grupos?.length && f.h > 1500) {
      y += 40;
      await dibujarInsignia('rubi', MARGEN, y - 10, 70);
      letra(800, 34, 112);
      texto(`Líderes de Rubí`, MARGEN + 90, y + 40, { color: C.papel });
      y += 120;
      letra(600, 32);
      for (const g of rubi.grupos.slice(0, 3)) {
        const lider = g.podio?.[0];
        if (!lider) continue;
        texto(`Grupo ${String(g.clave).split('-').pop()} · ${lider.nombre}`, MARGEN, y, { color: C.papel });
        texto(`${miles(lider.puntos)} pts`, f.w - MARGEN, y, { color: C.tinta3, alinear: 'right' });
        y += 52;
      }
    }
    pie(f);
  },

  /** El trayecto con mas puntos de la temporada. */
  async trayecto(f) {
    fondo(f, C.azul);
    arcoDeFondo(f, C.blanco, 0.14);
    cabecera(f, `Temporada · ${nombreMes()}`, { azul: true });
    const v = datos.mejorViaje;
    let y = titular(f, 'El trayecto de la temporada', 'El que más puntos ha sumado', f.arriba + 190, { azul: true, tam: f.h > 1500 ? 104 : 84 });
    if (!v) { vacio(f, y, 'Todavía no hay trayectos verificados esta temporada.'); pie(f, { azul: true }); return; }
    y += f.h > 1500 ? 60 : 20;
    letra(800, f.h > 1500 ? 330 : 240, 80);
    texto(miles(v.puntos), MARGEN - 10, y + (f.h > 1500 ? 280 : 200), { color: C.lima, espaciado: -14 });
    letra(800, 52, 112);
    texto('PUNTOS', MARGEN, y + (f.h > 1500 ? 350 : 262), { color: C.blanco, espaciado: 4 });
    y += f.h > 1500 ? 430 : 320;
    const [a, b] = tramo(v.ruta);
    letra(700, 46, 100);
    for (const l of lineas(`${a} → ${b}`, f.w - MARGEN * 2).slice(0, 2)) { texto(l, MARGEN, y, { color: C.blanco }); y += 56; }
    y += 30;
    const datosViaje = [
      ['Tiempo', formatearTiempo(v.tiempoSegundos)],
      ['Distancia', v.distanciaMetros ? `${(v.distanciaMetros / 1000).toFixed(1).replace('.', ',')} km` : '—'],
      ['Media', v.velocidadKmh ? `${Number(v.velocidadKmh).toFixed(1).replace('.', ',')} km/h` : '—'],
    ];
    const ancho = (f.w - MARGEN * 2 - 32) / 3;
    datosViaje.forEach(([k, val], i) => {
      const x = MARGEN + i * (ancho + 16);
      rect(x, y, ancho, 170, 30, 'rgba(255,255,255,.14)');
      letra(600, 28);
      texto(k, x + 30, y + 54, { color: 'rgba(255,255,255,.8)' });
      textoQueQuepa(val, x + 30, y + 128, ancho - 60, { tam: 60, color: C.blanco });
    });
    y += 230;
    letra(600, 34);
    texto(`Lo hizo ${v.username || 'un piloto'}${v.fechaViaje ? ` · ${fechaCorta(String(v.fechaViaje).slice(0, 10))}` : ''}`, MARGEN, y, { color: C.blanco });
    pie(f, { azul: true });
  },

  /** Los mas rapidos de las rutas mas transitadas. */
  async rutas(f) {
    fondo(f, C.papel);
    arcoDeFondo(f, C.azul, 0.1);
    cabecera(f, 'Récords de ruta', { claro: true });
    let y = titular(f, 'Reyes de las rutas', 'Los más rápidos de Madrid', f.arriba + 190, { claro: true, tam: f.h > 1500 ? 112 : 88 });
    const lista = datos.reyes.slice(0, f.h > 1500 ? 5 : 3);
    if (!lista.length) { vacio(f, y, 'Todavía no hay récords de ruta.', true); pie(f, { claro: true }); return; }
    const alto = Math.min(210, (f.h - f.abajo - 120 - y) / lista.length - 18);
    for (const r of lista) {
      rect(MARGEN, y, f.w - MARGEN * 2, alto, 34, C.blanco);
      const [a, b] = tramo(r.ruta);
      letra(600, 28);
      const linea = lineas(`${a} → ${b}`, f.w - MARGEN * 2 - 380)[0];
      texto(linea, MARGEN + 36, y + 56, { color: C.tinta2 });
      textoQueQuepa(r.nombre, MARGEN + 36, y + alto - 40, f.w - MARGEN * 2 - 420, { tam: alto * 0.3, color: C.tinta, anchura: 100, peso: 700 });
      letra(800, alto * 0.42, 80);
      texto(formatearTiempo(r.marca), f.w - MARGEN - 36, y + alto * 0.66, { color: C.azulOscuro, alinear: 'right', espaciado: -2 });
      y += alto + 18;
    }
    pie(f, { claro: true });
  },

  /** El top de la temporada en la clasificacion general. */
  async top(f) {
    fondo(f, C.tinta);
    arcoDeFondo(f);
    cabecera(f, `Temporada · ${nombreMes()}`);
    let y = titular(f, `Top de ${nombreMes().toLowerCase()}`, 'La clasificación general', f.arriba + 190, { tam: f.h > 1500 ? 116 : 92 });
    const filas = (datos.rankings.general || []).slice(0, f.h > 1500 ? 5 : 3);
    if (!filas.length) { vacio(f, y, 'La temporada acaba de empezar: todavía no hay nadie con puntos.'); pie(f); return; }
    const [p1, ...resto] = filas;
    const altoUno = f.h > 1500 ? 300 : 230;
    rect(MARGEN, y, f.w - MARGEN * 2, altoUno, 44, C.lima);
    if (p1.division) await dibujarInsignia(p1.division, f.w - MARGEN - 40 - altoUno * 0.5, y + 34, altoUno * 0.5, false);
    letra(800, 30, 112);
    texto('1.º', MARGEN + 44, y + 70, { color: C.tinta, espaciado: 2 });
    textoQueQuepa(p1.nombre, MARGEN + 44, y + altoUno * 0.66, f.w - MARGEN * 2 - altoUno * 0.6 - 90, { tam: altoUno * 0.28, color: C.tinta });
    letra(800, 46, 80);
    texto(`${miles(p1.puntos)} pts${p1.division ? ` · ${DIVISIONES[p1.division] || ''}` : ''}`, MARGEN + 44, y + altoUno - 40, { color: C.tinta });
    y += altoUno + 24;
    const alto = f.h > 1500 ? 120 : 100;
    for (const p of resto) {
      ctx.fillStyle = C.linea;
      ctx.fillRect(MARGEN, y + alto, f.w - MARGEN * 2, 2);
      letra(800, alto * 0.46, 80);
      texto(`${p.pos}`, MARGEN + 10, y + alto * 0.68, { color: C.tinta3 });
      if (p.division) await dibujarInsignia(p.division, MARGEN + 86, y + alto * 0.2, alto * 0.6);
      textoQueQuepa(p.nombre, MARGEN + 86 + alto * 0.6 + 28, y + alto * 0.68, f.w - MARGEN * 2 - 500, { tam: alto * 0.4, anchura: 100, peso: 700 });
      letra(800, alto * 0.4, 80);
      texto(`${miles(p.puntos)} pts`, f.w - MARGEN, y + alto * 0.68, { alinear: 'right' });
      y += alto + 8;
    }
    pie(f);
  },

  /** La ruta de la semana: el tramo y el podio de la semana. */
  async semana(f) {
    fondo(f, C.lima);
    arcoDeFondo(f, C.tinta, 0.08);
    cabecera(f, 'Ruta de la semana · ×2', { claro: true });
    const r = datos.rutaSemana;
    let y = f.arriba + 200;
    if (!r) { titular(f, 'Ruta de la semana', 'Muy pronto', y, { claro: true }); pie(f, { claro: true }); return; }
    const [a, b] = tramo(r.ruta);
    letra(800, 30, 112);
    texto('ESTA SEMANA PUNTÚA DOBLE', MARGEN, y, { color: C.tinta, espaciado: 3 });
    y += 40;
    const tam = f.h > 1500 ? 112 : 88;
    letra(800, tam, 80);
    for (const l of [...lineas(a, f.w - MARGEN * 2), `→ ${b}`].slice(0, 4)) {
      y += tam * 0.92;
      textoQueQuepa(l, MARGEN, y, f.w - MARGEN * 2, { tam, color: C.tinta });
    }
    y += 70;
    if (!r.filas.length) {
      vacio(f, y, 'Nadie tiene tiempo todavía esta semana. El primero se lleva el récord semanal.', true);
    } else {
      for (const p of r.filas.slice(0, 3)) {
        const alto = f.h > 1500 ? 120 : 100;
        rect(MARGEN, y, f.w - MARGEN * 2, alto, 30, p.pos === 1 ? C.tinta : 'rgba(17,17,16,.08)');
        const sobre = p.pos === 1 ? C.lima : C.tinta;
        letra(800, alto * 0.42, 80);
        texto(`${p.pos}`, MARGEN + 40, y + alto * 0.64, { color: sobre });
        textoQueQuepa(p.nombre, MARGEN + 110, y + alto * 0.64, f.w - MARGEN * 2 - 420, { tam: alto * 0.4, color: sobre, anchura: 100, peso: 700 });
        letra(800, alto * 0.4, 80);
        texto(formatearTiempo(p.marca), f.w - MARGEN - 40, y + alto * 0.64, { color: sobre, alinear: 'right' });
        y += alto + 16;
      }
    }
    letra(600, 30);
    texto(`${r.pilotos} ${r.pilotos === 1 ? 'piloto' : 'pilotos'} esta semana · hasta el domingo`, MARGEN, y + 40, { color: C.tinta2 });
    pie(f, { claro: true });
  },
};

const TITULOS = {
  campeones: 'Campeones de la temporada',
  ligas: 'Grandes ligas',
  trayecto: 'Trayecto con más puntos',
  rutas: 'Reyes de las rutas',
  top: 'Top de la temporada',
  semana: 'Ruta de la semana',
};

function fondo(f, color) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, f.w, f.h);
}

async function dibujar(pieza = piezaActiva) {
  const f = FORMATOS[formato];
  lienzo.width = f.w;
  lienzo.height = f.h;
  ctx.clearRect(0, 0, f.w, f.h);
  await PIEZAS[pieza](f);
}

// --- Datos -------------------------------------------------------------------------------

async function leer(ruta) {
  try {
    const snap = await getDoc(doc(db, ...ruta.split('/')));
    return snap.exists() ? snap.data() : null;
  } catch {
    return null;
  }
}

async function cargarDatos() {
  const modos = ['general', 'sprint', 'fondo', 'constancia'];
  const [rankings, ligas, general, indice] = await Promise.all([
    Promise.all(modos.map((m) => leer(`agregados/ranking-${m}`))),
    leer('agregados/ligas'),
    leer('config/general'),
    leer('agregados/rutas'),
  ]);

  // Reyes de las rutas: el record de las cinco rutas con mas viajes.
  const populares = Object.entries(indice?.viajesPorRuta || {}).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([r]) => r);
  const reyes = (await Promise.all(populares.map(async (ruta) => {
    const ag = await leer(`agregados/ruta-${ruta}`);
    const r = ag?.filas?.[0];
    return r ? { ruta, nombre: r.nombre, marca: r.marca } : null;
  }))).filter(Boolean).slice(0, 5);

  // El trayecto con mas puntos de la temporada (el mes en curso): los veinte
  // con mas puntos de siempre, y de esos el primero verificado de este mes.
  let mejorViaje = null;
  try {
    const mes = diaMadrid().slice(0, 7);
    const snap = await getDocs(query(collection(db, 'tiempos_viaje'), orderBy('puntos', 'desc'), limit(60)));
    mejorViaje = snap.docs.map((d) => d.data())
      .find((v) => v.estado === 'aprobado' && String(v.fechaViaje || '').startsWith(mes)) || null;
  } catch (error) {
    console.debug('Sin trayecto con mas puntos', error);
  }

  let rutaSemana = null;
  if (general?.rutaDestacada) {
    const ag = await leer(`agregados/ruta-${general.rutaDestacada}`);
    const deSemana = ag?.semanaDesde === lunesDeLaSemana();
    rutaSemana = {
      ruta: general.rutaDestacada,
      filas: deSemana ? ag.semana || [] : [],
      pilotos: deSemana ? ag.semanaPilotos || 0 : 0,
    };
  }

  datos = {
    rankings: Object.fromEntries(modos.map((m, i) => [m, rankings[i]?.filas || []])),
    ligas,
    reyes,
    mejorViaje,
    rutaSemana,
  };
}

// --- Controles ---------------------------------------------------------------------------

function pintarControles() {
  reemplazar(id('piezas'), Object.entries(TITULOS).map(([clave, titulo]) => el('button', {
    attrs: { type: 'button', 'aria-pressed': String(clave === piezaActiva) },
    on: { click: () => { piezaActiva = clave; pintarControles(); dibujar().catch(fallar); } },
  }, [el('span', { texto: titulo })])));
  id('formato-historia').setAttribute('aria-pressed', String(formato === 'historia'));
  id('formato-post').setAttribute('aria-pressed', String(formato === 'post'));
}

function descargarActual(pieza = piezaActiva) {
  return new Promise((ok) => {
    lienzo.toBlob((blob) => {
      if (!blob) { ok(); return; }
      const url = URL.createObjectURL(blob);
      const a = el('a', { attrs: { href: url, download: `bicifastness-${pieza}-${FORMATOS[formato].etiqueta}-${diaMadrid()}.png` } });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      ok();
    }, 'image/png');
  });
}

const fallar = (error) => { estado(id('mensaje'), 'No se ha podido dibujar la pieza.', 'error'); console.debug(error); };

id('formato-historia').addEventListener('click', () => { formato = 'historia'; pintarControles(); dibujar().catch(fallar); });
id('formato-post').addEventListener('click', () => { formato = 'post'; pintarControles(); dibujar().catch(fallar); });
id('btn-descargar').addEventListener('click', () => descargarActual());
id('btn-todas').addEventListener('click', async () => {
  for (const pieza of Object.keys(TITULOS)) {
    await dibujar(pieza);
    await descargarActual(pieza);
  }
  await dibujar();
});

exigirAdmin('redes').then(async () => {
  pintarControles();
  // La letra de la marca tiene que estar cargada ANTES de dibujar: el canvas no
  // espera a nadie y pintaria con la del sistema.
  await Promise.all([document.fonts.load('800 100px Archivo'), document.fonts.load('600 40px Archivo')]).catch(() => {});
  await cargarDatos();
  id('nota-datos').textContent = `Datos de ${new Date().toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. Vuelve a abrir la página para actualizarlos.`;
  await dibujar();
}).catch(fallar);
