'use strict';

/**
 * Punto unico desde el que se coge Firestore en el backend.
 *
 * Existe por el contador de cuota (#38). Cada modulo tenia su
 * `const db = () => admin.firestore();`, asi que envolver la instancia en el
 * worker media solo lo que el worker consultaba directamente — una parte
 * pequena — y dejaba fuera los agregados, la puntuacion, las metricas y las
 * temporadas, que es donde esta casi todo el gasto. El aviso habria llegado
 * tardisimo o nunca.
 *
 * Con esto, `usar()` instala una vez la instancia contada y todos los modulos
 * la reciben sin enterarse.
 *
 * Si nadie ha instalado nada — los tests, o un script suelto — se cae de vuelta
 * a `admin.firestore()`, que es lo que habia antes.
 */

const admin = require('firebase-admin');

let instalada = null;

/** Instala la instancia que van a usar todos los modulos. */
function usar(firestore) {
  instalada = firestore;
}

/** La instancia en uso. */
function db() {
  return instalada || admin.firestore();
}

module.exports = { db, usar };
