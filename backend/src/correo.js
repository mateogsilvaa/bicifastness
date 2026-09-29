'use strict';

/**
 * Envio de correo transaccional: por Gmail (la cuenta del proyecto) o por Resend.
 *
 * GMAIL, si estan GMAIL_USUARIO y GMAIL_CLAVE_APLICACION. Es la via por
 * defecto: sale de bicifastness@gmail.com, sin dominio propio que verificar y
 * con unos 500 destinatarios al dia. La clave es una CONTRASEÑA DE APLICACION
 * (Cuenta de Google → Seguridad → Verificacion en dos pasos → Contraseñas de
 * aplicacion), nunca la contraseña de la cuenta: se puede revocar sola sin
 * tocar nada mas, y no da acceso a la bandeja ni al resto de Google.
 *
 * RESEND, si no hay Gmail y esta RESEND_API_KEY. Queda para cuando haya dominio
 * propio y mas volumen.
 *
 * La v1 mandaba correo con una contrasena de aplicacion de Gmail EN CLARO Y
 * COMMITEADA (`functions/index.js`). Aqui la clave vive en GitHub Secrets y
 * solo la ve el worker: nunca toca el navegador ni Firestore, que es
 * exactamente por donde se filtraron las claves anteriores.
 *
 * Limites del plan gratuito de Resend: 3.000 correos al mes y 100 al dia. Con
 * un aviso por viaje verificado se llega antes de lo que parece, asi que:
 *
 *   - hay un tope diario propio, mas bajo que el suyo, y al alcanzarlo se
 *     encola en vez de enviar
 *   - los avisos de viaje verificado NO van uno por viaje: se agrupan
 *   - lo transaccional urgente (un rechazo) tiene prioridad sobre lo demas
 *
 * Nada de esto envia en modo simulacion. El worker corre con `--simular` a
 * menudo, y mandar correo de verdad desde una simulacion seria justo el tipo de
 * efecto secundario que una simulacion no debe tener.
 */

const ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 15000;

/** Margen contra el limite de 100/dia de Resend, para no chocar con el. */
const MAX_DIARIO = 90;

/**
 * Gmail deja unos 500 destinatarios al dia por SMTP a una cuenta normal. Se
 * queda en 400: pasarse bloquea el envio 24 h, y con el los avisos de cuota.
 */
const MAX_DIARIO_GMAIL = 400;

/** ¿Hay credenciales de Gmail? */
const hayGmail = () => Boolean(process.env.GMAIL_USUARIO && process.env.GMAIL_CLAVE_APLICACION);

/** El tope del dia segun la via que se este usando. */
function maxDiario() {
  return hayGmail() ? MAX_DIARIO_GMAIL : MAX_DIARIO;
}

/** El remitente por defecto: la propia cuenta de Gmail, que es la unica que Gmail deja poner. */
function remitentePorDefecto() {
  if (hayGmail()) return `BiciFastness <${process.env.GMAIL_USUARIO}>`;
  return process.env.CORREO_REMITENTE || 'BiciFastness <avisos@bicifastness.es>';
}

let transporteGmail = null;
function gmail() {
  if (!transporteGmail) {
    const nodemailer = require('nodemailer');
    transporteGmail = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.GMAIL_USUARIO,
        // Google la enseña en grupos de cuatro con espacios; los espacios sobran.
        pass: String(process.env.GMAIL_CLAVE_APLICACION).replace(/\s+/g, ''),
      },
      connectionTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS,
    });
  }
  return transporteGmail;
}

/**
 * ¿Merece la pena reintentar un fallo de SMTP?
 *
 * 4xx es temporal por definicion (421 saturado, 450/451/452 cupo o buzon
 * ocupado, 454 limite de envio); 5xx es definitivo (550 no existe, 553
 * direccion mal escrita)... salvo el 535 de autenticacion, que no mejora
 * reintentando pero TAMPOCO es culpa del destinatario: ese se marca aparte.
 */
function clasificarSmtp(err) {
  const codigo = Number(err?.responseCode) || 0;
  if (!codigo) return { reintentable: true };               // red, timeout, TLS
  if (codigo === 535 || codigo === 534) return { reintentable: false, credenciales: true };
  return { reintentable: codigo >= 400 && codigo < 500 };
}

async function enviarPorGmail({ para, asunto, html, texto, remitente, responderA }) {
  try {
    const info = await gmail().sendMail({
      from: remitente || remitentePorDefecto(),
      to: para,
      subject: asunto,
      html,
      text: texto,
      ...(responderA ? { replyTo: responderA } : {}),
    });
    return { enviado: true, id: info.messageId || null };
  } catch (err) {
    const { reintentable, credenciales } = clasificarSmtp(err);
    return {
      enviado: false,
      reintentable,
      error: credenciales
        ? 'Gmail rechaza la contraseña de aplicacion (revisa GMAIL_USUARIO y GMAIL_CLAVE_APLICACION).'
        : `Gmail: ${String(err?.response || err?.message || err).slice(0, 200)}`,
    };
  }
}

/**
 * Prioridades. Cuando se acaba el cupo del dia, lo bajo espera a manana.
 * Un rechazo es informacion que la persona necesita para arreglar su viaje;
 * un resumen semanal, no.
 */
const PRIORIDAD = {
  // Seguridad y moderacion, lo primero: una suspension o un cambio de
  // contraseña que no llega es un problema de verdad.
  clave_cambiada: 0,
  cuenta_suspendida: 0,
  mensaje_equipo: 1,
  viaje_rechazado: 1,
  error_procesar: 1,
  viaje_anulado: 1,
  bienvenida: 2,
  revision_lenta: 3,
  viajes_verificados: 4,
  resumen_semanal: 5,
};

/** Escapa texto que viene del usuario antes de meterlo en el HTML. */
function escapar(texto) {
  return String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Envia un correo. Nunca lanza: devuelve el resultado para que el worker
 * decida, porque un fallo de correo no puede tumbar la verificacion de viajes.
 *
 * @param {object} opciones
 * @param {string} opciones.para        destinatario
 * @param {string} opciones.asunto
 * @param {string} opciones.html
 * @param {string} opciones.texto       version en texto plano
 * @param {string} opciones.remitente
 * @param {string} [opciones.apiKey]
 * @param {boolean} [opciones.simular]
 */
async function enviar({ para, asunto, html, texto, remitente, apiKey, responderA = null, simular = false }) {
  if (simular) {
    console.log(`  [simulacion] correo a ${para}: ${asunto}`);
    return { enviado: false, simulado: true };
  }

  if (!para || !asunto) {
    return { enviado: false, error: 'Falta destinatario o asunto.' };
  }

  // Gmail primero, si esta configurado.
  if (hayGmail()) return enviarPorGmail({ para, asunto, html, texto, remitente, responderA });

  if (!apiKey) {
    return { enviado: false, error: 'No hay correo configurado: ni GMAIL_USUARIO/GMAIL_CLAVE_APLICACION ni RESEND_API_KEY.' };
  }

  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(), TIMEOUT_MS);

  try {
    const respuesta = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: remitente,
        to: [para],
        subject: asunto,
        ...(responderA ? { reply_to: responderA } : {}),
        html,
        // Sin version en texto plano, varios clientes marcan el correo como
        // sospechoso y baja la entregabilidad.
        text: texto,
      }),
      signal: control.signal,
    });

    if (!respuesta.ok) {
      const detalle = await respuesta.text().catch(() => '');
      return {
        enviado: false,
        // 429 y 5xx merecen reintento; un 422 por direccion invalida, no.
        reintentable: respuesta.status === 429 || respuesta.status >= 500,
        error: `Resend HTTP ${respuesta.status}: ${detalle.slice(0, 200)}`,
      };
    }

    const datos = await respuesta.json().catch(() => ({}));
    return { enviado: true, id: datos.id || null };
  } catch (err) {
    const motivo = err.name === 'AbortError' ? 'tiempo de espera agotado' : err.message;
    return { enviado: false, reintentable: true, error: `No se ha podido contactar con Resend: ${motivo}` };
  } finally {
    clearTimeout(temporizador);
  }
}

/**
 * Ordena una tanda de correos por prioridad y corta por el cupo del dia.
 * Lo que no cabe se devuelve aparte para que el worker lo deje encolado.
 */
function repartirCupo(cola, enviadosHoy = 0) {
  const restante = Math.max(0, maxDiario() - enviadosHoy);

  const ordenada = [...cola].sort((a, b) =>
    (PRIORIDAD[a.tipo] ?? 9) - (PRIORIDAD[b.tipo] ?? 9));

  return {
    ahora: ordenada.slice(0, restante),
    esperan: ordenada.slice(restante),
  };
}

/**
 * Token de baja: opaco, aleatorio y por usuario.
 *
 * No lleva dentro el uid ni nada descifrable. Es una llave suelta que el worker
 * cambia por el usuario mirando quien la tiene guardada, asi que aunque alguien
 * intercepte un correo ajeno solo puede dar de baja a esa persona, no deducir
 * quien es ni tocar su cuenta.
 *
 * 32 bytes en base64url son 43 caracteres: dentro del rango que exigen las
 * reglas de Firestore (32-128) y muy lejos de poder adivinarse a intentos.
 */
function generarTokenBaja() {
  return require('crypto').randomBytes(32).toString('base64url');
}

// --- Reintentos --------------------------------------------------------------

/** Cuantas veces se reintenta antes de darlo por perdido. */
const MAX_INTENTOS = 4;

/**
 * Cuanto esperar antes del siguiente intento, en minutos.
 *
 * Espera creciente: si Resend esta saturado, reintentar cada minuto solo empuja
 * mas. Y el ultimo intento cae mas de una hora despues, que da margen a que se
 * arregle una caida corta sin intervencion.
 */
function esperaMinutos(intento) {
  return [1, 5, 20, 90][Math.min(intento, 3)];
}

/**
 * Decide que hacer con un correo de la cola.
 *
 * Se separa del envio a proposito: asi la politica de reintentos se puede
 * probar entera sin red, que es donde estan los errores de este tipo de codigo.
 *
 * @param {object} entrada     documento de la cola
 * @param {object} resultado   lo que devolvio `enviar`
 * @param {Date}   ahora
 */
function decidirReintento(entrada, resultado, ahora = new Date()) {
  if (resultado.enviado) {
    return { estado: 'enviado', enviadoEn: ahora };
  }

  const intentos = (entrada.intentos || 0) + 1;

  // Un 422 por direccion invalida no mejora reintentando: solo gasta cupo.
  if (!resultado.reintentable) {
    return { estado: 'fallido', intentos, error: resultado.error || 'error definitivo' };
  }

  if (intentos >= MAX_INTENTOS) {
    return { estado: 'fallido', intentos, error: `agotados ${MAX_INTENTOS} intentos` };
  }

  return {
    estado: 'pendiente',
    intentos,
    error: resultado.error || null,
    reintentarTras: new Date(ahora.getTime() + esperaMinutos(intentos) * 60000),
  };
}

/**
 * Una direccion que rebota siempre deja de recibir intentos.
 *
 * No es cortesia: seguir escribiendo a direcciones muertas hunde la reputacion
 * del dominio, y con ella la entregabilidad de todos los demas correos.
 */
function debeDejarDeIntentar(entrada) {
  return (entrada.rebotes || 0) >= 2;
}

module.exports = {
  enviar,
  escapar,
  repartirCupo,
  generarTokenBaja,
  decidirReintento,
  debeDejarDeIntentar,
  esperaMinutos,
  PRIORIDAD,
  MAX_DIARIO,
  MAX_DIARIO_GMAIL,
  MAX_INTENTOS,
  maxDiario,
  hayGmail,
  remitentePorDefecto,
  clasificarSmtp,
};
