// Modulo de la pagina /info/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// La pagina es texto: lo unico que hace falta es la navegacion comun.

import { iniciarPagina } from '/assets/js/ui.js';

iniciarPagina('info');

// 7f: el ancla de la seccion que se esta leyendo, en tinta.
const anclas = [...document.querySelectorAll('.anclas-info a')];
const marcar = (id) => {
  for (const a of anclas) a.toggleAttribute('aria-current', a.getAttribute('href') === `#${id}`);
};
const secciones = anclas.map((a) => document.getElementById(a.getAttribute('href').slice(1))).filter(Boolean);
if (secciones[0]) marcar(secciones[0].id);
if ('IntersectionObserver' in window) {
  const vigia = new IntersectionObserver((entradas) => {
    const visible = entradas.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (visible) marcar(visible.target.id);
  }, { rootMargin: '-80px 0px -60% 0px' });
  for (const s of secciones) vigia.observe(s);
}
