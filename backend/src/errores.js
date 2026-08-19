'use strict';

/**
 * Error de negocio del backend.
 *
 * Sustituye al `HttpsError` de firebase-functions, que se importaba cuando esto
 * eran Cloud Functions. Ya no lo son: el codigo corre en un worker de GitHub
 * Actions, asi que arrastrar todo el SDK de funciones solo para una clase de
 * error no tenia sentido.
 *
 * Se conserva el campo `codigo` con los mismos nombres (`invalid-argument`,
 * `permission-denied`...) porque describen bien la causa y hacen legibles los
 * registros del worker.
 */
class ErrorApp extends Error {
  constructor(codigo, mensaje) {
    super(mensaje);
    this.name = 'ErrorApp';
    this.codigo = codigo;
  }
}

module.exports = { ErrorApp };
