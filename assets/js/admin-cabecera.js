/**
 * La cabecera comun de administracion (09): logo, "admin", las cinco secciones
 * y, en la cola, el buscador de pilotos y clanes.
 *
 * Es una herramienta de trabajo, no parte de la app: sin barra lateral ni
 * barra inferior, y solo pensada para escritorio.
 */

import { el, reemplazar, anilloLogo } from '/assets/js/dom.js';
import {
  auth, db, onAuthStateChanged, signOut, collection, doc, setDoc, serverTimestamp,
} from '/assets/js/firebase.js';

const SECCIONES = [
  { clave: 'panel', texto: 'Panel', href: '/admin/panel/' },
  { clave: 'revision', texto: 'Revisión', href: '/admin/#revision', contador: 'adm-cuenta-revision' },
  { clave: 'denuncias', texto: 'Denuncias', href: '/admin/#denuncias', contador: 'adm-cuenta-denuncias' },
  { clave: 'pilotos', texto: 'Pilotos y clanes', href: '/admin/#pilotos' },
  { clave: 'metricas', texto: 'Métricas', href: '/admin/metricas/' },
  { clave: 'errores', texto: 'Errores', href: '/admin/errores/' },
  { clave: 'redes', texto: 'Redes', href: '/admin/redes/' },
];

/**
 * @param {string} activa  clave de la seccion actual
 * @param {object} [opciones]
 * @param {(texto: string) => void} [opciones.alBuscar]  si se pasa, sale el buscador
 */
export function montarCabeceraAdmin(activa, { alBuscar = null } = {}) {
  document.body.classList.add('sin-navegacion', 'pagina-admin');
  let cabecera = document.querySelector('.adm-cabecera');
  if (!cabecera) {
    cabecera = el('header', { clase: 'adm-cabecera' });
    document.body.prepend(cabecera);
  }

  const buscador = alBuscar ? el('input', {
    clase: 'adm-buscar',
    attrs: { type: 'search', placeholder: 'Buscar piloto o clan', 'aria-label': 'Buscar piloto o clan', autocomplete: 'off' },
    on: { input: (e) => alBuscar(e.target.value) },
  }) : null;

  reemplazar(cabecera, [
    el('a', { clase: 'logo adm-logo', attrs: { href: '/', 'aria-label': 'bicifastness' } }, [
      anilloLogo(24), el('span', { clase: 'logo-palabra', texto: 'bicifastness' }),
    ]),
    el('span', { clase: 'adm-chip', texto: 'admin' }),
    el('nav', { clase: 'adm-nav', attrs: { 'aria-label': 'Administración' } }, SECCIONES.map((s) => el('a', {
      attrs: { href: s.href, 'aria-current': s.clave === activa ? 'page' : null, 'data-seccion': s.clave },
    }, [
      el('span', { texto: s.texto }),
      s.contador ? el('span', { clase: 'adm-contador oculto', attrs: { id: s.contador } }) : null,
    ]))),
    el('span', { clase: 'adm-hueco' }),
    buscador,
  ]);
  return { buscador };
}

/** Pone el numero de una seccion (y lo esconde a cero). */
export function contadorAdmin(idContador, n) {
  const nodo = document.getElementById(idContador);
  if (!nodo) return;
  nodo.textContent = String(n);
  nodo.classList.toggle('oculto', !n);
}

/** Marca la seccion activa sin repintar (las de /admin/ van por hash). */
export function marcarSeccionAdmin(activa) {
  for (const a of document.querySelectorAll('.adm-nav a')) {
    if (a.dataset.seccion === activa) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

// --- Acceso controlado ----------------------------------------------------------

/** Minutos sin tocar nada antes de cerrar la sesion de administracion. */
const MINUTOS_INACTIVO = 30;

/**
 * La puerta de las paginas de administracion. Nada de la pagina se ve hasta
 * que pasa (el `main` empieza oculto con `adm-bloqueada`), y:
 *
 *   - el rol sale del TOKEN firmado por Firebase, refrescado en el momento (un
 *     rol quitado hace un minuto ya no entra), no de un documento;
 *   - sin sesion o sin rol, fuera, a la portada;
 *   - cada entrada queda en `auditoria_admin`, que no se puede editar ni
 *     borrar: quien entra y a que;
 *   - tras 30 minutos sin actividad se cierra la sesion, por si el ordenador
 *     se queda abierto.
 *
 * Las reglas de Firestore son la defensa de verdad (todo lo de admin exige el
 * rol en el servidor); esto es que la pagina no enseñe nada a quien no debe.
 *
 * @param {string} pagina  para el registro ('panel', 'redes'...)
 * @returns {Promise<import('firebase/auth').User>}
 */
export function exigirAdmin(pagina) {
  document.body.classList.add('adm-bloqueada');
  return new Promise((resolver) => {
    const parar = onAuthStateChanged(auth, async (usuario) => {
      parar();
      if (!usuario) { window.location.replace('/entrar/'); return; }
      let token = null;
      try {
        token = await usuario.getIdTokenResult(true);
      } catch {
        // Sin red no se puede refrescar el token, y sin token refrescado no se
        // da por bueno el rol: mejor fuera que dentro con un rol caducado.
        token = null;
      }
      if (token?.claims?.admin !== true) { window.location.replace('/'); return; }

      document.body.classList.remove('adm-bloqueada');
      // El rastro de la entrada. Si falla no se bloquea el panel: el registro
      // es para auditar, no una segunda puerta.
      setDoc(doc(collection(db, 'auditoria_admin')), {
        adminUid: usuario.uid,
        accion: `acceso:${pagina}`,
        detalle: { pagina: window.location.pathname.slice(0, 60) },
        creado: serverTimestamp(),
      }).catch(() => {
        // Sin red o sin cuota el rastro no se escribe; no se bloquea el panel
        // por eso: el registro es para auditar, no una segunda puerta.
      });
      vigilarInactividad();
      resolver(usuario);
    });
  });
}

function vigilarInactividad() {
  let temporizador = null;
  const reiniciar = () => {
    clearTimeout(temporizador);
    temporizador = setTimeout(async () => {
      try { await signOut(auth); } finally { window.location.replace('/entrar/'); }
    }, MINUTOS_INACTIVO * 60000);
  };
  for (const evento of ['pointerdown', 'keydown', 'scroll']) window.addEventListener(evento, reiniciar, { passive: true });
  reiniciar();
}
