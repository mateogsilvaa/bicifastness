'use strict';

/**
 * Limitacion de frecuencia con estado en Firestore, aplicada en transaccion.
 *
 * Esto sustituye a la comprobacion que hacia subir/index.html en el navegador
 * ("solo 3 viajes al dia"), que se saltaba cualquiera desde la consola. Al ir en
 * transaccion tambien resiste el envio simultaneo de varias peticiones, que es
 * como se burla un contador leido-y-luego-escrito.
 */

const admin = require('firebase-admin');
const { ErrorApp } = require('./errores');
const { inicioDelDiaMadrid } = require('./util');

// Firestore se coge de `db.js`, no de `admin` directamente: es lo que permite
// que el contador de cuota (#38) vea TODO lo que hace el backend.
const { db } = require('./db');

/**
 * Reserva un hueco para una accion limitada.
 * Si se supera algun limite lanza `resource-exhausted` con un mensaje util.
 *
 * @param {string} uid
 * @param {string} accion         clave del contador, p.ej. 'subida'
 * @param {object} opciones
 * @param {number} opciones.porDia
 * @param {number} [opciones.porSemana]
 * @param {number} [opciones.segundosEntre]
 */
async function consumirCupo(uid, accion, opciones) {
  const ref = db().doc(`rate_limits/${uid}_${accion}`);
  const ahora = Date.now();
  const inicioHoy = inicioDelDiaMadrid(new Date(ahora));
  const inicioSemana = ahora - 7 * 24 * 60 * 60 * 1000;

  await db().runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const datos = doc.exists ? doc.data() : {};
    const sellos = Array.isArray(datos.sellos) ? datos.sellos : [];

    const ultimo = sellos.length ? Math.max(...sellos) : 0;
    if (opciones.segundosEntre && ahora - ultimo < opciones.segundosEntre * 1000) {
      const faltan = Math.ceil((opciones.segundosEntre * 1000 - (ahora - ultimo)) / 1000);
      throw new ErrorApp('resource-exhausted',
        `Vas demasiado rapido. Espera ${faltan} s antes de volver a intentarlo.`);
    }

    const hoy = sellos.filter((t) => t >= inicioHoy).length;
    if (hoy >= opciones.porDia) {
      throw new ErrorApp('resource-exhausted',
        `Has alcanzado el limite de ${opciones.porDia} al dia. Vuelve manana.`);
    }

    if (opciones.porSemana) {
      const semana = sellos.filter((t) => t >= inicioSemana).length;
      if (semana >= opciones.porSemana) {
        throw new ErrorApp('resource-exhausted',
          `Has alcanzado el limite de ${opciones.porSemana} en 7 dias.`);
      }
    }

    // Conservamos solo la ventana que nos interesa para que el documento no crezca.
    const vigentes = sellos.filter((t) => t >= inicioSemana);
    vigentes.push(ahora);
    tx.set(ref, { uid, accion, sellos: vigentes, ultimo: ahora }, { merge: true });
  });
}

/**
 * Devuelve el cupo restante del dia sin consumirlo, para poder enseñarselo al
 * usuario en la interfaz.
 */
async function cupoRestante(uid, accion, porDia) {
  const doc = await db().doc(`rate_limits/${uid}_${accion}`).get();
  if (!doc.exists) return porDia;
  const inicioHoy = inicioDelDiaMadrid();
  const usados = (doc.data().sellos || []).filter((t) => t >= inicioHoy).length;
  return Math.max(0, porDia - usados);
}

module.exports = { consumirCupo, cupoRestante };
