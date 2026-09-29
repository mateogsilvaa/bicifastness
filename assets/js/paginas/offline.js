/**
 * Pantalla que se ve cuando no hay red (07 · 7d).
 *
 * A diferencia del resto de paginas, esta NO llama a `iniciarPagina()`: eso
 * monta navegacion, pie y metricas, y arrastra Firebase entero. La unica pagina
 * pensada para cuando no hay conexion no puede depender de un modulo que
 * intenta hablar con la red para pintarse.
 *
 * Por eso solo se aplica el tema y se lee lo que ya esta guardado en el propio
 * dispositivo (`guardarResumenOffline`).
 */

import { el, id, reemplazar } from '/assets/js/dom.js';
import { leerResumenOffline } from '/assets/js/instalar.js';
import { diaMadrid } from '/assets/js/dia.js';

// El tema, aqui mismo y no desde `ui.js`: ese modulo arrastra `errores.js` y
// `metricas.js`, que importan Firebase desde gstatic. Sin red, esa importacion
// falla y con ella TODA esta pagina, que es justo la que tiene que ir sin red.
(() => {
  let elegido = 'sistema';
  try { elegido = localStorage.getItem('theme') || 'sistema'; } catch { /* modo privado */ }
  const oscuro = elegido === 'dark' || (elegido !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', oscuro ? 'dark' : 'light');
})();

const resumen = leerResumenOffline();

if (resumen) {
  const guardado = new Date(resumen.guardadoEn);
  const hora = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(guardado);
  const mismoDia = diaMadrid(guardado) === diaMadrid();
  id('texto-offline').textContent = `Esto es lo último que sabemos de ti, guardado en este móvil ${mismoDia ? `a las ${hora}` : `el ${guardado.toLocaleDateString('es-ES')}`}.`;

  const hoySalvado = resumen.ultimoDiaActivo && diaMadrid(new Date(resumen.ultimoDiaActivo)) === diaMadrid();
  const celdas = [
    ['Racha', resumen.racha === null || resumen.racha === undefined ? null : `${resumen.racha} ${resumen.racha === 1 ? 'día' : 'días'}`, 'grande'],
    ['Hoy', resumen.racha ? (hoySalvado ? 'Salvado' : 'Aún no') : null, hoySalvado ? 'estado ok' : 'estado'],
    ['BiciRating', resumen.biciRating === undefined ? null : Number(resumen.biciRating).toLocaleString('es-ES'), 'media'],
    ['Grupo', resumen.puestoGrupo ? `${resumen.puestoGrupo}.º` : null, 'media'],
  ].filter(([, valor]) => valor !== null && valor !== undefined);

  reemplazar(id('resumen'), celdas.map(([etiqueta, valor, clase]) => el('div', {}, [
    el('span', { texto: etiqueta }),
    el('strong', { clase, texto: String(valor) }),
  ])));
  id('resumen').classList.remove('oculto');
} else {
  id('texto-offline').classList.add('oculto');
  id('sin-resumen').classList.remove('oculto');
}

id('reintentar').addEventListener('click', () => {
  // `reload` reintenta la navegacion que fallo. Si sigue sin haber red, el
  // service worker devuelve otra vez esta misma pagina.
  window.location.reload();
});
