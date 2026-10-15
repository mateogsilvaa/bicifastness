// Pantalla "En obras": mapa de estaciones en canvas + titular que rota.
// Si el módulo de estaciones no carga, la página sigue funcionando sin mapa.
import { ESTACIONES } from '/assets/data/estaciones.js';

const reducido = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const modoOscuro = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const esMovil = () => window.matchMedia('(max-width: 700px)').matches;

/* ---------- Titular que rota ---------- */
const TITULARES = ['Ajustando los radios', 'Calibrando los cronos', 'Inflando las ruedas', 'Engrasando la cadena'];
const h1 = document.getElementById('titular');
let indice = 0, fase = 0;

function rotar() {
  h1.classList.add('sale');
  setTimeout(() => {
    indice = (indice + 1) % TITULARES.length;
    fase += 1;
    h1.textContent = TITULARES[indice];
    h1.classList.remove('sale');
    reasignarClanes();
  }, 260);
}

/* ---------- Mapa ---------- */
const lienzo = document.getElementById('mapa');
const ctx = lienzo.getContext('2d');
const SEMILLAS = [[40.428, -3.703], [40.425, -3.682], [40.408, -3.700], [40.436, -3.716], [40.445, -3.690], [40.412, -3.676], [40.418, -3.724], [40.438, -3.668]];
const CLANES = ['#FF5A1F', '#13A89E', '#E23D8C'];
let puntos = [], ancho = 0, alto = 0, rafPendiente = false;

function medir() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ancho = window.innerWidth; alto = window.innerHeight;
  lienzo.width = ancho * dpr; lienzo.height = alto * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const movil = esMovil();
  const escala = Math.max(ancho / 0.152, alto / 0.18) * (movil ? 1 : 0.92);
  const cx = movil ? 0.52 : 0.5, cy = movil ? 0.36 : 0.5;
  puntos = Object.values(ESTACIONES)
    .map(e => ({ lat: e.lat, lon: e.lon, x: (e.lon + 3.69) * 0.76 * escala + ancho * cx, y: (40.425 - e.lat) * escala + alto * cy, ahora: 0, meta: 0, color: null }))
    .filter(p => p.x > -6 && p.y > -6 && p.x < ancho + 6 && p.y < alto + 6);
  reasignarClanes();
}

function reasignarClanes() {
  const activos = [0, 1, 2].map(i => ({ s: SEMILLAS[(fase * (i + 1) + i * 3) % 8], c: CLANES[i] }));
  for (const p of puntos) {
    p.meta = 0;
    for (const a of activos) {
      if (Math.hypot(a.s[0] - p.lat, (a.s[1] - p.lon) * 0.76) < 0.0145) { p.meta = 1; p.color = a.c; break; }
    }
    if (reducido) p.ahora = p.meta;
  }
  pedirDibujo();
}

function pedirDibujo() {
  if (rafPendiente) return;
  rafPendiente = true;
  requestAnimationFrame(dibujar);
}

function dibujar() {
  rafPendiente = false;
  ctx.clearRect(0, 0, ancho, alto);
  const neutro = modoOscuro() ? '#34353A' : '#CAC6BB';
  const r0 = esMovil() ? 2.6 : 3.3;
  let animando = false;
  for (const p of puntos) {
    if (p.ahora !== p.meta) {
      p.ahora += Math.sign(p.meta - p.ahora) * 0.04;
      if (Math.abs(p.meta - p.ahora) < 0.04) p.ahora = p.meta; else animando = true;
    }
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = neutro;
    ctx.beginPath(); ctx.arc(p.x, p.y, r0, 0, 6.2832); ctx.fill();
    if (p.ahora > 0 && p.color) {
      ctx.globalAlpha = p.ahora;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, r0 + 0.9, 0, 6.2832); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  if (animando) pedirDibujo();
}

medir();
window.addEventListener('resize', medir);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', pedirDibujo);
if (!reducido) setInterval(rotar, 4600);
