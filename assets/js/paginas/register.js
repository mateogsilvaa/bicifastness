// Modulo de la pagina /register/ (01 Acceso · 1e).
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// Paso 1 de 2: se crea la cuenta de acceso con correo y contraseña, y nada mas.
// El perfil de piloto — nombre y las tres casillas del consentimiento — es el
// paso 2, en la portada, el MISMO que tras entrar con Google. Aqui no se llama
// a `crearPerfil`: ningun perfil nace sin que se hayan marcado las casillas.


import {
  auth, onAuthStateChanged, createUserWithEmailAndPassword,
  sendEmailVerification, traducirErrorAuth,
} from '/assets/js/firebase.js';
import { aplicarTema, montarAvisoCookies } from '/assets/js/ui.js';
import { id, icono } from '/assets/js/dom.js';
import { vigilarErrores } from '/assets/js/errores.js';
import { medir, anotar, volcar } from '/assets/js/metricas.js';
import { montarOjo, marcarError, fuerzaClave, pintarFuerza } from '/assets/js/campos-acceso.js';

// Sin `iniciarPagina` (no hay navegacion aqui), asi que se arranca a mano. Es
// el principio del embudo: `registro_abierto` aqui, `registro_completado` al
// terminar el paso 2 en la portada.
vigilarErrores();
medir();
anotar('registro_abierto');
aplicarTema();
montarAvisoCookies();

id('volver').append(icono('atras'));

const boton = id('btn-registro');
const campoCorreo = id('email');
const campoClave = id('password');
let registrando = false;

montarOjo(campoClave, id('ver-clave'));

onAuthStateChanged(auth, (usuario) => {
  if (usuario && !registrando) window.location.replace('/');
});

const correoValido = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);

campoClave.addEventListener('input', () => {
  pintarFuerza(id('fuerza-clave'), campoClave.value);
  marcarError(campoClave, false);
  id('error-clave').textContent = '';
});
campoCorreo.addEventListener('input', () => {
  marcarError(campoCorreo, false);
  id('error-email').textContent = '';
});

id('form-registro').addEventListener('submit', async (evento) => {
  evento.preventDefault();

  const email = campoCorreo.value.trim().toLowerCase();
  const clave = campoClave.value;
  const fuerza = fuerzaClave(clave);

  let fallo = false;
  if (!correoValido(email)) {
    marcarError(campoCorreo, true);
    id('error-email').textContent = email ? 'Ese correo no tiene buena pinta.' : 'Escribe tu correo.';
    fallo = true;
  }
  if (clave.length < 8 || fuerza.nivel === 'mal') {
    marcarError(campoClave, true);
    id('error-clave').textContent = clave.length < 8
      ? 'La contraseña necesita al menos 8 caracteres.'
      : 'Esa contraseña es demasiado fácil de adivinar.';
    fallo = true;
  }
  if (fallo) return;

  boton.disabled = true;
  boton.textContent = 'Creando tu cuenta…';
  id('mensaje').textContent = '';
  registrando = true;

  try {
    await createUserWithEmailAndPassword(auth, email, clave);

    // Con `catch` a proposito: esto SI puede fallar de verdad (Firebase limita
    // los envios por cuenta y por rato), y quedarse sin correo de verificacion
    // no puede impedir seguir. Pero se dice, aunque sea a la consola: sin esto,
    // "no me llega el correo de verificacion" no tiene ni un rastro que mirar.
    await sendEmailVerification(auth.currentUser)
      .catch((error) => console.warn('No se ha podido enviar la verificacion:', error.message));

    await volcar();
    // Al paso 2: la portada ve una cuenta sin perfil y pide el nombre.
    window.location.replace('/');
  } catch (error) {
    registrando = false;
    boton.disabled = false;
    boton.textContent = 'Continuar';
    if (error.code === 'auth/email-already-in-use') {
      marcarError(campoCorreo, true);
      id('error-email').textContent = 'Ese correo ya tiene cuenta.';
    } else {
      id('mensaje').textContent = error.code ? traducirErrorAuth(error) : error.message;
    }
  }
});
