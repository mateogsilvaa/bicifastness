// Modulo de la pagina /statssss/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.


import { db, collection, getDocs, query, where } from '/assets/js/firebase.js';
import { iniciarPagina } from '/assets/js/ui.js';
import { id, estado } from '/assets/js/dom.js';

iniciarPagina('');

(async () => {
  try {
    const [pilotos, viajes, clanes, estaciones] = await Promise.all([
      getDocs(collection(db, 'usuarios')),
      getDocs(query(collection(db, 'tiempos_viaje'), where('verificado', '==', true))),
      getDocs(collection(db, 'clanes')),
      getDocs(collection(db, 'estaciones_stats')),
    ]);

    const conquistadas = estaciones.docs.filter((d) => d.data().clanDominante).length;
    const formato = (n) => n.toLocaleString('es-ES');

    id('c-pilotos').textContent = formato(pilotos.size);
    id('c-viajes').textContent = formato(viajes.size);
    id('c-clanes').textContent = formato(clanes.size);
    id('c-estaciones').textContent = formato(conquistadas);

    estado(id('mensaje'), '');
    id('rejilla').hidden = false;
  } catch (error) {
    estado(id('mensaje'), `No se han podido cargar las estadisticas: ${error.message}`, 'error');
  }
})();
