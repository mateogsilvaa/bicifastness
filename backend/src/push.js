'use strict';

/**
 * Avisos push web (#33).
 *
 * POR QUE PUSH Y NO CORREO. El aviso mas util del juego es "te quedan cuatro
 * horas de racha". Por correo llega tarde y molesta; por push llega a tiempo y
 * se ignora sin abrir nada.
 *
 * LO QUE HAY QUE ASUMIR
 *
 *   - En iOS NO hay push si la web no esta anadida a la pantalla de inicio. Por
 *     eso este issue depende de la PWA (#52): sin instalarla, medio mundo se
 *     queda fuera y no hay forma de arreglarlo desde aqui.
 *   - Hacen falta claves VAPID, y el envio va desde el worker. Nunca desde el
 *     navegador: la clave privada firma los envios y en el cliente seria
 *     publica.
 *   - Una suscripcion caduca sola. El navegador la revoca al desinstalar la
 *     app, al limpiar los datos del sitio o porque si. Un 404 o un 410 del
 *     servicio de push significan "esta ya no vale": hay que borrarla, no
 *     reintentarla eternamente.
 *
 * NADA SE ENVIA A QUIEN NO LO HAYA ACEPTADO. No es una promesa: sin suscripcion
 * guardada no hay a donde enviar, y `quiere()` filtra ademas por el tipo.
 */

const webpush = require('web-push');
const { db } = require('./db');

/**
 * Tipos de aviso. La lista es cerrada a proposito: sin ella se acaba enviando
 * de todo, y el push es el canal que mas rapido se desactiva para siempre.
 */
const TIPOS = {
  viajeResuelto: {
    etiqueta: 'Cuando se resuelve un trayecto',
    // Lo que la persona esta esperando activamente: por defecto, si.
    porDefecto: true,
  },
  rachaEnPeligro: {
    etiqueta: 'Cuando mi racha esta en peligro',
    porDefecto: true,
  },
  cambioDivision: {
    etiqueta: 'Cuando cambio de division',
    porDefecto: false,
  },
};

let configurado = false;

/**
 * Prepara las claves. Devuelve false si no hay, y entonces no se envia nada.
 *
 * Sin claves NO es un error: es el estado normal hasta que alguien las genere
 * (`node scripts/claves-push.js`). Que el worker reviente por eso seria peor
 * que quedarse sin avisos.
 */
function configurar() {
  if (configurado) return true;

  const publica = process.env.VAPID_PUBLIC_KEY;
  const privada = process.env.VAPID_PRIVATE_KEY;
  const contacto = process.env.VAPID_SUBJECT || 'mailto:avisos@bicifastness.es';

  if (!publica || !privada) return false;

  webpush.setVapidDetails(contacto, publica, privada);
  configurado = true;
  return true;
}

/**
 * ¿Quiere esta persona este tipo de aviso?
 *
 * `undefined` significa "no lo ha tocado", no "lo ha desactivado": se aplica el
 * valor por defecto del tipo. Confundir las dos cosas es como se acaba sin
 * enviar nada a nadie, o enviando de todo a todos.
 */
function quiere(usuario, tipo) {
  const suscripciones = usuario?.push?.suscripciones;
  if (!Array.isArray(suscripciones) || !suscripciones.length) return false;

  const preferencia = usuario.push?.avisos?.[tipo];
  if (preferencia === undefined) return TIPOS[tipo]?.porDefecto === true;
  return preferencia === true;
}

/**
 * Envia un aviso a todas las suscripciones de una persona.
 *
 * Una misma cuenta puede tener varias: el movil y el ordenador son dos
 * navegadores distintos y cada uno tiene la suya. Enviar solo a la ultima
 * dejaria sin aviso al dispositivo que se este usando.
 *
 * NUNCA lanza. Un fallo de push no puede tumbar la verificacion de viajes.
 */
async function enviar(uid, tipo, mensaje, { simular = false } = {}) {
  if (!configurar()) return { enviados: 0, motivo: 'sin claves VAPID' };

  const ref = db().doc(`usuarios/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) return { enviados: 0, motivo: 'no existe' };

  const usuario = snap.data();
  if (!quiere(usuario, tipo)) return { enviados: 0, motivo: 'no lo quiere' };

  const suscripciones = usuario.push.suscripciones;
  if (simular) return { enviados: suscripciones.length, simulado: true };

  const carga = JSON.stringify({ ...mensaje, tipo });
  const caducadas = [];
  let enviados = 0;

  for (const suscripcion of suscripciones) {
    try {
      await webpush.sendNotification(suscripcion, carga);
      enviados++;
    } catch (error) {
      // 404 y 410 son la respuesta del servicio de push a "esta suscripcion ya
      // no existe". Reintentarla es tirar tiempo en cada pasada, para siempre.
      if (error.statusCode === 404 || error.statusCode === 410) {
        caducadas.push(suscripcion);
      } else {
        console.warn(`  push a ${uid}: ${error.statusCode || error.message}`);
      }
    }
  }

  if (caducadas.length) await olvidar(uid, caducadas);

  return { enviados, caducadas: caducadas.length };
}

/** Quita del usuario las suscripciones que el servicio ya no reconoce. */
async function olvidar(uid, suscripciones) {
  const ref = db().doc(`usuarios/${uid}`);
  const snap = await ref.get();
  if (!snap.exists) return;

  const muertas = new Set(suscripciones.map((s) => s.endpoint));
  const vivas = (snap.data().push?.suscripciones || []).filter((s) => !muertas.has(s.endpoint));

  await ref.update({ 'push.suscripciones': vivas });
}

/**
 * A quien avisar de que su racha esta en peligro.
 *
 * Es el aviso que justifica todo esto, y el que mas facil es enviar mal: a
 * quien ya ha salido hoy, a quien no tiene racha que perder, o dos veces el
 * mismo dia. Las tres cosas convierten el push en algo que se desactiva.
 */
function rachaEnPeligro(usuarios, hoy) {
  return usuarios.filter((u) => {
    if (!quiere(u, 'rachaEnPeligro')) return false;
    // Sin racha no hay nada que perder, y el aviso no significaria nada.
    if (!(u.racha > 0)) return false;
    // Ya ha salido hoy: la racha esta salvada.
    if (u.ultimoDiaActivo === hoy) return false;
    // Y una sola vez al dia.
    if (u.push?.ultimoAvisoRacha === hoy) return false;
    return true;
  });
}

module.exports = { TIPOS, configurar, quiere, enviar, olvidar, rachaEnPeligro };
