/**
 * Verificacion en dos pasos con una app de autenticacion (TOTP: Google
 * Authenticator, 1Password, Authy...).
 *
 * La hace Firebase Auth (Identity Platform), no nosotros: sin servidor, un
 * codigo comprobado en el navegador no valdria nada, porque el navegador es
 * justo lo que no es de fiar. Firebase lo comprueba y lo apunta en el token
 * firmado (`firebase.sign_in_second_factor == 'totp'`), y eso SI lo pueden
 * mirar las reglas de Firestore.
 *
 *   - Cualquiera puede activarla para su cuenta (Tu > Ajustes > Seguridad).
 *   - La administracion la necesita, y ademas reciente: cada vez que se entra
 *     al panel se vuelve a pedir el codigo (`verificarAdmin`), y las reglas no
 *     aceptan como admin un token cuya verificacion tenga mas de dos horas
 *     (`firestore.rules`, `segundoFactorAdmin`).
 *
 * Requisito de una vez en la consola de Firebase: Authentication con Identity
 * Platform y TOTP activado como segundo factor (docs/SEGURIDAD-2FA.md). Sin
 * eso, activarla dice que aun no esta disponible y no rompe nada.
 *
 * El secreto no sale de este navegador mas que hacia Firebase: el QR se pinta
 * aqui (assets/vendor/qrcode), no con un servicio de terceros.
 */

import {
  auth, multiFactor, TotpMultiFactorGenerator, getMultiFactorResolver,
  reauthenticateWithCredential, reauthenticateWithPopup, EmailAuthProvider,
  proveedorGoogle, browserPopupRedirectResolver,
} from './firebase.js';
import { el, abrirHoja, estado } from './dom.js';
import qrcode from '../vendor/qrcode/qrcode.js';

/** Cuanto vale una verificacion para el panel (las reglas dan 2 h de margen). */
const MINUTOS_VERIFICACION_ADMIN = 60;
const CLAVE_ADMIN = 'bf_admin_verificado';

/** ¿Tiene ya la verificacion en dos pasos? */
export function tieneDosPasos(usuario = auth.currentUser) {
  return Boolean(usuario && multiFactor(usuario).enrolledFactors.some((f) => f.factorId === 'totp'));
}

/** Los errores de esto, en castellano. */
function mensaje(error) {
  const c = error?.code || '';
  if (c === 'auth/invalid-verification-code' || c === 'auth/totp-challenge-timeout') return 'Ese código no es válido. Mira el que sale ahora en tu app.';
  if (c === 'auth/operation-not-allowed' || c === 'auth/admin-restricted-operation') return 'La verificación en dos pasos aún no está disponible. Lo estamos preparando.';
  if (c === 'auth/unverified-email') return 'Antes tienes que confirmar tu correo: abre el enlace que te mandamos al registrarte.';
  if (c === 'auth/unsupported-first-factor') return 'Esta forma de entrar no admite la verificación en dos pasos.';
  if (c === 'auth/requires-recent-login') return 'Por seguridad, cierra sesión, vuelve a entrar y repite esto.';
  if (c === 'auth/wrong-password' || c === 'auth/invalid-credential') return 'La contraseña no es correcta.';
  if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request') return 'Has cerrado la ventana antes de terminar.';
  if (c === 'auth/too-many-requests') return 'Demasiados intentos. Espera unos minutos.';
  if (c === 'auth/network-request-failed') return 'Sin conexión. Revisa tu red.';
  return 'No ha salido bien. Vuelve a intentarlo.';
}

/** El QR, como SVG. */
function qrSVG(texto) {
  const qr = qrcode(0, 'M');
  qr.addData(texto);
  qr.make();
  const n = qr.getModuleCount();
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `-2 -2 ${n + 4} ${n + 4}`);
  svg.setAttribute('class', 'qr-dos-pasos');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Código QR para tu app de autenticación');
  const fondo = document.createElementNS(NS, 'rect');
  for (const [k, v] of Object.entries({ x: -2, y: -2, width: n + 4, height: n + 4, fill: '#fff' })) fondo.setAttribute(k, String(v));
  svg.append(fondo);
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
  const ruta = document.createElementNS(NS, 'path');
  ruta.setAttribute('d', d);
  ruta.setAttribute('fill', '#000');
  svg.append(ruta);
  return svg;
}

/** Un campo de 6 cifras, con lo que esperan los moviles para autocompletarlo. */
function campoCodigo(idCampo) {
  return el('input', {
    clase: 'campo-codigo',
    attrs: {
      id: idCampo, inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}',
      maxlength: '6', placeholder: '000000', 'aria-label': 'Código de 6 cifras', required: '',
    },
  });
}

const limpio = (v) => String(v || '').replace(/\D/g, '').slice(0, 6);

/**
 * Pide un codigo y llama a `comprobar(codigo)` hasta que sale bien o se cierra.
 * @returns {Promise<boolean>} si salio bien
 */
function pedirCodigo({ titulo, texto, extra = [], boton = 'Verificar', comprobar, conClave = false }) {
  return new Promise((resolver) => {
    let hecho = false;
    const codigo = campoCodigo('codigo-dos-pasos');
    const clave = conClave ? el('input', {
      attrs: { type: 'password', autocomplete: 'current-password', 'aria-label': 'Tu contraseña', placeholder: 'Tu contraseña', required: '' },
    }) : null;
    const msg = el('p', { clase: 'mensaje', attrs: { 'aria-live': 'polite' } });
    const enviar = el('button', { clase: 'btn', texto: boton, attrs: { type: 'submit' } });
    const form = el('form', { clase: 'form-dos-pasos', attrs: { novalidate: '' } }, [
      ...extra,
      clave ? el('div', { clase: 'campo' }, [clave]) : null,
      codigo, msg, enviar,
    ]);
    const { cerrar } = abrirHoja([
      el('h2', { texto: titulo }),
      texto ? el('p', { clase: 'apagado', texto }) : null,
      form,
    ], { etiqueta: titulo, clase: 'hoja-dos-pasos', alCerrar: () => { if (!hecho) resolver(false); } });
    (clave || codigo).focus();

    codigo.addEventListener('input', () => {
      codigo.value = limpio(codigo.value);
      if (codigo.value.length === 6 && (!clave || clave.value)) form.requestSubmit();
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const valor = limpio(codigo.value);
      if (valor.length !== 6) { estado(msg, 'Escribe las 6 cifras.', 'error'); codigo.focus(); return; }
      if (clave && !clave.value) { estado(msg, 'Escribe tu contraseña.', 'error'); clave.focus(); return; }
      enviar.disabled = true;
      estado(msg, 'Comprobando…');
      try {
        await comprobar(valor, clave?.value);
        hecho = true;
        cerrar();
        resolver(true);
      } catch (error) {
        console.debug('Segundo paso', error);
        estado(msg, mensaje(error), 'error');
        codigo.value = '';
        codigo.focus();
        enviar.disabled = false;
      }
    });
  });
}

// --- Activar y desactivar ------------------------------------------------------

/**
 * Activa la verificacion en dos pasos en la cuenta abierta: genera el secreto,
 * enseña el QR y pide el primer codigo para confirmar que la app lo tiene.
 * @returns {Promise<boolean>}
 */
export async function activarDosPasos(usuario = auth.currentUser) {
  const sesion = await multiFactor(usuario).getSession();
  const secreto = await TotpMultiFactorGenerator.generateSecret(sesion);
  const url = secreto.generateQrCodeUrl(usuario.email || 'piloto', 'BiciFastness');
  return pedirCodigo({
    titulo: 'Verificación en dos pasos',
    texto: 'Escanea el código con tu app de autenticación (Google Authenticator, 1Password, Authy…) y escribe el código de 6 cifras que te da.',
    extra: [
      el('div', { clase: 'qr-caja' }, [qrSVG(url)]),
      el('details', { clase: 'clave-manual' }, [
        el('summary', { texto: '¿No puedes escanearlo?' }),
        el('p', { clase: 'menor', texto: 'Añade una cuenta a mano con esta clave:' }),
        el('code', { texto: secreto.secretKey.replace(/(.{4})/g, '$1 ').trim() }),
        el('a', { clase: 'menor', texto: 'O ábrelo en tu app desde este móvil', attrs: { href: url } }),
      ]),
    ],
    boton: 'Activar',
    comprobar: (codigo) => multiFactor(usuario).enroll(TotpMultiFactorGenerator.assertionForEnrollment(secreto, codigo), 'App de autenticación'),
  });
}

/** La quita. Firebase pide haber entrado hace poco: si no, lo dice el error. */
export async function desactivarDosPasos(usuario = auth.currentUser) {
  const factor = multiFactor(usuario).enrolledFactors.find((f) => f.factorId === 'totp');
  if (factor) await multiFactor(usuario).unenroll(factor);
}

export { mensaje as mensajeDosPasos };

// --- ¿Se puede activar? ----------------------------------------------------------

const CLAVE_NO_DISPONIBLE = 'bf_dos_pasos_no_disponible';
/** Cuanto se fia uno de un "no se puede" antes de volver a probar. */
const DIAS_NO_DISPONIBLE = 7;

/** Los errores que dicen que en esta cuenta, hoy, no se puede: no que algo haya fallado. */
const esNoDisponible = (error) => [
  'auth/operation-not-allowed', 'auth/admin-restricted-operation',
  'auth/unverified-email', 'auth/unsupported-first-factor',
].includes(error?.code);

/** Apunta (en este navegador) que activarla no es posible, si el error lo dice. */
export function apuntarSiNoDisponible(error) {
  if (!esNoDisponible(error)) return false;
  try { localStorage.setItem(CLAVE_NO_DISPONIBLE, String(Date.now())); } catch { /* se volvera a probar */ }
  return true;
}

/**
 * ¿Se puede activar en esta cuenta? Sin TOTP encendido en Firebase (o con el
 * correo sin confirmar) no hay manera, y ofrecerlo cada vez es solo un
 * estorbo. Se prueba pidiendo un secreto, que no activa nada, y un "no" se
 * recuerda una semana. Ante un fallo de otro tipo (sin red) se da por posible.
 */
export async function dosPasosDisponible(usuario = auth.currentUser) {
  try {
    if (Date.now() - Number(localStorage.getItem(CLAVE_NO_DISPONIBLE) || 0) < DIAS_NO_DISPONIBLE * 86400000) return false;
  } catch { /* sin almacenamiento: se prueba */ }
  try {
    await TotpMultiFactorGenerator.generateSecret(await multiFactor(usuario).getSession());
    return true;
  } catch (error) {
    return !apuntarSiNoDisponible(error);
  }
}

// --- Entrar --------------------------------------------------------------------

/**
 * Al entrar, si la cuenta tiene dos pasos, Firebase corta con
 * `auth/multi-factor-auth-required`. Esto pide el codigo y termina de entrar.
 *
 * @returns {Promise<import('firebase/auth').UserCredential|null>} null si se cancela
 *   o si el error no era de esto (entonces se relanza).
 */
export async function resolverSegundoPaso(error) {
  if (error?.code !== 'auth/multi-factor-auth-required') throw error;
  const resolutor = getMultiFactorResolver(auth, error);
  const pista = resolutor.hints.find((h) => h.factorId === 'totp');
  if (!pista) throw error;
  let credencial = null;
  const ok = await pedirCodigo({
    titulo: 'Código de verificación',
    texto: 'Escribe el código de 6 cifras de tu app de autenticación.',
    boton: 'Entrar',
    comprobar: async (codigo) => {
      credencial = await resolutor.resolveSignIn(TotpMultiFactorGenerator.assertionForSignIn(pista.uid, codigo));
    },
  });
  return ok ? credencial : null;
}

// --- Panel de administracion ---------------------------------------------------

const segundosDesde = (token) => Math.floor(Date.now() / 1000) - Number(token?.claims?.auth_time || 0);

function verificadoHacePoco(token) {
  try {
    const marca = Number(sessionStorage.getItem(CLAVE_ADMIN) || 0);
    if (Date.now() - marca > MINUTOS_VERIFICACION_ADMIN * 60000) return false;
  } catch {
    return false;
  }
  return token?.claims?.firebase?.sign_in_second_factor === 'totp'
    && segundosDesde(token) < MINUTOS_VERIFICACION_ADMIN * 60;
}

/**
 * La puerta del panel: pide el codigo cada vez que se entra (una vez por
 * pestaña y hora: pasar de una seccion a otra no lo vuelve a pedir).
 *
 * Por debajo es volver a identificarse (contraseña o Google) y despues el
 * codigo: es lo que hace que Firebase firme un token nuevo con el segundo paso
 * reciente, que es lo que miran las reglas.
 *
 * @returns {Promise<'ok'|'sin-dos-pasos'|'cancelado'>}
 */
export async function verificarAdmin(usuario, token) {
  if (!tieneDosPasos(usuario)) return 'sin-dos-pasos';
  if (verificadoHacePoco(token)) return 'ok';

  const conClave = usuario.providerData.some((p) => p.providerId === 'password');
  const terminar = async (error) => {
    const credencial = await resolverSegundoPaso(error);
    if (!credencial) throw Object.assign(new Error('cancelado'), { code: 'cancelado' });
  };

  let ok = false;
  try {
    if (conClave) {
      // Contraseña y codigo en el mismo dialogo: el codigo resuelve el reto que
      // Firebase devuelve al dar la contraseña.
      let reto = null;
      ok = await pedirCodigo({
        titulo: 'Entrar al panel',
        texto: 'Por seguridad, cada vez que entras al panel: tu contraseña y el código de tu app de autenticación.',
        boton: 'Entrar al panel',
        conClave: true,
        comprobar: async (codigo, clave) => {
          if (!reto) {
            try {
              await reauthenticateWithCredential(usuario, EmailAuthProvider.credential(usuario.email, clave));
              return; // sin reto: la cuenta no pide segundo paso (no deberia pasar)
            } catch (error) {
              if (error?.code !== 'auth/multi-factor-auth-required') throw error;
              reto = getMultiFactorResolver(auth, error);
            }
          }
          const pista = reto.hints.find((h) => h.factorId === 'totp');
          await reto.resolveSignIn(TotpMultiFactorGenerator.assertionForSignIn(pista.uid, codigo));
        },
      });
    } else {
      try {
        await reauthenticateWithPopup(usuario, proveedorGoogle(), browserPopupRedirectResolver);
        ok = true;
      } catch (error) {
        await terminar(error);
        ok = true;
      }
    }
  } catch (error) {
    console.debug('Verificacion del panel', error);
    ok = false;
  }
  if (!ok) return 'cancelado';
  await usuario.getIdToken(true);
  try { sessionStorage.setItem(CLAVE_ADMIN, String(Date.now())); } catch { /* sin marca: se pedira otra vez */ }
  return 'ok';
}
