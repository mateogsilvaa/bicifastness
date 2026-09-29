/**
 * El boton de "Continuar con Google", el mismo en /entrar/ y en /register/.
 *
 * Las dos pantallas hacen lo mismo con el: en Google, entrar y registrarse son
 * el mismo gesto. Lo que cambia es lo que pasa despues, y eso lo decide la
 * portada: si la cuenta no tiene perfil de piloto, pide el nombre y los
 * consentimientos antes de dejar hacer nada.
 */

import { entrarConGoogle, getAdditionalUserInfo, traducirErrorAuth } from './firebase.js';
import { estado } from './dom.js';
import { anotar, volcar } from './metricas.js';

/**
 * @param {HTMLButtonElement} boton
 * @param {HTMLElement} mensaje  donde se explica un fallo
 * @param {() => void} alEmpezar  para que la pagina no redirija por su cuenta
 *   en cuanto `onAuthStateChanged` vea la sesion, antes de apuntar la metrica
 * @param {() => void} alFallar  para deshacer lo anterior
 */
export function montarBotonGoogle(boton, mensaje, { alEmpezar, alFallar } = {}) {
  boton.addEventListener('click', async () => {
    boton.disabled = true;
    estado(mensaje, '');
    alEmpezar?.();

    try {
      const resultado = await entrarConGoogle();

      // Una cuenta NUEVA no ha completado nada todavia: le falta el nombre de
      // piloto, y el registro se cuenta cuando lo elija (portada). Contarlo
      // aqui inflaria el embudo con quien abre el popup y se va.
      if (!getAdditionalUserInfo(resultado)?.isNewUser) anotar('login_completado');
      await volcar();
      window.location.replace('/');
    } catch (error) {
      boton.disabled = false;
      alFallar?.();
      estado(mensaje, traducirErrorAuth(error), 'error');
    }
  });
}
