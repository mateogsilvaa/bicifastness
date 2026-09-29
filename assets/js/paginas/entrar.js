// Modulo de la pagina /entrar/ (01 Acceso · 1d y 1f).
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.


import {
  auth, onAuthStateChanged, signInWithEmailAndPassword,
  sendPasswordResetEmail, traducirErrorAuth,
} from '/assets/js/firebase.js';
import { aplicarTema, montarAvisoCookies } from '/assets/js/ui.js';
import { id, el, icono } from '/assets/js/dom.js';
import { vigilarErrores } from '/assets/js/errores.js';
import { medir, anotar, volcar } from '/assets/js/metricas.js';
import { montarBotonGoogle } from '/assets/js/acceso.js';
import { montarOjo, marcarError } from '/assets/js/campos-acceso.js';

// Esta pantalla no usa `iniciarPagina` (no lleva navegacion), y por eso se
// quedaba fuera de la recogida de errores y de la analitica: justo la pantalla
// donde mas duele no enterarse de un fallo, y donde se cae el embudo.
vigilarErrores();
medir();
aplicarTema();
montarAvisoCookies();

id('volver').append(icono('atras'));

const form = id('form-login');
const boton = id('btn-entrar');
const campoCorreo = id('email');
const campoClave = id('password');
const mensaje = id('mensaje');

montarOjo(campoClave, id('ver-clave'));

// Mientras se entra, la redireccion la hace quien entra, despues de apuntar la
// metrica. Si la hiciera esto, la pagina se iria antes de escribirla.
let entrando = false;

onAuthStateChanged(auth, (usuario) => {
  if (usuario && !entrando) window.location.replace('/');
});

montarBotonGoogle(id('btn-google'), id('mensaje-google'), {
  alEmpezar: () => { entrando = true; },
  alFallar: () => { entrando = false; },
});

/**
 * El error de Firebase, en castellano y en el sitio donde se entiende.
 *
 * `invalid-credential` es a proposito ambiguo: Firebase no dice si fallo el
 * correo o la contraseña, y la pantalla tampoco. Decir "ese correo no tiene
 * cuenta" permitiria averiguar quien esta registrado.
 */
function textoDeError(error) {
  if (error?.code === 'auth/invalid-credential' || error?.code === 'auth/wrong-password'
    || error?.code === 'auth/user-not-found') {
    return 'El correo o la contraseña no son correctos.';
  }
  return traducirErrorAuth(error);
}

for (const campo of [campoCorreo, campoClave]) {
  campo.addEventListener('input', () => {
    marcarError(campoCorreo, false);
    marcarError(campoClave, false);
    mensaje.textContent = '';
  });
}

form.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const email = campoCorreo.value.trim().toLowerCase();
  const clave = campoClave.value;

  if (!email || !clave) {
    marcarError(email ? campoClave : campoCorreo, true);
    mensaje.textContent = !email ? 'Escribe tu correo.' : 'Escribe tu contraseña.';
    return;
  }

  boton.disabled = true;
  boton.textContent = 'Entrando…';
  mensaje.textContent = '';
  entrando = true;

  try {
    // Un unico sistema de identidad. La version anterior tambien creaba una
    // cuenta en PocketBase con la contrasena escrita aqui: si el usuario no
    // existia alli, la CREABA con la clave introducida, lo que permitia
    // apropiarse de la cuenta de otro con solo conocer su correo.
    await signInWithEmailAndPassword(auth, email, clave);
    anotar('login_completado');
    await volcar();
    window.location.replace('/');
  } catch (error) {
    entrando = false;
    boton.disabled = false;
    boton.textContent = 'Entrar';
    marcarError(campoClave, true);
    mensaje.textContent = textoDeError(error);
  }
});

// --- Recuperar la contraseña (1f) ---------------------------------------------
//
// Una hoja con el correo ya escrito. La confirmacion es NEUTRA: sale igual
// exista o no la cuenta, porque responder distinto permitiria averiguar que
// direcciones estan registradas. Reenviar, a los 60 s.

const ESPERA_REENVIO = 60;

async function enviarRecuperacion(email) {
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (error) {
    // Da igual si el correo existe o no: responder distinto delataria quien
    // esta registrado. Se deja rastro para depurar, y nada mas.
    console.debug('recuperacion', error.code);
  }
}

function abrirHojaRecuperar(email) {
  const cuenta = el('p', { clase: 'hoja-cuenta', attrs: { 'aria-live': 'polite' } });
  const volver = el('button', { clase: 'btn', texto: 'Volver a entrar', attrs: { type: 'button' } });

  const velo = el('div', { clase: 'velo' });
  const hoja = el('div', {
    clase: 'hoja',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'titulo-recuperar' },
  }, [
    el('span', { clase: 'asa', attrs: { 'aria-hidden': 'true' } }),
    el('span', { clase: 'hoja-icono', attrs: { 'aria-hidden': 'true' } }, [icono('correo')]),
    el('h2', { texto: 'Mira tu correo', attrs: { id: 'titulo-recuperar' } }),
    el('p', {}, [
      el('span', { texto: 'Si hay una cuenta con ' }),
      el('span', { texto: email }),
      el('span', { texto: ', te llegará un enlace para elegir otra contraseña. Revisa también el correo no deseado.' }),
    ]),
    volver,
    cuenta,
  ]);

  let restante = ESPERA_REENVIO;
  let reloj = null;

  const pintarCuenta = () => {
    if (restante > 0) {
      cuenta.replaceChildren(document.createTextNode(`Reenviar en 0:${String(restante).padStart(2, '0')}`));
      return;
    }
    const reenviar = el('button', { clase: 'btn plano', texto: 'Reenviar', attrs: { type: 'button' } });
    reenviar.addEventListener('click', async () => {
      reenviar.disabled = true;
      await enviarRecuperacion(email);
      restante = ESPERA_REENVIO;
      arrancar();
    });
    cuenta.replaceChildren(reenviar);
  };

  const arrancar = () => {
    clearInterval(reloj);
    pintarCuenta();
    reloj = setInterval(() => {
      restante -= 1;
      pintarCuenta();
      if (restante <= 0) clearInterval(reloj);
    }, 1000);
  };

  const cerrar = () => {
    clearInterval(reloj);
    velo.remove();
    hoja.remove();
    document.removeEventListener('keydown', alTeclado);
    // De vuelta al formulario, donde se va a escribir la contraseña nueva.
    campoClave.focus();
  };
  const alTeclado = (e) => { if (e.key === 'Escape') cerrar(); };

  volver.addEventListener('click', cerrar);
  velo.addEventListener('click', cerrar);
  document.addEventListener('keydown', alTeclado);

  document.body.append(velo, hoja);
  volver.focus();
  arrancar();
}

id('btn-recuperar').addEventListener('click', async () => {
  const email = campoCorreo.value.trim().toLowerCase();
  if (!email) {
    marcarError(campoCorreo, true);
    mensaje.textContent = 'Escribe tu correo arriba y vuelve a pulsar aquí.';
    campoCorreo.focus();
    return;
  }
  await enviarRecuperacion(email);
  abrirHojaRecuperar(email);
});

// Desde el correo de "tu contraseña ha cambiado" (10g): directo a recuperarla.
if (window.location.hash === '#recuperar') {
  mensaje.textContent = 'Escribe tu correo y pulsa «He olvidado mi contraseña».';
  campoCorreo.focus();
}
