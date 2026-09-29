#!/usr/bin/env node
/**
 * Vuelca la clave publica de VAPID en el modulo que lee el navegador.
 *
 * Va aqui y no a mano para que el despliegue la pueda poner desde su entorno:
 * `VAPID_PUBLIC_KEY=... node scripts/build-push.js`.
 *
 * Sin la variable no falla: deja el marcador y el sitio funciona sin avisos,
 * que es el estado normal hasta que alguien genere las claves.
 */

const fs = require('fs');
const path = require('path');

const DESTINO = path.join(__dirname, '..', 'assets', 'data', 'push-config.js');
const MARCADOR = '__PON_AQUI_TU_CLAVE_PUBLICA_VAPID__';

/**
 * La clave que toca escribir.
 *
 * Si no viene por entorno se CONSERVA la que ya haya, no se pisa con el
 * marcador. Es lo que evita la trampa: el CI corre `npm run datos` sin la
 * variable y despues comprueba que los ficheros generados no han cambiado. Sin
 * esto, tener la clave puesta haria fallar el CI en cada pasada, y la salida
 * obvia — quitarla del control de versiones — dejaria el sitio desplegado sin
 * avisos.
 */
function claveAEscribir() {
  if (process.env.VAPID_PUBLIC_KEY) return process.env.VAPID_PUBLIC_KEY;

  try {
    const actual = fs.readFileSync(DESTINO, 'utf8').match(/VAPID_PUBLIC_KEY = '([^']*)'/);
    if (actual && actual[1]) return actual[1];
  } catch {
    // Todavia no existe.
  }
  return MARCADOR;
}

const clave = claveAEscribir();

fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
fs.writeFileSync(DESTINO,
  '// GENERADO AUTOMATICAMENTE por scripts/build-push.js — no editar a mano.\n'
  + '// Fuente: la variable de entorno VAPID_PUBLIC_KEY.\n'
  + '//\n'
  + '// La clave PUBLICA de VAPID no es un secreto: identifica al remitente y va\n'
  + '// en el JavaScript del sitio por diseno. La PRIVADA firma los envios y vive\n'
  + '// solo en los secretos de GitHub, donde la lee el worker.\n'
  + `export const VAPID_PUBLIC_KEY = '${clave}';\n`,
  'utf8');

// Los tipos de aviso los decide el backend, que es quien envia. El navegador
// solo los pinta, y tienen que ser LOS MISMOS: un interruptor para un tipo que
// el worker no conoce no apaga nada, y quien lo use pensara que si.
const { TIPOS } = require('../backend/src/push');

const TIPOS_DESTINO = path.join(__dirname, '..', 'assets', 'data', 'push-tipos.js');

fs.writeFileSync(TIPOS_DESTINO,
  '// GENERADO AUTOMATICAMENTE por scripts/build-push.js — no editar a mano.\n'
  + '// Fuente: backend/src/push.js\n'
  + '//\n'
  + '// Los tipos de aviso viven en el backend, que es quien decide si envia. El\n'
  + '// navegador solo los pinta, y tienen que ser LOS MISMOS: un interruptor para\n'
  + '// un tipo que el worker no conoce no apaga nada, y quien lo use pensara que si.\n'
  + `export const TIPOS = ${JSON.stringify(TIPOS)};\n`,
  'utf8');

console.log(clave === MARCADOR
  ? 'Sin VAPID_PUBLIC_KEY: el sitio queda sin avisos push (normal hasta generarlas).'
  : `OK: clave publica de VAPID escrita (${clave.slice(0, 12)}...).`);
console.log(`OK: ${Object.keys(TIPOS).length} tipos de aviso repartidos al navegador.`);
