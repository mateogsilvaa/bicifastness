/**
 * Como activar los avisos, explicado para el movil que tienes en la mano.
 *
 * Los avisos fallan casi siempre por lo mismo, y ninguna de esas causas se
 * arregla desde la web: en iPhone solo existen con la app en la pantalla de
 * inicio, y si alguien dijo "Bloquear" una vez, el navegador no vuelve a
 * preguntar nunca. Lo unico que se puede hacer es decir, paso a paso, donde se
 * toca. Eso es este modulo: averigua en que caso estas y pinta los pasos.
 *
 * No escribe nada ni pide permisos: eso sigue en `push.js`.
 */

import { el, icono } from './dom.js';
import { estaInstalada } from './instalar.js';
import { soportado, configurado, suscripcionActual } from './push.js';

export const esIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
export const esAndroid = () => /android/i.test(navigator.userAgent);

/**
 * En que punto esta este dispositivo:
 * - 'sin-claves'   el proyecto aun no tiene claves de envio
 * - 'ios-instalar' iPhone sin la app en la pantalla de inicio
 * - 'no-soportado' este navegador no tiene push
 * - 'bloqueado'    se dijo que no; solo se arregla en los ajustes
 * - 'activos'      ya llegan a este dispositivo
 * - 'activables'   todo listo: falta pulsar el boton
 */
export async function estadoAvisos() {
  if (!configurado()) return 'sin-claves';
  if (esIOS() && !estaInstalada()) return 'ios-instalar';
  if (!soportado() || typeof Notification === 'undefined') return 'no-soportado';
  if (Notification.permission === 'denied') return 'bloqueado';
  if (Notification.permission === 'granted' && await suscripcionActual()) return 'activos';
  return 'activables';
}

/** Los pasos para desbloquearlos, segun donde estes. */
function pasosDesbloquear() {
  if (esIOS()) {
    return ['Abre los Ajustes del iPhone.', 'Entra en Notificaciones y busca BiciFastness.', 'Activa «Permitir notificaciones» y vuelve aquí.'];
  }
  if (esAndroid() && estaInstalada()) {
    return ['Mantén pulsado el icono de BiciFastness en tu pantalla de inicio.', 'Toca «Información de la aplicación» (la i) y luego Notificaciones.', 'Actívalas y vuelve a abrir la app.'];
  }
  if (esAndroid()) {
    return ['Toca el icono que hay a la izquierda de la dirección (el candado o los ajustes).', 'Entra en Permisos o Notificaciones.', 'Elige «Permitir» y recarga la página.'];
  }
  return ['Pulsa el candado que hay a la izquierda de la dirección.', 'Busca Notificaciones y elige «Permitir».', 'Recarga la página.'];
}

const lista = (pasos) => el('ol', { clase: 'pasos-avisos' }, pasos.map((p) => el('li', { texto: p })));

/**
 * La tarjeta con la explicacion para cada estado. `null` en 'activables' y
 * 'activos': ahi lo que toca es el boton, no una explicacion.
 */
export function guiaAvisos(estado) {
  if (estado === 'sin-claves') {
    return el('div', { clase: 'guia-avisos' }, [
      icono('campana', 'icono'),
      el('div', {}, [
        el('strong', { texto: 'Los avisos llegan muy pronto' }),
        el('p', { texto: 'Te avisaremos cuando se resuelva un trayecto, cuando alguien te adelante en un tramo y cuando tu racha esté en peligro.' }),
      ]),
    ]);
  }
  if (estado === 'ios-instalar') {
    return el('div', { clase: 'guia-avisos' }, [
      icono('campana', 'icono'),
      el('div', {}, [
        el('strong', { texto: 'En iPhone, primero a la pantalla de inicio' }),
        el('p', { texto: 'Apple solo deja enviar avisos a las webs que están en la pantalla de inicio. Son 20 segundos:' }),
        lista([
          'En Safari, toca el botón Compartir (el cuadrado con la flecha hacia arriba).',
          'Baja y elige «Añadir a pantalla de inicio».',
          'Abre BiciFastness desde el icono nuevo y vuelve aquí, a Tú › Ajustes.',
          'Toca «Recibir avisos» y después «Permitir».',
        ]),
        el('p', { clase: 'menor apagado', texto: 'Hace falta iOS 16.4 o posterior.' }),
      ]),
    ]);
  }
  if (estado === 'no-soportado') {
    return el('div', { clase: 'guia-avisos' }, [
      icono('campana', 'icono'),
      el('div', {}, [
        el('strong', { texto: 'Este navegador no puede recibir avisos' }),
        el('p', { texto: esAndroid() ? 'Abre BiciFastness en Chrome y actívalos desde ahí.' : 'Prueba desde el móvil, con la app en la pantalla de inicio.' }),
      ]),
    ]);
  }
  if (estado === 'bloqueado') {
    return el('div', { clase: 'guia-avisos atencion' }, [
      icono('campana', 'icono'),
      el('div', {}, [
        el('strong', { texto: 'Los avisos están bloqueados' }),
        el('p', { texto: 'En algún momento se dijo que no, y el móvil ya no vuelve a preguntar. Se arregla así:' }),
        lista(pasosDesbloquear()),
      ]),
    ]);
  }
  return null;
}

/** Lo que se ve justo antes del permiso: que va a salir y que hay que tocar. */
export function antesDelPermiso() {
  return el('p', { clase: 'menor apagado', texto: esIOS()
    ? 'Al tocar, el iPhone te preguntará si quieres recibir notificaciones: toca «Permitir».'
    : 'Al tocar, el móvil te preguntará si permites las notificaciones: elige «Permitir».' });
}

/**
 * Un aviso de prueba, local: sale de este dispositivo y no pasa por el
 * servidor. Sirve para comprobar que el movil los enseña (modo concentracion,
 * no molestar...) sin esperar a que pase algo de verdad.
 */
export async function avisoDePrueba() {
  const registro = await navigator.serviceWorker.ready;
  await registro.showNotification('Así te llegarán los avisos', {
    body: 'Cuando se resuelva un trayecto o alguien te adelante en un tramo, saldrá aquí.',
    icon: '/images/icono/icono-192.png',
    badge: '/images/icono/icono-192.png',
    tag: 'prueba',
  });
}
