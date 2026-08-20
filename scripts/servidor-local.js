#!/usr/bin/env node
/**
 * Servidor estatico para desarrollo, que imita a GitHub Pages: sirve
 * `/home/` desde `/home/index.html` y cae en `404.html` cuando existe.
 *
 * Existe porque el emulador de Firebase Hosting ya no representa a produccion:
 * el sitio se sirve desde Pages, que ni aplica las cabeceras de `firebase.json`
 * ni entiende sus rewrites. Para mirar la CSP y los modulos hace falta algo que
 * se comporte como el destino real.
 *
 * Uso: node scripts/servidor-local.js [puerto]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PUERTO = Number(process.argv[2]) || 5000;

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
  });
  respuesta.end(fs.readFileSync(destino));
}).listen(PUERTO, () => {
  console.log(`Sitio en http://localhost:${PUERTO}/`);
});
