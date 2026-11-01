/**
 * El boton de "Continuar con Google", el mismo en /entrar/ y en /register/.
 *
 * Las dos pantallas hacen lo mismo con el: en Google, entrar y registrarse son
 * el mismo gesto. Lo que cambia es lo que pasa despues, y eso lo decide la
 * portada: si la cuenta no tiene perfil de piloto, pide el nombre y los
 * consentimientos antes de dejar hacer nada.
 */

import { entrarConGoogle, getAdditionalUserInfo, traducirErrorAuth } from './firebase.js';
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
export function montarBotonGoogle(boton, mensaje, { alEmpezar, alFallar } = {}) {
  boton.addEventListener('click', async () => {
    // Dentro de Instagram y similares Google no deja entrar: se explica que
    // hacer en vez de dejar que falle con un error de ventanas emergentes.
    if (esNavegadorIntegrado()) { explicarNavegadorIntegrado(); return; }
    boton.disabled = true;
    estado(mensaje, '');
    alEmpezar?.();

    try {
      // Con dos pasos activados, Google tambien corta y pide el codigo.
      const resultado = await entrarConGoogle().catch(resolverSegundoPaso);
      if (!resultado) { boton.disabled = false; alFallar?.(); return; }

      // Una cuenta NUEVA no ha completado nada todavia: le falta el nombre de
      // piloto, y el registro se cuenta cuando lo elija (portada). Contarlo
      // aqui inflaria el embudo con quien abre el popup y se va.
      const cuentaNueva = Boolean(getAdditionalUserInfo(resultado)?.isNewUser);
      if (!cuentaNueva) anotar('login_completado');
      await volcar();
      window.location.replace(destinoTrasEntrar({ cuentaNueva }));
    } catch (error) {
      boton.disabled = false;
      alFallar?.();
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
      // La ventana de Google no se ha podido abrir: casi siempre es un
      // navegador integrado que no reconocemos. Se explica igual, sin asustar.
      if (error?.code === 'auth/popup-blocked') { explicarNavegadorIntegrado(); return; }
      estado(mensaje, traducirErrorAuth(error), 'error');
      // Que llegue al panel de errores con su codigo: "Google no funciona" sin
      // codigo no se puede arreglar. Solo el codigo y el mensaje de Firebase,
      // nada de la cuenta.
      if (!DE_LA_PERSONA.has(error?.code)) {
        // El mensaje de Firebase va en la pila, que es el campo libre que admiten
        // las reglas de `errores_cliente`.
        registrar(`Entrar con Google: ${error?.code || 'sin codigo'}`, String(error?.message || '').slice(0, 300))
          .catch(() => {});
      }
    }
  });
}
