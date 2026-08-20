// Modulo de la pagina /
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.


import { db, collection, getDocs, query, where } from '/assets/js/firebase.js';
import { aplicarTema, montarPieLegal, montarAvisoCookies, montarNavegacion } from '/assets/js/ui.js';
import { id } from '/assets/js/dom.js';

aplicarTema();
montarNavegacion('');
montarPieLegal();
montarAvisoCookies();

// Las cifras dan credibilidad, pero la pagina tiene que servir igual si la
// consulta falla: por eso arrancan con una raya y solo se sustituyen cuando
// llegan datos. Nunca se muestra un cero que haga parecer que esto esta vacio.
(async () => {
  try {
    const [pilotos, tiempos] = await Promise.all([
      getDocs(collection(db, 'usuarios')),
      getDocs(query(collection(db, 'tiempos_viaje'), where('verificado', '==', true))),
    ]);
    if (pilotos.size) id('c-pilotos').textContent = pilotos.size.toLocaleString('es-ES');
    if (tiempos.size) id('c-tiempos').textContent = tiempos.size.toLocaleString('es-ES');
  } catch (error) {
    console.debug('Cifras no disponibles', error);
  }
})();
