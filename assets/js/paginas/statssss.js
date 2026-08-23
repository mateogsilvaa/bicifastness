// Modulo de la pagina /statssss/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// Lee de `agregados/`, NO de las colecciones. Antes traia las cuatro enteras
// para pintar cuatro numeros: 15.765 lecturas por visita con 15.000 viajes
// acumulados, un tercio de la cuota diaria de una sentada (docs/COSTE.md).
// Ahora son dos lecturas, y las repetidas dentro de la misma pestana, ninguna.

import { iniciarPagina } from '/assets/js/ui.js';
import { id, estado } from '/assets/js/dom.js';
import { traerAgregado } from '/assets/js/agregados.js';

iniciarPagina('');

(async () => {
  try {
    const [portada, mapa] = await Promise.all([
      traerAgregado('portada'),
      traerAgregado('mapa'),
    ]);

    // Que no existan todavia es normal, no es un error: el worker los crea la
    // primera vez que aprueba algo.
    if (!portada) {
      estado(id('mensaje'), 'Todavia no hay estadisticas. Vuelve cuando se verifique el primer viaje.', 'aviso');
      return;
    }

    const formato = (n) => Number(n || 0).toLocaleString('es-ES');

    id('c-pilotos').textContent = formato(portada.usuarios ?? portada.pilotos);
    id('c-viajes').textContent = formato(portada.viajes);
    id('c-clanes').textContent = formato(portada.clanes);
    id('c-estaciones').textContent = formato(mapa?.resumen?.conDueno);

    estado(id('mensaje'), '');
    id('rejilla').hidden = false;
  } catch (error) {
    estado(id('mensaje'), `No se han podido cargar las estadisticas: ${error.message}`, 'error');
  }
})();
