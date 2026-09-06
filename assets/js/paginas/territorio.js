// Modulo de la pagina /territorio/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// Fusiona /mapa/ y /clanes/. La estacion elegida y la pestaña viajan en la
// query string, para que un enlace a una estacion concreta se pueda compartir.

import { iniciarPagina, aplicarTema } from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';
import { traerAgregado } from '/assets/js/agregados.js';
import { auth, onAuthStateChanged } from '/assets/js/firebase.js';
import { iniciar as iniciarMiClan, pedirEntrada } from '/assets/js/mi-clan.js';

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

/**
 * Color de una estacion.
 *
 * Solo se pinta del color de un clan si de verdad la CONTROLA. Una estacion con
 * lider pero sin dueño se queda neutral y se marca aparte: pintarla del color
 * del que va primero por un punto daria un mapa lleno de dueños falsos, y
 * ademas taparia justo donde hay partida.
 */
function colorEstacion(numero) {
  const stats = porEstacion.get(numero);
  if (!stats?.clanDominante) return NEUTRAL;
  return colorSeguro(porClan.get(stats.clanDominante)?.color) || NEUTRAL;
}

/** Las estaciones en disputa se marcan con borde, no con color. */
function estiloEstacion(numero) {
  const stats = porEstacion.get(numero);
  const disputa = Boolean(stats?.enDisputa) && Boolean(stats?.lider);

  return {
    radius: disputa ? 8 : 7,
    fillColor: colorEstacion(numero),
    // Borde punteado y grueso: se distingue del resto sin necesidad de leyenda
    // y sin gastar un color, que en este sistema son escasos a proposito.
    color: disputa ? '#E8FF3A' : '#fff',
    weight: disputa ? 3 : 2,
    opacity: 1,
    fillOpacity: 0.9,
  };
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
      el('span', {
        texto: clan ? `Controlada por ${clan.nombre}`
          : stats?.lider ? 'En disputa'
            : 'Territorio neutral',
      }),
    ]),

    // El reparto entero, no solo quien manda: sin el, nadie entiende por que
    // pierde una estacion ni cuanto le falta para ganarla.
    stats?.cuota && Object.keys(stats.cuota).length
      ? el('div', { estilo: { marginBottom: 'var(--e4)' } }, [
        el('p', { clase: 'etiqueta', texto: 'Reparto' }),
        ...Object.entries(stats.cuota)
          .sort((a, b) => b[1] - a[1])
          .map(([clanId, pct]) => {
            const punto = el('span', { clase: 'marca-clan', attrs: { 'aria-hidden': 'true' } });
            punto.style.background = colorSeguro(porClan.get(clanId)?.color) || NEUTRAL;

            return el('div', { clase: 'fila separada', estilo: { marginBottom: 'var(--e2)' } }, [
              el('div', { clase: 'fila' }, [
                punto,
                el('span', { clase: 'menor', texto: porClan.get(clanId)?.nombre || clanId }),
              ]),
              el('span', { clase: 'marca', estilo: { fontSize: '16px' }, texto: `${pct}%` }),
            ]);
          }),
      ])
      : null,

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
      el('p', { texto: 'Crea el primero desde la pestaña Mi clan y empieza a repartirte la ciudad.' }),
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
          // Pedir entrada desde aqui. Antes esta tabla solo se miraba: el boton
          // llevaba a "crealo desde tu perfil", y en el perfil no habia nada.
          el('button', {
            clase: 'btn plano',
            texto: 'Pedir entrar',
            attrs: { type: 'button', 'aria-label': `Pedir entrar en ${c.nombre || c.clanId}` },
            on: { click: () => pedirEntrada(c.clanId) },
          }),
        ]),
      ]);
    })),
  ]));
}

// --- Pestañas ----------------------------------------------------------------

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
}

for (const p of PESTANAS) {
  id(`tab-${p}`).addEventListener('click', () => mostrar(p));
}

// La gestion del clan propio vive en su modulo (#29). Aqui solo se le dice
// cuando hay sesion: `onAuthStateChanged` salta tambien al cargar, asi que
// tambien cubre el caso de entrar ya con la sesion puesta.
onAuthStateChanged(auth, (u) => { iniciarMiClan(u); });

// --- Carga -------------------------------------------------------------------

async function cargar() {
  fichaVacia();

  try {
    // UNA lectura, no 631. Esta era la ultima pantalla que seguia recorriendo
    // colecciones enteras: todos los clanes mas un documento por estacion. Ademas
    // de la cuota, eran 631 documentos que un movil tenia que descargar y pintar
    // en la calle (#27, docs/COSTE.md).
    const [agregado, geojson] = await Promise.all([
      traerAgregado('mapa'),
      fetch('/data/emt.geojson').then((r) => {
        if (!r.ok) throw new Error('No se ha podido cargar el mapa de estaciones.');
        return r.json();
      }),
    ]);

    porClan = new Map(Object.entries(agregado?.clanes || {}));

    // El agregado llama `clan` a quien controla y `disputa` a si esta en juego;
    // el resto de la pantalla usa los nombres largos. Se traduce aqui, en un
    // sitio, en vez de repartir el detalle por toda la pantalla.
    porEstacion = new Map(Object.entries(agregado?.estaciones || {})
      .map(([id, e]) => [id, {
        clanDominante: e.clan || null,
        lider: e.lider || null,
        cuota: e.cuota || {},
        enDisputa: Boolean(e.disputa),
      }]));

    L.geoJSON(geojson, {
      pointToLayer: (feature, latlng) =>
        L.circleMarker(latlng, estiloEstacion(String(feature.properties.number || ''))),
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
