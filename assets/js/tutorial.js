/**
 * El tutorial de la primera vez: que es esto, como se juega y como tenerla
 * como app. Unas pocas pantallas que se pasan con un dedo, y "Saltar" siempre
 * a la vista.
 *
 * UNA SOLA VEZ, Y DE VERDAD UNA. Se marca como visto en cuanto se ABRE (no al
 * terminarlo), en dos sitios: este dispositivo (localStorage) y el perfil
 * (`usuarios/{uid}.tutorialVisto`, que las reglas dejan escribir solo a `true`).
 * Asi no vuelve ni recargando a mitad, ni entrando desde otro movil, ni
 * borrando datos del navegador. Quien quiera repasarlo lo tiene en Tu > Ajustes.
 *
 * Solo para las cuentas nuevas: quien ya estaba antes de que existiera no lo
 * necesita, y sacarselo ahora seria justo lo molesto.
 */

import { el, icono, anilloLogo } from './dom.js';
import { estaInstalada, puedeInstalarYa, instalarAhora } from './instalar.js';
import { db, doc, updateDoc } from './firebase.js';

const CLAVE = 'bf_tutorial_visto';
/** Las cuentas creadas antes de este dia no lo ven solas. */
const DESDE = Date.UTC(2026, 9, 27);

const esIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const esAndroid = () => /android/i.test(navigator.userAgent);

const vistoAqui = () => { try { return localStorage.getItem(CLAVE) !== null; } catch { return false; } };

function marcarVisto(uid) {
  try { localStorage.setItem(CLAVE, new Date().toISOString()); } catch { /* modo privado */ }
  if (uid) updateDoc(doc(db, 'usuarios', uid), { tutorialVisto: true }).catch(() => { /* queda la marca local */ });
}

/** ¿Le toca? Nuevo, sin verlo en ningun sitio, y sin otro dialogo delante. */
export function tocaTutorial(perfil) {
  if (!perfil || perfil.tutorialVisto === true || vistoAqui()) return false;
  const creado = perfil.creado?.toMillis?.() ?? null;
  return creado !== null && creado >= DESDE;
}

/** Lo abre si toca. Devuelve si lo ha abierto. */
export function tutorialSiToca(perfil, uid) {
  if (!tocaTutorial(perfil)) return false;
  if (document.querySelector('[role="dialog"]')) {
    // Otro dialogo delante (los textos legales, por ejemplo): se espera a que
    // se cierre, sin perder la ocasion.
    const vigia = new MutationObserver(() => {
      if (document.querySelector('[role="dialog"]')) return;
      vigia.disconnect();
      if (tocaTutorial(perfil)) abrirTutorial({ uid });
    });
    vigia.observe(document.body, { childList: true });
    return false;
  }
  abrirTutorial({ uid });
  return true;
}

/** Los pasos para añadirla a la pantalla de inicio, segun el movil. */
function pasosApp() {
  if (estaInstalada()) {
    return [el('p', { clase: 'tutorial-nota', texto: 'Ya la tienes como app. Así te llegan los avisos cuando se verifica un trayecto.' })];
  }
  const lista = (pasos) => el('ol', { clase: 'tutorial-pasos' }, pasos.map((p) => el('li', {}, [].concat(p))));
  if (esIOS()) {
    const otroNavegador = /crios|fxios/i.test(navigator.userAgent);
    return [lista([
      ['Toca ', icono('compartir', 'icono peq'), otroNavegador ? ' (arriba, junto a la dirección).' : ' en la barra de abajo de Safari.'],
      'Baja y elige «Añadir a pantalla de inicio».',
      'Pulsa «Añadir» y ábrela siempre desde el icono.',
    ]), el('p', { clase: 'tutorial-nota', texto: 'En iPhone es la única forma de recibir avisos.' })];
  }
  const boton = puedeInstalarYa()
    ? el('button', {
      clase: 'btn', texto: 'Añadir ahora', attrs: { type: 'button' },
      on: { click: async (e) => { e.currentTarget.disabled = true; await instalarAhora(); } },
    })
    : null;
  if (esAndroid()) {
    return [boton, lista([
      'Abre el menú del navegador (⋮ arriba o ≡ abajo).',
      'Elige «Instalar aplicación» o «Añadir a pantalla de inicio».',
      'Ábrela desde el icono, como cualquier app.',
    ])].filter(Boolean);
  }
  return [boton, lista([
    'En el ordenador: busca el icono de instalar en la barra de direcciones.',
    'En el móvil: menú del navegador → «Añadir a pantalla de inicio».',
  ])].filter(Boolean);
}

const PASOS = [
  {
    icono: null,
    titulo: 'Te damos la bienvenida',
    texto: 'Compite con tus trayectos en BiciMAD: cada viaje suma puntos, rachas y territorio para tu clan.',
  },
  {
    icono: 'subir',
    titulo: 'Sube tu trayecto',
    texto: 'Al acabar, haz una captura del viaje en la app de BiciMAD y súbela aquí. Rellenamos los datos solos: tú solo confirmas.',
  },
  {
    icono: 'comprobado',
    titulo: 'Lo verificamos',
    texto: 'En unos minutos se comprueba la captura. Cuando esté, verás los puntos y de dónde salen. Puedes cerrar la app mientras.',
  },
  {
    icono: 'rayo',
    titulo: 'Racha y misiones',
    texto: 'Pedalea días seguidos para multiplicar tus puntos. Cada día hay tres misiones, y también las hay de la semana y del mes.',
  },
  {
    icono: 'clasificacion',
    titulo: 'Ligas y clasificación',
    texto: 'Compites en un grupo de tu división. Cada dos semanas se cierra la liga: los primeros suben y los últimos bajan.',
  },
  {
    icono: 'clan',
    titulo: 'Clanes y territorio',
    texto: 'Únete a un clan o crea el tuyo. Las estaciones donde más pedaleáis pasan a ser vuestras en el mapa.',
  },
  {
    icono: 'perfil',
    titulo: 'Tu perfil',
    texto: 'Elige banner y lema, y añade tus redes para que otros pilotos te encuentren. Hay recompensas escondidas por Madrid.',
  },
  {
    icono: null, logo: true, app: true,
    titulo: 'Tenla como app',
    texto: 'Añádela a la pantalla de inicio: se abre al instante, a pantalla completa, y te avisamos cuando se verifique un trayecto.',
  },
];

/**
 * Abre el tutorial. Desde Ajustes se abre aunque ya se haya visto.
 * @param {object} [o]
 * @param {string} [o.uid]  para marcarlo visto en el perfil
 */
export function abrirTutorial({ uid = null } = {}) {
  if (document.querySelector('.tutorial')) return;
  marcarVisto(uid);

  const antes = document.activeElement;
  let paso = 0;
  const cuerpo = el('div', { clase: 'tutorial-cuerpo', attrs: { 'aria-live': 'polite' } });
  const puntos = el('div', { clase: 'tutorial-puntos', attrs: { 'aria-hidden': 'true' } }, PASOS.map(() => el('span')));
  const atras = el('button', { clase: 'btn plano', texto: 'Atrás', attrs: { type: 'button' } });
  const siguiente = el('button', { clase: 'btn', texto: 'Siguiente', attrs: { type: 'button' } });
  const saltar = el('button', { clase: 'btn plano tutorial-saltar', texto: 'Saltar', attrs: { type: 'button' } });

  const capa = el('div', {
    clase: 'tutorial',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Cómo funciona BiciFastness', tabindex: '-1' },
  }, [
    saltar,
    cuerpo,
    puntos,
    el('div', { clase: 'tutorial-botones' }, [atras, siguiente]),
  ]);

  const cerrar = () => {
    capa.remove();
    document.removeEventListener('keydown', teclas);
    document.body.classList.remove('con-tutorial');
    if (antes && typeof antes.focus === 'function') antes.focus();
  };

  const pintar = () => {
    const p = PASOS[paso];
    cuerpo.replaceChildren(
      el('div', { clase: 'tutorial-dibujo' }, [p.logo || !p.icono ? anilloLogo(72) : icono(p.icono)]),
      el('span', { clase: 'tutorial-contador', texto: `${paso + 1} de ${PASOS.length}` }),
      el('h2', { texto: p.titulo }),
      el('p', { texto: p.texto }),
      ...(p.app ? pasosApp() : []),
    );
    [...puntos.children].forEach((punto, i) => punto.classList.toggle('activo', i === paso));
    atras.style.visibility = paso === 0 ? 'hidden' : 'visible';
    siguiente.textContent = paso === PASOS.length - 1 ? 'Empezar' : 'Siguiente';
    saltar.style.visibility = paso === PASOS.length - 1 ? 'hidden' : 'visible';
  };
  const ir = (n) => {
    if (n >= PASOS.length) { cerrar(); return; }
    paso = Math.max(0, n);
    pintar();
  };
  const teclas = (e) => {
    if (e.key === 'Escape') cerrar();
    else if (e.key === 'ArrowRight') ir(paso + 1);
    else if (e.key === 'ArrowLeft') ir(paso - 1);
  };

  atras.addEventListener('click', () => ir(paso - 1));
  siguiente.addEventListener('click', () => ir(paso + 1));
  saltar.addEventListener('click', cerrar);

  // Deslizar con el dedo, como cualquier carrusel del movil.
  let x0 = null;
  capa.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  capa.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 50) ir(paso + (dx < 0 ? 1 : -1));
  });

  document.addEventListener('keydown', teclas);
  document.body.classList.add('con-tutorial');
  document.body.append(capa);
  pintar();
  capa.focus();
}
