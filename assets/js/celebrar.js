/**
 * Celebracion de lo que el juego devuelve (#51).
 *
 * Verificar un viaje, mantener la racha o subir de division son los momentos en
 * los que esto deja de ser un formulario. Si el resultado es un texto gris, no
 * enganchan.
 *
 * DOS REGLAS QUE NO SE NEGOCIAN
 *
 * 1. La animacion ACOMPANA, no bloquea. Nada de aqui retrasa que la persona
 *    pueda seguir usando la pantalla: el contenido esta puesto desde el primer
 *    momento y lo que se anima es como aparece.
 *
 * 2. Con `prefers-reduced-motion` no se mueve nada, pero SE VE TODO. Es el
 *    fallo clasico de esto: dejar las partes en `opacity: 0` y confiar en que
 *    la animacion las traiga. Cuando el sistema desactiva las animaciones — y
 *    `app.css` las desactiva con `animation: none !important` — se quedan
 *    invisibles para siempre. Aqui se anade la clase que las oculta SOLO si se
 *    van a animar de verdad.
 */

import { el } from './dom.js';

/** ¿Ha pedido esta persona que no se mueva nada? */
export function sinMovimiento() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    // Si no se puede preguntar, se asume que si: moverse de mas molesta a quien
    // lo necesita, y no moverse no molesta a nadie.
    return true;
  }
}

// --- Sonido ---------------------------------------------------------------------

const CLAVE_SONIDO = 'bf_sonido';

/**
 * El sonido va APAGADO por defecto y hay que encenderlo a proposito.
 *
 * Una web que suena sola la primera vez que la abres en el metro es una web que
 * se cierra. Y el navegador tampoco deja reproducir nada hasta que ha habido un
 * gesto, asi que encenderlo de oficio no funcionaria ni queriendo.
 */
export function sonidoActivo() {
  try { return localStorage.getItem(CLAVE_SONIDO) === '1'; } catch { return false; }
}

export function activarSonido(activo) {
  try { localStorage.setItem(CLAVE_SONIDO, activo ? '1' : '0'); } catch { /* modo privado */ }
}

export function sonar(fichero = '/sounds/notification.mp3') {
  if (!sonidoActivo()) return;
  try {
    const audio = new Audio(fichero);
    audio.volume = 0.4;
    // Sin `catch` esto tira una promesa no capturada en cuanto el navegador
    // decide que no ha habido gesto suficiente.
    audio.play().catch(() => {});
  } catch { /* sin audio, ni pasa nada */ }
}

// --- Aparicion por partes ----------------------------------------------------------

/**
 * Hace aparecer una lista de nodos uno detras de otro.
 *
 * El retraso va en una variable CSS y no en un `setTimeout` por nodo: asi lo
 * lleva el compositor del navegador y no compite con el hilo principal, que en
 * un movil normal esta ocupado pintando el resto de la pantalla.
 */
export function aparecerPorPartes(nodos, { pasoMs = 90 } = {}) {
  if (sinMovimiento()) return nodos;

  nodos.forEach((nodo, i) => {
    if (!nodo) return;
    nodo.classList.add('aparece');
    nodo.style.setProperty('--retraso', `${i * pasoMs}ms`);
  });

  return nodos;
}

/**
 * Un pulso corto sobre algo que acaba de cambiar.
 *
 * Se limpia la clase al terminar para que se pueda volver a disparar: una clase
 * que se queda puesta hace que la segunda vez no pase nada.
 */
export function destacar(nodo) {
  if (!nodo || sinMovimiento()) return nodo;

  nodo.classList.remove('pulso');
  // Forzar un reflow: sin esto, quitar y poner la clase en el mismo cuadro no
  // reinicia la animacion y el segundo pulso no se ve.
  void nodo.offsetWidth;
  nodo.classList.add('pulso');

  nodo.addEventListener('animationend', () => nodo.classList.remove('pulso'), { once: true });
  return nodo;
}

// --- Desglose de puntos ----------------------------------------------------------------

const FILAS = [
  ['base', 'Por completar el trayecto'],
  ['distancia', 'Por la distancia'],
  ['velocidad', 'Por el ritmo'],
];

const MULTIPLICADORES = [
  ['multiplicadorRacha', 'Racha'],
  ['multiplicadorRuta', 'Ruta del dia'],
  ['multiplicadorTerritorio', 'Territorio propio'],
];

/**
 * Los puntos de un viaje, contados por partes.
 *
 * Un total suelto no dice nada: quien no entiende de donde salen sus puntos no
 * puede decidir que hacer distinto manana, que es justo lo que tiene que
 * devolver un juego.
 */
export function desglosePuntos(viaje) {
  const desglose = viaje?.puntosDesglose;
  if (!desglose) return [];

  const linea = (etiqueta, valor, destacada = false) => el('div', {
    clase: 'fila separada',
    estilo: { padding: 'var(--e2) 0' },
  }, [
    el('span', { clase: destacada ? '' : 'menor apagado', texto: etiqueta }),
    el('span', { clase: 'marca', texto: valor }),
  ]);

  const nodos = FILAS
    .filter(([clave]) => (desglose[clave] || 0) > 0)
    .map(([clave, etiqueta]) => linea(etiqueta, `+${Math.round(desglose[clave])}`));

  // Los multiplicadores solo se enseñan si multiplican: un "x1" es ruido, y
  // ademas hace pensar que se ha perdido algo.
  for (const [clave, etiqueta] of MULTIPLICADORES) {
    const valor = Number(desglose[clave]) || 1;
    if (valor === 1) continue;
    nodos.push(linea(etiqueta, `x${valor.toFixed(2).replace(/\.?0+$/, '')}`));
  }

  if (typeof viaje.puntos === 'number') {
    nodos.push(el('div', {
      clase: 'fila separada',
      estilo: { padding: 'var(--e3) 0 0', borderTop: 'var(--borde)', marginTop: 'var(--e2)' },
    }, [
      el('span', { estilo: { fontWeight: '700' }, texto: 'Total' }),
      el('span', { clase: 'cifra', texto: `${viaje.puntos}` }),
    ]));
  }

  return aparecerPorPartes(nodos);
}

/**
 * Celebra un viaje recien verificado.
 *
 * Devuelve los nodos ya preparados; quien llama decide donde van. No monta
 * dialogos ni tapa la pantalla: la persona acaba de subir algo y lo que quiere
 * es ver el resultado, no cerrar una ventana.
 */
export function celebrarVerificado(viaje) {
  if (!viaje || viaje.estado !== 'aprobado') return [];

  const nodos = desglosePuntos(viaje);
  if (nodos.length) sonar();
  return nodos;
}
