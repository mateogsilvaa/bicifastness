'use strict';

/**
 * Envio de correo transaccional con Resend.
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
 * Prioridades. Cuando se acaba el cupo del dia, lo bajo espera a manana.
 * Un rechazo es informacion que la persona necesita para arreglar su viaje;
 * un resumen semanal, no.
 */
const PRIORIDAD = {
  viaje_rechazado: 1,
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
async function enviar({ para, asunto, html, texto, remitente, apiKey, simular = false }) {
  if (simular) {
    console.log(`  [simulacion] correo a ${para}: ${asunto}`);
    return { enviado: false, simulado: true };
  }

  if (!apiKey) {
    return { enviado: false, error: 'No hay RESEND_API_KEY configurada.' };
  }
  if (!para || !asunto) {
    return { enviado: false, error: 'Falta destinatario o asunto.' };
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
  const restante = Math.max(0, MAX_DIARIO - enviadosHoy);

  const ordenada = [...cola].sort((a, b) =>
    (PRIORIDAD[a.tipo] ?? 9) - (PRIORIDAD[b.tipo] ?? 9));

  return {
    ahora: ordenada.slice(0, restante),
    esperan: ordenada.slice(restante),
  };
}

module.exports = {
  enviar,
  escapar,
  repartirCupo,
  PRIORIDAD,
  MAX_DIARIO,
};
