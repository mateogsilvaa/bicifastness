// Modulo de la pagina /info/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.


import { iniciarPagina } from '/assets/js/ui.js';
iniciarPagina('info');
