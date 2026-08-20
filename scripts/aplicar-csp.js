#!/usr/bin/env node
/**
 * Escribe la Content-Security-Policy de `shared/csp.json` en cada pagina, como
 * <meta http-equiv>.
 *
 * Existe porque el sitio se sirve desde GitHub Pages, que no permite configurar
 * cabeceras HTTP: la CSP que vivia en `firebase.json` se perdia entera al
 * migrar. Y porque 16 paginas con la politica copiada a mano divergen el mismo
 * dia que alguien anade un origen.
 *
 * `npm run validar` comprueba que ninguna pagina se ha quedado atras.
 *
 * Uso: node scripts/aplicar-csp.js [--comprobar]
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const IGNORAR = ['node_modules', '.git', 'backend', '.modulos'];
const MARCA = /^[ \t]*<meta http-equiv="Content-Security-Policy"[^>]*>\r?\n?/m;

/**
 * La otra cabecera de `firebase.json` que si se puede declarar en HTML.
 * `X-Content-Type-Options`, `Permissions-Policy` y HSTS no tienen equivalente
 * en <meta> y se pierden al servir desde Pages.
 */
const REFERRER = '<meta name="referrer" content="strict-origin-when-cross-origin">';
const MARCA_REFERRER = /^[ \t]*<meta name="referrer"[^>]*>\r?\n?/m;

/** Construye la cadena de la politica a partir del JSON. */
function politica() {
  const csp = JSON.parse(fs.readFileSync(path.join(RAIZ, 'shared/csp.json'), 'utf8'));
  return Object.entries(csp)
    .filter(([directiva]) => !directiva.startsWith('_'))
    .map(([directiva, origenes]) => [directiva, ...origenes].join(' ').trim())
    .join('; ');
}

function paginas(dir, encontradas = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORAR.includes(e.name)) continue;
    const completo = path.join(dir, e.name);
    if (e.isDirectory()) paginas(completo, encontradas);
    else if (e.name.endsWith('.html')) encontradas.push(completo);
  }
  return encontradas;
}

/**
 * Devuelve el HTML con la etiqueta puesta al dia, o null si ya estaba bien.
 * La CSP tiene que ir lo antes posible en el <head>: el navegador aplica la
 * politica segun parsea, asi que cualquier recurso declarado por encima de ella
 * se carga sin control.
 */
function aplicar(html, contenido) {
  const etiqueta = `<meta http-equiv="Content-Security-Policy" content="${contenido}">`;
  const bloque = `${etiqueta}\n${REFERRER}\n`;

  const cspAlDia = MARCA.test(html) && html.match(MARCA)[0].trim() === etiqueta;
  const referrerAlDia = MARCA_REFERRER.test(html) && html.match(MARCA_REFERRER)[0].trim() === REFERRER;
  if (cspAlDia && referrerAlDia) return null;

  // Se quitan las etiquetas que hubiera y se vuelven a poner juntas, para que
  // el orden no dependa de en que estado estuviera la pagina.
  let limpio = html.replace(MARCA, '').replace(MARCA_REFERRER, '');

  // Van justo despues de <meta charset>, que debe ir en los primeros 1024
  // bytes. La CSP tiene que ir lo antes posible: el navegador aplica la
  // politica segun parsea, asi que cualquier recurso declarado por encima de
  // ella se carga sin control.
  const charset = limpio.match(/^[ \t]*<meta charset="[^"]+">\r?\n?/m);
  if (!charset) return { error: 'no encuentro <meta charset> donde anclar la CSP' };

  return limpio.replace(charset[0], `${charset[0]}${bloque}`);
}

const soloComprobar = process.argv.includes('--comprobar');
const contenido = politica();

let cambiadas = 0;
let errores = 0;

for (const pagina of paginas(RAIZ)) {
  const rel = path.relative(RAIZ, pagina).split(path.sep).join('/');
  const html = fs.readFileSync(pagina, 'utf8');
  const resultado = aplicar(html, contenido);

  if (resultado === null) continue;

  if (resultado && resultado.error) {
    console.error(`ERROR    ${rel}: ${resultado.error}`);
    errores++;
    continue;
  }

  if (soloComprobar) {
    console.error(`CSP      ${rel} no tiene la politica al dia`);
    errores++;
    continue;
  }

  fs.writeFileSync(pagina, resultado, 'utf8');
  console.log(`ok       ${rel}`);
  cambiadas++;
}

if (errores) {
  console.error(`\n${errores} paginas con la CSP mal. Lanza: node scripts/aplicar-csp.js`);
  process.exit(1);
}

console.log(soloComprobar
  ? 'CSP al dia en todas las paginas.'
  : `CSP aplicada — ${cambiadas} paginas actualizadas.`);
