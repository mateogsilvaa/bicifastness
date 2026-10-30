/**
 * La cabecera comun de administracion (09): logo, "admin", las cinco secciones
 * y, en la cola, el buscador de pilotos y clanes.
 *
 * Es una herramienta de trabajo, no parte de la app: sin barra lateral ni
 * barra inferior, y solo pensada para escritorio.
 */

import { el, reemplazar, anilloLogo, abrirHoja } from '/assets/js/dom.js';
import {
  auth, db, onAuthStateChanged, signOut, collection, doc, getDoc, setDoc, serverTimestamp,
} from '/assets/js/firebase.js';
import {
  verificarAdmin, activarDosPasos, mensajeDosPasos, dosPasosDisponible, apuntarSiNoDisponible,
} from '/assets/js/dos-pasos.js';

const SECCIONES = [
  { clave: 'panel', texto: 'Panel', href: '/admin/panel/' },
  { clave: 'acceso', texto: 'Acceso', href: '/admin/acceso/' },
  { clave: 'revision', texto: 'Revisión', href: '/admin/#revision', contador: 'adm-cuenta-revision' },
  { clave: 'denuncias', texto: 'Denuncias', href: '/admin/#denuncias', contador: 'adm-cuenta-denuncias' },
  { clave: 'pilotos', texto: 'Pilotos y clanes', href: '/admin/#pilotos' },
  { clave: 'metricas', texto: 'Métricas', href: '/admin/metricas/' },
  { clave: 'errores', texto: 'Errores', href: '/admin/errores/' },
  { clave: 'redes', texto: 'Redes', href: '/admin/redes/' },
  { clave: 'recompensas', texto: 'Recompensas', href: '/admin/recompensas/' },
  { clave: 'nfc', texto: 'NFC', href: '/admin/nfc/' },
  { clave: 'tienda', texto: 'Tienda', href: '/admin/tienda/' },
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
  centrarSeccionActiva();
  return { buscador };
}

/**
 * En el movil las secciones se deslizan de lado: la activa, a la vista. Solo
 * se mueve la barra (scrollLeft), no la pagina.
 */
function centrarSeccionActiva() {
  const nav = document.querySelector('.adm-nav');
  const activa = nav?.querySelector('[aria-current="page"]');
  if (!activa || nav.scrollWidth <= nav.clientWidth) return;
  nav.scrollLeft = activa.offsetLeft - (nav.clientWidth - activa.offsetWidth) / 2;
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
  centrarSeccionActiva();
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
      if (!(await puertaDosPasos(usuario, token))) return;

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

// --- Verificacion en dos pasos (assets/js/dos-pasos.js) ------------------------

/** ¿Esta encendido `config/seguridad.adminMfa`? Con el, las reglas la exigen. */
async function dosPasosExigidos() {
  try {
    const snap = await getDoc(doc(db, 'config', 'seguridad'));
    return snap.exists() && snap.data().adminMfa === true;
  } catch {
    // Sin poder leerlo (sin red, o ya exigida y sin el segundo paso): se trata
    // como exigida, que es el lado seguro.
    return true;
  }
}

/**
 * Antes de enseñar nada del panel: el codigo de la app de autenticacion, cada
 * vez que se entra. Si la cuenta aun no la tiene, se ofrece activarla; si las
 * reglas ya la exigen, sin ella no se pasa.
 *
 * @returns {Promise<boolean>} si se puede seguir
 */
export async function puertaDosPasos(usuario, token) {
  const resultado = await verificarAdmin(usuario, token);
  if (resultado === 'ok') {
    ofrecerExigirSiempre(usuario);
    return true;
  }
  if (resultado === 'cancelado') { window.location.replace('/'); return false; }

  const exigidos = await dosPasosExigidos();
  // Si en esta cuenta no se puede activar (TOTP sin encender en Firebase, o el
  // correo sin confirmar) no se ofrece: saldria en cada entrada para nada.
  if (!exigidos && !(await dosPasosDisponible(usuario))) return true;
  const activada = await pantallaActivar(usuario, exigidos);
  if (activada) return puertaDosPasos(usuario, await usuario.getIdTokenResult(true));
  if (exigidos) { window.location.replace('/'); return false; }
  return true;
}

function pantallaActivar(usuario, exigidos) {
  return new Promise((resolver) => {
    const msg = el('p', { clase: 'mensaje', attrs: { 'aria-live': 'polite' } });
    let hecho = false;
    const activar = el('button', {
      clase: 'btn', texto: 'Activarla ahora', attrs: { type: 'button' },
      on: {
        click: async () => {
          activar.disabled = true;
          try {
            if (await activarDosPasos(usuario)) { hecho = true; cerrar(); resolver(true); return; }
          } catch (error) {
            msg.textContent = mensajeDosPasos(error);
            // No se puede: la proxima vez ya no se ofrece (dosPasosDisponible).
            if (apuntarSiNoDisponible(error)) { activar.remove(); return; }
          }
          activar.disabled = false;
        },
      },
    });
    const { cerrar } = abrirHoja([
      el('h2', { texto: 'Protege el panel con dos pasos' }),
      el('p', {
        texto: exigidos
          ? 'El panel exige la verificación en dos pasos y esta cuenta aún no la tiene. Actívala con una app de autenticación para entrar.'
          : 'Con ella, cada vez que entres al panel te pediremos el código de tu app de autenticación. Aunque alguien tenga tu contraseña, no podrá entrar.',
      }),
      msg,
      el('div', { clase: 'dos-botones-hoja' }, [
        activar,
        el('button', {
          clase: 'btn plano', texto: exigidos ? 'Salir' : 'Más tarde', attrs: { type: 'button' },
          on: { click: () => cerrar() },
        }),
      ]),
    ], { etiqueta: 'Verificación en dos pasos', alCerrar: () => { if (!hecho) resolver(false); } });
  });
}

/**
 * Con los dos pasos ya funcionando, el boton para que las reglas la EXIJAN.
 * Encenderla se puede desde aqui; apagarla no (solo desde la consola de
 * Firebase): quien robe la sesion no puede quitar la proteccion.
 */
async function ofrecerExigirSiempre(usuario) {
  if (await dosPasosExigidos()) return;
  const aviso = el('div', { clase: 'adm-aviso-mfa' }, [
    el('span', { texto: 'Tu cuenta ya tiene verificación en dos pasos, pero las reglas todavía aceptan el panel sin ella.' }),
    el('button', {
      clase: 'btn', texto: 'Exigirla siempre', attrs: { type: 'button' },
      on: {
        click: async () => {
          try {
            await setDoc(doc(db, 'config', 'seguridad'), { adminMfa: true, por: usuario.uid, actualizado: serverTimestamp() });
            aviso.remove();
          } catch (error) {
            console.debug('No se ha podido exigir', error);
            aviso.firstChild.textContent = 'No se ha podido guardar. Recarga la página y vuelve a intentarlo.';
          }
        },
      },
    }),
  ]);
  document.body.append(aviso);
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
