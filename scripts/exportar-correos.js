#!/usr/bin/env node
/**
 * Deja cada correo como un .html suelto en docs/correos/, con datos de ejemplo.
 *
 * Dos usos:
 *   - verlos en el navegador (o arrastrarlos a Gmail) sin mandar nada;
 *   - copiar `restablecer.html` en Firebase: Authentication → Plantillas →
 *     Restablecimiento de contraseña → Mensaje. Ese lo manda Firebase, no el
 *     worker, y por eso tiene que estar pegado alli.
 *
 * Uso: npm run correos
 */

const fs = require('fs');
const path = require('path');
const p = require('../backend/src/plantillas');

const DESTINO = path.join(__dirname, '..', 'docs', 'correos');
const TOKEN = 'ejemplo'.padEnd(40, '0');
const nombre = 'Lucía';

const correos = {
  '10a-rechazado': p.viajeRechazado({
    nombre, tokenBaja: TOKEN, ruta: 'Puerta del Sol → Ópera', tiempoSegundos: 512, fecha: 'hoy',
    motivo: 'El tiempo de la captura no coincide con el de BiciMAD.',
  }),
  '10b-error': p.errorAlProcesar({ nombre, tokenBaja: TOKEN, ruta: 'Puerta del Sol → Ópera' }),
  '10c-bienvenida': p.bienvenida({ nombre, tokenBaja: TOKEN }),
  '10d-mensaje': p.mensajeEquipo({
    nombre, tokenBaja: TOKEN, asunto: 'Sobre tu trayecto de ayer',
    texto: 'Hola: hemos visto que la captura venía recortada.\n\nSi la vuelves a subir entera, cuenta.',
    sobre: 'Trayecto Puerta del Sol → Ópera',
  }),
  '10e-suspendida': p.cuentaSuspendida({ nombre, motivo: 'Capturas editadas en varios trayectos.', desde: 'hoy' }),
  '10g-clave-cambiada': p.contrasenaCambiada({ nombre, cuando: 'hoy a las 18:02', dispositivo: 'Chrome en Android' }),
};

fs.mkdirSync(DESTINO, { recursive: true });
for (const [nombreFichero, m] of Object.entries(correos)) {
  fs.writeFileSync(path.join(DESTINO, `${nombreFichero}.html`), m.html, 'utf8');
}
fs.writeFileSync(path.join(DESTINO, 'restablecer.html'), p.PLANTILLA_FIREBASE_RESTABLECER, 'utf8');
console.log(`Escritos ${Object.keys(correos).length + 1} correos en ${path.relative(process.cwd(), DESTINO)}`);
