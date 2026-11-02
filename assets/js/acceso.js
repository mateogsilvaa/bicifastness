/**
 * El boton de "Continuar con Google", el mismo en /entrar/ y en /register/.
 *
 * Las dos pantallas hacen lo mismo con el: en Google, entrar y registrarse son
 * el mismo gesto. Lo que cambia es lo que pasa despues, y eso lo decide la
 * portada: si la cuenta no tiene perfil de piloto, pide el nombre y los
 * consentimientos antes de dejar hacer nada.
 */

import {
  entrarConGoogle, entrarConGoogleRedirigiendo, volverDeGoogle, getAdditionalUserInfo, traducirErrorAuth,
} from './firebase.js';
import { resolverSegundoPaso } from './dos-pasos.js';
import { estado } from './dom.js';
import { anotar, volcar } from './metricas.js';
import { registrar } from './errores.js';
import { destinoTrasEntrar } from './canje-pendiente.js';
import { guardarGooglePendiente } from './vincular-google.js';
import { esNavegadorIntegrado, explicarNavegadorIntegrado } from './navegador-integrado.js';

/** Lo que hace la persona, no un fallo: no se apunta como error. */
const DE_LA_PERSONA = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/popup-blocked']);

/**
 * @param {HTMLButtonElement} boton
 * @param {HTMLElement} mensaje  donde se explica un fallo
 * @param {() => void} alEmpezar  para que la pagina no redirija por su cuenta
 *   en cuanto `onAuthStateChanged` vea la sesion, antes de apuntar la metrica
 * @param {() => void} alFallar  para deshacer lo anterior
 */
/** Marca de "me he ido a Google en esta pestaña": al volver se recoge. */
const CLAVE_VUELTA = 'bf_google_redirigido';

/**
 * ¿Mejor ir a Google en la misma pestaña que abrir una ventana?
 *
 * En la app instalada, siempre: la ventana se abre fuera y su respuesta no
 * vuelve. En iPhone/iPad tambien, por la misma razon cuando Safari corta la
 * ventana.
 */
function mejorRedirigir() {
  const instalada = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
  return Boolean(instalada);
}

function marcarVuelta() { try { sessionStorage.setItem(CLAVE_VUELTA, '1'); } catch { /* se recoge igual con getRedirectResult */ } }
function vieneDeGoogle() { try { return sessionStorage.getItem(CLAVE_VUELTA) === '1'; } catch { return false; } }
function olvidarVuelta() { try { sessionStorage.removeItem(CLAVE_VUELTA); } catch { /* nada */ } }

/** Lo que pasa despues de entrar, venga de la ventana o de la vuelta. */
async function trasEntrar(resultado) {
  // Una cuenta NUEVA no ha completado nada todavia: le falta el nombre de
  // piloto, y el registro se cuenta cuando lo elija (portada). Contarlo
  // aqui inflaria el embudo con quien abre el popup y se va.
  const cuentaNueva = Boolean(getAdditionalUserInfo(resultado)?.isNewUser);
  if (!cuentaNueva) anotar('login_completado');
  await volcar();
  window.location.replace(destinoTrasEntrar({ cuentaNueva }));
}

/** Un fallo al entrar con Google, explicado. */
function explicarFallo(error, mensaje) {
  // Ese correo ya tiene cuenta con contraseña: se guarda Google y se le
  // lleva a entrar con la contraseña, que lo vincula (vincular-google.js).
  if (error?.code === 'auth/account-exists-with-different-credential') {
    const correo = guardarGooglePendiente(error);
    try { if (correo) sessionStorage.setItem('bf_correo_entrar', correo); } catch { /* se escribe a mano */ }
    if (window.location.pathname.startsWith('/entrar/')) {
      estado(mensaje, 'Ya tienes cuenta con este correo. Entra una vez con tu contraseña y quedará unida a Google: después podrás entrar con cualquiera de los dos.', 'info');
      document.dispatchEvent(new CustomEvent('bf:correo-entrar'));
    } else {
      window.location.replace('/entrar/');
    }
    return;
  }
  estado(mensaje, traducirErrorAuth(error), 'error');
  // Que llegue al panel de errores con su codigo: "Google no funciona" sin
  // codigo no se puede arreglar. Solo el codigo y el mensaje de Firebase,
  // nada de la cuenta. El mensaje va en la pila, que es el campo libre que
  // admiten las reglas de `errores_cliente`.
  if (!DE_LA_PERSONA.has(error?.code)) {
    registrar(`Entrar con Google: ${error?.code || 'sin codigo'}`, String(error?.message || '').slice(0, 300))
      .catch(() => {});
  }
}

// La vuelta de Google se recoge UNA vez por pagina (la portada tiene dos botones).
let vueltaRecogida = false;

/**
 * @param {HTMLButtonElement} boton
 * @param {HTMLElement} mensaje  donde se explica un fallo
 * @param {() => void} alEmpezar  para que la pagina no redirija por su cuenta
 *   en cuanto `onAuthStateChanged` vea la sesion, antes de apuntar la metrica
 * @param {() => void} alFallar  para deshacer lo anterior
 */
export function montarBotonGoogle(boton, mensaje, { alEmpezar, alFallar } = {}) {
  // De vuelta de Google en esta misma pestaña: se termina de entrar aqui.
  if (!vueltaRecogida && vieneDeGoogle()) {
    vueltaRecogida = true;
    olvidarVuelta();
    alEmpezar?.();
    boton.disabled = true;
    estado(mensaje, 'Entrando con Google…', 'info');
    volverDeGoogle().catch(resolverSegundoPaso).then(async (resultado) => {
      if (resultado) { await trasEntrar(resultado); return; }
      // Se fue a Google y volvio sin cuenta: o se echo atras, o el navegador
      // (Safari en la app instalada) no deja recoger la respuesta. Se dice.
      boton.disabled = false;
      estado(mensaje, 'No se ha completado el acceso con Google. Vuelve a intentarlo, o ábrelo en el navegador del móvil o entra con tu correo.', 'info');
      alFallar?.();
    }).catch((error) => {
      boton.disabled = false;
      alFallar?.();
      explicarFallo(error, mensaje);
    });
  }

  const irAGoogle = async () => {
    marcarVuelta();
    try {
      await entrarConGoogleRedirigiendo();
    } catch (error) {
      olvidarVuelta();
      boton.disabled = false;
      alFallar?.();
      explicarFallo(error, mensaje);
    }
  };

  boton.addEventListener('click', async () => {
    // Dentro de Instagram y similares Google no deja entrar: se explica que
    // hacer en vez de dejar que falle con un error de ventanas emergentes.
    if (esNavegadorIntegrado()) { explicarNavegadorIntegrado(); return; }
    boton.disabled = true;
    estado(mensaje, '');
    alEmpezar?.();

    // En la app instalada, directamente a Google en esta pestaña.
    if (mejorRedirigir()) { await irAGoogle(); return; }

    try {
      // Con dos pasos activados, Google tambien corta y pide el codigo.
      const resultado = await entrarConGoogle().catch(resolverSegundoPaso);
      if (!resultado) { boton.disabled = false; alFallar?.(); return; }
      await trasEntrar(resultado);
    } catch (error) {
      // La ventana no se ha podido abrir (bloqueada, o un navegador que no la
      // deja): en vez de una explicacion, se va a Google en esta pestaña, que
      // funciona en todos. Antes aqui salia la hoja de "estas en Instagram"
      // aunque no lo estuvieras.
      if (error?.code === 'auth/popup-blocked' || error?.code === 'auth/operation-not-supported-in-this-environment') {
        await irAGoogle();
        return;
      }
      boton.disabled = false;
      alFallar?.();
      explicarFallo(error, mensaje);
    }
  });
}
