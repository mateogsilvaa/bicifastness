/**
 * Pantalla que se ve cuando no hay red.
 *
 * A diferencia del resto de paginas, esta NO llama a `iniciarPagina()`: eso
 * monta navegacion, pie y metricas, y arrastra Firebase entero. La unica pagina
 * pensada para cuando no hay conexion no puede depender de un modulo que
 * intenta hablar con la red para pintarse.
 *
 * Por eso solo se aplica el tema y se lee lo que ya esta guardado en el propio
 * dispositivo.
 */

import { el, id, reemplazar } from '/assets/js/dom.js';
import { aplicarTema } from '/assets/js/ui.js';
import { leerResumenOffline } from '/assets/js/instalar.js';

aplicarTema();

const resumen = leerResumenOffline();

if (resumen) {
  const filas = [
    ['Piloto', resumen.username],
    ['BiciRating', resumen.biciRating],
    ['Viajes verificados', resumen.viajesVerificados],
    ['Racha', resumen.racha === null ? null : `${resumen.racha} dias`],
  ].filter(([, valor]) => valor !== null && valor !== undefined);

  reemplazar(id('resumen'),
    el('p', { clase: 'etiqueta', texto: 'Guardado en este movil' }),
    ...filas.map(([etiqueta, valor]) => el('div', { clase: 'fila' }, [
      el('span', { clase: 'menor apagado', texto: etiqueta }),
      el('span', { clase: 'cifra', texto: String(valor) }),
    ])),
    el('p', {
      clase: 'menor apagado',
      texto: `Del ${new Date(resumen.guardadoEn).toLocaleString('es-ES')}. Puede haber cambiado.`,
    }));
  id('resumen').classList.remove('oculto');
} else {
  id('sin-resumen').classList.remove('oculto');
}

id('reintentar').addEventListener('click', () => {
  // `reload` reintenta la navegacion que fallo. Si sigue sin haber red, el
  // service worker devuelve otra vez esta misma pagina.
  window.location.reload();
});
