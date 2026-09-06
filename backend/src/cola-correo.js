'use strict';

/**
 * La cola de correos pendientes (#65).
 *
 * DE DONDE SE VIENE. `correo.enviar` se tomaba la molestia de clasificar cada
 * fallo —`reintentable: status === 429 || status >= 500`— y quien lo llamaba
 * tiraba ese dato a la basura. Un 429 de Resend, un 5xx o un timeout de 15 s se
 * registraban en consola y ahi acababa todo. El caso que mas duele es
 * `viaje_rechazado`, que es el unico correo que se manda en el momento y
 * precisamente para que la persona sepa por que le han tumbado el viaje.
 *
 * `decidirReintento`, `debeDejarDeIntentar` y `repartirCupo` llevaban escritas
 * y probadas desde el principio, sin un solo llamante. Esto es lo que faltaba
 * para que sirvieran de algo.
 *
 * QUE SE GUARDA, Y SOBRE TODO QUE NO. Un correo encolado guarda:
 *
 *     { uid, tipo, extra, intentos, reintentarTras }
 *
 * NO guarda el destinatario ni el mensaje ya montado. Eso es deliberado: la
 * direccion vive en Firebase Auth, que es su sitio, y el mensaje lleva dentro
 * el nombre de la persona. Guardar cualquiera de las dos cosas en Firestore es
 * exactamente lo que se saco de ahi en #59 y #60. Se resuelven las dos en el
 * momento de enviar, que ademas evita mandar un nombre viejo.
 *
 * `extra` son los datos de la plantilla —la ruta, los motivos del rechazo— que
 * no identifican a nadie por si solos y sin los cuales el correo no se puede
 * volver a montar.
 *
 * Aqui no hay IO: entra el estado, sale la decision, y el worker lee y escribe.
 * Es el mismo reparto que `denuncias.js`, `nombres.js` y `rachas.js`.
 */

const { PRIORIDAD, MAX_DIARIO } = require('./correo');

/** Cuantos se miran por pasada. Acotado, como todo lo que lee el worker. */
const POR_PASADA = 50;

/**
 * Lo que se guarda de un correo que no ha podido salir.
 *
 * @param {string} uid
 * @param {string} tipo   una clave de `plantillas.POR_TIPO`
 * @param {object} extra  datos de la plantilla, sin nada que identifique
 */
function entrada(uid, tipo, extra = {}, ahora = new Date()) {
  return {
    uid,
    tipo,
    extra,
    intentos: 1,
    // El primer reintento no es inmediato: si Resend acaba de devolver un 429,
    // volver a la carga en la misma pasada es empujar mas fuerte.
    reintentarTras: new Date(ahora.getTime() + 60000),
    creado: ahora,
  };
}

/**
 * De los pendientes que ya toca reintentar, cuales caben hoy.
 *
 * Dos cortes, y los dos importan:
 *
 *   1. `reintentarTras` — no se toca lo que todavia esta esperando su turno
 *   2. el cupo del dia — `MAX_DIARIO` es 90 y el plan gratis de Resend da 100
 *
 * El segundo corte NO es por orden de llegada, es por PRIORIDAD: cuando se
 * acaba el cupo, lo que se queda fuera es el resumen semanal, no el aviso de
 * que te han rechazado un viaje. Para eso estaba `repartirCupo`.
 */
function tocaAhora(pendientes, { enviadosHoy = 0, ahora = new Date() } = {}) {
  const vencidos = pendientes.filter((p) => {
    const cuando = p.reintentarTras?.toDate?.() || p.reintentarTras;
    return !cuando || new Date(cuando) <= ahora;
  });

  const restante = Math.max(0, MAX_DIARIO - enviadosHoy);

  const ordenada = [...vencidos].sort((a, b) =>
    (PRIORIDAD[a.tipo] ?? 9) - (PRIORIDAD[b.tipo] ?? 9));

  return { ahora: ordenada.slice(0, restante), esperan: ordenada.slice(restante) };
}

module.exports = { entrada, tocaAhora, POR_PASADA };
