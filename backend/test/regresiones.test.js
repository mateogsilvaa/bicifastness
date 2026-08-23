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
// Las exclusiones de `:` y `/` antes del comentario no son cosmeticas: sin
// ellas, una URL se traga el resto del fichero. `https://*.basemaps.cartocdn.com`
// (que sale en la CSP de todas las paginas) abre un `/*` que no cierra hasta el
// siguiente `*/` real, y con el se van cientos de lineas. Eso daba por buenas
// paginas que no lo eran, incluida la comprobacion de innerHTML de mas abajo.
const leerCodigo = (rel) => leer(rel)
  .replace(/(^|[^:/])\/\*[\s\S]*?\*\//g, '$1')
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

/** Rutas relativas de todas las paginas del sitio. */
const paginasHtml = () => recorrerProyecto(/\.html$/).map((p) => path.relative(RAIZ, p));

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
  const { csp } = JSON.parse(leer('shared/cabeceras.json'));
  const directiva = (nombre) => (csp[nombre] || []).join(' ');

  assert.ok(!directiva('script-src').includes("'unsafe-inline'"),
    "script-src no debe llevar 'unsafe-inline'");
  assert.ok(!JSON.stringify(csp).includes("'unsafe-eval'"));
  assert.deepStrictEqual(csp['object-src'], ["'none'"]);
  // Sin backend propio, el cliente habla con Firestore a traves de googleapis.
  assert.match(directiva('connect-src'), /googleapis\.com/);
});

test('las cabeceras que solo existen por HTTP estan puestas', () => {
  // Es la razon de servir desde Vercel y no desde GitHub Pages: Pages no
  // permite cabeceras, y estas seis no tienen equivalente en <meta>.
  const cabeceras = JSON.parse(leer('vercel.json')).headers
    .flatMap((bloque) => bloque.headers);
  const valor = (clave) => (cabeceras.find((h) => h.key === clave) || {}).value;

  for (const clave of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy',
    'Permissions-Policy', 'Strict-Transport-Security', 'Cross-Origin-Opener-Policy']) {
    assert.ok(valor(clave), `falta la cabecera ${clave}`);
  }

  // `frame-ancestors` es la directiva que el navegador ignora cuando la CSP
  // llega por <meta>: solo cuenta si viaja en la cabecera.
  assert.match(valor('Content-Security-Policy'), /frame-ancestors 'none'/);
});

test('la CSP de la cabecera y la del <meta> no divergen', () => {
  // Las dos se generan de shared/cabeceras.json. Si alguien edita una a mano,
  // el navegador aplicaria la interseccion y algo dejaria de cargar sin que
  // nadie sepa por que.
  const { csp } = JSON.parse(leer('shared/cabeceras.json'));
  const esperada = Object.entries(csp)
    .map(([d, origenes]) => [d, ...origenes].join(' ').trim())
    .join('; ');

  const enPagina = leer('clasificacion/index.html')
    .match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.strictEqual(enPagina, esperada);

  const enCabecera = JSON.parse(leer('vercel.json')).headers
    .flatMap((b) => b.headers)
    .find((h) => h.key === 'Content-Security-Policy').value;
  // La cabecera lleva ademas frame-ancestors, pero todo lo demas es identico.
  assert.ok(enCabecera.startsWith(esperada), 'la cabecera no contiene la politica base');
});

test('todas las paginas llevan la CSP escrita', () => {
  // Sin cabeceras, una pagina sin su <meta> se queda sin ninguna proteccion y
  // nada mas lo delata: el HTML sigue siendo valido.
  for (const rel of paginasHtml()) {
    assert.match(leer(rel), /<meta http-equiv="Content-Security-Policy"/,
      `${rel} no lleva la CSP`);
    assert.match(leer(rel), /<meta name="referrer"/, `${rel} no lleva referrer-policy`);
  }
});

test('hay antiframing, que la CSP por meta no puede dar', () => {
  // `frame-ancestors` es una de las directivas que el navegador IGNORA cuando
  // la CSP llega por <meta>, y `X-Frame-Options` era una cabecera. Sin esto no
  // quedaria nada contra el clickjacking.
  const ui = leerCodigo('assets/js/ui.js');
  assert.match(ui, /window\.top !== window\.self/);
});

test('el JavaScript de las paginas no va incrustado en el HTML', () => {
  // Con `script-src 'self'` y sin hashes, un <script> en linea queda bloqueado:
  // la pagina se veria bien y no haria absolutamente nada.
  for (const rel of paginasHtml()) {
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(leer(rel)),
      `${rel} lleva JavaScript incrustado, que la CSP bloquea`);
  }
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

/**
 * La contrasena de aplicacion de Gmail de la v1, que es lo que este test busca.
 *
 * Va codificada por un motivo tonto pero real: el test que impide publicar la
 * contrasena la llevaba dentro EN CLARO, y este repositorio es publico. O sea
 * que el guardian era el unico sitio del arbol donde seguia estando, y ahi la
 * encuentra igual cualquier rastreador automatico de credenciales.
 *
 * Esto no la protege — quien lea este comentario la decodifica en un segundo —
 * y no sustituye a lo unico que sirve, que es ROTARLA (issue #1). Lo unico que
 * hace es que deje de estar en texto plano en un repositorio publico.
 */
const CONTRASENA_V1 = Buffer.from('cm52YyBqZHBlIG1yc3cgdnpqeQ==', 'base64').toString('utf8');

test('no hay credenciales incrustadas en el codigo', () => {
  for (const fichero of recorrerProyecto(/\.(html|js|ya?ml)$/)) {
    const rel = path.relative(RAIZ, fichero);
    const contenido = leer(rel);
    assert.ok(!contenido.includes(CONTRASENA_V1), `${rel} contiene la contrasena de Gmail`);
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
  // Ya no hay claves de IA: la captura se lee con OCR local. El unico secreto
  // del worker es la cuenta de servicio.
  assert.ok(!/GEMINI|OPENAI|ANTHROPIC/i.test(flujo), 'el worker no debe depender de ninguna IA');
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
  assert.match(leerCodigo('assets/js/paginas/yo.js'), /impugnarViaje\(/);
  assert.match(bloque('tiempos_viaje'), /previo\(\)\.revisadoPor == 'automatico'/);
});

test('el borrado de cuenta deja constancia para el worker', () => {
  assert.match(bloque('solicitudes_borrado'), /allow create: if esYo\(uid\)/);
  assert.match(leerCodigo('assets/js/acciones.js'), /export async function solicitarBorradoCuenta/);
});

// --- Navegacion movil -----------------------------------------------------------

test('la navegacion tiene cuatro destinos mas la accion', () => {
  const ui = leerCodigo('assets/js/ui.js');
  const destinos = (ui.match(/slug: '/g) || []).length;

  // Cuatro destinos + `subir`. Con siete, cada uno se quedaba en el 14% del
  // ancho de pantalla: iconos diminutos y objetivos tactiles por debajo del
  // minimo accesible.
  assert.strictEqual(destinos, 5, 'la barra deberia llevar 4 destinos y la accion de subir');

  // `/subir/` no es un destino mas: es la accion, y va aparte.
  assert.match(ui, /const SUBIR = /);
});

test('el destino activo se marca para lectores de pantalla', () => {
  // El color de la regla azul no puede ser el unico portador de "estas aqui".
  assert.match(leerCodigo('assets/js/ui.js'), /'aria-current': esActivo\(/);
});

test('el sistema de diseno no admite sombras', () => {
  // Regla del redisenio: el UNICO box-shadow/outline permitido es el de
  // :focus-visible. Todo lo demas era "ambiente".
  const css = leer('assets/css/app.css');
  const sombras = [...css.matchAll(/box-shadow:[^;]+;/g)].map((m) => m[0]);

  // `inset` en la fila propia es un borde de 3 px, no una sombra: es la unica
  // forma de pintar un borde dentro de una celda de tabla sin descuadrar la
  // rejilla de columnas.
  const decorativas = sombras.filter((s) => !s.includes('inset') && !s.includes('none'));
  assert.deepStrictEqual(decorativas, [], `sombras decorativas: ${decorativas.join(' ')}`);
});

/**
 * Paginas que todavia arrastran su propio <style>, del redisenio a medias.
 *
 * Esta lista SOLO puede encoger. El test falla en los dos sentidos:
 *   - si una pagina que no esta aqui define estilos, es una regresion
 *   - si una de aqui ya no los define, hay que quitarla de la lista
 *
 * Lo segundo importa tanto como lo primero: una lista de excepciones que nadie
 * poda deja de significar nada y acaba tapando el problema que vigila.
 */
const PENDIENTES_DE_REDISENIO = [
  'admin/index.html',
  'statssss/index.html',
];

test('ninguna pagina nueva define estilos propios', () => {
  // "Un componente = una clase en app.css". Un <style> suelto es como el
  // sistema se desmonta: el siguiente color ya no sale de los tokens.
  const rel = (p) => p.split(path.sep).join('/');

  // La pagina de obras es autocontenida a proposito: si el sitio se rompe,
  // tiene que seguir en pie sin depender de app.css.
  const conEstilos = paginasHtml()
    .map(rel)
    .filter((p) => p !== 'mantenimiento/index.html')
    .filter((p) => /<style[^>]*>/.test(leer(p)));

  const nuevas = conEstilos.filter((p) => !PENDIENTES_DE_REDISENIO.includes(p));
  assert.deepStrictEqual(nuevas, [], `paginas con <style> propio: ${nuevas.join(', ')}`);

  const yaLimpias = PENDIENTES_DE_REDISENIO.filter((p) => !conEstilos.includes(p));
  assert.deepStrictEqual(yaLimpias, [],
    `ya no tienen estilos propios, quitalas de PENDIENTES_DE_REDISENIO: ${yaLimpias.join(', ')}`);
});

test('los avisos fijos no tapan la barra inferior', () => {
  // El aviso de cookies iba a `bottom: 0` y se comia las cuatro pestañas y el
  // boton de subir justo mientras se lee.
  const css = leer('assets/css/app.css');
  // Y solo cuando la barra existe: subirlo siempre deja un hueco de 64 px en
  // entrar, registro, legales y la baja de correo, que no la llevan.
  assert.match(css, /body:has\(\.nav-inf\) \.cookies \{\s*bottom: calc\(var\(--alto-barra\)/);
});

test('las rutas viejas siguen llegando a algun sitio', () => {
  // Los directorios se han borrado, pero las URLs estan enlazadas desde fuera.
  // Sin redireccion, cada una es un 404 y se pierde lo que hubiera indexado.
  const redirecciones = JSON.parse(leer('vercel.json')).redirects || [];
  const destino = (origen) => (redirecciones.find((r) => r.source === origen) || {}).destination;

  const esperadas = {
    '/home': '/',
    '/ranking': '/clasificacion/',
    '/mapa': '/territorio/',
    '/profile': '/yo/',
  };

  for (const [vieja, nueva] of Object.entries(esperadas)) {
    assert.strictEqual(destino(vieja), nueva, `${vieja} no redirige a ${nueva}`);
    const regla = redirecciones.find((r) => r.source === vieja);
    assert.strictEqual(regla.permanent, true, `${vieja} deberia ser un 301`);
  }

  // Y los directorios ya no existen: si existieran, Vercel serviria el fichero
  // en vez de redirigir.
  for (const viejo of ['home', 'ranking', 'bicirating', 'mapa', 'clanes', 'profile']) {
    assert.ok(!fs.existsSync(path.join(RAIZ, viejo)), `el directorio ${viejo}/ sigue ahi`);
  }
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

test('el modo mantenimiento tapa tambien las paginas que existen', () => {
  const conf = JSON.parse(leer('vercel.json'));
  const redir = (conf.redirects || [])[0];

  assert.ok(redir, 'sin redirect no hay modo mantenimiento');
  assert.strictEqual(redir.destination, '/mantenimiento/');
  // En Vercel los redirects se evaluan ANTES del sistema de ficheros: por eso
  // tapan /admin/ y /home/, que existen como fichero. Un rewrite no bastaria.
  assert.match(redir.source, /\(\?!/, 'el patron debe excluir la propia pagina de obras');
  assert.match(redir.source, /mantenimiento/);
  assert.strictEqual(redir.permanent, false, 'un 308 se cachearia en el navegador');
});

test('la pagina de obras no depende de nada del sitio', () => {
  const html = leerCodigo('mantenimiento/index.html');
  // Si algo del sitio se rompe, esta tiene que seguir en pie.
  assert.ok(!/<script/.test(html), 'la pagina de obras no debe llevar scripts');
  assert.ok(!/href="\/assets\//.test(html), 'no debe depender de los assets del sitio');
  assert.match(html, /name="robots" content="noindex"/,
    'no debe indexarse en lugar del sitio real');
});

test('solo hay un sitio publicado', () => {
  // Dos destinos de despliegue es como la gente acaba viendo una version vieja,
  // y como el modo mantenimiento protege un sitio pero no el otro.
  const ci = leer('.github/workflows/ci.yml');
  assert.ok(!/--only hosting|only hosting,/.test(ci),
    'el CI no debe desplegar hosting: el sitio vive en Vercel');

  // Pero las reglas de Firestore SI tienen que seguir desplegandose: son el
  // control de acceso y Vercel no las toca.
  assert.match(ci, /firestore:rules/);

  assert.ok(!fs.existsSync(path.join(RAIZ, '.github/workflows/paginas.yml')),
    'queda el workflow de GitHub Pages');
});

test('el despliegue no publica el backend ni los scripts', () => {
  const ignorados = leer('.vercelignore').split('\n').map((l) => l.trim());

  // Todo esto acabaria servido por URL, y `firestore.rules` ademas cuenta a
  // quien deja entrar donde.
  //
  // `scripts` se admite de las dos formas: `scripts/` excluye la carpeta y
  // `scripts/*` su contenido. La segunda es la que hay, porque es la unica que
  // permite la excepcion de `build-version.js`, que el `buildCommand` necesita
  // tener subido para poder ejecutarlo.
  for (const carpeta of ['backend/', 'shared/', '.github/', 'node_modules/']) {
    assert.ok(ignorados.includes(carpeta), `${carpeta} acabaria publicado en la web`);
  }
  assert.ok(ignorados.includes('scripts/') || ignorados.includes('scripts/*'),
    'los scripts de administracion acabarian publicados en la web');
  assert.ok(ignorados.includes('firestore.rules'));

  // Y de las excepciones, solo la del generador de la version: cualquier otra
  // estaria publicando una herramienta de administracion.
  const excepciones = ignorados.filter((l) => l.startsWith('!'));
  assert.deepStrictEqual(excepciones, ['!scripts/build-version.js'],
    `hay excepciones nuevas en .vercelignore: ${excepciones.join(', ')}`);

  // El mapa hace fetch('/data/emt.geojson'): eso SI tiene que publicarse.
  assert.ok(!ignorados.includes('data/'), 'el mapa se quedaria sin estaciones');
  assert.match(leerCodigo('assets/js/paginas/territorio.js'), /\/data\/emt\.geojson/);
});

test('el service worker no se queda cacheado', () => {
  // /sw.js encaja tambien en la regla de `.js`, y cuando dos reglas definen la
  // misma cabecera gana la ULTIMA. Si alguien reordena el bloque, el navegador
  // se queda sirviendo la app vieja para siempre.
  const bloques = JSON.parse(leer('vercel.json')).headers;
  const indiceSw = bloques.findIndex((b) => b.source === '/sw.js');
  const indiceJs = bloques.findIndex((b) => /js\|css\|html/.test(b.source));

  assert.ok(indiceSw > indiceJs, '/sw.js tiene que ir despues de la regla de .js');
  assert.match(bloques[indiceSw].headers[0].value, /no-store/);
});

test('un viaje aprobado guarda distancia, velocidad y puntos', () => {
  const worker = leerCodigo('backend/worker.js');

  // Sin esto, todo el motor de juego (distancias, puntuacion, rachas) seria
  // codigo muerto: se calcularia y no llegaria a ningun documento.
  for (const campo of ['distanciaMetros', 'velocidadKmh', 'puntos', 'puntosDesglose']) {
    assert.match(worker, new RegExp(`${campo}:`), `el viaje no guarda ${campo}`);
  }

  // La racha es lectura-modificacion-escritura y el worker aprueba varios
  // viajes por tanda: sin transaccion, el segundo del mismo piloto pisa al
  // primero.
  assert.match(worker, /runTransaction/, 'la racha se actualiza sin transaccion');

  // Y los acumulados tienen que ir con increment por el mismo motivo.
  assert.match(worker, /metrosTotales: admin\.firestore\.FieldValue\.increment/);
  assert.match(worker, /segundosTotales: admin\.firestore\.FieldValue\.increment/);
});

test('la distancia no la declara el usuario', () => {
  // Es lo que permite que anadir distancia y velocidad al juego no abra
  // superficie nueva de fraude: salen del par de estaciones y del tiempo, que
  // el pipeline ya contrasta contra la captura.
  const viajes = bloque('tiempos_viaje');
  const alta = viajes.slice(viajes.indexOf('allow create'), viajes.indexOf('allow update'));
  const permitidos = (alta.match(/hasOnly\(\[([^\]]+)\]\)/) || [, ''])[1];

  for (const prohibido of ['distanciaMetros', 'velocidadKmh', 'puntos']) {
    assert.ok(!permitidos.includes(prohibido),
      `el cliente puede declarar ${prohibido} al crear el viaje`);
  }
});

test('el usuario puede darse de baja de los correos por si mismo', () => {
  // El RGPD exige baja facil. Si la preferencia solo la pudiera tocar un
  // administrador, no seria baja facil.
  const usuarios = bloque('usuarios');
  const propio = usuarios.slice(usuarios.indexOf('allow update: if esYo'));
  const permitidos = propio.match(/hasOnly\(\[([^\]]+)\]\)/)[1];

  assert.ok(permitidos.includes('avisosCorreo'), 'el usuario no puede cambiar su preferencia de correo');

  // Pero sigue sin poder tocar nada de puntuacion.
  for (const prohibido of ['biciRating', 'puntosTemporada', 'racha', 'escudos']) {
    assert.ok(!permitidos.includes(prohibido), `el usuario puede escribir ${prohibido}`);
  }
});

test('el worker respeta la preferencia de correo antes de enviar', () => {
  const worker = leerCodigo('backend/worker.js');
  assert.match(worker, /avisosCorreo === false/, 'se envia sin mirar la preferencia');

  // Y nunca envia en simulacion: el worker corre con --simular a menudo.
  assert.match(worker, /simular: SIMULAR/);
});

test('la baja de correo se puede pedir sin sesion, pero nada mas', () => {
  // Es la UNICA coleccion que escribe gente sin autenticar. Sin acotarla es una
  // via de llenar la base de datos gratis, y si se pudiera leer se podrian
  // raspar tokens ajenos para dar de baja a otros.
  const bajas = bloque('solicitudes_baja');

  assert.match(bajas, /allow read, update, delete: if false/,
    'no debe poder leerse, actualizarse ni borrarse desde el cliente');
  assert.match(bajas, /hasOnly\(\['creado'\]\)/, 'admite campos de mas');
  assert.match(bajas, /token\.size\(\) >= 32/, 'un token corto se puede adivinar a intentos');
  assert.match(bajas, /token\.matches/, 'el id del documento no esta acotado');
});

test('la migracion borra los datos personales del viaje, no los conserva', () => {
  // Es lo que cierra el #59. `set` sin merge REEMPLAZA el documento: con merge,
  // `email_real` y `foto_url` seguirian ahi y la fuga con ellos.
  const migracion = leerCodigo('scripts/migrar-datos.js');

  assert.match(migracion, /doc\.ref\.set\(nuevo\)/, 'debe reemplazar el documento, no fusionarlo');
  assert.ok(!/doc\.ref\.set\(nuevo, \{ merge/.test(migracion), 'con merge los campos viejos sobreviven');

  // Los viajes sin cuenta de Auth tambien se limpian: si se dejaran como estan,
  // seguirian publicando un correo y una captura.
  assert.match(migracion, /anonimizados/);

  // Y tiene que existir la comprobacion que dice cuando es seguro reabrir.
  assert.match(migracion, /--comprobar|SOLO_COMPROBAR/);
});

test('la migracion no depende de Cloud Storage', () => {
  // Storage exige el plan Blaze (tarjeta). Las capturas van a la coleccion
  // `capturas`, que es como funciona la v2 entera.
  const migracion = leerCodigo('scripts/migrar-datos.js');
  assert.ok(!/admin\.storage\(\)/.test(migracion), 'usa Cloud Storage, que no esta disponible');
  assert.match(migracion, /capturas\/\$\{doc\.id\}/);
});

test('la lectura publica de viajes esta cerrada hasta migrar', () => {
  // Guarda contra reabrirla por descuido: mientras los documentos de produccion
  // lleven `email_real` y `foto_url`, "verificado es publico" los publica.
  const viajes = bloque('tiempos_viaje');
  const lineaActiva = viajes.split('\n').find((l) => l.trim().startsWith('allow read:'));

  assert.ok(!/verificado == true/.test(lineaActiva),
    'la lectura publica esta abierta: revisa el issue #59 antes de reabrirla');
});

test('el correo no vive en una coleccion de lectura publica', () => {
  // `usuarios` alimenta los rankings, asi que estaba abierta a cualquiera. El
  // mismo documento llevaba el correo: "publico para el ranking" significaba
  // publicar la direccion de todo el mundo. Y no era solo dato viejo, la regla
  // de alta lo admitia, asi que habria seguido pasando despues de migrar.
  const usuarios = bloque('usuarios');
  const permitidos = usuarios.match(/allow create[\s\S]*?hasOnly\(\[([^\]]+)\]\)/)[1];

  assert.ok(!permitidos.includes("'email'"),
    'el alta admite un campo email: el correo vive en Firebase Auth, no aqui');

  // Y el alta desde el navegador tampoco lo manda.
  assert.ok(!/email: String\(email/.test(leerCodigo('assets/js/acciones.js')),
    'crearPerfil sigue guardando el correo');
});

test('el worker saca el correo de Auth, no del documento', () => {
  // Ademas de no filtrarlo, asi nunca esta obsoleto: si alguien cambia su
  // direccion, una copia en Firestore apuntaria a la vieja.
  const worker = leerCodigo('backend/worker.js');
  assert.match(worker, /admin\.auth\(\)\.getUser\(/);
  assert.ok(!/para: datos\.email/.test(worker), 'sigue leyendo el correo del documento');
});

test('los agregados son publicos y solo los escribe el worker', () => {
  const ag = bloque('agregados');
  assert.match(ag, /allow read: if true/);
  assert.match(ag, /allow write: if false/);
});

test('el navegador no recorre colecciones para pintar clasificaciones', () => {
  // Recorrer `usuarios` costaba 175 lecturas por visita, y esa coleccion esta
  // ademas cerrada (#60). Si alguien vuelve a poner un getDocs aqui, la pantalla
  // deja de funcionar Y se come la cuota.
  const pagina = leerCodigo('assets/js/paginas/clasificacion.js');

  assert.ok(!/getDocs\(collection\(/.test(pagina),
    'la clasificacion vuelve a recorrer colecciones');
  assert.match(pagina, /doc\(db, 'agregados'/);
});

test('los agregados se reconstruyen una vez por tanda, no por viaje', () => {
  // Leer todos los viajes y todos los usuarios es la operacion mas cara del
  // worker. Hacerla por cada viaje aprobado es como se agota la cuota (#36).
  const worker = leerCodigo('backend/worker.js');
  // Con argumento o sin el: desde #34 se le pasa la carga ya hecha para no leer
  // usuarios y viajes dos veces en la misma pasada. Lo que importa sigue siendo
  // cuantas veces se llama y desde donde.
  const llamadas = (worker.match(/reconstruirAgregados\(/g) || []).length;

  assert.strictEqual(llamadas, 1, 'reconstruirAgregados se llama mas de una vez');
  // Y fuera del bucle que procesa la cola.
  assert.ok(worker.indexOf('reconstruirAgregados(') > worker.indexOf('for (const doc of cola.docs)'),
    'se reconstruye dentro del bucle de la cola');
});

/**
 * Consultas compuestas que hace el codigo y el indice que cada una necesita.
 *
 * Firestore no avisa de esto al escribir el codigo: falla EN EJECUCION, y el
 * mensaje solo aparece cuando la consulta llega a correr con datos de verdad.
 * Asi es como el worker estuvo fallando cada pocos minutos: el indice declarado
 * era `estado ASC, creado DESCENDING` y la cola pide `creado ASC`, porque es
 * FIFO y procesa el mas viejo primero. La direccion forma parte del indice.
 *
 * Si anades una consulta con dos filtros, o con filtro y orden, apuntala aqui.
 */
const CONSULTAS_COMPUESTAS = [
  {
    donde: "worker.main(): la cola de pendientes, mas viejo primero",
    coleccion: 'tiempos_viaje',
    campos: [['estado', 'ASCENDING'], ['creado', 'ASCENDING']],
  },
  {
    donde: 'worker.validarBasico(): cupo diario',
    // Sin orderBy explicito, Firestore ordena por el campo de la desigualdad.
    coleccion: 'tiempos_viaje',
    campos: [['uid', 'ASCENDING'], ['creado', 'ASCENDING']],
  },
  {
    donde: 'worker.reunirContexto(): ultimos viajes del piloto',
    coleccion: 'tiempos_viaje',
    campos: [['uid', 'ASCENDING'], ['verificado', 'ASCENDING'], ['creado', 'DESCENDING']],
  },
  {
    donde: 'worker.reunirContexto(): mejores tiempos de la ruta',
    coleccion: 'tiempos_viaje',
    campos: [['ruta', 'ASCENDING'], ['verificado', 'ASCENDING'], ['tiempoSegundos', 'ASCENDING']],
  },
  {
    donde: 'portada.pintarUltimaMarca(): el ultimo trayecto por fecha de viaje',
    coleccion: 'tiempos_viaje',
    campos: [['uid', 'ASCENDING'], ['verificado', 'ASCENDING'], ['fechaViaje', 'DESCENDING']],
  },
  {
    donde: 'yo.cargarHistorial(): historial paginado, mas reciente primero',
    coleccion: 'tiempos_viaje',
    campos: [['uid', 'ASCENDING'], ['creado', 'DESCENDING']],
  },
  {
    donde: 'puntuacion.recalcularClan(): miembros ordenados',
    coleccion: 'usuarios',
    campos: [['clanId', 'ASCENDING'], ['biciRating', 'DESCENDING']],
  },
];

test('cada consulta compuesta tiene su indice declarado', () => {
  const declarados = JSON.parse(leer('firestore.indexes.json')).indexes;

  const existe = (coleccion, campos) => declarados.some((i) =>
    i.collectionGroup === coleccion
    && i.fields.length === campos.length
    && i.fields.every((f, n) => f.fieldPath === campos[n][0] && f.order === campos[n][1]));

  const sinIndice = CONSULTAS_COMPUESTAS
    .filter((c) => !existe(c.coleccion, c.campos))
    .map((c) => `${c.donde} -> ${c.coleccion}: ${c.campos.map((f) => f.join(' ')).join(', ')}`);

  assert.deepStrictEqual(sinIndice, [],
    `consultas que fallarian en ejecucion:\n  ${sinIndice.join('\n  ')}`);
});

test('la cola se procesa por orden de llegada', () => {
  // Si alguien la cambia a `desc`, los viajes viejos se quedan al final para
  // siempre cuando haya mas de MAX_POR_TANDA en cola. Y ademas invalida el
  // indice de arriba.
  const worker = leerCodigo('backend/worker.js');
  const cola = worker.slice(worker.indexOf("where('estado', '==', 'pendiente')"));

  assert.match(cola.slice(0, 200), /orderBy\('creado', 'asc'\)/,
    'la cola dejaria de ser FIFO');
});

test('el cierre de temporada es idempotente', () => {
  // Es la operacion mas destructiva del proyecto: toca a todos los usuarios y
  // pone contadores a cero. Ejecutarla dos veces archivaria ceros encima de lo
  // ya archivado y borraria la temporada entera de todo el mundo.
  const codigo = leerCodigo('backend/src/temporadas.js');

  // Se comprueba la marca ANTES de tocar nada.
  assert.match(codigo, /if \(marca\.exists\) \{\s*return \{ yaCerrada: true/);

  // Y se ESCRIBE la marca antes de archivar. Al reves, un corte a mitad dejaria
  // la puerta abierta a repetirlo todo.
  const posMarca = codigo.indexOf('refConfig.set(');
  const posArchivo = codigo.indexOf('temporadas/${temporada}`)');
  assert.ok(posMarca > 0 && posMarca < posArchivo,
    'la marca de cerrada se escribe despues de archivar');
});

test('las operaciones periodicas simulan por defecto', () => {
  // Con la version que escribe por defecto, un error de tecleo cierra la
  // temporada de todo el mundo.
  const runner = leerCodigo('backend/periodicas.js');
  assert.match(runner, /const APLICAR = process\.argv\.includes\('--aplicar'\)/);
  assert.ok(!/const SIMULAR = .*includes\('--simular'\)/.test(runner),
    'simular deberia ser el defecto, no una bandera');
});

test('el cierre de temporada no borra lo conseguido', () => {
  // Se resetean los puntos de la temporada. Los records, los kilometros y las
  // insignias se quedan: lo logrado no se borra, solo el marcador.
  const codigo = leerCodigo('backend/src/temporadas.js');
  const actualizacion = codigo.slice(codigo.indexOf('lote.update(db().doc(`usuarios/'), codigo.indexOf('archivados++'));

  assert.match(actualizacion, /puntosTemporada: 0/);
  assert.match(actualizacion, /arrayUnion/, 'las insignias deberian sumarse, no reemplazarse');
  assert.ok(!/metrosTotales: 0|viajesVerificados: 0|mejorRacha: 0/.test(actualizacion),
    'se estan borrando totales historicos');
});

test('el historial de temporadas lo lee su dueño', () => {
  // Las subcolecciones NO heredan las reglas del padre: sin bloque propio, esto
  // cae en el cierre por defecto y ni su dueño puede leerlo.
  const bloque = REGLAS.slice(REGLAS.indexOf('match /usuarios/{uid}/temporadas/'));
  const hasta = bloque.slice(0, bloque.indexOf('match /', 10));

  assert.match(hasta, /allow read: if esYo\(uid\) \|\| esAdmin\(\)/);
  assert.match(hasta, /allow write: if false/, 'el usuario podria falsear su historial');
});

test('hay un ranking por cada modo del juego', () => {
  // Que existan por separado es lo que hace que un fondista se vea primero en
  // Fondo aunque este el ultimo en Sprint. Sin eso, el juego vuelve a ser solo
  // de velocistas.
  const codigo = leerCodigo('backend/src/agregados.js');
  for (const modo of ['general', 'sprint', 'fondo', 'constancia']) {
    assert.match(codigo, new RegExp(`${modo}: \{`), `falta el modo ${modo}`);
  }

  // Y la pantalla los ofrece los cuatro.
  const pagina = leer('clasificacion/index.html');
  for (const modo of ['general', 'sprint', 'fondo', 'constancia']) {
    assert.match(pagina, new RegExp(`value="${modo}"`), `la pantalla no ofrece ${modo}`);
  }
});

test('el mapa distingue controlar de ir primero', () => {
  // Pintar del color del que va primero por un punto daria un mapa lleno de
  // dueños falsos, y taparia justo donde hay partida.
  const pagina = leerCodigo('assets/js/paginas/territorio.js');

  assert.match(pagina, /if \(!stats\?\.clanDominante\) return NEUTRAL/,
    'se colorea sin comprobar que alguien controle de verdad');
  assert.match(pagina, /enDisputa/, 'la disputa no se marca en el mapa');
});

test('el territorio decae por diferencia de fechas', () => {
  // Un cron que TIENE que correr cada dia acaba saltandose alguno, y entonces
  // el territorio se queda congelado sin que nadie lo note.
  const codigo = leerCodigo('backend/src/territorio.js');
  assert.match(codigo, /Date\.parse\(hasta\) - Date\.parse\(desde\)/);
  assert.match(codigo, /CONSERVA_DIARIA \*\* dias/);

  // Y el recalculo guarda la fecha, o no habria desde donde medir.
  assert.match(leerCodigo('backend/src/puntuacion.js'), /ultimoDecaimiento: hoy/);
});

test('la influencia pesa las tres componentes del juego', () => {
  const { PESOS } = require('../src/territorio');
  const suma = Object.values(PESOS).reduce((t, p) => t + p, 0);

  assert.ok(Math.abs(suma - 1) < 0.001, `los pesos suman ${suma}, deberian sumar 1`);
  for (const componente of ['presencia', 'velocidad', 'volumen']) {
    assert.ok(PESOS[componente] > 0, `${componente} no pesa nada`);
  }
});

test('el bonus de territorio exige controlar, no ir primero', () => {
  // En una estacion en disputa no hay bonus para nadie: tenerla a medias no es
  // tenerla.
  const worker = leerCodigo('backend/worker.js');
  const funcion = worker.slice(
    worker.indexOf('async function tocaTerritorioPropio'),
    worker.indexOf('async function premiar'));

  assert.match(funcion, /clanDominante === clan/);
  assert.ok(!/lider === clan/.test(funcion), 'bastaria con ir primero');

  // Y si no se puede comprobar, se puntua SIN bonus: es peor dar puntos de mas
  // que de menos.
  assert.match(funcion, /catch[\s\S]*return false/);
});

test('las misiones son las mismas para todo el mundo', () => {
  // Es lo que permite leerlas con UNA lectura cacheable en vez de una por
  // usuario. Si fueran personales, 1.000 visitas serian 1.000 lecturas.
  const bloque = REGLAS.slice(REGLAS.indexOf('match /config/misiones/dias/'));
  const hasta = bloque.slice(0, bloque.indexOf('match /', 10));

  assert.match(hasta, /allow read: if true/);
  // Y las escribe el worker: si las escribiera el cliente, cualquiera se
  // pondria objetivos de un metro.
  assert.match(hasta, /allow write: if false/);
});

test('la ruta del dia se fija una vez al dia', () => {
  // Cambiarla a media mañana invalidaria la clasificacion diaria que la gente
  // ya esta compitiendo.
  const worker = leerCodigo('backend/worker.js');
  assert.match(worker, /if \(datos\.rutaDestacadaDia === hoy\) return;/);
  assert.match(worker, /rutaDestacadaDia: hoy/);
});

test('el panel de inicio pone primero lo que se puede perder', () => {
  // La pregunta que responde es "que hago hoy", no "que hice". La racha va
  // arriba porque es lo unico que se pierde si no sales.
  const pagina = leer('index.html');
  const posRacha = pagina.indexOf('id="racha"');
  const posMarca = pagina.indexOf('id="ultima-marca"');

  assert.ok(posRacha > 0 && posRacha < posMarca,
    'la ultima marca va antes que la racha');
});

test('el worker no falla cuando todavia no hay credenciales', () => {
  // Sin esta salida limpia, cada despertar del cron cuenta como fallo: manda un
  // correo y, en repositorio privado, gasta un minuto entero de Actions por no
  // hacer nada.
  const flujo = leer('.github/workflows/verificar-viajes.yml');
  assert.match(flujo, /if \[ -z "\$FIREBASE_SERVICE_ACCOUNT" \]/);
  assert.match(flujo, /::warning::/, 'el salto debe quedar anotado, no ser silencioso');

  // Pero el worker en si SI tiene que morir con error: decidir que el proyecto
  // no esta configurado es cosa del workflow, no suya.
  assert.match(leerCodigo('backend/worker.js'), /Falta FIREBASE_SERVICE_ACCOUNT[\s\S]{0,80}process\.exit\(1\)/);
});


// --- Despliegue ----------------------------------------------------------------

test('vercel.json no lleva claves que Vercel no entienda', () => {
  // Esto tumbo CINCO despliegues seguidos y no se veia en ningun sitio: el
  // fichero llevaba un comentario con la convencion de la clave "//" — que es
  // JSON perfectamente valido — y el esquema de Vercel rechaza cualquier clave
  // que no conozca. El despliegue ni llega a construirse: falla con "should NOT
  // have additional property `//`" y el sitio se queda con lo ultimo que
  // funcionase.
  //
  // La lista es la de propiedades de configuracion de proyecto de Vercel que
  // usa este repositorio. Si hace falta una nueva, se añade AQUI a proposito,
  // que es lo que obliga a comprobar que existe de verdad.
  const PERMITIDAS = [
    '$schema', 'cleanUrls', 'trailingSlash', 'redirects', 'rewrites',
    'headers', 'buildCommand', 'outputDirectory', 'installCommand',
    'framework', 'regions', 'ignoreCommand',
  ];

  const vercel = JSON.parse(leer('vercel.json'));
  for (const clave of Object.keys(vercel)) {
    assert.ok(PERMITIDAS.includes(clave),
      `vercel.json tiene la clave "${clave}", que Vercel rechaza. `
      + 'Los comentarios van al README: ese fichero no los admite.');
  }
});

test('el modo mantenimiento tapa el sitio pero no las rutas viejas', () => {
  // El primer redirect es el que pone la web en obras, y el README dice que
  // para reabrir hay que borrar SOLO ese. Si alguien lo mueve de sitio, esa
  // instruccion se convierte en "borra las rutas viejas", que estan enlazadas
  // desde fuera.
  const { redirects } = JSON.parse(leer('vercel.json'));
  assert.ok(Array.isArray(redirects) && redirects.length > 1);

  assert.match(redirects[0].destination, /^\/mantenimiento\//,
    'el primer redirect ya no es el de mantenimiento; revisa el README');
  assert.strictEqual(redirects[0].permanent, false,
    'el redirect de mantenimiento tiene que ser temporal, o los navegadores lo cachean para siempre');

  for (const vieja of ['/home', '/ranking', '/mapa']) {
    assert.ok(redirects.some((r) => r.source === vieja),
      `falta el redirect de la ruta vieja ${vieja}`);
  }
});

// --- Contraste (WCAG AA, #53) -------------------------------------------------

/** Los dos bloques de tokens de `app.css`: el tema claro y el oscuro. */
function paletas() {
  const css = leer('assets/css/app.css');
  const bloque = (desde) => {
    const inicio = css.indexOf(desde);
    assert.ok(inicio !== -1, `no encuentro el bloque ${desde}`);
    const fin = css.indexOf('}', inicio);
    return Object.fromEntries(
      [...css.slice(inicio, fin).matchAll(/(--[a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]])
    );
  };

  const claro = bloque(':root {');
  // El tema oscuro redefine solo algunos: los que no, se heredan del claro.
  return { claro, oscuro: { ...claro, ...bloque("[data-theme='dark']") } };
}

const canal = (c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const luminancia = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
};
const contraste = (a, b) => {
  const [mayor, menor] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (mayor + 0.05) / (menor + 0.05);
};

test('el texto pasa el 4,5:1 de la WCAG AA en los dos temas', () => {
  // Solo los tokens que se usan COMO TEXTO. `--lima` queda fuera a proposito:
  // en `app.css` aparece unicamente como fondo del subrayador del record, y
  // sobre el va `--tinta`, que da de sobra.
  const TEXTOS = ['--tinta', '--tinta-2', '--tinta-3', '--azul', '--verde', '--rojo', '--ambar'];
  // `--papel-3` no entra: su unico uso es el fondo de un boton deshabilitado,
  // que la propia norma excluye (1.4.3, texto de un control inactivo).
  const FONDOS = ['--papel', '--papel-2'];

  const fallos = [];
  for (const [tema, paleta] of Object.entries(paletas())) {
    for (const texto of TEXTOS) {
      for (const fondo of FONDOS) {
        const ratio = contraste(paleta[texto], paleta[fondo]);
        if (ratio < 4.5) fallos.push(`${tema}: ${texto} (${paleta[texto]}) sobre ${fondo} = ${ratio.toFixed(2)}`);
      }
    }
  }

  assert.deepStrictEqual(fallos, [],
    `hay texto por debajo del minimo legible:\n  ${fallos.join('\n  ')}`);
});

test('el indicador de foco se ve contra lo que tiene al lado', () => {
  // 1.4.11: los elementos de interfaz necesitan 3:1. El foco es un borde azul
  // de 2 px en los campos y un contorno azul en todo lo demas.
  for (const [tema, paleta] of Object.entries(paletas())) {
    for (const vecino of ['--papel', '--linea']) {
      const ratio = contraste(paleta['--azul'], paleta[vecino]);
      assert.ok(ratio >= 3,
        `${tema}: el foco (--azul) sobre ${vecino} solo da ${ratio.toFixed(2)}`);
    }
  }
});

// --- Repaso legal (#55) ---------------------------------------------------------

test('la version de cada documento legal coincide con la que registra el codigo', () => {
  // El consentimiento se guarda con una version. Si el documento dice 1.2.0 y
  // el codigo registra 1.1.0, lo que hay guardado no demuestra que se acepto
  // ESE texto, que es justo lo que el RGPD pide poder demostrar.
  const registrada = leer('backend/src/config.js').match(/VERSION_TERMINOS: '([^']+)'/)[1];

  // Los cuatro no tienen por que ir a la vez: se sube el de la version que
  // cambia. Lo que no puede pasar es que ninguno vaya por la version que se
  // esta registrando.
  const versiones = ['privacidad', 'terminos', 'cookies', 'aviso-legal'].map((doc) => {
    const html = leer(`legal/${doc}/index.html`);
    return { doc, version: (html.match(/class="version">Version ([\d.]+)/) || [])[1] };
  });

  for (const { doc, version } of versiones) {
    assert.ok(version, `legal/${doc} no declara version`);
  }
  assert.ok(versiones.some((v) => v.version === registrada),
    `el codigo registra ${registrada} y ningun documento legal esta en esa version: `
    + versiones.map((v) => `${v.doc}=${v.version}`).join(', '));
});

test('la politica de privacidad no dice que no medimos, cuando si medimos', () => {
  // La analitica propia entro despues de escribir la politica, y el texto
  // seguia diciendo que no habia ninguna. Un documento legal que describe algo
  // que no es lo que pasa es peor que no tenerlo.
  const privacidad = leer('legal/privacidad/index.html');
  const hayAnalitica = fs.existsSync(path.join(RAIZ, 'assets/js/metricas.js'));

  if (!hayAnalitica) return;

  assert.match(privacidad, /id="medicion"/,
    'hay analitica propia y la politica no la describe');
  assert.ok(!/no usamos cookies\s+de seguimiento ni herramientas de analitica\.\s*</.test(privacidad),
    'la politica afirma que no hay analitica de ningun tipo');

  // Y la de cookies tiene que explicar por que sigue sin haber banner.
  assert.match(leer('legal/cookies/index.html'), /banner|consentimiento/i);
});

test('lo que la politica promete conservar tiene quien lo pode', () => {
  // Un plazo de conservacion que no ejecuta nadie no es un plazo. Los errores
  // del cliente solo se vaciaban a mano desde el panel, o sea nunca.
  const privacidad = leer('legal/privacidad/index.html');
  if (!/Errores de la aplicacion:/.test(privacidad)) return;

  const metricas = leerCodigo('backend/src/metricas.js');
  assert.match(metricas, /podarErrores/, 'la politica promete un plazo que no ejecuta nadie');
  assert.match(leerCodigo('backend/worker.js'), /podarErrores\(/,
    'la poda existe pero el worker no la llama');
});

test('el derecho de supresion lo ejecuta alguien', () => {
  // Estuvo prometido en la politica, ofrecido en el perfil y admitido por las
  // reglas, pero `solicitudes_borrado` no la procesaba nadie: las peticiones se
  // acumulaban para siempre.
  const worker = leerCodigo('backend/worker.js');
  assert.match(worker, /solicitudes_borrado/,
    'nadie procesa las solicitudes de borrado de cuenta (RGPD art. 17)');
  assert.match(worker, /procesarBorrados\(\)/);
});

test('el export incluye las subcolecciones, no solo el documento del perfil', () => {
  // Las temporadas archivadas cuelgan del usuario como subcoleccion: no vienen
  // dentro del perfil. Sin pedirlas aparte, el export se dejaba fuera todo el
  // historial de competicion, que es justo lo que el art. 20 llama
  // portabilidad.
  const acciones = leerCodigo('assets/js/acciones.js');
  const exportar = acciones.slice(acciones.indexOf('export async function exportarMisDatos'));
  const cuerpo = exportar.slice(0, exportar.indexOf('export async function solicitarBorradoCuenta'));

  assert.match(cuerpo, /'temporadas'/, 'el export se deja fuera las temporadas archivadas');
  assert.match(cuerpo, /auth\.currentUser/, 'el export se deja fuera el correo, que vive en Auth');
});

test('sigue visible que esto no tiene nada que ver con BiciMAD ni con la EMT', () => {
  const terminos = leer('legal/terminos/index.html');
  assert.match(terminos, /No existe relacion alguna con BiciMAD/);
  assert.match(terminos, /EMT/);
});

test('los enlaces entre documentos de docs/ no estan rotos', () => {
  // Un enlace roto en la documentacion no falla en ninguna parte: se descubre
  // el dia que alguien vuelve al proyecto y lo sigue. Que es exactamente el dia
  // en que esta documentacion tiene que servir para algo.
  const docs = fs.readdirSync(path.join(RAIZ, 'docs')).filter((f) => f.endsWith('.md'));

  for (const doc of docs) {
    const texto = leer(`docs/${doc}`);
    for (const [, destino] of texto.matchAll(/\]\(([A-Z][A-Za-z]+\.md)(#[^)]*)?\)/g)) {
      assert.ok(docs.includes(destino), `docs/${doc} enlaza a ${destino}, que no existe`);
    }
  }
});
