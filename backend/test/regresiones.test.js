'use strict';

/**
 * Pruebas de regresion de la arquitectura.
 *
 * En este montaje NO hay servidor HTTP: el navegador escribe directamente en
 * Firestore y las reglas SON el control de acceso. Por eso aqui se comprueba
 * sobre todo que las reglas no dejen abierta ninguna de las puertas que
 * provocaron el compromiso anterior.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

/** Igual que `leer`, pero sin comentarios: sirve para buscar CODIGO de verdad. */
const leerCodigo = (rel) => leer(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  .replace(/<!--[\s\S]*?-->/g, '');

function recorrerProyecto(extensiones) {
  const encontrados = [];
  (function recorrer(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      // Las propias pruebas se excluyen: contienen a proposito las cadenas que
      // buscamos, y si no acaban dandose por buenas a si mismas.
      if (['node_modules', '.git', 'test', 'scripts', 'lib'].includes(e.name)) continue;
      const completo = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(completo);
      else if (extensiones.test(e.name)) encontrados.push(completo);
    }
  })(RAIZ);
  return encontrados;
}

const REGLAS = leerCodigo('firestore.rules');

/** Extrae el bloque `match /coleccion/...` completo. */
function bloque(coleccion) {
  const inicio = REGLAS.indexOf(`match /${coleccion}/`);
  assert.ok(inicio !== -1, `no hay reglas para ${coleccion}`);
  const siguiente = REGLAS.indexOf('match /', inicio + 10);
  return REGLAS.slice(inicio, siguiente === -1 ? undefined : siguiente);
}

// --- Lo que provoco el hackeo -------------------------------------------------

test('el rol de admin sale del token firmado, no de un documento', () => {
  assert.match(REGLAS, /request\.auth\.token\.admin == true/);
});

test('el alta de perfil no admite rol ni puntuacion inicial', () => {
  const usuarios = bloque('usuarios');
  assert.ok(!/'esAdmin'|'isAdmin'|'rol'/.test(usuarios), 'la lista de campos permite un campo de rol');
  assert.match(usuarios, /datos\(\)\.biciRating == 0/);
  assert.match(usuarios, /datos\(\)\.viajesVerificados == 0/);
});

test('el usuario no puede tocar su propia puntuacion ni sus insignias', () => {
  const usuarios = bloque('usuarios');
  const propio = usuarios.slice(usuarios.indexOf('allow update: if esYo'));
  const permitidos = propio.match(/hasOnly\(\[([^\]]+)\]\)/)[1];
  for (const prohibido of ['biciRating', 'logros', 'viajesVerificados', 'puntosPorRuta', 'suspendido']) {
    assert.ok(!permitidos.includes(prohibido),
      `el usuario puede escribir ${prohibido} en su propio perfil`);
  }
});

// --- La fuga de correos (#59 y #60) -------------------------------------------
//
// Dos incidentes con la misma raiz: un dato personal guardado dentro de un
// documento de lectura publica. Las reglas eran correctas para el modelo v2 y
// se aplicaban sobre datos v1. Estas pruebas fijan las dos mitades: que el
// correo no vuelva al documento, y que la lectura no vuelva a abrirse antes de
// que la migracion haya corrido.

test('el perfil no puede volver a guardar el correo', () => {
  const usuarios = bloque('usuarios');
  const alta = usuarios.match(/allow create[\s\S]*?hasOnly\(\[([^\]]+)\]\)/)[1];
  assert.ok(!/'email'/.test(alta),
    'la lista de campos del alta vuelve a admitir el correo: vive en Firebase Auth');

  const acciones = leerCodigo('assets/js/acciones.js');
  const perfil = acciones.slice(
    acciones.indexOf('export async function crearPerfil'),
    acciones.indexOf('export async function aceptarLegal')
  );
  assert.ok(!/\bemail\b/.test(perfil), 'crearPerfil vuelve a escribir el correo en Firestore');

  assert.ok(!/^\s*email,?$/m.test(leerCodigo('scripts/migrar-datos.js')),
    'la migracion vuelve a copiar el correo al documento de usuario');
});

test('ni los perfiles ni los viajes se leen sin sesion', () => {
  // Mientras `usuarios` lleve el correo en produccion y `tiempos_viaje` lleve
  // `email_real` y `foto_url`, publico significa publicar datos personales.
  // Lo publico vuelve desde `agregados/` (#35), no desde estas colecciones.
  for (const coleccion of ['usuarios', 'tiempos_viaje']) {
    const lectura = bloque(coleccion).match(/allow read:[^;]*;/)[0];
    assert.ok(!/\bif true\b/.test(lectura), `${coleccion} vuelve a ser legible sin sesion`);
    assert.match(lectura, /esAdmin\(\)/, `${coleccion} deberia dejar leer a la administracion`);
    assert.match(lectura, /esYo\(/, `${coleccion} deberia dejar leer a su dueno`);
  }
});

test('un viaje verificado no vuelve a ser publico por el campo verificado', () => {
  const lectura = bloque('tiempos_viaje').match(/allow read:[^;]*;/)[0];
  assert.ok(!/verificado == true/.test(lectura),
    'la lectura publica de los verificados solo se restaura tras migrar los datos (#54)');
});

test('un viaje solo puede nacer pendiente y sin verificar', () => {
  const viajes = bloque('tiempos_viaje');
  assert.match(viajes, /datos\(\)\.estado == 'pendiente'/);
  assert.match(viajes, /datos\(\)\.verificado == false/);
  assert.match(viajes, /esYo\(datos\(\)\.uid\)/);
});

test('el dueno de un viaje no puede marcarlo como verificado', () => {
  const viajes = bloque('tiempos_viaje');
  // La unica actualizacion que se le permite es impugnar un rechazo automatico.
  const delDueno = viajes.slice(
    viajes.indexOf('allow update: if esYo'),
    viajes.indexOf('allow update: if esAdmin')
  );
  const permitidos = delDueno.match(/hasOnly\(\[([^\]]+)\]\)/)[1];
  assert.ok(!permitidos.includes('verificado'), 'el dueno puede tocar el campo verificado');
  assert.ok(!permitidos.includes('tiempoSegundos'), 'el dueno puede cambiar su tiempo despues');
  assert.match(delDueno, /datos\(\)\.estado == 'revision'/);
});

test('nadie puede borrar un viaje desde el navegador', () => {
  assert.match(bloque('tiempos_viaje'), /allow delete: if false/);
});

test('las capturas no las lee ni su autor', () => {
  const capturas = bloque('capturas');
  assert.match(capturas, /allow read: if esAdmin\(\)/);
  assert.match(capturas, /allow update, delete: if false/);
  // Un documento de Firestore tiene un tope duro de 1 MiB.
  const tope = Number(capturas.match(/datos\(\)\.datos\.size\(\) < (\d+)/)[1]);
  assert.ok(tope < 1048576, `el limite de captura (${tope}) supera el maximo de un documento`);
});

test('el material antifraude y los secretos estan cerrados', () => {
  assert.match(bloque('huellas_captura'), /allow read, write: if false/);
  assert.match(bloque('secrets'), /allow read, write: if false/);
});

test('las reglas cierran por defecto', () => {
  const cierre = REGLAS.slice(REGLAS.lastIndexOf('match /{document=**}'));
  assert.match(cierre, /allow read, write: if false/);
});

test('el rastro de auditoria no se puede reescribir', () => {
  assert.match(bloque('auditoria_admin'), /allow update, delete: if false/);
});

test('la puntuacion de clanes y el mapa solo los escribe el worker', () => {
  assert.match(bloque('estaciones_stats'), /allow write: if false/);
  const clanes = bloque('clanes');
  const permitidos = clanes.match(/allow update[\s\S]*?hasOnly\(\[([^\]]+)\]\)/)[1];
  assert.ok(!permitidos.includes('biciRating'), 'el lider puede inflar la puntuacion del clan');
  assert.ok(!permitidos.includes('logros'), 'el lider puede darse insignias');
});

// --- Cabeceras ----------------------------------------------------------------

test('la CSP no abre la puerta a scripts en linea', () => {
  const csp = JSON.parse(leer('firebase.json')).hosting.headers
    .flatMap((h) => h.headers)
    .find((h) => h.key === 'Content-Security-Policy').value;

  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), "script-src no debe llevar 'unsafe-inline'");
  assert.ok(!/'unsafe-eval'/.test(csp));
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  // Sin backend propio, el cliente habla con Firestore a traves de googleapis.
  assert.match(csp.match(/connect-src([^;]*)/)[1], /googleapis\.com/);
});

// --- Frontend ------------------------------------------------------------------

test('ninguna pagina construye interfaz con innerHTML', () => {
  const paginas = recorrerProyecto(/\.html$/);
  assert.ok(paginas.length >= 15, `esperaba al menos 15 paginas, encontradas ${paginas.length}`);
  for (const pagina of paginas) {
    const rel = path.relative(RAIZ, pagina);
    assert.ok(!/\.innerHTML\s*\+?=/.test(leerCodigo(rel)), `${rel} asigna innerHTML`);
  }
});

test('no queda rastro de PocketBase ni del tunel de ngrok', () => {
  for (const fichero of recorrerProyecto(/\.(html|js)$/)) {
    const rel = path.relative(RAIZ, fichero);
    assert.ok(!/ngrok-free|pocketbase@|new PocketBase/i.test(leerCodigo(rel)),
      `${rel} sigue referenciando PocketBase/ngrok`);
  }
});

test('no hay credenciales incrustadas en el codigo', () => {
  for (const fichero of recorrerProyecto(/\.(html|js|ya?ml)$/)) {
    const rel = path.relative(RAIZ, fichero);
    const contenido = leer(rel);
    assert.ok(!/rnvc jdpe mrsw vzjy/.test(contenido), `${rel} contiene la contrasena de Gmail`);
    assert.ok(!/['"]\d{8,10}:AA[\w-]{30,}['"]/.test(contenido), `${rel} contiene un token de Telegram`);
    assert.ok(!/"private_key"\s*:/.test(contenido), `${rel} contiene una clave de servicio`);
  }
});

// --- Worker ---------------------------------------------------------------------

test('el worker es quien decide, y no se cuelga si algo falla', () => {
  const worker = leerCodigo('backend/worker.js');
  // Un fallo no puede dejar el viaje atascado en la cola para siempre.
  assert.match(worker, /estado: 'revision'/);
  assert.match(worker, /catch \(error\)/);
  // La huella se crea, no se sobrescribe: si no, el rechazo por duplicado
  // borraria el rastro que apunta al viaje original.
  assert.match(worker, /huellas_captura'\)\.doc\(hashSha\)\.create\(/);
  // El cupo diario se cuenta aqui: en el navegador se salta desde la consola.
  assert.match(worker, /VIAJES_POR_DIA/);
});

test('el workflow del worker no puede solaparse consigo mismo', () => {
  const flujo = leer('.github/workflows/verificar-viajes.yml');
  assert.match(flujo, /concurrency:/, 'dos workers a la vez procesarian los mismos viajes');
  assert.match(flujo, /FIREBASE_SERVICE_ACCOUNT: \$\{\{ secrets\./);
  assert.match(flujo, /GEMINI_API_KEY: \$\{\{ secrets\./);
});

// --- Legal ----------------------------------------------------------------------

test('las cuatro paginas legales existen y marcan lo que falta rellenar', () => {
  for (const doc of ['aviso-legal', 'privacidad', 'terminos', 'cookies']) {
    const html = leer(`legal/${doc}/index.html`);
    assert.ok(html.length > 1500, `legal/${doc} parece incompleto`);
    assert.match(html, /pie-legal/, `legal/${doc} no monta el pie legal`);
  }
  for (const doc of ['aviso-legal', 'privacidad', 'terminos']) {
    assert.match(leer(`legal/${doc}/index.html`), /class="pendiente"/,
      `legal/${doc} deberia marcar los datos pendientes del responsable`);
  }
});

test('la version legal del cliente y la del servidor no se separan', () => {
  const servidor = leer('backend/src/config.js').match(/VERSION_TERMINOS: '([^']+)'/)[1];
  const cliente = leer('assets/js/ui.js').match(/VERSION_LEGAL = '([^']+)'/)[1];
  assert.strictEqual(cliente, servidor, `ui.js dice ${cliente} y config.js dice ${servidor}`);
});

test('el registro exige aceptacion expresa y sin casillas premarcadas', () => {
  const casillas = leer('register/index.html').match(/<input type="checkbox"[^>]*>/g) || [];
  assert.ok(casillas.length >= 3, 'faltan las casillas de terminos, privacidad y edad');
  for (const casilla of casillas) {
    assert.ok(!/checked/.test(casilla), 'el consentimiento no puede venir premarcado (RGPD art. 7)');
  }
});

test('se puede impugnar un rechazo automatico (RGPD art. 22.3)', () => {
  assert.match(leerCodigo('assets/js/acciones.js'), /export async function impugnarViaje/);
  assert.match(leerCodigo('profile/index.html'), /impugnarViaje\(/);
  assert.match(bloque('tiempos_viaje'), /previo\(\)\.revisadoPor == 'automatico'/);
});

test('el borrado de cuenta deja constancia para el worker', () => {
  assert.match(bloque('solicitudes_borrado'), /allow create: if esYo\(uid\)/);
  assert.match(leerCodigo('assets/js/acciones.js'), /export async function solicitarBorradoCuenta/);
});

// --- Navegacion movil -----------------------------------------------------------

test('la barra inferior no mete mas de cinco destinos', () => {
  const enMovil = (leerCodigo('assets/js/ui.js').match(/movil: true/g) || []).length;
  assert.ok(enMovil <= 5, `${enMovil} destinos en la barra inferior: con mas de 5 no caben`);
  assert.ok(enMovil >= 4, 'la barra inferior se ha quedado sin destinos');
});

test('el CSS es mobile-first', () => {
  const css = leer('assets/css/app.css');
  const minWidth = (css.match(/@media \(min-width/g) || []).length;
  const maxWidth = (css.match(/@media \(max-width/g) || []).length;
  assert.ok(minWidth > maxWidth,
    `mobile-first es ampliar con min-width (${minWidth}), no recortar con max-width (${maxWidth})`);
});

test('los objetivos tactiles llegan al minimo accesible', () => {
  const css = leer('assets/css/app.css');
  assert.match(css, /min-height: (4[4-9]|5\d)px/);
  // Menos de 16px en un input hace que Safari en iOS haga zoom al enfocarlo.
  assert.match(css, /font-size: 16px/);
});

// --- Modo mantenimiento -----------------------------------------------------

test('el modo mantenimiento no publica ninguna pagina de la app', () => {
  const conf = JSON.parse(leer('firebase.mantenimiento.json'));
  const ignorados = conf.hosting.ignore;

  // Firebase sirve primero el fichero estatico que exista: si una pagina se
  // publica, sigue accesible escribiendo su URL por mucho rewrite que haya.
  const secciones = ['home', 'ranking', 'bicirating', 'mapa', 'clanes',
    'subir', 'profile', 'info', 'admin', 'statssss', 'register', 'entrar'];
  for (const seccion of secciones) {
    assert.ok(ignorados.includes(`${seccion}/**`), `/${seccion}/ seguiria publicada`);
  }
  assert.ok(ignorados.includes('index.html'), 'la landing seguiria publicada en /');

  // Y todo lo demas cae en la pagina de obras.
  assert.deepStrictEqual(conf.hosting.rewrites, [
    { source: '**', destination: '/mantenimiento/index.html' },
  ]);
});

test('la pagina de obras no depende de nada del sitio', () => {
  const html = leerCodigo('mantenimiento/index.html');
  // Si algo del sitio se rompe, esta tiene que seguir en pie.
  assert.ok(!/<script/.test(html), 'la pagina de obras no debe llevar scripts');
  assert.ok(!/href="\/assets\//.test(html), 'no debe depender de los assets del sitio');
  assert.match(html, /name="robots" content="noindex"/,
    'no debe indexarse en lugar del sitio real');
});

test('el interruptor de mantenimiento esta cableado en el CI', () => {
  const flujo = leer('.github/workflows/ci.yml');
  assert.match(flujo, /MANTENIMIENTO: \$\{\{ vars\.MANTENIMIENTO \}\}/);
  assert.match(flujo, /--config firebase\.mantenimiento\.json/);
});

test('la landing no es el formulario de acceso', () => {
  const landing = leer('index.html');
  assert.ok(!/type="password"/.test(landing), 'la raiz no debe ser el login');
  assert.match(landing, /href="\/register\/"/, 'falta la llamada a registrarse');
  assert.match(landing, /href="\/entrar\/"/, 'falta el acceso para quien ya tiene cuenta');
  // El login vive ahora en su propia ruta.
  assert.match(leer('entrar/index.html'), /type="password"/);
});

test('el modo mantenimiento de Vercel tapa tambien las paginas existentes', () => {
  const conf = JSON.parse(leer('vercel.json'));
  const redir = (conf.redirects || [])[0];

  assert.ok(redir, 'sin redirect no hay modo mantenimiento');
  assert.strictEqual(redir.destination, '/mantenimiento/');
  // En Vercel los redirects se evaluan antes del sistema de ficheros: por eso
  // tapan /admin/ y /home/, que existen como fichero.
  assert.match(redir.source, /\(\?!/, 'el patron debe excluir la propia pagina de obras');
  assert.match(redir.source, /mantenimiento/);
  assert.strictEqual(redir.permanent, false, 'un 308 se cachearia en el navegador');
});

test('el despliegue no publica el backend ni los scripts', () => {
  const ignorados = leer('.vercelignore').split('\n').map((l) => l.trim());
  for (const carpeta of ['backend/', 'scripts/', '.github/']) {
    assert.ok(ignorados.includes(carpeta), `${carpeta} acabaria publicado en la web`);
  }
  assert.ok(ignorados.includes('firestore.rules'));
  // El mapa lee /data/emt.geojson: eso SI tiene que publicarse.
  assert.ok(!ignorados.includes('data/'), 'el mapa se quedaria sin estaciones');
});
