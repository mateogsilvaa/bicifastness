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

  const enPagina = leer('home/index.html')
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
  assert.match(leerCodigo('assets/js/paginas/profile.js'), /impugnarViaje\(/);
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
  for (const carpeta of ['backend/', 'scripts/', 'shared/', '.github/', 'node_modules/']) {
    assert.ok(ignorados.includes(carpeta), `${carpeta} acabaria publicado en la web`);
  }
  assert.ok(ignorados.includes('firestore.rules'));

  // El mapa hace fetch('/data/emt.geojson'): eso SI tiene que publicarse.
  assert.ok(!ignorados.includes('data/'), 'el mapa se quedaria sin estaciones');
  assert.match(leerCodigo('assets/js/paginas/mapa.js'), /\/data\/emt\.geojson/);
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

