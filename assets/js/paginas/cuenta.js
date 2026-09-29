// Modulo de la pagina /cuenta/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.

import {
  auth, verifyPasswordResetCode, confirmPasswordReset, applyActionCode,
  signInWithEmailAndPassword,
} from '/assets/js/firebase.js';
import { id } from '/assets/js/dom.js';
import { aplicarTema } from '/assets/js/ui.js';
import { montarOjo, marcarError, fuerzaClave, pintarFuerza } from '/assets/js/campos-acceso.js';
import { avisarCambioDeClave } from '/assets/js/acciones.js';

aplicarTema();

/**
 * Donde aterrizan los enlaces de los correos de Firebase Auth.
 *
 * Firebase trae su propia pagina para esto, en firebaseapp.com, en ingles y sin
 * nuestro aspecto. Con esta (Authentication → Plantillas → URL de accion:
 * <sitio>/cuenta/) el enlace del correo abre la web de siempre, y ademas se
 * puede hacer lo que la de Firebase no hace: al cambiar la contraseña, entrar
 * directamente y pedir el aviso de seguridad (10g) para que, si no ha sido la
 * propia persona, se entere.
 *
 *   ?mode=resetPassword&oobCode=…   elegir contraseña nueva
 *   ?mode=verifyEmail&oobCode=…     confirmar el correo
 *   ?mode=recoverEmail&oobCode=…    deshacer un cambio de correo
 */

const params = new URLSearchParams(window.location.search);
const modo = params.get('mode');
const codigo = params.get('oobCode') || '';

const chip = id('estado');
const titulo = id('titulo');
const mensaje = id('mensaje');
const form = id('form-clave');
const campo = id('clave');

function estado(texto, clase) {
  chip.textContent = texto;
  chip.className = `chip ${clase}`;
}

function enlaceMalo() {
  estado('Enlace caducado', 'rechazado');
  titulo.textContent = 'Este enlace ya no sirve';
  mensaje.textContent = 'Caduca a la hora y solo vale una vez. Pide otro desde «He olvidado mi contraseña».';
}

/** "Chrome en Android": lo justo para reconocerse. Ni versiones ni IP. */
function dispositivo() {
  const ua = navigator.userAgent;
  const nav = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Un navegador';
  const so = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : null;
  return so ? `${nav} en ${so}` : nav;
}

function volverA(texto, href) {
  id('volver').textContent = texto;
  id('volver').href = href;
}

async function restablecer() {
  let email;
  try {
    email = await verifyPasswordResetCode(auth, codigo);
  } catch {
    enlaceMalo();
    return;
  }

  estado('Enlace correcto', 'pendiente');
  titulo.textContent = 'Elige una contraseña nueva';
  mensaje.textContent = `Para ${email}. Mínimo 8 caracteres; con números y algún símbolo, mejor.`;
  form.classList.remove('oculto');
  montarOjo(campo, id('ver-clave'));
  campo.addEventListener('input', () => {
    marcarError(campo, false);
    id('error-clave').textContent = '';
    pintarFuerza(id('fuerza-clave'), campo.value);
  });
  campo.focus();

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const clave = campo.value;
    if (clave.length < 8 || fuerzaClave(clave).nivel === 'mal') {
      marcarError(campo, true);
      id('error-clave').textContent = clave.length < 8
        ? 'La contraseña necesita al menos 8 caracteres.'
        : 'Esa contraseña es demasiado fácil de adivinar.';
      return;
    }
    const boton = id('guardar');
    boton.disabled = true;
    boton.textContent = 'Guardando…';
    try {
      await confirmPasswordReset(auth, codigo, clave);
    } catch {
      form.classList.add('oculto');
      enlaceMalo();
      return;
    }

    form.classList.add('oculto');
    estado('Contraseña cambiada', 'verificado');
    titulo.textContent = 'Listo, ya tienes contraseña nueva';
    mensaje.textContent = 'Entrando…';

    // Entrar con la nueva y dejar pedido el aviso de seguridad. Si algo de esto
    // falla, la contraseña ya esta cambiada: se manda a entrar a mano.
    try {
      await signInWithEmailAndPassword(auth, email, clave);
      await avisarCambioDeClave(dispositivo());
      mensaje.textContent = 'Te mandamos un correo para confirmarlo.';
      volverA('Ir a bicifastness', '/');
      setTimeout(() => window.location.replace('/'), 2500);
    } catch {
      mensaje.textContent = 'Ya puedes entrar con ella.';
    }
  });
}

async function aplicar(textoHecho, tituloHecho) {
  try {
    await applyActionCode(auth, codigo);
  } catch {
    enlaceMalo();
    return;
  }
  estado('Hecho', 'verificado');
  titulo.textContent = tituloHecho;
  mensaje.textContent = textoHecho;
  volverA('Ir a bicifastness', '/');
  // Si hay sesion abierta, que recoja el correo ya verificado.
  await auth.currentUser?.reload?.().catch(() => { /* sin sesion, da igual */ });
}

if (!codigo) {
  enlaceMalo();
} else if (modo === 'resetPassword') {
  restablecer();
} else if (modo === 'verifyEmail') {
  aplicar('Ya está confirmado. Te avisaremos a esta dirección de lo que pase con tus trayectos.', 'Correo confirmado');
} else if (modo === 'recoverEmail') {
  aplicar('Tu cuenta vuelve a tener el correo de antes. Si no pediste el cambio, cambia también la contraseña.', 'Correo recuperado');
} else {
  enlaceMalo();
}
