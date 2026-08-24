#!/usr/bin/env node
/**
 * Genera el par de claves VAPID para los avisos push (#33).
 *
 * Se ejecuta UNA vez. Cambiarlas despues invalida todas las suscripciones que
 * haya: a todo el mundo le dejan de llegar los avisos y hay que volver a pedir
 * permiso, que es justo lo que no se puede volver a pedir. Guardalas bien.
 *
 * Uso: node scripts/claves-push.js
 */

const webpush = require('../backend/node_modules/web-push');

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log('Claves VAPID generadas. Se usan UNA vez y no se cambian:\n');

console.log('1. Secreto de GitHub (Settings > Secrets and variables > Actions):\n');
console.log(`   VAPID_PRIVATE_KEY = ${privateKey}`);
console.log(`   VAPID_PUBLIC_KEY  = ${publicKey}`);
console.log('   VAPID_SUBJECT     = mailto:tu@correo.com\n');

console.log('2. La PUBLICA tambien en el sitio, porque el navegador la necesita');
console.log('   para suscribirse. NO es un secreto: identifica al remitente y va');
console.log('   en el JavaScript por diseno.\n');
console.log('   Ponla en assets/data/push-config.js, o exporta VAPID_PUBLIC_KEY');
console.log('   y lanza `node scripts/build-push.js`.\n');

console.log('La PRIVADA firma los envios y no puede salir de los secretos: con');
console.log('ella, cualquiera manda notificaciones en nombre del sitio.');
