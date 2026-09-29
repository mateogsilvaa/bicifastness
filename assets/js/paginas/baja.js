// Modulo de la pagina /baja/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.

import { db, doc, setDoc, serverTimestamp } from '/assets/js/firebase.js';
import { id } from '/assets/js/dom.js';
import { aplicarTema } from '/assets/js/ui.js';

aplicarTema();

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
const chip = id('estado-baja');

function ponerEstado(texto, clase) {
  chip.textContent = texto;
  chip.className = `chip ${clase}`;
}

// El mismo formato que exigen las reglas. Comprobarlo aqui es cortesia: evita
// una escritura condenada al fallo y da un mensaje que se entiende.
const VALIDO = /^[A-Za-z0-9_-]{32,128}$/;

if (!VALIDO.test(token)) {
  ponerEstado('Enlace no válido', 'rechazado');
  mensaje.textContent = 'Este enlace no es válido o está incompleto. Cópialo entero desde el correo, '
    + 'o apaga los avisos desde Tú → Ajustes.';
} else {
  ponerEstado('Enlace correcto', 'pendiente');
  mensaje.textContent = 'Dejarás de recibir correos sobre tus trayectos. Puedes volver a activarlos en Tú → Ajustes.';
  boton.classList.remove('oculto');
}

boton.addEventListener('click', async () => {
  boton.disabled = true;
  boton.textContent = 'Un momento…';
  try {
    await setDoc(doc(db, 'solicitudes_baja', token), { creado: serverTimestamp() });
    // Honesto con los tiempos: el worker no es inmediato.
    ponerEstado('Hecho. No te escribiremos más.', 'verificado');
    id('titulo').textContent = 'Baja registrada';
    mensaje.textContent = 'Dejarás de recibir avisos en unos minutos. Puedes volver a activarlos cuando quieras desde Tú → Ajustes.';
    boton.classList.add('oculto');
  } catch (error) {
    console.debug('No se ha podido registrar la baja', error);
    // Una solicitud con ese token ya existe (reglas: solo crear) o el enlace
    // caduco y el worker ya lo borro.
    ponerEstado('Enlace caducado', 'rechazado');
    mensaje.textContent = 'No hemos podido registrar la baja con este enlace. Apaga los avisos desde Tú → Ajustes, '
      + 'o usa el enlace del último correo.';
    boton.disabled = false;
    boton.textContent = 'Darme de baja';
  }
});
