/**
 * `firebase-admin` para los scripts de la raiz.
 *
 * Solo esta instalado en `backend/node_modules` (lo instala `npm ci` dentro de
 * `backend/`), y Node busca los modulos subiendo desde la carpeta del script:
 * desde `scripts/` nunca llega a `backend/`. Con un `require('firebase-admin')`
 * a secas, todos los scripts de administracion fallaban con "Cannot find
 * module" aunque las dependencias estuvieran instaladas.
 */

const path = require('path');

const BACKEND = path.join(__dirname, '..', '..', 'backend');

let ruta;
try {
  ruta = require.resolve('firebase-admin', { paths: [BACKEND, __dirname] });
} catch {
  throw new Error('Falta firebase-admin. Instala las dependencias del worker una vez:\n'
    + '  cd backend\n  npm ci\n  cd ..');
}

module.exports = require(ruta);
