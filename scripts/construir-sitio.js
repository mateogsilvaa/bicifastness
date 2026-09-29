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

  for (const [vieja, nueva] of Object.entries(REDIRECCIONES)) {
    const carpeta = path.join(destino, vieja);
    // Si algun dia vuelve a existir una pagina con ese nombre, manda la pagina.
    if (fs.existsSync(carpeta)) continue;
    fs.mkdirSync(carpeta, { recursive: true });
    fs.writeFileSync(path.join(carpeta, 'index.html'), paginaQueSalta(nueva));
  }

  return { abierta, ficheros: contar(destino) };
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

module.exports = { construir, REDIRECCIONES, NO_SE_PUBLICA, publicable };
