#!/usr/bin/env node
/**
 * Vuelca las cabeceras de seguridad de `shared/cabeceras.json` en los dos
 * sitios donde hacen falta:
 *
 *   1. `vercel.json`  las cabeceras HTTP de verdad, que son las que aplica el
 *                     navegador y las unicas que pueden declarar
 *                     `frame-ancestors` o HSTS
 *   2. cada pagina    la CSP tambien como <meta>, como defensa en profundidad
 *                     por si el HTML se sirve desde otro sitio
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
const IGNORAR = ['node_modules', '.git', 'backend', '.modulos'];

const MARCA_CSP = /^[ \t]*<meta http-equiv="Content-Security-Policy"[^>]*>\r?\n?/m;
const REFERRER = '<meta name="referrer" content="strict-origin-when-cross-origin">';
const MARCA_REFERRER = /^[ \t]*<meta name="referrer"[^>]*>\r?\n?/m;

const config = () => JSON.parse(fs.readFileSync(path.join(RAIZ, 'shared/cabeceras.json'), 'utf8'));

/** Convierte un objeto de directivas en la cadena de la politica. */
function serializar(directivas) {
  return Object.entries(directivas)
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

/** Bloque `headers` completo de vercel.json. */
function bloqueVercel({ csp, csp_solo_cabecera: soloCabecera, otras }) {
  const politica = serializar({ ...csp, ...soloCabecera });

  return [
    {
      source: '/(.*)',
      headers: [
        { key: 'Content-Security-Policy', value: politica },
        ...Object.entries(otras).map(([key, value]) => ({ key, value })),
      ],
    },
    {
      // Sin hash en el nombre, `immutable` dejaria a la gente con el CSS viejo
      // para siempre.
      source: '/(.*).(js|css|html)',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }],
    },
    {
      source: '/(.*).(png|jpg|jpeg|svg|webp|woff2|mp3|geojson)',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
    },
    {
      // ESTE BLOQUE VA EL ULTIMO A PROPOSITO. `/sw.js` encaja tambien en la
      // regla de `.js` de arriba, y cuando dos reglas definen la misma cabecera
      // gana la ultima. Subirlo dejaria el service worker cacheado, que es como
      // se queda un navegador sirviendo la app vieja para siempre.
      source: '/sw.js',
      headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
    },
  ];
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

// 2. vercel.json.
const rutaVercel = path.join(RAIZ, 'vercel.json');
if (!fs.existsSync(rutaVercel)) {
  console.error('ERROR    falta vercel.json');
  errores++;
} else {
  const vercel = JSON.parse(fs.readFileSync(rutaVercel, 'utf8'));
  const esperado = bloqueVercel(cabeceras);

  if (JSON.stringify(vercel.headers) !== JSON.stringify(esperado)) {
    if (soloComprobar) {
      console.error('CABECERA vercel.json no tiene las cabeceras al dia');
      errores++;
    } else {
      vercel.headers = esperado;
      fs.writeFileSync(rutaVercel, `${JSON.stringify(vercel, null, 2)}\n`, 'utf8');
      console.log('ok       vercel.json');
      cambios++;
    }
  }
}

if (errores) {
  console.error(`\n${errores} sitios con las cabeceras mal. Lanza: node scripts/aplicar-cabeceras.js`);
  process.exit(1);
}

console.log(soloComprobar
  ? 'Cabeceras al dia en las paginas y en vercel.json.'
  : `Cabeceras aplicadas — ${cambios} ficheros actualizados.`);
