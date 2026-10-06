// Modulo de la pagina /territorio/ (05 Mapa y clanes; en escritorio 8k y 8l).
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// El mapa manda: ocupa la pantalla y todo lo demas vive en una hoja inferior
// con tres alturas (asomada, media, completa); en escritorio, un panel flotante
// de 400 px. Puntos por estacion: relleno = controlada (> 50 %), anillo = en
// disputa, gris = libre. La estacion elegida y la pestaña viajan en la URL.

import { iniciarPagina, aplicarTema } from '/assets/js/ui.js';
import { id, el, icono, estado, reemplazar } from '/assets/js/dom.js';
import { traerAgregado } from '/assets/js/agregados.js';
import { auth, onAuthStateChanged, db, doc, getDoc } from '/assets/js/firebase.js';
import { iniciar as iniciarMiClan, pedirEntrada, datosMiClan } from '/assets/js/mi-clan.js';
import { bicisEnVivo, bicisDe, textoBicis, haceCuanto, claveEstacion } from '/assets/js/bicis-vivo.js';

iniciarPagina('territorio');

const tema = aplicarTema();

let porClan = new Map();
let porEstacion = new Map();
let estaciones = [];
let rankingClanes = [];
let miClanId = null;
let haySesion = false;
let filtro = 'todos';
let elegida = null;
let ultimasBicis = null;

// --- Mapa --------------------------------------------------------------------

// En pantallas tactiles, las 685 estaciones se pintan en un <canvas>: como
// elementos SVG, cada arrastre del mapa movia 685 nodos y en un movil se notaba
// a tirones. Con raton se quedan en SVG, que es lo que permite recorrerlas con
// el teclado.
const TACTIL = window.matchMedia('(pointer: coarse)').matches;
const mapa = L.map('mapa', { zoomControl: false, attributionControl: true, preferCanvas: TACTIL })
  .setView([40.4230, -3.7000], 14);

// Teselas de Esri "Canvas" (gris claro y gris oscuro, sin etiquetas): SOLO
// las calles, sin cafeterias, tiendas ni nombres de nada. Las de OSM traian
// todos los locales del barrio encima de las estaciones, y las de CARTO salen
// con "API KEY REQUIRED". Las de Esri no piden clave; la atribucion va abajo.
document.documentElement.dataset.mapa = tema === 'dark' ? 'oscuro' : 'claro';
const BASE = tema === 'dark' ? 'World_Dark_Gray_Base' : 'World_Light_Gray_Base';
L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${BASE}/MapServer/tile/{z}/{y}/{x}`, {
  attribution: 'Calles &copy; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  // Esri Canvas llega hasta el 16; por encima se amplia la del 16.
  maxZoom: 18,
  maxNativeZoom: 16,
}).addTo(mapa);

id('zoom-mas').append(icono('mas'));
id('zoom-menos').append(el('span', { clase: 'raya-menos', attrs: { 'aria-hidden': 'true' } }));
id('centrar').append(icono('pin'));
id('buscar-bici').prepend(icono('buscar'));
id('zoom-mas').addEventListener('click', () => mapa.zoomIn());
id('zoom-menos').addEventListener('click', () => mapa.zoomOut());

// La ubicacion SOLO al pulsar: pedirla al abrir el mapa es un dialogo del
// sistema sin motivo, y la mayoria de la gente no lo necesita.
id('centrar').addEventListener('click', () => {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (p) => mapa.setView([p.coords.latitude, p.coords.longitude], 16),
    () => estado(id('mensaje'), 'No hemos podido saber dónde estás.', 'error'),
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
  );
});

/**
 * Solo se admiten colores hexadecimales. El color lo elige quien crea el clan:
 * interpolado sin mirar, `red" onload="...` ejecutaba codigo.
 */
function colorSeguro(valor) {
  return /^#[0-9a-f]{3,8}$/i.test(String(valor || '')) ? valor : null;
}

const NEUTRAL = getComputedStyle(document.documentElement).getPropertyValue('--mapa-neutro').trim() || '#CFCBC1';

/**
 * Color de una estacion. Solo se pinta del color de un clan si de verdad la
 * CONTROLA: pintarla del color del que va primero por un punto daria un mapa
 * lleno de dueños falsos, y taparia justo donde hay partida.
 */
function colorEstacion(numero) {
  const stats = porEstacion.get(numero);
  if (!stats?.clanDominante) return NEUTRAL;
  return colorSeguro(porClan.get(stats.clanDominante)?.color) || NEUTRAL;
}

/** Tamaño segun el zoom: al alejar, los puntos bajan y los libres casi desaparecen (5g). */
function radioSegunZoom() {
  const z = mapa.getZoom();
  return z >= 15 ? 7 : z >= 14 ? 5.5 : z >= 13 ? 4 : 2.4;
}

function visibleConFiltro(numero) {
  const stats = porEstacion.get(numero);
  if (filtro === 'disputa') return Boolean(stats?.enDisputa);
  if (filtro === 'miclan') return Boolean(miClanId && stats?.cuota?.[miClanId]);
  return true;
}

/** Relleno = controlada; anillo = en disputa (del color del que va primero); gris = libre. */
function estiloEstacion(numero) {
  const stats = porEstacion.get(numero);
  const disputa = Boolean(stats?.enDisputa) && Boolean(stats?.lider);
  const libre = !stats?.clanDominante && !disputa;
  const r = radioSegunZoom();
  const visible = visibleConFiltro(numero);
  const alejado = mapa.getZoom() < 13;
  const esElegida = elegida === numero;

  return {
    radius: esElegida ? r + 4 : disputa ? r + 1 : r,
    fillColor: disputa ? '#FFFFFF' : colorEstacion(numero),
    color: disputa
      ? (colorSeguro(porClan.get(stats.lider)?.color) || NEUTRAL)
      : esElegida ? getComputedStyle(document.documentElement).getPropertyValue('--tinta').trim() : '#FFFFFF',
    weight: disputa ? 3 : esElegida ? 3 : libre ? 1 : 1.5,
    opacity: visible ? 1 : 0.15,
    fillOpacity: !visible ? 0.1 : libre ? (alejado ? 0.25 : 0.85) : 0.95,
  };
}

const capas = new Map();
function repintarPuntos() {
  for (const [numero, capa] of capas) capa.setStyle(estiloEstacion(numero));
}
mapa.on('zoomend', repintarPuntos);

for (const b of document.querySelectorAll('[data-filtro]')) {
  b.addEventListener('click', () => {
    filtro = b.dataset.filtro;
    for (const x of document.querySelectorAll('[data-filtro]')) x.setAttribute('aria-pressed', String(x === b));
    repintarPuntos();
  });
}

// --- La hoja: tres alturas ---------------------------------------------------------

const hoja = id('hoja-mapa');
const ALTURAS = ['asomada', 'media', 'completa'];
const MOVIL = window.matchMedia('(max-width: 899px)');

/** Cuanto asoma la hoja en cada altura, en px. La hoja mide siempre lo mismo. */
function asoma(a) {
  const total = hoja.offsetHeight;
  if (a === 'completa') return total;
  if (a === 'media') return Math.min(total * 0.62, 440);
  return id('asa-mapa').offsetHeight + id('resumen-mapa').offsetHeight;
}

let desplazado = 0;
function colocar(y) {
  desplazado = Math.max(0, y);
  hoja.style.transform = `translate3d(0, ${desplazado}px, 0)`;
}
function recolocar() {
  if (!MOVIL.matches) { hoja.style.transform = ''; return; }
  colocar(hoja.offsetHeight - asoma(hoja.dataset.altura));
}

function altura(a) {
  hoja.dataset.altura = a;
  id('asa-mapa').setAttribute('aria-label', a === 'completa' ? 'Reducir el panel' : 'Ampliar el panel');
  // Despues de que el contenido de esa altura este puesto (el resumen se mide).
  requestAnimationFrame(recolocar);
}
window.addEventListener('resize', recolocar);
// El resumen (lo que asoma) llega despues, con los datos: se vuelve a medir.
if ('ResizeObserver' in window) {
  new ResizeObserver(() => { if (hoja.dataset.altura === 'asomada' && !arrastre) recolocar(); }).observe(id('resumen-mapa'));
}
MOVIL.addEventListener?.('change', recolocar);
requestAnimationFrame(recolocar);

// Arrastrar: la hoja sigue al dedo y al soltar encaja en la altura mas cercana
// (con un empujon si el gesto iba rapido). Un toque sin arrastre es un clic.
let arrastre = null;
let acabaDeArrastrar = false;
function empezarArrastre(e) {
  if (!MOVIL.matches || (e.pointerType === 'mouse' && e.button !== 0)) return;
  arrastre = { y0: e.clientY, base: desplazado, t0: performance.now(), movido: false };
}
id('asa-mapa').addEventListener('pointerdown', empezarArrastre);
id('resumen-mapa').addEventListener('pointerdown', empezarArrastre);
window.addEventListener('pointermove', (e) => {
  if (!arrastre) return;
  const d = e.clientY - arrastre.y0;
  if (!arrastre.movido && Math.abs(d) < 6) return;
  arrastre.movido = true;
  hoja.classList.add('arrastrando');
  const tope = hoja.offsetHeight - asoma('asomada');
  colocar(Math.min(tope, arrastre.base + d));
}, { passive: true });
window.addEventListener('pointerup', (e) => {
  if (!arrastre) return;
  const { movido, y0, t0 } = arrastre;
  arrastre = null;
  hoja.classList.remove('arrastrando');
  if (!movido) return;
  acabaDeArrastrar = true;
  setTimeout(() => { acabaDeArrastrar = false; }, 0);
  const velocidad = (e.clientY - y0) / Math.max(1, performance.now() - t0); // px/ms, + hacia abajo
  const destino = desplazado + velocidad * 180;
  const total = hoja.offsetHeight;
  const cerca = ALTURAS
    .map((a) => ({ a, y: total - asoma(a) }))
    .sort((x, y) => Math.abs(x.y - destino) - Math.abs(y.y - destino))[0].a;
  if (cerca === hoja.dataset.altura) recolocar(); else altura(cerca);
});

id('asa-mapa').addEventListener('click', () => {
  if (acabaDeArrastrar) return;
  const i = ALTURAS.indexOf(hoja.dataset.altura);
  altura(ALTURAS[(i + 1) % ALTURAS.length]);
});
id('resumen-mapa').addEventListener('click', (e) => {
  if (acabaDeArrastrar) return;
  if (e.target.closest('a')) return;
  // 5c: Mi clan y Clanes van en la hoja completa.
  if (hoja.dataset.altura === 'asomada') { altura('completa'); mostrar(miClanId ? 'miclan' : 'clanes'); }
});

// --- 5b · Estacion ---------------------------------------------------------------------

const iniciales = (n) => String(n || '').split(/\s+/).filter(Boolean).map((p) => p[0]).join('').slice(0, 3).toUpperCase();
const nombreLimpio = (n, numero) => String(n || `Estación ${numero}`).replace(/^\s*\d+[a-zA-Z]?\s*[-–]\s*/, '');

function pintarEstacion(propiedades) {
  const numero = String(propiedades.number || '');
  const stats = porEstacion.get(numero);
  const cuota = Object.entries(stats?.cuota || {}).sort((a, b) => b[1] - a[1]);
  const total = cuota.reduce((t, [, v]) => t + v, 0) || 1;
  const pct = (v) => Math.round((v / total) * 100);
  const dueno = stats?.clanDominante ? porClan.get(stats.clanDominante) : null;
  const mia = miClanId && stats?.clanDominante === miClanId;
  const chip = stats?.enDisputa
    ? el('span', { clase: 'chip-estado asedio', texto: mia || stats?.cuota?.[miClanId] ? 'En asedio' : 'En disputa' })
    : dueno ? el('span', { clase: 'chip-estado controlada', texto: mia ? 'Es de tu clan' : `De ${dueno.nombre}` })
      : el('span', { clase: 'chip-estado libre', texto: 'Libre' });

  // Con tres clanes se ven los tres; con mas, los dos primeros y "otros".
  const principales = cuota.length <= 3 ? cuota : cuota.slice(0, 2);
  const resto = cuota.length <= 3 ? [] : cuota.slice(2);
  const filas = [
    ...principales.map(([clanId, v]) => ({
      color: colorSeguro(porClan.get(clanId)?.color) || NEUTRAL,
      nombre: `${porClan.get(clanId)?.nombre || clanId}${clanId === miClanId ? ' · tu clan' : ''}`,
      valor: pct(v),
      tuyo: clanId === miClanId,
    })),
    resto.length ? { color: NEUTRAL, nombre: `Otros ${resto.length} ${resto.length === 1 ? 'clan' : 'clanes'}`, valor: resto.reduce((t, [, v]) => t + pct(v), 0) } : null,
  ].filter(Boolean);

  // Bicis y huecos ahora mismo (CityBikes, desde el navegador: no gasta cuota).
  const vivo = el('div', { clase: 'vivo-estacion', attrs: { 'aria-live': 'polite' } }, [
    el('span', { clase: 'punto-vivo', attrs: { 'aria-hidden': 'true' } }),
    el('span', { texto: 'Mirando las bicis…' }),
  ]);
  pintarVivo(vivo, numero);

  reemplazar(id('ficha-estacion'), el('div', { clase: 'ficha-estacion' }, [
    el('div', { clase: 'ficha-cabeza' }, [
      el('div', {}, [
        el('span', { clase: 'rotulo', texto: `Estación ${numero}` }),
        el('h2', { texto: nombreLimpio(propiedades.Name, numero) }),
      ]),
      chip,
    ]),
    vivo,
    cuota.length ? el('div', { clase: 'reparto-estacion' }, [
      el('div', { clase: 'barra-influencia', attrs: { role: 'img', 'aria-label': filas.map((f) => `${f.nombre} ${f.valor} %`).join(', ') } }, [
        ...filas.map((f) => el('span', { estilo: { flex: String(f.valor), background: f.color } })),
        el('i', { clase: 'linea-50', attrs: { 'aria-hidden': 'true' } }),
      ]),
      ...filas.map((f) => el('div', { clase: `fila-influencia ${f.tuyo ? 'tuya' : ''}` }, [
        el('span', { clase: 'cuadro', estilo: { background: f.color } }),
        el('span', { texto: f.nombre }),
        el('strong', { texto: String(f.valor) }),
      ])),
    ]) : el('p', { clase: 'apagado', texto: 'Nadie tiene influencia aquí todavía. El primer clan que pedalee por ella empieza a quedársela.' }),
    el('p', { clase: 'nota-territorio', texto: 'Cuenta la presencia (viajes que tocan la estación), la velocidad en sus tramos y los km. Cada día se pierde un 3 %: sin pedalear, en tres semanas se va la mitad.' }),
    el('a', {
      clase: 'btn grande', attrs: { href: '/subir/', 'data-subir': '' },
      texto: mia ? 'Competir aquí · tu clan suma ×1,10' : 'Competir aquí · ×1,10 si la controláis',
    }),
  ]));
}

/** La linea de bicis en vivo de la ficha. Sin datos, desaparece sin error. */
async function pintarVivo(nodo, numero) {
  const d = await bicisDe(numero);
  if (elegida !== numero) return; // ya se ha abierto otra estacion
  if (!d) { nodo.remove(); return; }
  const datos = await bicisEnVivo();
  reemplazar(nodo, [
    el('span', { clase: `punto-vivo ${d.enLinea ? '' : 'apagado'}`, attrs: { 'aria-hidden': 'true' } }),
    el('strong', { texto: textoBicis(d) }),
    d.bases ? el('span', { clase: 'apagado', texto: `de ${d.bases} anclajes · ${haceCuanto(datos.pedido)}` }) : null,
  ]);
}

// Mientras hay una estacion abierta, su disponibilidad se refresca cada minuto.
setInterval(() => {
  if (document.hidden || !elegida) return;
  const nodo = document.querySelector('.vivo-estacion');
  if (nodo) bicisEnVivo().then(() => pintarVivo(nodo, elegida));
}, 60 * 1000);

function fichaVacia() {
  reemplazar(id('ficha-estacion'), el('div', { clase: 'vacio-rayas' }, [
    el('strong', { texto: 'Elige una estación' }),
    el('span', { texto: 'Toca cualquier punto del mapa para ver quién la domina.' }),
  ]));
}

// --- 5a · Resumen de la hoja asomada ------------------------------------------------------

function resumenClan() {
  const destino = id('resumen-mapa');
  if (!haySesion) {
    const clanes = porClan.size;
    const conDueno = [...porEstacion.values()].filter((s) => s.clanDominante).length;
    reemplazar(destino, el('div', { clase: 'resumen-invitado' }, [
      el('span', {}, [el('strong', { texto: 'Entra para unirte a un clan' }), el('br'), el('small', { texto: `${clanes} ${clanes === 1 ? 'clan se reparte' : 'clanes se reparten'} ${conDueno} estaciones.` })]),
      el('a', { clase: 'btn', texto: 'Entrar', attrs: { href: '/entrar/' } }),
    ]));
    return;
  }
  if (!miClanId || !porClan.get(miClanId)) {
    reemplazar(destino, el('div', { clase: 'resumen-clan' }, [
      el('span', { clase: 'escudo-clan vacio', texto: '+' }),
      el('span', { clase: 'datos' }, [el('strong', { texto: 'Solo se conquista en equipo' }), el('small', { texto: 'Únete a un clan o crea el tuyo.' })]),
      icono('derecha', 'icono peq sube'),
    ]));
    return;
  }
  const clan = porClan.get(miClanId);
  const suyas = [...porEstacion.entries()].filter(([, s]) => s.clanDominante === miClanId);
  const puesto = rankingClanes.findIndex((c) => c.nombre === clan.nombre) + 1;
  const asedio = [...porEstacion.entries()]
    .filter(([, s]) => s.enDisputa && s.cuota?.[miClanId])
    .map(([n, s]) => {
      const rival = Object.entries(s.cuota).filter(([c]) => c !== miClanId).sort((a, b) => b[1] - a[1])[0]?.[0];
      return { nombre: nombreDe(n), rival: porClan.get(rival)?.nombre };
    });
  const rivales = [...new Set(asedio.map((a) => a.rival).filter(Boolean))];
  reemplazar(destino, [
    el('div', { clase: 'resumen-clan' }, [
      el('span', { clase: 'escudo-clan', estilo: { background: colorSeguro(clan.color) || 'var(--tinta-3)' }, texto: iniciales(clan.nombre) }),
      el('span', { clase: 'datos' }, [
        el('strong', { texto: clan.nombre }),
        el('small', { texto: `${suyas.length} ${suyas.length === 1 ? 'estación' : 'estaciones'}${puesto ? ` · ${puesto}.º de ${rankingClanes.length} clanes` : ''}` }),
      ]),
      icono('derecha', 'icono peq sube'),
    ]),
    asedio.length ? el('div', { clase: 'aviso atencion con-icono' }, [
      icono('aviso', 'icono'),
      el('p', { texto: `${asedio.slice(0, 2).map((a) => a.nombre).join(' y ')}${asedio.length > 2 ? ` y ${asedio.length - 2} más` : ''}, en asedio${rivales.length === 1 ? ` por ${rivales[0]}` : ''}.` }),
    ]) : null,
  ]);
}

const nombres = new Map();
const nombreDe = (numero) => nombres.get(numero) || `Estación ${numero}`;

// --- Clanes -----------------------------------------------------------------------------

function pintarClanes() {
  const dominadas = new Map();
  for (const s of porEstacion.values()) if (s.clanDominante) dominadas.set(s.clanDominante, (dominadas.get(s.clanDominante) || 0) + 1);
  const porNombre = new Map(rankingClanes.map((c) => [c.nombre, c]));
  const orden = [...porClan.entries()]
    .map(([clanId, c]) => ({ clanId, ...c, ranking: porNombre.get(c.nombre), dominadas: dominadas.get(clanId) || 0 }))
    .sort((a, b) => (a.ranking?.pos || 999) - (b.ranking?.pos || 999) || b.dominadas - a.dominadas);

  if (!orden.length) {
    reemplazar(id('lista-clanes'), el('div', { clase: 'vacio-rayas' }, [
      el('strong', { texto: 'Todavía no hay clanes' }),
      el('span', { texto: 'Crea el primero desde Mi clan y empieza a repartirte la ciudad.' }),
    ]));
    return;
  }

  reemplazar(id('lista-clanes'), el('div', { clase: 'lista-ranking clanes' }, orden.map((c, i) => el('div', { clase: `fila-clan ${c.clanId === miClanId ? 'tuya' : ''}` }, [
    el('span', { clase: 'pos', texto: String(c.ranking?.pos || i + 1) }),
    el('span', { clase: 'escudo-clan', estilo: { background: colorSeguro(c.color) || 'var(--tinta-3)' }, texto: iniciales(c.nombre) }),
    el('span', { clase: 'quien' }, [
      el('span', { clase: 'nombre', texto: c.nombre || c.clanId }),
      el('span', { clase: 'clan', texto: `${c.ranking?.viajes ?? '—'} miembros · ${c.dominadas} estaciones` }),
    ]),
    haySesion && !miClanId
      ? el('button', {
        clase: 'btn secundario pedir', texto: 'Pedir', attrs: { type: 'button', 'aria-label': `Pedir entrar en ${c.nombre || c.clanId}` },
        on: { click: () => pedirEntrada(c.clanId) },
      })
      : el('strong', { clase: 'valor', texto: String(c.ranking?.puntos ?? '') }),
  ]))));
}

// --- Pestañas ----------------------------------------------------------------------------

const PESTANAS = ['estaciones', 'clanes', 'miclan'];

function mostrar(pestana, { recordar = true } = {}) {
  const activa = PESTANAS.includes(pestana) ? pestana : 'estaciones';
  for (const p of PESTANAS) {
    id(`tab-${p}`).setAttribute('aria-selected', String(p === activa));
    id(`panel-${p}`).classList.toggle('oculto', p !== activa);
  }
  if (recordar) {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', activa);
    window.history.replaceState({}, '', url);
  }
  // 5b es media altura (la estacion); 5c, completa (Clanes y Mi clan).
  if (activa !== 'estaciones' && hoja.dataset.altura === 'media') altura('completa');
}
for (const p of PESTANAS) id(`tab-${p}`).addEventListener('click', () => mostrar(p));

// La gestion del clan propio vive en su modulo (#29).
onAuthStateChanged(auth, async (u) => {
  haySesion = Boolean(u);
  if (u) {
    try {
      const snap = await getDoc(doc(db, 'usuarios', u.uid));
      miClanId = snap.exists() ? snap.data().clanId || null : null;
    } catch {
      miClanId = null; // sin perfil, el mapa se ve igual
    }
  }
  // El mapa primero: el panel del clan cuenta estaciones y colores que salen de el.
  await listo;
  await iniciarMiClan(u, { clanes: () => porClan, estaciones: () => porEstacion, ranking: () => rankingClanes, nombreDe });
  miClanId = datosMiClan()?.clanId || miClanId;
  // La ficha abierta sabe ahora cual es tu clan ("· tu clan", "En asedio").
  const abierta = elegida && estaciones.find((f) => String(f.properties.number) === elegida);
  if (abierta) pintarEstacion(abierta.properties);
  resumenClan();
  pintarClanes();
  repintarPuntos();
});

// --- Carga --------------------------------------------------------------------------------

async function cargar() {
  fichaVacia();
  try {
    // UNA lectura del agregado, no 631 documentos (#27, docs/COSTE.md).
    const [agregado, geojson, ranking] = await Promise.all([
      traerAgregado('mapa'),
      fetch('/data/emt.geojson').then((r) => {
        if (!r.ok) throw new Error('No se ha podido cargar el mapa de estaciones.');
        return r.json();
      }),
      traerAgregado('ranking-clanes').catch(() => null),
    ]);
    rankingClanes = ranking?.filas || [];
    porClan = new Map(Object.entries(agregado?.clanes || {}));
    porEstacion = new Map(Object.entries(agregado?.estaciones || {}).map(([n, e]) => [n, {
      clanDominante: e.clan || null,
      lider: e.lider || null,
      cuota: e.cuota || {},
      enDisputa: Boolean(e.disputa),
    }]));
    estaciones = geojson.features || [];

    L.geoJSON(geojson, {
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, estiloEstacion(String(feature.properties.number || ''))),
      onEachFeature: (feature, capa) => {
        const numero = String(feature.properties.number || '');
        nombres.set(numero, nombreLimpio(feature.properties.Name, numero));
        capas.set(numero, capa);
        capa.on('click', () => elegir(feature.properties));
        // Sin esto, el mapa entero queda fuera del alcance del teclado.
        capa.options.keyboard = true;
        const stats = porEstacion.get(numero);
        const dueno = stats?.clanDominante ? porClan.get(stats.clanDominante)?.nombre : null;
        const cuota = dueno ? Math.round(stats.cuota[stats.clanDominante] || 0) : null;
        const base = `${nombreLimpio(feature.properties.Name, numero)}${dueno ? ` · ${dueno} · ${cuota}` : stats?.enDisputa ? ' · en disputa' : ''}`;
        capa.bindTooltip(base, { className: 'tooltip-mapa', direction: 'top' });
        // Al pasar por encima, con las bicis de ahora si ya se han pedido.
        capa.on('mouseover', () => {
          const d = ultimasBicis?.estaciones?.[claveEstacion(numero)];
          capa.setTooltipContent(d ? `${base} · ${textoBicis(d)}` : base);
        });
      },
    }).addTo(mapa);

    resumenClan();
    pintarClanes();
    // Las bicis de todas las estaciones, para los tooltips: una peticion a
    // CityBikes, no a Firestore.
    bicisEnVivo().then((d) => { ultimasBicis = d; });

    const parametros = new URLSearchParams(window.location.search);
    const pedida = parametros.get('estacion');
    const feature = pedida && estaciones.find((f) => String(f.properties.number) === pedida);
    if (feature) elegir(feature.properties, { centrar: true });
    else mostrar(parametros.get('tab') || (parametros.get('clan') ? 'clanes' : 'estaciones'), { recordar: false });
    if (parametros.get('tab') || parametros.get('clan')) altura(parametros.get('tab') === 'estaciones' ? 'media' : 'completa');
  } catch (error) {
    console.debug('No se ha podido cargar el territorio', error);
    estado(id('mensaje'), 'No hemos podido cargar el mapa. Vuelve a intentarlo.', 'error');
  }
}

function elegir(propiedades, { centrar = false } = {}) {
  const anterior = elegida;
  elegida = String(propiedades.number || '');
  pintarEstacion(propiedades);
  mostrar('estaciones');
  if (hoja.dataset.altura === 'asomada') altura('media');
  if (anterior && capas.get(anterior)) capas.get(anterior).setStyle(estiloEstacion(anterior));
  capas.get(elegida)?.setStyle(estiloEstacion(elegida));
  if (centrar) {
    const [lon, lat] = estaciones.find((f) => String(f.properties.number) === elegida)?.geometry?.coordinates || [];
    if (lat) mapa.setView([lat, lon], 16);
  }
  const url = new URL(window.location.href);
  url.searchParams.set('estacion', elegida);
  window.history.replaceState({}, '', url);
}

const listo = cargar();
