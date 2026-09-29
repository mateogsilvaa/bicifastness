#!/usr/bin/env node
/**
 * Servidor estatico para desarrollo. Sirve como GitHub Pages: `/home/` desde
 * `/home/index.html`, y 404.html para lo que no existe. La CSP va por <meta>
 * en cada pagina, asi que en local se aplica igual que en produccion.
 *
 * Para ver exactamente lo que se publica: `node scripts/construir-sitio.js
 * --abierta` y servir `_site/`.
 *
 * Uso: node scripts/servidor-local.js [puerto]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PUERTO = Number(process.argv[2]) || 5000;
// `npm run maqueta`: sirve un Firebase de mentira con datos de ejemplo
// (scripts/maqueta/firebase.js) para ver todas las pantallas con sesion sin
// cuenta ni red. Nunca afecta a lo que se despliega.
const MAQUETA = process.argv.includes('--maqueta');

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
};

http.createServer((peticion, respuesta) => {
  const url = decodeURIComponent(peticion.url.split('?')[0]);

  // Sin esto, `GET /../firestore.rules` sirve ficheros de fuera del sitio.
  let destino = path.join(RAIZ, url);
  if (!destino.startsWith(RAIZ)) {
    respuesta.writeHead(403).end('Fuera del sitio');
    return;
  }

  if (url.endsWith('/')) destino = path.join(destino, 'index.html');
  if (MAQUETA && url === '/assets/js/firebase.js') destino = path.join(__dirname, 'maqueta', 'firebase.js');

  if (!fs.existsSync(destino) || fs.statSync(destino).isDirectory()) {
    const cuatrocientos = path.join(RAIZ, '404.html');
    if (fs.existsSync(cuatrocientos)) {
      respuesta.writeHead(404, { 'Content-Type': TIPOS['.html'] });
      respuesta.end(fs.readFileSync(cuatrocientos));
      return;
    }
    respuesta.writeHead(404).end('No encontrado');
    return;
  }

  respuesta.writeHead(200, {
    'Content-Type': TIPOS[path.extname(destino)] || 'application/octet-stream',
    // Sin esto el navegador cachea por heuristica (no hay Cache-Control, pero
    // si Last-Modified) y sigue sirviendo el CSS y los modulos viejos aunque el
    // fichero en disco haya cambiado. Cuesta un buen rato darse cuenta de que
    // lo que estas mirando no es lo que acabas de escribir.
    'Cache-Control': 'no-store',
  });
  respuesta.end(fs.readFileSync(destino));
}).listen(PUERTO, () => {
  console.log(`Sitio en http://localhost:${PUERTO}/${MAQUETA ? "  (maqueta: datos de ejemplo, sin Firebase)" : ""}`);
});
