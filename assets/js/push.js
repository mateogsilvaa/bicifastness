/**
 * Suscripcion a los avisos push (#33).
 *
 * CUANDO SE PIDE EL PERMISO, que es lo unico que de verdad importa aqui:
 * DESPUES del primer trayecto verificado, nunca al entrar. El permiso de
 * notificaciones es de una sola oportunidad — si alguien dice que no, el
 * navegador lo recuerda y no lo vuelve a preguntar — asi que pedirlo antes de
 * que la persona sepa para que sirve la app es como se pierde para siempre.
 *
 * EN iOS solo funciona con la web anadida a la pantalla de inicio. Ahi ni
 * siquiera existe el permiso hasta que se instala, asi que lo primero que se
 * ofrece es instalar (#52).
 */

import { el, reemplazar } from './dom.js';
import { estaInstalada } from './instalar.js';
import { VAPID_PUBLIC_KEY } from '../data/push-config.js';

const CLAVE_RECHAZO = 'bf_push_rechazado';

const guardado = (clave) => { try { return localStorage.getItem(clave); } catch { return null; } };
const guardar = (clave, valor) => { try { localStorage.setItem(clave, valor); } catch { /* modo privado */ } };

/** ¿Puede este navegador, aqui y ahora, recibir avisos? */
export function soportado() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  // En iOS el PushManager existe pero solo sirve con la app instalada. Ofrecer
  // el permiso fuera de ahi da un error que no se entiende.
  const esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return !esIOS || estaInstalada();
}

/** ¿Esta configurado el proyecto para poder enviar? */
export const configurado = () => Boolean(VAPID_PUBLIC_KEY) && !VAPID_PUBLIC_KEY.startsWith('__');

/**
 * La clave publica va en base64url y el navegador la quiere en bytes.
 *
 * `atob` no entiende base64url: hay que devolver el `-` y el `_` a `+` y `/` y
 * rellenar el padding. Sin esto, `subscribe()` falla con un error de clave
 * invalida que no dice nada de esto.
 */
function claveEnBytes(base64url) {
  const relleno = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + relleno).replace(/-/g, '+').replace(/_/g, '/');
  const crudo = atob(base64);
  return Uint8Array.from([...crudo].map((c) => c.charCodeAt(0)));
}

/** La suscripcion de ESTE navegador, si la hay. Sin pedir permiso. */
export async function suscripcionActual() {
  if (!soportado()) return null;
  try {
    const registro = await navigator.serviceWorker.ready;
    return await registro.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Pide permiso y se suscribe. Solo desde un gesto de la persona.
 *
 * Devuelve la suscripcion, o null si dijo que no. Quien llama tiene que
 * guardarla: aqui no se escribe en Firestore para que este modulo no dependa de
 * las acciones y se pueda probar solo.
 */
export async function suscribir() {
  if (!soportado() || !configurado()) return null;

  const permiso = await Notification.requestPermission();
  if (permiso !== 'granted') {
    // Se recuerda para no volver a ofrecerlo. El navegador ya no lo preguntaria
    // otra vez, asi que insistir solo gasta sitio en la pantalla.
    guardar(CLAVE_RECHAZO, '1');
    return null;
  }

  const registro = await navigator.serviceWorker.ready;
  return registro.pushManager.subscribe({
    // Obligatorio en todos los navegadores actuales: no se admiten
    // suscripciones silenciosas, y es lo correcto.
    userVisibleOnly: true,
    applicationServerKey: claveEnBytes(VAPID_PUBLIC_KEY),
  });
}

/** Se da de baja en este navegador. */
export async function desuscribir() {
  const suscripcion = await suscripcionActual();
  if (suscripcion) await suscripcion.unsubscribe();
  return suscripcion;
}

/**
 * Ofrece activar los avisos, si toca.
 *
 * No toca si: el navegador no puede, el proyecto no tiene claves, ya esta
 * suscrito, todavia no ha subido ningun trayecto, o ya dijo que no.
 */
export async function ofrecerAvisos(contenedor, { alAceptar }) {
  if (!contenedor || !soportado() || !configurado()) return false;
  if (guardado(CLAVE_RECHAZO)) return false;
  // La misma marca que usa la invitacion a instalar: el primer trayecto subido.
  if (!guardado('bf_primer_viaje_subido')) return false;
  if (await suscripcionActual()) return false;
  if (Notification.permission === 'denied') return false;

  reemplazar(contenedor, el('div', { clase: 'bloque pila' }, [
    el('p', { clase: 'etiqueta', texto: 'Avisos' }),
    el('h2', { clase: 'h2', texto: 'Que te avisemos cuando tu racha este en peligro' }),
    el('p', {
      clase: 'menor apagado',
      texto: 'Un aviso a las ocho de la tarde si aun no has salido, y otro cuando '
        + 'se resuelva un trayecto. Se apagan de uno en uno desde tu perfil.',
    }),
    el('div', { clase: 'fila', estilo: { flexWrap: 'wrap' } }, [
      el('button', {
        clase: 'btn',
        texto: 'Avisarme',
        on: {
          click: async (evento) => {
            const boton = evento.currentTarget;
            boton.disabled = true;
            try {
              const suscripcion = await suscribir();
              if (suscripcion) await alAceptar(suscripcion);
            } finally {
              contenedor.replaceChildren();
              contenedor.classList.add('oculto');
            }
          },
        },
      }),
      el('button', {
        clase: 'btn secundario',
        texto: 'Ahora no',
        on: {
          click: () => {
            guardar(CLAVE_RECHAZO, '1');
            contenedor.replaceChildren();
            contenedor.classList.add('oculto');
          },
        },
      }),
    ]),
  ]));

  contenedor.classList.remove('oculto');
  return true;
}
