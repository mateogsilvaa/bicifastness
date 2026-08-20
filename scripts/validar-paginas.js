#!/usr/bin/env node
/**
 * Comprueba, para cada pagina HTML del sitio:
 *   1. que todas las rutas de import existen en disco
 *   2. que los recursos locales referenciados (css, js, imagenes) existen
 *   3. que no queda ningun innerHTML fuera de comentarios
 *   4. que lleva la CSP de `shared/cabeceras.json` al dia
 *   5. que no tiene JavaScript incrustado, que la CSP bloquearia
 *
 * Esto pilla los enlaces rotos, que es el fallo mas facil de colar al mover
 * ficheros de sitio y el que ninguna otra herramienta del proyecto detecta:
 * el HTML sigue siendo valido y los tests siguen pasando.
 *
 * Uso: node scripts/validar-paginas.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const IGNORAR = ['node_modules', '.git', 'backend', '.modulos'];

function buscar(dir, extension, encontradas = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORAR.includes(e.name)) continue;
    const completo = path.join(dir, e.name);
    if (e.isDirectory()) buscar(completo, extension, encontradas);
    else if (e.name.endsWith(extension)) encontradas.push(completo);
  }
  return encontradas;
}

const paginas = (dir, encontradas) => buscar(dir, '.html', encontradas);

// Las exclusiones de `:` y `/` antes del comentario evitan que una URL se trague
// el resto del fichero: `https://*.basemaps.cartocdn.com`, que sale en la CSP de
// todas las paginas, abre un `/*` que no cierra hasta el siguiente `*/` real.
const sinComentarios = (texto) => texto
  .replace(/(^|[^:/])\/\*[\s\S]*?\*\//g, '$1')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  .replace(/<!--[\s\S]*?-->/g, '');

let errores = 0;
const lista = paginas(RAIZ);

for (const pagina of lista) {
  const rel = path.relative(RAIZ, pagina).split(path.sep).join('/');
  const html = fs.readFileSync(pagina, 'utf8');

  // El JavaScript de las paginas vive en assets/js/paginas/. Un <script> en
  // linea lo bloquearia la CSP, que declara `script-src 'self'` sin
  // 'unsafe-inline': la pagina se veria bien y no haria nada.
  if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(html)) {
    console.error(`INLINE   ${rel} lleva JavaScript incrustado, que la CSP bloquea`);
    errores++;
  }

  for (const m of html.matchAll(/(?:href|src)="(\/[^"#?]+)"/g)) {
    if (m[1].startsWith('//')) continue;
    let destino = path.join(RAIZ, m[1]);
    if (m[1].endsWith('/')) destino = path.join(destino, 'index.html');
    if (!fs.existsSync(destino)) {
      console.error(`RECURSO  ${rel} -> ${m[1]} no existe`);
      errores++;
    }
  }

  if (/\.innerHTML\s*\+?=/.test(sinComentarios(html))) {
    console.error(`XSS      ${rel} asigna innerHTML`);
    errores++;
  }
}

// --- Imports de los modulos --------------------------------------------------
// Antes esto se comprobaba sobre el <script type="module"> incrustado. Ahora el
// codigo vive en ficheros sueltos, asi que hay que mirarlos ahi o se dejaria de
// comprobar sin que nadie se entere.
const modulos = buscar(path.join(RAIZ, 'assets/js'), '.js');

for (const modulo of modulos) {
  const rel = path.relative(RAIZ, modulo).split(path.sep).join('/');
  const codigo = fs.readFileSync(modulo, 'utf8');

  for (const m of codigo.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const ruta = m[1];
    if (!ruta.startsWith('/') && !ruta.startsWith('.')) continue; // paquete externo

    const destino = ruta.startsWith('/')
      ? path.join(RAIZ, ruta)
      : path.resolve(path.dirname(modulo), ruta);

    if (!fs.existsSync(destino)) {
      console.error(`IMPORT   ${rel} -> ${ruta} no existe`);
      errores++;
    }
  }

  if (/\.innerHTML\s*\+?=/.test(sinComentarios(codigo))) {
    console.error(`XSS      ${rel} asigna innerHTML`);
    errores++;
  }
}

// --- CSP ---------------------------------------------------------------------
// Se delega en el propio generador para no tener la politica escrita en dos
// sitios, que es justo lo que este proyecto intenta no hacer.
try {
  execFileSync('node', [path.join(__dirname, 'aplicar-cabeceras.js'), '--comprobar'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
} catch {
  errores++;
}

console.log(
  `${lista.length} paginas y ${modulos.length} modulos revisados — ` +
  `${errores} ${errores === 1 ? 'error' : 'errores'}`
);
process.exit(errores ? 1 : 0);
