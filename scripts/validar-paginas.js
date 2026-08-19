#!/usr/bin/env node
/**
 * Comprueba, para cada pagina HTML del sitio:
 *   1. que todas las rutas de import existen en disco
 *   2. que los recursos locales referenciados (css, js, imagenes) existen
 *   3. que no queda ningun innerHTML fuera de comentarios
 *
 * Esto pilla los enlaces rotos, que es el fallo mas facil de colar al mover
 * ficheros de sitio y el que ninguna otra herramienta del proyecto detecta:
 * el HTML sigue siendo valido y los tests siguen pasando.
 *
 * Uso: node scripts/validar-paginas.js
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const IGNORAR = ['node_modules', '.git', 'backend', '.modulos'];

function paginas(dir, encontradas = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORAR.includes(e.name)) continue;
    const completo = path.join(dir, e.name);
    if (e.isDirectory()) paginas(completo, encontradas);
    else if (e.name.endsWith('.html')) encontradas.push(completo);
  }
  return encontradas;
}

const sinComentarios = (texto) => texto
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  .replace(/<!--[\s\S]*?-->/g, '');

let errores = 0;
const lista = paginas(RAIZ);

for (const pagina of lista) {
  const rel = path.relative(RAIZ, pagina).split(path.sep).join('/');
  const html = fs.readFileSync(pagina, 'utf8');

  const modulo = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (modulo) {
    for (const m of modulo[1].matchAll(/from\s+['"](\/[^'"]+)['"]/g)) {
      if (!fs.existsSync(path.join(RAIZ, m[1]))) {
        console.error(`IMPORT   ${rel} -> ${m[1]} no existe`);
        errores++;
      }
    }
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

console.log(`${lista.length} paginas revisadas — ${errores} ${errores === 1 ? 'error' : 'errores'}`);
process.exit(errores ? 1 : 0);
