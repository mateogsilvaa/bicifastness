// Modulo de la pagina /baja/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.

import { db, doc, setDoc, serverTimestamp } from '/assets/js/firebase.js';
import { id, estado } from '/assets/js/dom.js';

/**
 * Baja de los avisos por correo, SIN iniciar sesion.
 *
 * El RGPD pide baja facil, y si hay que entrar con usuario y contrasena para
 * darse de baja, no es baja facil: la mitad de la gente marca el correo como
 * spam en vez de pelearse con un login. Como aqui no hay servidor que atienda
 * el enlace, el mecanismo es este:
 *
 *   1. el correo trae un token opaco que solo tiene quien lo ha recibido
 *   2. esta pagina escribe `solicitudes_baja/{token}`, que es la unica
 *      escritura sin sesion que permiten las reglas
 *   3. el worker cambia el token por el usuario, apaga sus avisos y borra la
 *      solicitud
 *
 * Nadie puede LEER esa coleccion, asi que no se puede raspar para averiguar
 * tokens de otras personas.
 */

const token = new URLSearchParams(window.location.search).get('t') || '';

const mensaje = id('mensaje');
const boton = id('confirmar');

// El mismo formato que exigen las reglas. Comprobarlo aqui es cortesia: evita
// una escritura condenada al fallo y da un mensaje que se entiende.
const VALIDO = /^[A-Za-z0-9_-]{32,128}$/;

if (!VALIDO.test(token)) {
  estado(mensaje,
    'Este enlace no es valido o esta incompleto. Copialo entero desde el correo, '
    + 'o cambia tus avisos desde tu perfil.', 'error');
} else {
  estado(mensaje, 'Vas a dejar de recibir avisos por correo. '
    + 'Los avisos sobre tus propios trayectos son los que dejaras de ver.');
  boton.classList.remove('oculto');
}

boton.addEventListener('click', async () => {
  boton.disabled = true;
  estado(mensaje, 'Procesando...');

  try {
    await setDoc(doc(db, 'solicitudes_baja', token), { creado: serverTimestamp() });

    id('titulo').textContent = 'Baja registrada';
    // Honesto con los tiempos: el worker no es inmediato.
    estado(mensaje,
      'Hecho. Dejaras de recibir avisos en unos minutos. '
      + 'Puedes volver a activarlos cuando quieras desde tu perfil.', 'ok');
    boton.classList.add('oculto');
  } catch (error) {
    console.debug('No se ha podido registrar la baja', error);
    estado(mensaje,
      'No hemos podido registrar la baja. Vuelve a intentarlo, o desactiva los '
      + 'avisos desde tu perfil.', 'error');
    boton.disabled = false;
  }
});
