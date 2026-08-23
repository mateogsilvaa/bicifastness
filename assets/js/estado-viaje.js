/**
 * El viaje recien subido, en vivo.
 *
 * El worker tarda unos diez minutos. Hasta ahora, durante ese rato la pantalla
 * decia "puedes seguir el estado en tu perfil" y ahi se acababa: quien queria
 * saber algo tenia que recargar el perfil cada pocos minutos, y quien no lo
 * hacia se iba sin enterarse de que su viaje habia sido rechazado.
 *
 * COSTE, que aqui es lo que manda. `onSnapshot` factura una lectura por cada
 * documento que cambia mientras se escucha, y el plan gratuito da cincuenta mil
 * al dia. Por eso:
 *
 *   - se escucha UN documento, el del viaje recien subido. Nunca la coleccion:
 *     eso serian tantas lecturas como viajes tenga la persona, cada vez que se
 *     mueva cualquiera de ellos
 *   - se corta en cuanto el worker dicta veredicto. Lo que pase despues (que un
 *     administrador resuelva una revision) puede tardar horas y no justifica
 *     tener una conexion abierta
 *   - se corta tambien al salir de la pagina. Sin esto, moverse por el sitio va
 *     dejando escuchas colgando
 *
 * Que viaje seguir se guarda en `sessionStorage`, no en `localStorage`: muere
 * con la pestaña, que es exactamente lo que dura el interes por esto.
 */

import { db, doc, onSnapshot } from './firebase.js';
import { el, reemplazar } from './dom.js';
import { estadoDeViaje, motivoDeViaje } from './motivos.js';
import { celebrarVerificado } from '/assets/js/celebrar.js';

const CLAVE = 'viaje-en-curso';

/** Estados en los que ya no hay nada mas que esperar del worker. */
const RESUELTOS = ['aprobado', 'rechazado', 'revision'];

// --- Que viaje seguir ---------------------------------------------------------

/** Apunta el viaje recien subido para que la portada pueda seguirlo. */
export function recordarViaje(id) {
  try { sessionStorage.setItem(CLAVE, id); } catch { /* modo privado: se pierde y ya */ }
}

export function viajeRecordado() {
  try { return sessionStorage.getItem(CLAVE); } catch { return null; }
}

export function olvidarViaje() {
  try { sessionStorage.removeItem(CLAVE); } catch { /* idem */ }
}

// --- Suscripcion --------------------------------------------------------------

/**
 * Escucha un viaje hasta que se resuelva.
 *
 * @param {string} viajeId
 * @param {(viaje: object|null) => void} alCambiar
 * @returns {() => void} corta la escucha; se puede llamar mas de una vez
 */
export function seguirViaje(viajeId, alCambiar) {
  let parar = null;
  let cortado = false;

  const cancelar = () => {
    if (cortado) return;
    cortado = true;
    window.removeEventListener('pagehide', cancelar);
    // `parar` puede no estar todavia si esto se llama antes de que
    // `onSnapshot` devuelva. La bandera lo cubre: al asignarse se cancela.
    if (parar) parar();
  };

  parar = onSnapshot(
    doc(db, 'tiempos_viaje', viajeId),
    (snap) => {
      if (cortado) return;
      if (!snap.exists()) { alCambiar(null); cancelar(); return; }

      const viaje = { id: snap.id, ...snap.data() };
      alCambiar(viaje);
      if (RESUELTOS.includes(viaje.estado)) cancelar();
    },
    () => {
      // Sin sesion o sin permiso no hay nada que enseñar, y desde luego no un
      // error: el viaje esta subido igual.
      cancelar();
      alCambiar(null);
    }
  );

  if (cortado) parar();
  window.addEventListener('pagehide', cancelar);
  return cancelar;
}

// --- Pintado ------------------------------------------------------------------

/**
 * Tarjeta con el estado del viaje y, si se ha rechazado, por que.
 *
 * El motivo sale SIEMPRE de `motivos.js`, nunca de `auditoria.señales[].mensaje`:
 * esos mensajes llevan los numeros del antifraude dentro.
 *
 * @param {object} viaje
 * @param {object} [opciones]
 * @param {boolean} [opciones.conEnlace]  añade el enlace al historial
 */
export function tarjetaEstado(viaje, { conEnlace = true } = {}) {
  const textos = estadoDeViaje(viaje?.estado || 'pendiente');
  const rechazado = viaje?.estado === 'rechazado';
  const motivo = rechazado ? motivoDeViaje(viaje) : null;

  return el('div', { clase: 'bloque' }, [
    el('div', { clase: 'fila separada' }, [
      el('p', { clase: 'etiqueta', texto: 'Tu ultimo trayecto', estilo: { margin: '0' } }),
      el('span', { clase: `chip ${textos.chip}`, texto: textos.titulo }),
    ]),

    el('p', { texto: textos.texto, estilo: { marginBottom: '0' } }),

    // De donde salen los puntos, por partes (#51). Un total suelto no dice
    // nada: quien no entiende como se han sumado no puede decidir que hacer
    // distinto manana.
    viaje?.estado === 'aprobado' && viaje?.puntosDesglose
      ? el('div', { estilo: { marginTop: 'var(--e4)' } }, celebrarVerificado(viaje))
      : null,

    motivo
      ? el('div', { clase: 'aviso error', estilo: { marginTop: 'var(--e4)', marginBottom: '0' } }, [
        el('p', { clase: 'etiqueta', texto: motivo.dePersona ? 'Lo que dice quien lo ha revisado' : 'Motivo' }),
        el('p', { texto: motivo.texto }),
        motivo.queHacer ? el('p', { clase: 'menor apagado', texto: motivo.queHacer }) : null,
      ])
      : null,

    // El derecho a que lo mire una persona (art. 22.3 RGPD) se ejerce desde el
    // historial, que es donde esta el formulario de alegacion. Aqui solo se
    // enseña la puerta.
    rechazado && viaje?.revisadoPor === 'automatico' && !viaje?.impugnado
      ? el('p', { clase: 'menor', estilo: { marginBottom: '0' } }, [
        el('a', { texto: 'Si crees que es un error, puedes pedir que lo revise una persona', attrs: { href: '/yo/' } }),
      ])
      : null,

    conEnlace
      ? el('a', {
        clase: 'btn secundario',
        texto: 'Ver mi historial',
        attrs: { href: '/yo/' },
        estilo: { marginTop: 'var(--e4)' },
      })
      : null,
  ]);
}

/** Pinta la tarjeta dentro de un contenedor, con region viva para el lector. */
export function pintarEstado(contenedor, viaje, opciones) {
  contenedor.setAttribute('aria-live', 'polite');
  reemplazar(contenedor, tarjetaEstado(viaje, opciones));
}
