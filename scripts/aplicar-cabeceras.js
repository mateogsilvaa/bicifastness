#!/usr/bin/env node
/**
 * Vuelca la politica de seguridad de `shared/cabeceras.json` en cada pagina,
 * como <meta http-equiv="Content-Security-Policy"> y <meta name="referrer">.
 *
 * GitHub Pages no deja poner cabeceras HTTP, asi que el <meta> es la unica
 * CSP que llega al navegador. Lo que el <meta> no puede dar (frame-ancestors,
 * HSTS...) esta explicado en el propio cabeceras.json.
 *
 * Existe por dos motivos. El primero, que 18 paginas con la politica copiada a
 * mano divergen el mismo dia que alguien anade un origen. El segundo, mas
 * gordo: la CSP declaraba `script-src 'self'` mientras TODAS las paginas
 * llevaban su JavaScript incrustado, que esa politica bloquea. El sitio entero
 * se habria quedado sin funcionar, y nada lo delataba porque la unica pagina
 * publicada (la de obras) es la unica sin scripts.
 *
 * `npm run validar` comprueba que nada se ha quedado atras.
 *
 * Uso: node scripts/aplicar-cabeceras.js [--comprobar]
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
// docs/correos: los correos de ejemplo (npm run correos) no son paginas del sitio.
const IGNORAR = ['node_modules', '.git', 'backend', '.modulos', 'correos'];

const MARCA_CSP = /^[ \t]*<meta http-equiv="Content-Security-Policy"[^>]*>\r?\n?/m;
const REFERRER = '<meta name="referrer" content="strict-origin-when-cross-origin">';
const MARCA_REFERRER = /^[ \t]*<meta name="referrer"[^>]*>\r?\n?/m;

const config = () => JSON.parse(fs.readFileSync(path.join(RAIZ, 'shared/cabeceras.json'), 'utf8'));

/**
 * Las claves que empiezan por `_` son comentarios, no directivas.
 *
 * Sin esto, un comentario escrito DENTRO del objeto `csp` acaba serializado
 * como una directiva inventada, con su texto entero dentro de la politica. El
 * navegador ignora lo que no conoce, asi que no protesta: simplemente te pasas
 * un rato sin entender por que la directiva de al lado no se aplica. Paso.
 */
function serializar(directivas) {
  return Object.entries(directivas)
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
 * Devuelve el HTML con las etiquetas al dia, o null si ya lo estaban.
 *
 * La CSP tiene que ir lo antes posible en el <head>: el navegador aplica la
 * politica segun parsea, asi que cualquier recurso declarado por encima de ella
 * se carga sin control.
 */
function aplicarAPagina(html, cspMeta) {
  const etiqueta = `<meta http-equiv="Content-Security-Policy" content="${cspMeta}">`;

  const cspAlDia = MARCA_CSP.test(html) && html.match(MARCA_CSP)[0].trim() === etiqueta;
  const refAlDia = MARCA_REFERRER.test(html) && html.match(MARCA_REFERRER)[0].trim() === REFERRER;
  if (cspAlDia && refAlDia) return null;

  // Se quitan las que hubiera y se vuelven a poner juntas, para que el orden no
  // dependa de en que estado estuviera la pagina.
  const limpio = html.replace(MARCA_CSP, '').replace(MARCA_REFERRER, '');

  const charset = limpio.match(/^[ \t]*<meta charset="[^"]+">\r?\n?/m);
  if (!charset) return { error: 'no encuentro <meta charset> donde anclar la CSP' };

  return limpio.replace(charset[0], `${charset[0]}${etiqueta}\n${REFERRER}\n`);
}

// --- Ejecucion ---------------------------------------------------------------

const soloComprobar = process.argv.includes('--comprobar');
const cabeceras = config();
const cspMeta = serializar(cabeceras.csp);

let cambios = 0;
let errores = 0;

// 1. Las paginas.
for (const pagina of paginas(RAIZ)) {
  const rel = path.relative(RAIZ, pagina).split(path.sep).join('/');
  const html = fs.readFileSync(pagina, 'utf8');
  const resultado = aplicarAPagina(html, cspMeta);

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
  cambios++;
}

if (errores) {
  console.error(`\n${errores} sitios con las cabeceras mal. Lanza: node scripts/aplicar-cabeceras.js`);
  process.exit(1);
}

console.log(soloComprobar
  ? 'Cabeceras al dia en las paginas.'
  : `Cabeceras aplicadas — ${cambios} ficheros actualizados.`);
