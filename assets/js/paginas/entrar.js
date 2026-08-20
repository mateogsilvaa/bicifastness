// Modulo de la pagina /entrar/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.


import {
  auth, onAuthStateChanged, signInWithEmailAndPassword,
  sendPasswordResetEmail, traducirErrorAuth,
} from '/assets/js/firebase.js';
import { aplicarTema, montarPieLegal, montarAvisoCookies } from '/assets/js/ui.js';
import { id, estado } from '/assets/js/dom.js';

aplicarTema();
montarPieLegal();
montarAvisoCookies();

const form = id('form-login');
const boton = id('btn-entrar');
const mensaje = id('mensaje');

onAuthStateChanged(auth, (usuario) => {
  if (usuario) window.location.replace('/');
});

form.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const email = id('email').value.trim().toLowerCase();
  const clave = id('password').value;

  if (!email || !clave) {
    estado(mensaje, 'Rellena los dos campos.', 'error');
    return;
  }

  boton.disabled = true;
  boton.textContent = 'Entrando...';
  estado(mensaje, '');

  try {
    // Un unico sistema de identidad. La version anterior tambien creaba una
    // cuenta en PocketBase con la contrasena escrita aqui: si el usuario no
    // existia alli, la CREABA con la clave introducida, lo que permitia
    // apropiarse de la cuenta de otro con solo conocer su correo.
    await signInWithEmailAndPassword(auth, email, clave);
    window.location.replace('/');
  } catch (error) {
    boton.disabled = false;
    boton.textContent = 'Entrar';
    estado(mensaje, traducirErrorAuth(error), 'error');
  }
});

id('btn-recuperar').addEventListener('click', async (evento) => {
  evento.preventDefault();
  const email = id('email').value.trim().toLowerCase();
  if (!email) {
    estado(mensaje, 'Escribe tu correo arriba y vuelve a pulsar aqui.', 'aviso');
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (error) {
    // Da igual si el correo existe o no: responder distinto permitiria
    // averiguar que direcciones estan registradas.
    console.debug('recuperacion', error.code);
  }
  estado(mensaje, 'Si ese correo tiene cuenta, recibiras un enlace para cambiar la contrasena.', 'exito');
});
