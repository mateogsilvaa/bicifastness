#!/usr/bin/env node
/**
 * Monta en `_site/` la web tal cual se publica en GitHub Pages.
 *
 * El repositorio tiene mas cosas que la web: el worker, los scripts de
 * administracion, las reglas de Firestore, la documentacion. Nada de eso tiene
 * que acabar servido por URL (el backend y las reglas cuentan como funciona el
 * antifraude y a quien deja entrar donde). Aqui se copia solo lo publicable.
 *
 * Tres cosas que antes hacia `vercel.json` y que Pages no sabe hacer:
 *
 *   1. REDIRIGIR las rutas viejas (/ranking, /mapa...), que estan enlazadas
 *      desde fuera. Se genera una pagina minima por cada una que salta a la
 *      nueva.
 *   2. CERRAR LA WEB por obras. Con la web cerrada se publica SOLO la pagina de
 *      obras, como portada y como 404: cualquier URL, exista o no, la enseña.
 *      Se abre con la variable del repositorio `WEB_ABIERTA` = `si` (Settings →
 *      Secrets and variables → Actions → Variables) y volviendo a lanzar el
 *      workflow. Sin la variable, la web esta CERRADA: es el lado seguro por el
 *      que equivocarse.
 *   3. La version desplegada la escribe antes `build-version.js`, con el SHA
 *      que pone GitHub Actions.
 *
 * Uso:
 *   node scripts/construir-sitio.js              # segun WEB_ABIERTA
 *   node scripts/construir-sitio.js --abierta    # forzar abierta (pruebas)
 *   node scripts/construir-sitio.js --cerrada    # forzar obras (pruebas)
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

/**
 * Lo que NO se publica. Ademas de esto, nada que empiece por punto (.git,
 * .github, .claude), por guion bajo (_site) ni que acabe en .md o .log.
 */
const NO_SE_PUBLICA = new Set([
  'backend', 'scripts', 'shared', 'node_modules', 'docs', 'test-reglas',
  'firestore.rules', 'firestore.indexes.json', 'firebase.json',
  'package.json', 'package-lock.json', 'eslint.config.mjs',
]);

/** Las rutas de la v1 y a donde van ahora. */
const REDIRECCIONES = {
  home: '/',
  ranking: '/clasificacion/',
  bicirating: '/clasificacion/?tab=pilotos',
  mapa: '/territorio/',
  clanes: '/territorio/?tab=clanes',
  profile: '/yo/',
};

const publicable = (nombre) => !nombre.startsWith('.')
  && !nombre.startsWith('_')
  && !/\.(md|log)$/i.test(nombre)
  && !NO_SE_PUBLICA.has(nombre);

/** Una pagina que solo salta a otra. Sin scripts: el meta refresh basta. */
function paginaQueSalta(destino) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${destino}">
<link rel="canonical" href="${destino}">
<title>BiciFastness</title>
</head>
<body>
<p>Esta página se ha movido. <a href="${destino}">Ir a la nueva</a>.</p>
</body>
</html>
`;
}

function abiertaSegunEntorno() {
  if (process.argv.includes('--abierta')) return true;
  if (process.argv.includes('--cerrada')) return false;
  return /^(si|sí|true|1)$/i.test(String(process.env.WEB_ABIERTA || '').trim());
}

/**
 * @param {{destino?: string, abierta?: boolean}} opciones
 * @returns {{abierta: boolean, ficheros: number}}
 */
function construir({ destino = path.join(RAIZ, '_site'), abierta = abiertaSegunEntorno() } = {}) {
  fs.rmSync(destino, { recursive: true, force: true });
  fs.mkdirSync(destino, { recursive: true });

  const cname = path.join(RAIZ, 'CNAME');
  if (fs.existsSync(cname)) fs.copyFileSync(cname, path.join(destino, 'CNAME'));

  if (!abierta) {
    // Solo la pagina de obras, que no depende de nada del sitio salvo el icono.
    const obras = fs.readFileSync(path.join(RAIZ, 'mantenimiento', 'index.html'));
    fs.mkdirSync(path.join(destino, 'mantenimiento'), { recursive: true });
    for (const f of ['index.html', '404.html', 'mantenimiento/index.html']) {
      fs.writeFileSync(path.join(destino, f), obras);
    }
    fs.cpSync(path.join(RAIZ, 'images'), path.join(destino, 'images'), { recursive: true });
    return { abierta, ficheros: contar(destino) };
  }

  for (const entrada of fs.readdirSync(RAIZ)) {
    if (!publicable(entrada)) continue;
    fs.cpSync(path.join(RAIZ, entrada), path.join(destino, entrada), { recursive: true });
  }

  optimizar(destino, leerVersion());

  for (const [vieja, nueva] of Object.entries(REDIRECCIONES)) {
    const carpeta = path.join(destino, vieja);
    // Si algun dia vuelve a existir una pagina con ese nombre, manda la pagina.
    if (fs.existsSync(carpeta)) continue;
    fs.mkdirSync(carpeta, { recursive: true });
    fs.writeFileSync(path.join(carpeta, 'index.html'), paginaQueSalta(nueva));
  }

  return { abierta, ficheros: contar(destino) };
}

// --- Velocidad -------------------------------------------------------------------
//
// El sitio son modulos ES sin empaquetar: cada pagina importa otros, que
// importan otros. Sin ayuda, el navegador los descubre por niveles —pide uno,
// lo lee, ve sus imports, pide esos— y en GitHub Pages cada nivel son cientos
// de milisegundos. Tres o cuatro niveles eran segundos de pantalla en blanco.
//
// Aqui se arreglan dos cosas, solo en lo publicado (el repositorio no cambia):
//
//   1. Cada pagina declara en <head> TODOS los modulos que va a necesitar
//      (`modulepreload`), asi que se piden a la vez desde el principio.
//   2. Cada modulo y el CSS llevan la version en la URL (`?v=<commit>`). Una
//      URL con version nunca cambia de contenido, y el service worker la sirve
//      de su cache sin preguntar: volver a abrir la app no espera a la red. Al
//      publicar otra version cambian todas las URLs a la vez, asi que nunca se
//      mezclan modulos de dos despliegues.

const ORIGEN_FIREBASE = 'https://www.gstatic.com';

// `from '…'`, `import '…'` e `import('…')`, con rutas propias (absolutas en
// /assets/ o relativas).
const IMPORTS_PROPIOS = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])((?:\.{1,2}\/|\/assets\/)[^'"?]+?\.js)\2/g;
// Solo los estaticos, para saber que precargar (los dinamicos se piden cuando
// hacen falta, y precargarlos es justo lo que no se quiere).
const IMPORTS_ESTATICOS = /(?:\bfrom\s*|\bimport\s+)(['"])([^'"]+?)\1/g;

function leerVersion() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 8);
  try {
    const m = fs.readFileSync(path.join(RAIZ, 'assets/data/version.js'), 'utf8').match(/VERSION_APP = '([^']+)'/);
    if (m && m[1] !== 'desconocida') return m[1];
  } catch { /* sin version.js */ }
  return String(Date.now().toString(36));
}

/** Todos los modulos que carga una pagina, sin repetir y en orden de descubrimiento. */
function grafoDeModulos(destino, entradas) {
  const propios = new Set();
  const externos = new Set();
  const pendientes = [...entradas];
  while (pendientes.length) {
    const ruta = pendientes.shift();
    if (propios.has(ruta)) continue;
    const fichero = path.join(destino, ruta);
    if (!fs.existsSync(fichero)) continue;
    propios.add(ruta);
    const codigo = fs.readFileSync(fichero, 'utf8');
    for (const [, , especificador] of codigo.matchAll(IMPORTS_ESTATICOS)) {
      if (especificador.startsWith(ORIGEN_FIREBASE)) externos.add(especificador);
      else if (especificador.startsWith('/')) pendientes.push(especificador);
      else if (especificador.startsWith('.')) {
        pendientes.push(path.posix.normalize(path.posix.join(path.posix.dirname(ruta), especificador)));
      }
    }
  }
  return { propios: [...propios], externos: [...externos] };
}

function ficheros(dir, extension, lista = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const completo = path.join(dir, e.name);
    if (e.isDirectory()) ficheros(completo, extension, lista);
    else if (e.name.endsWith(extension)) lista.push(completo);
  }
  return lista;
}

function optimizar(destino, version) {
  const conVersion = (ruta) => `${ruta}?v=${version}`;

  // 1. Las precargas, calculadas sobre el codigo tal cual (antes de versionar).
  const precargas = new Map();
  for (const html of ficheros(destino, '.html')) {
    const texto = fs.readFileSync(html, 'utf8');
    const entradas = [...texto.matchAll(/<script type="module" src="(\/assets\/[^"?]+\.js)"/g)].map((m) => m[1]);
    if (entradas.length) precargas.set(html, grafoDeModulos(destino, entradas));
  }

  // 2. La version en cada import del codigo publicado.
  for (const js of ficheros(path.join(destino, 'assets'), '.js')) {
    if (js.includes(`${path.sep}vendor${path.sep}`)) continue;
    const codigo = fs.readFileSync(js, 'utf8');
    const nuevo = codigo.replace(IMPORTS_PROPIOS, (_, antes, comilla, ruta) => `${antes}${comilla}${conVersion(ruta)}${comilla}`);
    if (nuevo !== codigo) fs.writeFileSync(js, nuevo);
  }

  // 3. Cada pagina: version en sus modulos y su CSS, y las precargas en <head>.
  for (const html of ficheros(destino, '.html')) {
    let texto = fs.readFileSync(html, 'utf8');
    texto = texto
      .replace(/(<script type="module" src=")(\/assets\/[^"?]+\.js)(")/g, (_, a, ruta, b) => `${a}${conVersion(ruta)}${b}`)
      .replace(/(<link rel="stylesheet" href=")(\/assets\/css\/[^"?]+\.css)(")/g, (_, a, ruta, b) => `${a}${conVersion(ruta)}${b}`);

    const grafo = precargas.get(html);
    const lineas = ['<link rel="preload" href="/assets/fonts/archivo-latin.woff2" as="font" type="font/woff2" crossorigin>'];
    if (grafo) {
      if (grafo.externos.length) {
        lineas.push(`<link rel="preconnect" href="${ORIGEN_FIREBASE}" crossorigin>`);
        lineas.push('<link rel="preconnect" href="https://firestore.googleapis.com" crossorigin>');
      }
      for (const url of grafo.externos) lineas.push(`<link rel="modulepreload" href="${url}">`);
      for (const ruta of grafo.propios) lineas.push(`<link rel="modulepreload" href="${conVersion(ruta)}">`);
    }
    texto = texto.replace('</head>', `${lineas.join('\n')}\n</head>`);
    fs.writeFileSync(html, texto);
  }

  // 4. El service worker: una cache por version (al activarse borra las
  //    anteriores) y lo que precarga, con las mismas URLs que pedira la pagina.
  const sw = path.join(destino, 'sw.js');
  if (fs.existsSync(sw)) {
    const codigo = fs.readFileSync(sw, 'utf8')
      .replace(/const CACHE = '([^']+)';/, (_, nombre) => `const CACHE = '${nombre}-${version}';`)
      .replace(/'(\/assets\/[^'?]+\.(?:js|css))'/g, (_, ruta) => `'${conVersion(ruta)}'`);
    fs.writeFileSync(sw, codigo);
  }
}

function contar(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? contar(path.join(dir, e.name)) : 1), 0);
}

if (require.main === module) {
  const { abierta, ficheros } = construir();
  console.log(abierta
    ? `Web ABIERTA: ${ficheros} ficheros en _site/.`
    : `Web CERRADA por obras (WEB_ABIERTA no es "si"): ${ficheros} ficheros en _site/.`);
}

module.exports = { construir, grafoDeModulos, REDIRECCIONES, NO_SE_PUBLICA, publicable };
