#!/usr/bin/env node
/**
 * Los iconos de la web (pestaña, pantalla de inicio, manifiesto) y el logo de
 * los correos, a partir del logo del sistema (Logo.dc.html del diseño):
 * baldosa azul #1B80E5 con esquinas de 6,5/24, el anillo abierto blanco y el
 * punto de salida.
 *
 * Solo hace falta volver a lanzarlo si cambia el logo. Usa `sharp`, que esta
 * en backend/node_modules (cd backend && npm ci).
 *
 * Uso: node scripts/generar-iconos.js
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const DESTINO = path.join(RAIZ, 'images', 'icono');
const sharp = require(require.resolve('sharp', { paths: [path.join(RAIZ, 'backend')] }));

const AZUL = '#1B80E5';
const BLANCO = '#FFFFFF';

/** El logo, igual que en el diseño: viewBox 24x24. */
const logo = ({ fondo = AZUL, trazo = BLANCO, esquina = 6.5 } = {}) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect width="24" height="24" rx="${esquina}" fill="${fondo}"/>
  <path d="M12 5 A7 7 0 1 1 5.94 8.5" fill="none" stroke="${trazo}" stroke-width="2.6" stroke-linecap="round"/>
  <circle cx="5.94" cy="8.5" r="2.1" fill="${trazo}"/>
</svg>
`;

/**
 * Enmascarable (Android recorta a circulo, gota...): fondo a sangre y el
 * dibujo dentro de la zona segura del 80 %, asi que se reduce al 70 %.
 */
const enmascarable = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect width="24" height="24" fill="${AZUL}"/>
  <g transform="translate(3.6 3.6) scale(0.7)">
    <path d="M12 5 A7 7 0 1 1 5.94 8.5" fill="none" stroke="${BLANCO}" stroke-width="2.6" stroke-linecap="round"/>
    <circle cx="5.94" cy="8.5" r="2.1" fill="${BLANCO}"/>
  </g>
</svg>
`;

/**
 * Para la pantalla de inicio de iOS, que pone sus propias esquinas y no
 * admite transparencia: baldosa sin redondear y el dibujo un poco mas
 * pequeño, como hacen los iconos del sistema.
 */
const apple = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect width="24" height="24" fill="${AZUL}"/>
  <g transform="translate(1.8 1.8) scale(0.85)">
    <path d="M12 5 A7 7 0 1 1 5.94 8.5" fill="none" stroke="${BLANCO}" stroke-width="2.6" stroke-linecap="round"/>
    <circle cx="5.94" cy="8.5" r="2.1" fill="${BLANCO}"/>
  </g>
</svg>
`;

async function png(svg, lado, fichero) {
  await sharp(Buffer.from(svg), { density: Math.max(72, lado * 4) })
    .resize(lado, lado)
    .png({ compressionLevel: 9 })
    .toFile(fichero);
}

async function main() {
  fs.mkdirSync(DESTINO, { recursive: true });
  fs.writeFileSync(path.join(DESTINO, 'icono.svg'), logo());

  for (const lado of [48, 72, 96, 128, 144, 152, 192, 256, 384, 512]) {
    await png(logo(), lado, path.join(DESTINO, `icono-${lado}.png`));
  }
  for (const lado of [167, 180]) await png(apple(), lado, path.join(DESTINO, `icono-${lado}.png`));
  for (const lado of [192, 512]) await png(enmascarable(), lado, path.join(DESTINO, `maskable-${lado}.png`));

  // La insignia de las notificaciones: Android solo usa la transparencia, asi
  // que va el dibujo en blanco sobre nada. Con la baldosa saldria un cuadrado.
  await png(logo({ fondo: 'none', trazo: BLANCO }), 96, path.join(DESTINO, 'insignia-96.png'));

  // El logo suelto (lo usa la pagina de obras) y el de los correos, a 2x.
  await png(logo(), 512, path.join(RAIZ, 'images', 'logo.png'));
  await png(logo(), 56, path.join(DESTINO, 'logo-email.png'));

  console.log(`Iconos escritos en ${path.relative(RAIZ, DESTINO)}/`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
