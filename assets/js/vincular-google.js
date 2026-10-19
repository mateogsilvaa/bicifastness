/**
 * Correo y contraseña + Google = la misma cuenta.
 *
 * Firebase guarda una cuenta por correo. Si alguien se registro con correo y
 * contraseña y un dia pulsa "Entrar con Google" con ese mismo correo:
 * - con Gmail, Google manda: entra directamente en SU cuenta (mismo uid).
 * - con cualquier otro correo, Firebase se niega
 *   (`auth/account-exists-with-different-credential`): no puede saber si quien
 *   pulsa es el dueño de la contraseña.
 *
 * Para lo segundo: se guarda aqui la credencial de Google que trae el error,
 * se le pide que entre UNA vez con su contraseña y, al entrar, se vincula
 * Google a esa misma cuenta. Desde entonces entra con cualquiera de los dos y
 * es siempre el mismo piloto, con sus trayectos.
 *
 * Se guarda en `sessionStorage` (esta pestaña) y caduca a los 10 minutos: son
 * tokens de Google, y no tienen que quedarse por ahi.
 */

import { linkWithCredential, credencialGoogle, credencialGoogleDeError } from './firebase.js';

const CLAVE = 'bf_google_pendiente';
const VIGENCIA_MS = 10 * 60 * 1000;

/** Del error de Google: guarda lo necesario para vincular despues. Devuelve el correo, si lo trae. */
export function guardarGooglePendiente(error) {
  const cred = credencialGoogleDeError(error);
  const correo = String(error?.customData?.email || '').toLowerCase();
  if (!cred || (!cred.idToken && !cred.accessToken)) return correo || null;
  try {
    sessionStorage.setItem(CLAVE, JSON.stringify({
      correo, idToken: cred.idToken || null, accessToken: cred.accessToken || null, t: Date.now(),
    }));
  } catch { /* sin almacenamiento: tendra que volver a pulsar Google despues de entrar */ }
  return correo || null;
}

export function googlePendiente() {
  try {
    const d = JSON.parse(sessionStorage.getItem(CLAVE) || 'null');
    if (!d || Date.now() - d.t > VIGENCIA_MS) { sessionStorage.removeItem(CLAVE); return null; }
    return d;
  } catch {
    return null;
  }
}

const olvidar = () => { try { sessionStorage.removeItem(CLAVE); } catch { /* nada que olvidar */ } };

/**
 * Tras entrar con contraseña: si hay un Google pendiente del MISMO correo, lo
 * vincula. Nunca lanza: si falla, se entra igual, sin Google vinculado.
 * @returns {Promise<boolean>} si se ha vinculado
 */
export async function vincularGooglePendiente(usuario) {
  const p = googlePendiente();
  if (!p || !usuario) return false;
  // Solo al dueño de ese correo: nunca una cuenta de Google a otra persona.
  if (p.correo && String(usuario.email || '').toLowerCase() !== p.correo) { olvidar(); return false; }
  try {
    await linkWithCredential(usuario, credencialGoogle(p.idToken, p.accessToken));
    return true;
  } catch (error) {
    // Ya vinculada, o esa cuenta de Google ya es de otro usuario: no hay nada mas que hacer.
    console.debug('No se ha podido vincular Google', error?.code);
    return false;
  } finally {
    olvidar();
  }
}
