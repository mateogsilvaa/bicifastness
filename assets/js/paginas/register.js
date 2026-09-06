// Modulo de la pagina /register/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.


import {
  auth, onAuthStateChanged, createUserWithEmailAndPassword,
  sendEmailVerification, traducirErrorAuth,
} from '/assets/js/firebase.js';
import { aplicarTema, montarPieLegal, montarAvisoCookies } from '/assets/js/ui.js';
import { id, estado } from '/assets/js/dom.js';
import { PALABRAS_PROHIBIDAS } from '/assets/data/palabras-prohibidas.js';
import { crearPerfil } from '/assets/js/acciones.js';

aplicarTema();
montarPieLegal();
montarAvisoCookies();

const mensaje = id('mensaje');
const boton = id('btn-registro');
let registrando = false;

onAuthStateChanged(auth, (usuario) => {
  if (usuario && !registrando) window.location.replace('/');
});

// Misma normalizacion que en el servidor: lista y entrada, los dos lados.
const normalizar = (t) => String(t ?? '').toLowerCase().normalize('NFD')
  .replace(/\p{Diacritic}/gu, '').replace(/[\s\-_.]+/g, '');
const PROHIBIDAS = [...new Set(PALABRAS_PROHIBIDAS.map(normalizar))].filter(Boolean);

/**
 * Validacion en el cliente: sirve para dar respuesta inmediata, NO para
 * proteger nada. El servidor vuelve a comprobarlo todo en completarRegistro.
 */
function validarNombre(valor) {
  const nombre = valor.trim();
  if (nombre.length < 3) return 'Minimo 3 caracteres.';
  if (nombre.length > 24) return 'Maximo 24 caracteres.';
  if (!/^[\p{L}\p{N}_\- ]+$/u.test(nombre)) return 'Solo letras, numeros, guion y espacio.';
  const limpio = normalizar(nombre);
  if (PROHIBIDAS.some((p) => limpio.includes(p))) return 'Ese nombre no esta permitido.';
  return null;
}

function validarClave(clave) {
  if (clave.length < 8) return 'Minimo 8 caracteres.';
  if (clave.length > 128) return 'Demasiado larga.';
  // Las listas de contrasenas filtradas empiezan siempre por estas.
  const obvias = ['12345678', 'password', 'contrasena', 'qwertyui', 'bicimad1', '11111111'];
  if (obvias.some((o) => clave.toLowerCase().includes(o))) return 'Esa contrasena es demasiado facil de adivinar.';
  return null;
}

const pistaUsuario = id('pista-username');
id('username').addEventListener('input', (e) => {
  const error = e.target.value ? validarNombre(e.target.value) : null;
  pistaUsuario.textContent = error || '';
  pistaUsuario.className = `pista${error ? ' mal' : ''}`;
  e.target.setAttribute('aria-invalid', error ? 'true' : 'false');
});

const pistaClave = id('pista-password');
id('password').addEventListener('input', (e) => {
  const error = e.target.value ? validarClave(e.target.value) : null;
  pistaClave.textContent = error || '';
  pistaClave.className = `pista${error ? ' mal' : ''}`;
  e.target.setAttribute('aria-invalid', error ? 'true' : 'false');
});

id('form-registro').addEventListener('submit', async (evento) => {
  evento.preventDefault();

  const username = id('username').value.trim();
  const email = id('email').value.trim().toLowerCase();
  const clave = id('password').value;
  const clave2 = id('password2').value;

  const fallo = validarNombre(username)
    || (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? 'El correo no es valido.' : null)
    || validarClave(clave)
    || (clave !== clave2 ? 'Las contrasenas no coinciden.' : null)
    || (!id('acepta-terminos').checked ? 'Debes aceptar los Terminos de Uso.' : null)
    || (!id('acepta-privacidad').checked ? 'Debes aceptar la Politica de Privacidad.' : null)
    || (!id('acepta-edad').checked ? 'Debes confirmar que tienes 14 anos o mas.' : null);

  if (fallo) { estado(mensaje, fallo, 'error'); return; }

  boton.disabled = true;
  boton.textContent = 'Creando cuenta...';
  estado(mensaje, '');
  registrando = true;

  try {
    await createUserWithEmailAndPassword(auth, email, clave);

    // El perfil lo crea el servidor. Antes lo escribia el navegador con
    // `isAdmin: false` en el objeto, lo que dejaba claro que ese campo era
    // manipulable desde el cliente: bastaba con enviarlo a true.
    await crearPerfil({ username, email });

    // Con `catch` a proposito: esto SI puede fallar de verdad (Firebase limita
    // los envios por cuenta y por rato), y quedarse sin correo de verificacion
    // no puede impedir terminar el registro. Pero se dice, aunque sea a la
    // consola: sin esto, "no me llega el correo de verificacion" no tiene ni un
    // rastro que mirar.
    await sendEmailVerification(auth.currentUser)
      .catch((error) => console.warn('No se ha podido enviar la verificacion:', error.message));
    window.location.replace('/');
  } catch (error) {
    registrando = false;
    boton.disabled = false;
    boton.textContent = 'Empezar a competir';

    // Si Auth creo la cuenta pero el perfil fallo, la dejamos utilizable:
    // al volver a entrar se reintenta el alta del perfil.
    const texto = error.code ? traducirErrorAuth(error) : error.message;
    estado(mensaje, texto, 'error');
  }
});
