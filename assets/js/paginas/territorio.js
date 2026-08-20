// Modulo de la pagina /territorio/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// Fusiona /mapa/ y /clanes/. La estacion elegida y la pestaña viajan en la
// query string, para que un enlace a una estacion concreta se pueda compartir.

import { db, collection, getDocs } from '/assets/js/firebase.js';
import { iniciarPagina, aplicarTema } from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';

iniciarPagina('territorio');

const tema = aplicarTema();

let porClan = new Map();
let porEstacion = new Map();

// --- Mapa --------------------------------------------------------------------

const mapa = L.map('mapa', { zoomControl: true }).setView([40.4168, -3.7038], 13);

L.tileLayer(
  tema === 'dark'
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  { attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19 },
).addTo(mapa);

/**
 * Solo se admiten colores hexadecimales. Cualquier otra cosa se descarta.
 *
 * El color lo elige quien crea el clan. La version anterior lo interpolaba
 * dentro de un atributo `style`, asi que un color como `red" onload="...`
 * rompia el atributo y ejecutaba codigo.
 */
function colorSeguro(valor) {
  return /^#[0-9a-f]{3,8}$/i.test(String(valor || '')) ? valor : null;
}

const NEUTRAL = '#888888';

/** Color con el que se pinta una estacion segun quien la domine. */
function colorEstacion(numero) {
  const stats = porEstacion.get(numero);
  const clan = stats?.clanDominante ? porClan.get(stats.clanDominante) : null;
  return colorSeguro(clan?.color) || NEUTRAL;
}

// --- Ficha de estacion -------------------------------------------------------

/**
 * Ficha de la estacion seleccionada.
 *
 * Sustituye al popup del mapa: en movil un popup sobre el mapa tapa justo lo
 * que estas mirando, y ademas obliga a construir interfaz dentro de Leaflet.
 */
function pintarEstacion(propiedades) {
  const numero = String(propiedades.number || '');
  const stats = porEstacion.get(numero);
  const clan = stats?.clanDominante ? porClan.get(stats.clanDominante) : null;

  const marca = el('span', { clase: 'marca-clan', attrs: { 'aria-hidden': 'true' } });
  marca.style.background = colorEstacion(numero);

  // El GeoJSON trae el nombre como "2 - Metro Callao". El numero ya va en la
  // etiqueta de arriba, asi que repetirlo en el titulo sobra.
  const nombre = String(propiedades.Name || `Estacion ${numero}`)
    .replace(/^\s*\d+[a-zA-Z]?\s*[-–]\s*/, '');

  reemplazar(id('ficha-estacion'), el('div', {}, [
    el('p', { clase: 'etiqueta', texto: `Estacion ${numero}` }),
    el('h2', { clase: 'h2', texto: nombre }),
    propiedades.Address ? el('p', { clase: 'menor apagado', texto: propiedades.Address }) : null,

    el('div', { clase: 'fila', estilo: { marginBottom: 'var(--e4)' } }, [
      marca,
      el('span', { texto: clan ? clan.nombre : 'Territorio neutral' }),
    ]),

    stats ? el('div', { clase: 'fila', estilo: { gap: 'var(--e6)' } }, [
      el('div', {}, [
        el('p', { clase: 'etiqueta', texto: 'Puntos' }),
        el('p', { clase: 'cifra', texto: String(stats.totalPuntos || 0), estilo: { margin: '0' } }),
      ]),
    ]) : null,

    el('a', { clase: 'btn', texto: 'Competir aqui', attrs: { href: `/subir/?origen=${encodeURIComponent(numero)}` } }),
  ]));
}

function fichaVacia() {
  reemplazar(id('ficha-estacion'), el('div', { clase: 'vacio' }, [
    el('h3', { texto: 'Elige una estacion' }),
    el('p', { texto: 'Pulsa cualquier punto del mapa para ver quien la domina.' }),
  ]));
}

// --- Lista de clanes ---------------------------------------------------------

function pintarClanes() {
  const orden = [...porClan.entries()]
    .map(([clanId, datos]) => ({ clanId, ...datos }))
    .sort((a, b) => (b.biciRating || 0) - (a.biciRating || 0));

  if (!orden.length) {
    reemplazar(id('lista-clanes'), el('div', { clase: 'vacio' }, [
      el('h3', { texto: 'Todavia no hay clanes' }),
      el('p', { texto: 'Crea el primero desde tu perfil y empieza a repartirte la ciudad.' }),
    ]));
    return;
  }

  // Cuantas estaciones domina cada clan: es el dato de esta pantalla, y no
  // sale del documento del clan.
  const dominadas = new Map();
  for (const stats of porEstacion.values()) {
    if (!stats.clanDominante) continue;
    dominadas.set(stats.clanDominante, (dominadas.get(stats.clanDominante) || 0) + 1);
  }

  reemplazar(id('lista-clanes'), el('table', { clase: 'tabla' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { texto: 'Pos', clase: 'col-puesto', attrs: { scope: 'col' } }),
      el('th', { texto: 'Clan', attrs: { scope: 'col' } }),
      el('th', { texto: 'Estaciones', clase: 'col-marca', attrs: { scope: 'col' } }),
    ])]),
    el('tbody', {}, orden.map((c, i) => {
      const marca = el('span', { clase: 'marca-clan', attrs: { 'aria-hidden': 'true' } });
      marca.style.background = colorSeguro(c.color) || NEUTRAL;

      return el('tr', { clase: i === 0 ? 'record' : '' }, [
        el('td', { clase: 'col-puesto' }, [el('span', { clase: 'puesto', texto: String(i + 1) })]),
        el('td', {}, [
          el('div', { clase: 'fila' }, [marca, el('span', { clase: 'nombre', texto: c.nombre || c.clanId })]),
          el('div', { clase: 'clan', texto: `${c.biciRating || 0} puntos · ${c.numMiembros || 0} miembros` }),
        ]),
        el('td', { clase: 'col-marca' }, [
          el('span', { clase: 'marca', texto: String(dominadas.get(c.clanId) || 0) }),
        ]),
      ]);
    })),
  ]));
}

// --- Pestañas ----------------------------------------------------------------

function mostrar(pestana, { recordar = true } = {}) {
  const activa = pestana === 'clanes' ? 'clanes' : 'estaciones';

  for (const p of ['estaciones', 'clanes']) {
    id(`tab-${p}`).setAttribute('aria-selected', String(p === activa));
    id(`panel-${p}`).classList.toggle('oculto', p !== activa);
  }

  if (recordar) {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', activa);
    window.history.replaceState({}, '', url);
  }
}

for (const p of ['estaciones', 'clanes']) {
  id(`tab-${p}`).addEventListener('click', () => mostrar(p));
}

// --- Carga -------------------------------------------------------------------

async function cargar() {
  fichaVacia();

  try {
    const [clanesSnap, statsSnap, geojson] = await Promise.all([
      getDocs(collection(db, 'clanes')),
      getDocs(collection(db, 'estaciones_stats')),
      fetch('/data/emt.geojson').then((r) => {
        if (!r.ok) throw new Error('No se ha podido cargar el mapa de estaciones.');
        return r.json();
      }),
    ]);

    porClan = new Map(clanesSnap.docs.map((d) => [d.id, d.data()]));
    porEstacion = new Map(statsSnap.docs.map((d) => [d.id, d.data()]));

    L.geoJSON(geojson, {
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
        radius: 7,
        fillColor: colorEstacion(String(feature.properties.number || '')),
        color: '#fff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.9,
      }),
      onEachFeature: (feature, capa) => {
        // El detalle va al panel, no a un popup encima del mapa: en movil el
        // popup tapa justo la zona que estas mirando.
        capa.on('click', () => {
          pintarEstacion(feature.properties);
          mostrar('estaciones');

          const url = new URL(window.location.href);
          url.searchParams.set('estacion', String(feature.properties.number || ''));
          window.history.replaceState({}, '', url);
        });

        // Sin esto, el mapa entero queda fuera del alcance del teclado.
        capa.options.keyboard = true;
        capa.bindTooltip(feature.properties.Name || `Estacion ${feature.properties.number}`);
      },
    }).addTo(mapa);

    pintarClanes();

    const parametros = new URLSearchParams(window.location.search);
    mostrar(parametros.get('tab') || 'estaciones', { recordar: false });
  } catch (error) {
    console.debug('No se ha podido cargar el territorio', error);
    estado(id('mensaje'), 'No hemos podido cargar el mapa. Vuelve a intentarlo.', 'error');
  }
}

cargar();
