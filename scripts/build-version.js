#!/usr/bin/env node
/**
 * Genera `assets/data/version.js` con la version desplegada.
 *
 * Existe por una pregunta muy concreta que se hace cada vez que aparece un
 * error: **¿es nuevo, o llevaba ahi meses?** Sin saber de que version viene
 * cada error, la respuesta es mirar fechas y adivinar.
 *
 * De donde sale el identificador, por orden:
 *   1. `VERCEL_GIT_COMMIT_SHA`, que Vercel pone en cada despliegue
 *   2. `git rev-parse`, para desarrollo local
 *   3. 'desconocida', que tambien es informacion: significa que se sirvio algo
 *      generado fuera de los dos caminos previstos
 *
 * Lo lanza el `buildCommand` de vercel.json.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const DESTINO = path.join(RAIZ, 'assets/data/version.js');

function version() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 8);
  }

  try {
    return execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
      cwd: RAIZ,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'desconocida';
  }
}

const contenido = `// GENERADO por scripts/build-version.js. No editar a mano.
//
// Identifica la version desplegada. Viaja con cada error que se recoge, para
// poder responder si un fallo es nuevo o llevaba ahi desde antes.

export const VERSION_APP = '${version()}';
`;

fs.mkdirSync(path.dirname(DESTINO), { recursive: true });
fs.writeFileSync(DESTINO, contenido, 'utf8');

console.log(`Version desplegada: ${version()}`);
