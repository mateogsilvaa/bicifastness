// Modulo de la pagina /bicirating/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.


import { db, collection, getDocs } from '/assets/js/firebase.js';
import { iniciarPagina } from '/assets/js/ui.js';
import { id, el, estado, reemplazar, imagen, esqueleto } from '/assets/js/dom.js';

iniciarPagina('bicirating');

let pilotos = [];
let clanes = [];
let vista = 'pilotos';

cargar();

async function cargar() {
  reemplazar(id('lista'), esqueleto(6, 66));
  try {
    // Lectura publica directa de Firestore. Antes venia de PocketBase a traves
    // de un tunel de ngrok, que ademas era un punto unico de fallo.
    const [usuariosSnap, clanesSnap] = await Promise.all([
      getDocs(collection(db, 'usuarios')),
      getDocs(collection(db, 'clanes')),
    ]);

    pilotos = usuariosSnap.docs
      .map((d) => ({ uid: d.id, ...d.data() }))
      .filter((u) => !u.suspendido)
      .sort((a, b) => (b.biciRating || 0) - (a.biciRating || 0));

    clanes = clanesSnap.docs
      .map((d) => ({ clanId: d.id, ...d.data() }))
      .sort((a, b) => (b.biciRating || 0) - (a.biciRating || 0));

    estado(id('mensaje'), '');
    pintar();
  } catch (error) {
    estado(id('mensaje'), `No se ha podido cargar la clasificacion: ${error.message}`, 'error');
  }
}

function pintar() {
  const datos = vista === 'pilotos' ? pilotos : clanes;

  if (!datos.length) {
    reemplazar(id('lista'), el('div', { clase: 'vacio', texto: 'Todavia no hay nadie clasificado.' }));
    return;
  }

  reemplazar(id('lista'), datos.slice(0, 100).map((item, indice) => {
    const puesto = indice + 1;
    const clase = `fila ${puesto <= 3 ? `p${puesto}` : ''}`;

    if (vista === 'pilotos') {
      const nombre = item.username || 'Piloto';
      return el('div', { clase }, [
        el('div', { clase: 'puesto', texto: `#${puesto}` }),
        imagen(item.avatarUrl || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(nombre)}&backgroundColor=0071c3`,
          { clase: 'avatar', attrs: { alt: '', loading: 'lazy' } }),
        el('div', { clase: 'nombre' }, [
          el('strong', { texto: nombre }),
          el('span', { texto: `${item.viajesVerificados || 0} viajes verificados` }),
        ]),
        el('div', { clase: 'puntos', texto: String(item.biciRating || 0) }),
      ]);
    }

    const marca = el('div', { clase: 'marca-clan' });
    marca.style.background = item.color || 'var(--primary)';

    return el('div', { clase }, [
      el('div', { clase: 'puesto', texto: `#${puesto}` }),
      marca,
      el('div', { clase: 'nombre' }, [
        el('strong', { texto: item.nombre || item.clanId }),
        el('span', { texto: `${item.numMiembros ?? (item.miembros || []).length} miembros` }),
      ]),
      el('div', { clase: 'puntos', texto: String(item.biciRating || 0) }),
    ]);
  }));
}

for (const cual of ['pilotos', 'clanes']) {
  id(`tab-${cual}`).addEventListener('click', () => {
    vista = cual;
    id('tab-pilotos').classList.toggle('activa', cual === 'pilotos');
    id('tab-clanes').classList.toggle('activa', cual === 'clanes');
    pintar();
  });
}
