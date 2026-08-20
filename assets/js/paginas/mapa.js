// Modulo de la pagina /mapa/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.


import { db, collection, getDocs } from '/assets/js/firebase.js';
import { iniciarPagina, aplicarTema } from '/assets/js/ui.js';
import { id, el, reemplazar } from '/assets/js/dom.js';

const tema = aplicarTema();
iniciarPagina('mapa');

const mapa = L.map('mapa', { zoomControl: true }).setView([40.4168, -3.7038], 13);

L.tileLayer(
  tema === 'dark'
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  { attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 19 }
).addTo(mapa);

cargar();

async function cargar() {
  try {
    const [clanesSnap, statsSnap, geojson] = await Promise.all([
      getDocs(collection(db, 'clanes')),
      getDocs(collection(db, 'estaciones_stats')),
      fetch('/data/emt.geojson').then((r) => {
        if (!r.ok) throw new Error('No se ha podido cargar el mapa de estaciones.');
        return r.json();
      }),
    ]);

    const porClan = new Map(clanesSnap.docs.map((d) => [d.id, d.data()]));
    const porEstacion = new Map(statsSnap.docs.map((d) => [d.id, d.data()]));

    L.geoJSON(geojson, {
      pointToLayer: (feature, latlng) => {
        const numero = String(feature.properties.number || '');
        const stats = porEstacion.get(numero);
        const clan = stats?.clanDominante ? porClan.get(stats.clanDominante) : null;

        return L.circleMarker(latlng, {
          radius: 7,
          fillColor: colorSeguro(clan?.color) || '#888',
          color: '#fff',
          weight: 2,
          opacity: 1,
          fillOpacity: 0.9,
        });
      },
      onEachFeature: (feature, capa) => {
        const numero = String(feature.properties.number || '');
        const stats = porEstacion.get(numero);
        const clan = stats?.clanDominante ? porClan.get(stats.clanDominante) : null;

        // El popup se construye con nodos, no con una plantilla de HTML.
        // La version anterior interpolaba el nombre y el COLOR del clan
        // directamente dentro de un atributo style, y el color lo elegia quien
        // creaba el clan: `style="background:${color}"` con un color como
        // `red" onload="...` rompia el atributo y ejecutaba codigo.
        const dominio = el('span', {
          clase: 'dominio',
          texto: clan ? `Dominada por ${clan.nombre}` : 'Territorio neutral',
        });
        dominio.style.background = colorSeguro(clan?.color) || '#888';

        capa.bindPopup(el('div', { clase: 'popup' }, [
          el('h3', { texto: feature.properties.Name || `Estacion ${numero}` }),
          el('p', { texto: feature.properties.Address || '' }),
          dominio,
          el('a', {
            texto: 'Competir en esta estacion',
            attrs: { href: `/subir/?origen=${encodeURIComponent(numero)}` },
          }),
        ]), { minWidth: 230 });
      },
    }).addTo(mapa);

    pintarLeyenda(clanesSnap.docs.map((d) => d.data()), porEstacion);
  } catch (error) {
    console.error('Error inicializando el mapa', error);
  }
}

/** Solo se admiten colores hexadecimales. Cualquier otra cosa se descarta. */
function colorSeguro(valor) {
  return /^#[0-9a-f]{3,8}$/i.test(String(valor || '')) ? valor : null;
}

function pintarLeyenda(clanes, porEstacion) {
  const conteo = new Map();
  for (const stats of porEstacion.values()) {
    if (stats.clanDominante) conteo.set(stats.clanDominante, (conteo.get(stats.clanDominante) || 0) + 1);
  }

  const conTerritorio = clanes
    .filter((c) => conteo.has(c.clanId))
    .sort((a, b) => conteo.get(b.clanId) - conteo.get(a.clanId))
    .slice(0, 12);

  if (!conTerritorio.length) return;

  reemplazar(id('leyenda'), [
    el('strong', { texto: 'Dominio', estilo: { display: 'block', marginBottom: '8px' } }),
    ...conTerritorio.map((clan) => {
      const punto = el('i');
      punto.style.background = colorSeguro(clan.color) || '#888';
      return el('div', {}, [punto, el('span', { texto: `${clan.nombre} (${conteo.get(clan.clanId)})` })]);
    }),
  ]);
  id('leyenda').hidden = false;
}
