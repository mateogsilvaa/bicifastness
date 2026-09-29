/**
 * Instalacion en la pantalla de inicio, y estado offline.
 *
 * Dos motivos concretos para que esto exista, mas alla del icono:
 *
 *   1. En iOS **no hay avisos push** si la web no esta anadida a la pantalla de
 *      inicio. Sin esto, la mitad de los usuarios se queda sin avisos (#33).
 *   2. Un icono en la pantalla de inicio es un recordatorio diario gratis.
 *
 * La invitacion aparece DESPUES del primer viaje subido, nunca al entrar.
 * Pedirlo de entrada, antes de que la persona sepa para que sirve la app, es
 * como se pierde el permiso para siempre: el navegador recuerda el rechazo y no
 * lo vuelve a ofrecer.
 */

import { el, icono, reemplazar, anilloLogo, rechazadoHace } from './dom.js';

const CLAVE_RESUMEN = 'bf_ultimo_resumen';
const CLAVE_RECHAZO = 'bf_instalar_rechazado';
const CLAVE_VIAJE_SUBIDO = 'bf_primer_viaje_subido';

let eventoInstalacion = null;

// Chrome dispara esto cuando la app cumple los requisitos de instalacion. Hay
// que guardarlo: solo se puede usar una vez y solo desde un gesto del usuario.
window.addEventListener('beforeinstallprompt', (evento) => {
  evento.preventDefault();
  eventoInstalacion = evento;
});

window.addEventListener('appinstalled', () => {
  eventoInstalacion = null;
  try { localStorage.removeItem(CLAVE_RECHAZO); } catch { /* modo privado */ }
});

/** Registra el service worker. Sin el no hay ni instalacion ni offline. */
export function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.debug('El service worker no se ha registrado', error);
    });
  });
}

/** ¿Ya se esta ejecutando como app instalada? */
export function estaInstalada() {
  return window.matchMedia('(display-mode: standalone)').matches
    // iOS no implementa display-mode: standalone en Safari; usa esto.
    || window.navigator.standalone === true;
}

const esIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  && !/crios|fxios/i.test(navigator.userAgent);

const guardado = (clave) => { try { return localStorage.getItem(clave); } catch { return null; } };
const guardar = (clave, valor) => { try { localStorage.setItem(clave, valor); } catch { /* modo privado */ } };

/**
 * Deja constancia de que esta persona ya ha subido un viaje. A partir de aqui
 * tiene sentido invitarla a instalar la app.
 */
export function marcarPrimerViaje() {
  if (!guardado(CLAVE_VIAJE_SUBIDO)) guardar(CLAVE_VIAJE_SUBIDO, new Date().toISOString());
}

/**
 * Muestra la invitacion, si toca.
 *
 * No toca si: ya esta instalada, si aun no ha subido ningun viaje, si ya dijo
 * que no, o si el navegador no lo permite. Devuelve si se ha llegado a mostrar.
 */
export function ofrecerInstalacion(contenedor) {
  if (!contenedor) return false;
  if (estaInstalada()) return false;
  if (!guardado(CLAVE_VIAJE_SUBIDO)) return false;
  // "Ahora no" = no volver a ofrecer en 14 dias (07 · 7b).
  if (rechazadoHace(CLAVE_RECHAZO, 14)) return false;

  // En iOS no hay `beforeinstallprompt`: no se puede lanzar el dialogo desde
  // JavaScript, hay que explicar el gesto. Es la unica via para que un iPhone
  // reciba avisos push.
  if (!eventoInstalacion && !esIOS()) return false;

  const cerrar = () => { contenedor.replaceChildren(); contenedor.classList.add('oculto'); };
  const pasosIOS = el('div', { clase: 'tarjeta-grande pasos-ios oculto' }, [
    el('span', { clase: 'rotulo', texto: 'En iPhone (Safari), así:' }),
    el('div', { clase: 'paso-ios' }, [el('span', { clase: 'paso-numero tonal', texto: '1' }), el('span', {}, ['Toca ', icono('compartir', 'icono peq azul'), ' abajo'])]),
    el('div', { clase: 'paso-ios' }, [el('span', { clase: 'paso-numero tonal', texto: '2' }), el('span', { texto: '"Añadir a pantalla de inicio"' })]),
    el('div', { clase: 'paso-ios' }, [el('span', { clase: 'paso-numero tonal', texto: '3' }), el('span', { texto: 'Ábrela desde el icono azul' })]),
  ]);

  reemplazar(contenedor, el('div', { clase: 'pila tarjetas-sistema' }, [
    el('div', { clase: 'tarjeta-grande tarjeta-instalar' }, [
      el('div', { clase: 'fila-instalar' }, [
        anilloLogo(52),
        el('span', {}, [
          el('strong', { texto: 'Tenla a mano' }),
          el('span', { texto: 'Añádela a la pantalla de inicio: se abre como una app y funciona en el metro.' }),
        ]),
      ]),
      el('div', { clase: 'dos-botones-hoja' }, [
        el('button', {
          clase: 'btn', texto: 'Añadir', attrs: { type: 'button' },
          on: {
            click: async () => {
              if (esIOS() && !eventoInstalacion) { pasosIOS.classList.remove('oculto'); return; }
              const evento = eventoInstalacion;
              eventoInstalacion = null;
              cerrar();
              await evento.prompt();
            },
          },
        }),
        el('button', {
          clase: 'btn plano apagado-boton', texto: 'Ahora no', attrs: { type: 'button' },
          on: { click: () => { guardar(CLAVE_RECHAZO, String(Date.now())); cerrar(); } },
        }),
      ]),
    ]),
    pasosIOS,
  ]));

  contenedor.classList.remove('oculto');
  return true;
}

/**
 * Guarda un resumen minimo del piloto para poder ensenar algo cuando no hay
 * red. Son datos propios y se quedan en este dispositivo: no salen de aqui ni
 * los ve nadie mas.
 */
export function guardarResumenOffline(perfil, extra = {}) {
  if (!perfil) return;
  guardar(CLAVE_RESUMEN, JSON.stringify({
    username: perfil.username || null,
    biciRating: perfil.biciRating ?? null,
    viajesVerificados: perfil.viajesVerificados ?? null,
    racha: perfil.racha ?? null,
    division: perfil.division || null,
    // Si hoy ya esta salvado, para la pantalla sin red (07 · 7d).
    ultimoDiaActivo: perfil.ultimoDiaActivo || null,
    // Puesto en el grupo, si la portada lo sabe ("7.º de 30").
    ...extra,
    guardadoEn: new Date().toISOString(),
  }));
}

/**
 * Lo borra al cerrar sesion: el lateral de escritorio lo usa para pintar tu
 * ficha, y quien entre despues en este navegador no tiene por que verla.
 */
export function olvidarResumenOffline() {
  try { localStorage.removeItem(CLAVE_RESUMEN); } catch { /* modo privado */ }
}

/** Lee ese resumen. Lo usa /offline/. */
export function leerResumenOffline() {
  try { return JSON.parse(guardado(CLAVE_RESUMEN) || 'null'); } catch { return null; }
}

export { CLAVE_RESUMEN };
