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

test('la ventana de huellas no se relee por cada viaje de la tanda', () => {
  // Era la lectura mas cara del worker: los MISMOS documentos, releidos enteros
  // por cada viaje procesado. Con 25 viajes en una pasada, 25 veces lo mismo.
  const worker = leerCodigo('backend/worker.js');

  const carga = worker.match(/huellas_captura'\)\s*\n?\s*\.orderBy/g) || [];
  assert.strictEqual(carga.length, 1,
    'la ventana de huellas se lee en mas de un sitio');
  assert.match(worker, /if \(huellasRecientes\) return huellasRecientes;/,
    'la ventana no esta cacheada para la ejecucion');
  // Lo que escribe esta misma ejecucion tiene que entrar en la cache, o subir
  // dos veces la misma imagen en la misma pasada colaria la segunda.
  assert.match(worker, /apuntarHuella\(/,
    'las huellas nuevas no se meten en la cache');
});

test('el duplicado exacto se busca por el id del documento, no recorriendo', () => {
  // El id de `huellas_captura` ES el sha. Buscarlo directo cuesta una lectura en
  // vez de la ventana entera, y ademas pilla el duplicado por viejo que sea:
  // recorriendo, se escapaba todo lo que hubiera salido de la ventana.
  const worker = leerCodigo('backend/worker.js');
  assert.match(worker, /huellas_captura'\)\.doc\(hashSha\)\.get\(\)/,
    'el duplicado byte a byte no se busca por id');
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
 * Paginas a las que se les admite un <style> propio, y por que.
 *
 * `/admin/` no es parte del sitio publico: es la pantalla de trabajo de quien
 * modera. Sus estilos — el visor de capturas a pantalla completa, la tabla de
 * cotejo, la rejilla de reportes — no los usa ninguna otra pagina, y meterlos
 * en `app.css` los haria descargar a todo el mundo para nada.
 *
 * La excepcion NO es barra libre: el test de abajo comprueba que esos estilos
 * no pisan ninguna clase comun y que no llevan un solo color a mano. Una
 * pantalla que redefine `.container` o `.seccion` se lleva por delante piezas
 * compartidas y nadie sabe por que se ven distintas alli.
 */
const CON_ESTILOS_PROPIOS = [
  'admin/index.html',
];

test('los estilos propios del panel no pisan el sistema de diseno', () => {
  const css = leer('assets/css/app.css');
  const comunes = new Set([...css.matchAll(/^\.([a-z0-9-]+)/gm)].map((m) => m[1]));

  for (const pagina of CON_ESTILOS_PROPIOS) {
    const bloque = (leer(pagina).match(/<style>([\s\S]*?)<\/style>/) || [])[1];
    if (!bloque) continue;

    // Redefinir una clase comun desde una pagina suelta es como se rompen las
    // piezas compartidas: dejan de verse igual en un sitio y nadie sabe por que.
    const propias = new Set([...bloque.matchAll(/^\s*\.([a-z0-9-]+)/gm)].map((m) => m[1]));
    const pisadas = [...propias].filter((c) => comunes.has(c));
    assert.deepStrictEqual(pisadas, [],
      `${pagina} redefine clases de app.css: ${pisadas.join(', ')}`);

    // Y ni un color a mano: el siguiente que se anada ya no sale de los tokens,
    // y en tema oscuro se ve lo que sea.
    const literales = bloque.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    assert.deepStrictEqual(literales, [],
      `${pagina} lleva colores literales: ${literales.join(', ')}`);
  }
});

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

  const nuevas = conEstilos.filter((p) => !CON_ESTILOS_PROPIOS.includes(p));
  assert.deepStrictEqual(nuevas, [], `paginas con <style> propio: ${nuevas.join(', ')}`);

  // La lista tambien tiene que encoger: una excepcion que ya no hace falta y
  // que nadie poda deja de significar nada y acaba tapando lo que vigila.
  const yaLimpias = CON_ESTILOS_PROPIOS.filter((p) => !conEstilos.includes(p));
  assert.deepStrictEqual(yaLimpias, [],
    `ya no tienen estilos propios, quitalas de CON_ESTILOS_PROPIOS: ${yaLimpias.join(', ')}`);
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

test('los puntos de la v1 se archivan, ni se suman ni se tiran', () => {
  // Sumarlos daria ventaja de salida a quien ya estaba, y medida con otras
  // reglas: la v1 solo puntuaba ir rapido. Tirarlos es decirle a alguien con dos
  // años de viajes que no cuentan. Se archivan como una temporada mas.
  const migracion = leerCodigo('scripts/migrar-datos.js');

  assert.match(migracion, /temporadas\/\$\{TEMPORADA_V1\}/,
    'el historial de la v1 no se archiva en la subcoleccion del usuario');

  // La temporada en curso arranca a cero para todo el mundo.
  assert.match(migracion, /puntosTemporada: 0/);
  assert.ok(!/puntosTemporada: Number\(datos\.biciRating/.test(migracion),
    'los puntos de la v1 se estan sumando a la temporada en curso');

  // Y los viajes migrados no pueden volver a repartir puntos.
  assert.match(migracion, /premiado: true/,
    'sin esta marca el worker podria volver a premiar los viajes de la v1');
});

test('los viajes migrados llevan distancia, y marcada si es estimada', () => {
  // Sin esto el modo Fondo arranca como si nadie hubiera pedaleado nunca:
  // alguien con doscientos viajes a la espalda tendria cero kilometros.
  const migracion = leerCodigo('scripts/migrar-datos.js');

  assert.match(migracion, /require\('\.\.\/backend\/src\/distancias'\)/,
    'debe medir con el mismo modulo que el worker, o los viajes viejos y los nuevos no cuentan igual');
  assert.match(migracion, /distanciaMetros:/);
  assert.match(migracion, /velocidadKmh:/);
  // La diferencia entre un kilometraje medido y uno deducido tiene que quedar
  // visible: quien mire su perfil tiene derecho a saber cual esta viendo.
  assert.match(migracion, /distanciaEstimada:/);
});

test('la migracion ofrece copia de seguridad y no la sobrescribe', () => {
  // `set` sin merge no tiene vuelta atras: sin copia, un error es definitivo.
  const migracion = leerCodigo('scripts/migrar-datos.js');

  assert.match(migracion, /--copia/, 'no hay forma de hacer copia antes de aplicar');
  assert.match(migracion, /flag: 'wx'/,
    'sobrescribiria una copia existente al lanzar el comando dos veces');

  // Y el camino de vuelta tiene que estar escrito, no en la cabeza de nadie.
  const guion = leer('docs/MIGRACION.md');
  assert.match(guion, /Camino de vuelta/);
  assert.match(guion, /--copia/);
});

test('alguien cierra los dias perdidos de las rachas', () => {
  // `rachas.cerrarDiasPerdidos` existia, estaba probada, y su documentacion
  // decia "lo llama la pasada diaria del worker". No la llamaba nadie. El
  // efecto: ninguna racha se rompia nunca y ningun escudo se gastaba jamas, asi
  // que el escudo no protegia de nada y el perfil enseñaba rachas de gente que
  // llevaba meses sin salir.
  const worker = leerCodigo('backend/worker.js');
  assert.match(worker, /rachas\.cerrarDiasPerdidos\(/,
    'nadie cierra los dias perdidos: las rachas no se rompen nunca');

  // Y se ejecuta: `main` llama al trabajo diario, que es quien la llama.
  const principal = worker.slice(worker.indexOf('async function main'));
  assert.match(principal, /await trabajoDiario\(\)/,
    'el trabajo diario esta escrito pero no se ejecuta');
  assert.match(worker.slice(worker.indexOf('async function trabajoDiario')), /await cerrarRachas\(\)/,
    'el trabajo diario no cierra las rachas');
});

test('el trabajo diario no recorre colecciones enteras en cada pasada', () => {
  // El worker corre cada cinco minutos. Sin marca, las dos operaciones que
  // recorren colecciones enteras se repetirian 288 veces al dia.
  const worker = leerCodigo('backend/worker.js');
  const diario = worker.slice(worker.indexOf('async function trabajoDiario'));

  assert.match(diario.slice(0, 900), /ultimoDia/,
    'sin marca del dia, el trabajo diario corre en cada pasada');

  // La marca se escribe DESPUES de las dos: si se corta a medias, la siguiente
  // pasada lo reintenta entero, que es seguro porque son idempotentes.
  const marca = diario.indexOf('ultimoDia: hoy');
  const rescate = diario.indexOf('rescatarSinLider');
  assert.ok(rescate !== -1 && marca > rescate,
    'la marca se escribe antes de terminar: un corte dejaria el dia a medias');
});

test('las rutas ancladas se pueden anclar desde la web', () => {
  // `guardarFavoritas` llevaba escrita desde la reescritura y no la llamaba
  // ninguna pantalla: se podian anclar rutas por consola y de ninguna otra
  // forma.
  const perfil = leerCodigo('assets/js/paginas/yo.js');
  assert.match(perfil, /guardarFavoritas\(/, 'nadie llama a guardarFavoritas');
  assert.match(leer('yo/index.html'), /id="favoritas"/, 'falta el sitio donde pintarlas');

  // El tope de tres lo impone la regla; la pantalla tiene que decirlo antes de
  // que la escritura falle.
  assert.match(perfil, /siguiente\.size >= 3/,
    'la pantalla deja pasar la cuarta y deja que la rechace la regla');
});

test('la gestion de clanes tiene interfaz, no solo acciones', () => {
  // Las doce acciones de clan llevaban escritas en `acciones.js` —con sus reglas
  // y sus pruebas— y no las llamaba NINGUNA pagina. El backend estaba entero y
  // no habia pantalla: un lider no podia aceptar a nadie, ni expulsar, ni ceder
  // el mando, ni invitar.
  const pantalla = leerCodigo('assets/js/mi-clan.js');

  const ACCIONES = [
    'crearClan', 'solicitarEntrada', 'retirarSolicitud', 'responderSolicitud',
    'expulsarMiembro', 'cambiarOficial', 'cederLiderazgo', 'abandonarClan',
    'disolverClan', 'crearInvitacion', 'usarInvitacion', 'confirmarEntrada',
  ];

  for (const accion of ACCIONES) {
    assert.match(pantalla, new RegExp(`\\b${accion}\\b`),
      `${accion} sigue sin tener quien la llame`);
  }

  // Y la pantalla tiene que estar enchufada a la pagina.
  const territorio = leerCodigo('assets/js/paginas/territorio.js');
  assert.match(territorio, /mi-clan\.js/, 'el modulo existe pero no lo carga nadie');
  assert.match(leer('territorio/index.html'), /id="panel-miclan"/,
    'falta el panel donde se pinta');
});

test('la plantilla del clan sale de un agregado, no de usuarios', () => {
  // `usuarios` dejo de ser publica al cerrar la fuga de correos (#60), asi que
  // el navegador no puede leer el perfil de otro. Sin agregado, un lider veria
  // una lista de identificadores y no sabria a quien esta expulsando.
  const pantalla = leerCodigo('assets/js/mi-clan.js');
  assert.match(pantalla, /agregados'?,?\s*`?clan-/,
    'la pantalla no lee el agregado del clan');
  assert.ok(!/collection\(db, 'usuarios'\)/.test(pantalla),
    'esta recorriendo usuarios, que no puede leer');

  // El agregado del clan NO pasa por `limpiar()`, asi que la lista blanca de
  // `CAMPOS_PUBLICABLES` no le aplica. Es una excepcion a proposito y acotada:
  //
  //   - lleva `uid` porque sin el no se puede expulsar ni ascender a nadie, y
  //     porque los uid de un clan YA son publicos: estan en `clanes/{id}.miembros`,
  //     que cualquiera puede leer
  //   - no lleva nada que no este ya en las clasificaciones publicas
  //
  // Lo que esta prueba vigila es que la excepcion no crezca. Publicar
  // `ultimoDiaActivo`, por ejemplo, seria contarle al clan entero cuando sale a
  // la calle cada uno.
  const publica = leerCodigo('backend/src/puntuacion.js');
  const ficha = publica.slice(publica.indexOf('const ficha = (uid)'), publica.indexOf('await db().doc(`agregados/clan-'));

  for (const prohibido of ['email', 'ultimoDiaActivo', 'tokenBaja', 'push',
    'consentimiento', 'suspendido', 'favoritas']) {
    assert.ok(!new RegExp(`\\b${prohibido}\\b`).test(ficha),
      `el agregado del clan publica ${prohibido}`);
  }

  // Y la lista blanca general sigue sin `uid`: la excepcion es de este agregado,
  // no de todos. En una clasificacion publica el uid no hace falta para nada.
  assert.ok(!leerCodigo('backend/src/agregados.js').includes("'uid', 'viajeId'"),
    'el uid ha entrado en la lista blanca general de agregados');
});

test('las plantillas de correo escritas se envian de verdad', () => {
  // Tres estaban escritas y probadas y no las enviaba nadie. La peor, la de
  // viaje anulado: anular un viaje le quita a alguien puntos que ya tenia, y sin
  // aviso lo que ve es que su puntuacion ha bajado sola de un dia para otro.
  const worker = leerCodigo('backend/worker.js');

  for (const plantilla of ['viajeAnulado', 'bienvenida', 'revisionLenta']) {
    assert.match(worker, new RegExp(`plantillas\\.${plantilla}\\b`),
      `la plantilla ${plantilla} esta escrita y no la envia nadie`);
  }
});

test('los avisos repetibles llevan marca para no salir en cada pasada', () => {
  // El worker corre cada cinco minutos: un aviso sin marca sale 288 veces al
  // dia a la misma persona.
  const worker = leerCodigo('backend/worker.js');

  const bienvenida = worker.slice(worker.indexOf('async function darBienvenidas'));
  assert.match(bienvenida.slice(0, 1400), /bienvenidaEnviada: true/,
    'la bienvenida se enviaria en cada pasada');

  const revision = worker.slice(worker.indexOf('async function avisarRevisionesLentas'));
  assert.match(revision.slice(0, 1800), /avisoRevision: true/,
    'el aviso de revision lenta se enviaria en cada pasada');

  // Y la marca se pone aunque el correo falle: reintentarlo cada cinco minutos
  // no lo arregla, y sin marca el bucle no para.
  assert.match(bienvenida.slice(0, 1400), /if \(!SIMULAR\) await doc\.ref\.update\(\{ bienvenidaEnviada: true \}\);\s*\n\s*if \(enviado\)/,
    'la marca depende de que el correo salga: un fallo deja el aviso en bucle');
});

test('el correo de bienvenida se puede encontrar con una consulta', () => {
  // `where('bienvenidaEnviada', '==', false)` NO encuentra los documentos donde
  // el campo falta: en Firestore un campo ausente no lo devuelve ninguna
  // consulta. Si el alta no lo escribe, la consulta sale siempre vacia y nadie
  // recibe la bienvenida — que es exactamente el fallo que esto arregla, pero
  // por otra via.
  assert.match(leerCodigo('assets/js/acciones.js'), /bienvenidaEnviada: false/,
    'el alta no escribe el campo: la consulta del worker no encontraria a nadie');

  const usuarios = bloque('usuarios');
  const alta = usuarios.match(/allow create[\s\S]*?hasOnly\(\[([^\]]+)\]\)/)[1];
  assert.ok(alta.includes('bienvenidaEnviada'),
    'las reglas rechazarian el alta: el campo no esta en la lista');
  assert.match(usuarios, /datos\(\)\.bienvenidaEnviada == false/,
    'el alta podria nacer con la bienvenida ya marcada como enviada');
});

test('las tres piezas de clanes y rachas que nadie llamaba estan enchufadas', () => {
  // Las tres estaban escritas, exportadas y probadas, y sin una sola llamada en
  // produccion. Una funcion probada que no llama nadie da la misma sensacion de
  // seguridad que una que funciona, y no hace nada.
  const worker = leerCodigo('backend/worker.js');
  const mantenimiento = leerCodigo('backend/src/clan-mantenimiento.js');
  const acciones = leerCodigo('assets/js/acciones.js');

  assert.match(worker, /rachas\.cerrarDiasPerdidos\(/, 'las rachas no se rompen nunca');
  assert.match(worker, /clanes\.aplicarInvitacion\(/, 'las invitaciones no se resuelven nunca');
  assert.match(mantenimiento, /elegirSucesor\(clan, miembros, ahora\)/,
    'los clanes sin lider no se rescatan nunca');
  assert.match(worker, /clanes\.rescatarSinLider\(/);

  // Y la otra punta del enlace de invitacion: el navegador tiene que dejar el
  // CODIGO en algun sitio. Antes solo se metia en `solicitudes`, o sea que el
  // enlace acababa siendo una solicitud normal que el lider aprobaba a mano.
  assert.match(acciones, /usos_invitacion/,
    'el navegador no guarda el codigo: el worker no sabe que invitacion gastar');
  assert.match(bloque('usos_invitacion'), /allow update: if false/,
    'el cliente podria escribirse el resultado de su propia invitacion');
});

test('alguien escribe el progreso de las misiones', () => {
  // `misiones.progreso` estaba exportada, probada y sin llamar desde ningun
  // sitio. La portada leia `perfil.misiones`, que no lo escribia nadie, asi que
  // las tres misiones ponian "Pendiente" para siempre: se veian, y no habia
  // forma de completarlas.
  const worker = leerCodigo('backend/worker.js');
  assert.match(worker, /misiones\.(progreso|progresoDeTotales)\(/,
    'nadie calcula el progreso de las misiones: se quedan en Pendiente para siempre');
  assert.match(worker, /misiones: progresoMisiones|misiones: \{/,
    'el progreso no se guarda en el perfil, que es de donde lo lee la portada');
});

test('worker y navegador estan de acuerdo en que dia es', () => {
  // Las misiones se publican con una clave de fecha y el navegador las pide con
  // la suya. Si una es UTC y la otra local, en horario de verano no coinciden
  // entre las 22:00 y las 00:00, y la seccion de misiones desaparece cada noche.
  const worker = leerCodigo('backend/worker.js');
  const preparar = worker.slice(worker.indexOf('async function prepararDia'));
  assert.match(preparar.slice(0, 400), /diaMadrid\(\)/,
    'el worker publica las misiones con el dia UTC');

  const portada = leerCodigo('assets/js/paginas/portada.js');
  assert.match(portada, /timeZone: 'Europe\/Madrid'/,
    'la portada usa la fecha del dispositivo: desde otro pais pediria otro dia');
});

test('el historial de la v1 no se cuela arriba de las temporadas', () => {
  // Las temporadas son meses naturales (`2026-08`) y se ordenan por su
  // identificador. `v1` empieza por letra, asi que en un orden descendente
  // alfabetico se colaria por encima de todos los meses — justo al reves de lo
  // que es: lo mas antiguo que tiene nadie.
  const perfil = leerCodigo('assets/js/paginas/yo.js');

  assert.match(perfil, /function ordenTemporada/,
    'las temporadas se ordenan por el identificador crudo: v1 saldria arriba');
  assert.ok(!/String\(b\.temporada\)\.localeCompare\(String\(a\.temporada\)\)/.test(perfil),
    'ha vuelto la comparacion cruda de identificadores');

  // Y `v1` es un nombre interno: fuera del repositorio nadie sabe que hubo una
  // v1 ni por que su historial esta aparte.
  assert.match(perfil, /function nombreTemporada/,
    'la tabla pintaria el identificador interno "v1" tal cual');
});

test('el aviso a los usuarios de la v1 respeta la baja y no se repite', () => {
  // Un envio masivo desde un cliente de correo se saltaria las tres cosas que
  // comprueba este test, y la primera convierte un aviso util en una infraccion.
  const guion = leerCodigo('scripts/avisar-migracion.js');

  assert.match(guion, /avisosCorreo === false/, 'escribiria a quien se dio de baja');
  assert.match(guion, /tokenBaja/, 'el correo saldria sin enlace de baja');
  assert.match(guion, /avisadoMigracionV1/, 'no hay marca: relanzarlo escribiria dos veces a la misma gente');

  // Y el correo se pide a Auth, no al documento: alli es donde vive (#60).
  assert.match(guion, /admin\.auth\(\)\.getUser\(/);

  // La marca va DESPUES del envio. Al reves, un fallo a mitad dejaria gente
  // marcada como avisada sin haber recibido nada.
  const envio = guion.indexOf('correo.enviar');
  const marca = guion.indexOf('avisadoMigracionV1: true');
  assert.ok(envio !== -1 && marca > envio,
    'la marca de avisado se escribe antes del envio: un fallo dejaria gente sin correo y marcada');
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
    donde: 'metricas.resumir(): viajes verificados por ventana, con consulta de conteo',
    coleccion: 'tiempos_viaje',
    campos: [['verificado', 'ASCENDING'], ['fechaViaje', 'ASCENDING']],
  },
  {
    donde: 'puntuacion.recalcularRuta(): los mas rapidos de la ruta, para el podio',
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
  // Anclado en la COLECCION y no en el filtro: `estado == 'pendiente'` lo usan
  // tambien las peticiones de invitacion, y buscar solo el filtro encontraba la
  // consulta equivocada.
  const cola = worker.slice(worker.indexOf("collection('tiempos_viaje')\n    .where('estado', '==', 'pendiente')"));

  assert.ok(cola, 'ya no se encuentra la consulta de la cola de viajes');
  assert.match(cola.slice(0, 200), /orderBy\('creado', 'asc'\)/,
    'la cola dejaria de ser FIFO');
});

test('las periodicas se reparten por el cron que dispara, no por la fecha', () => {
  // Decidirlo por la fecha se rompe el dia 1 que cae en lunes: los dos cron
  // disparan, los dos ven dia 01 y los dos ejecutan el cierre de temporada. Esa
  // semana las divisiones no se actualizan y el cierre corre dos veces.
  const flujo = leer('.github/workflows/periodicas.yml');

  assert.match(flujo, /github\.event\.schedule/,
    'la operacion se elige por la fecha: el dia 1 en lunes se come las divisiones');
  assert.ok(!/date -u \+%d/.test(flujo), 'ha vuelto el reparto por fecha');

  // Un cron que no reconozcamos no puede disparar lo irreversible.
  const porDefecto = flujo.slice(flujo.indexOf('case "${{ github.event.schedule }}"'));
  assert.match(porDefecto.slice(0, 600), /\*\)\s*\n\s*OPERACION=divisiones/,
    'un cron desconocido acabaria cerrando la temporada, que no tiene vuelta atras');
});

test('las periodicas programadas escriben de verdad', () => {
  // En una ejecucion `schedule` no hay `inputs`, asi que `inputs.aplicar` sale
  // vacio. Resolver el modo solo con esa expresion daba `--simular` SIEMPRE: una
  // vez activados los cron, la temporada no se habria cerrado nunca y nadie se
  // habria enterado, porque el workflow sale en verde igual.
  const flujo = leer('.github/workflows/periodicas.yml');

  assert.match(flujo, /github\.event_name \}\}" = "schedule"/,
    'las ejecuciones programadas no distinguen su modo: simularian siempre');

  const decision = flujo.slice(flujo.indexOf('github.event_name'));
  assert.match(decision.slice(0, 300), /MODO=--aplicar/,
    'una ejecucion programada tiene que escribir, no simular');

  // Y a mano sigue mandando la casilla, que viene desmarcada.
  assert.match(flujo, /inputs\.aplicar && '--aplicar' \|\| '--simular'/,
    'lanzarlo a mano deberia simular salvo que se pida escribir a proposito');
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

  // Y dentro de cada regla, que es donde se colo la segunda vez: el comentario
  // no estaba solo en la raiz, tambien dentro de un bloque de `headers`.
  // Mirando solo las claves de primer nivel, esa se pasaba por alto.
  const CLAVES_REGLA = ['source', 'headers', 'destination', 'permanent',
    'has', 'missing', 'statusCode'];
  for (const regla of [...(vercel.headers || []), ...(vercel.redirects || []), ...(vercel.rewrites || [])]) {
    for (const clave of Object.keys(regla)) {
      assert.ok(CLAVES_REGLA.includes(clave),
        `una regla de vercel.json tiene la clave "${clave}", que Vercel rechaza igual que en la raiz`);
    }
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

test('el dominio de las estaciones no se recalcula viaje a viaje', () => {
  // Recalcular el dominio de una estacion cuesta leer `tiempos_viaje` y
  // `usuarios` ENTEROS. Hacerlo por cada viaje aprobado eran 15.464 lecturas
  // por viaje con 15.000 acumulados: treinta y tres aprobaciones agotaban la
  // cuota diaria del proyecto entero, y sin que nadie mirase la web — bastaba
  // con que la gente subiera viajes (docs/COSTE.md).
  const worker = leerCodigo('backend/worker.js');

  assert.ok(!/recalcularTrasCambio/.test(worker),
    'el worker vuelve a hacer el recalculo completo por viaje');
  assert.match(worker, /recalcularEstaciones\(/, 'nadie rehace el dominio de las estaciones');

  // Y esa llamada tiene que estar FUERA del bucle de la cola, igual que los
  // agregados.
  assert.ok(worker.indexOf('recalcularEstaciones(') > worker.indexOf('for (const doc of cola.docs)'),
    'el dominio se recalcula dentro del bucle de la cola');
});

// --- Vigilancia de la cuota (#38) ------------------------------------------------

test('todo lo que hace el worker pasa por el contador de cuota', () => {
  // Si alguien vuelve a coger `admin.firestore()` directamente, esa parte deja
  // de contarse y el aviso llega tarde o no llega. El aviso es lo unico que hay
  // entre un dia malo y la web caida hasta medianoche.
  const worker = leerCodigo('backend/worker.js');

  assert.match(worker, /cuota\.contar\(arrancar\(\)\)/,
    'el worker no envuelve Firestore con el contador');

  // Y la instancia contada se instala para TODOS los modulos. Sin esto, el
  // contador mide solo las consultas directas del worker y deja fuera los
  // agregados, la puntuacion y las metricas, que es donde esta casi todo.
  assert.match(worker, /almacen\.usar\(db\)/,
    'la instancia contada no se instala: el resto del backend no se cuenta');

  // `arrancar()` es la unica que la coge sin contar, y solo para envolverla.
  const veces = (worker.match(/admin\.firestore\(\)/g) || []).length;
  assert.strictEqual(veces, 1,
    'hay codigo del worker que coge Firestore sin pasar por el contador');

  // Y ningun modulo del backend se la coge por su cuenta.
  const modulos = fs.readdirSync(path.join(RAIZ, 'backend/src'))
    .filter((f) => f.endsWith('.js') && f !== 'db.js');

  for (const modulo of modulos) {
    assert.ok(!/const db = \(\) => admin\.firestore\(\)/.test(leerCodigo(`backend/src/${modulo}`)),
      `${modulo} coge Firestore por su cuenta: lo que haga no se cuenta`);
  }
});

test('el modo degradado apaga lo que mas lee, no la verificacion', () => {
  const worker = leerCodigo('backend/worker.js');

  assert.match(worker, /degradado/, 'no hay modo degradado');
  // Lo que se apaga: agregados, metricas y dominio. Lo que NO: la cola.
  assert.match(worker, /rehacerPesado/);
  assert.ok(!/if \(degradado\) return/.test(worker),
    'el modo degradado no puede saltarse la verificacion: es lo que la gente espera');
});

test('el consumo se registra al final, para contar tambien lo periodico', () => {
  const worker = leerCodigo('backend/worker.js');
  const main = worker.slice(worker.indexOf('async function main()'));

  assert.ok(main.indexOf('cerrarCuota(') > main.indexOf('reconstruirAgregados('),
    'la cuota se cierra antes del trabajo periodico: no contaria lo mas caro');
});

test('la coleccion de cuota no la lee cualquiera', () => {
  assert.match(bloque('cuota'), /allow read: if esAdmin\(\)/);
  assert.match(bloque('cuota'), /allow write: if false/);
});

// --- Accesibilidad tras el rediseno (#53) ----------------------------------------

test('todo lo que recibe un mensaje de estado se anuncia', () => {
  // `estado()` escribe en estos elementos: errores de subida, veredictos,
  // confirmaciones. Sin `aria-live`, quien usa un lector de pantalla no se
  // entera de que su viaje ha sido rechazado — el texto aparece y no lo dice
  // nadie. Es la clase de fallo que no se ve mirando la pantalla.
  const sinAnunciar = [];

  for (const pagina of paginasHtml()) {
    const html = leer(pagina);
    for (const [etiqueta] of html.matchAll(/<[a-z]+[^>]*\bid="(?:mensaje|msg-[a-z-]+)"[^>]*>/g)) {
      if (!/aria-live=/.test(etiqueta)) sinAnunciar.push(`${pagina}: ${etiqueta.trim()}`);
    }
  }

  assert.deepStrictEqual(sinAnunciar, [],
    `hay mensajes de estado que un lector de pantalla no anuncia:\n  ${sinAnunciar.join('\n  ')}`);
});

test('ningun boton se queda sin nombre accesible', () => {
  // Un boton que solo lleva un icono se anuncia como "boton" y ya. Pasa al
  // sustituir texto por un SVG y no acordarse del `aria-label`.
  const mudos = [];

  for (const pagina of paginasHtml()) {
    const html = leer(pagina);
    for (const [entero, atributos, contenido] of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) {
      if (/aria-label=|aria-labelledby=/.test(atributos)) continue;

      // Texto de verdad: lo que queda al quitar etiquetas y los SVG, que son
      // decorativos.
      const texto = contenido.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
      if (!texto) mudos.push(`${pagina}: ${entero.slice(0, 80)}`);
    }
  }

  assert.deepStrictEqual(mudos, [],
    `hay botones sin nombre accesible:\n  ${mudos.join('\n  ')}`);
});

test('el mapa se puede recorrer con el teclado', () => {
  // Un mapa que solo se usa con el dedo deja fuera a gente. Leaflet no pone el
  // foco en los marcadores salvo que se le diga.
  const territorio = leerCodigo('assets/js/paginas/territorio.js');
  assert.match(territorio, /keyboard = true/,
    'los marcadores del mapa quedan fuera del alcance del teclado');
});

test('cada campo de formulario tiene su etiqueta', () => {
  const huerfanos = [];

  for (const pagina of paginasHtml()) {
    const html = leer(pagina);

    // Explicita: <label for="x">. Es la unica que funciona cuando la etiqueta
    // no puede envolver al campo.
    const porFor = new Set(
      [...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));

    // Implicita: el campo va DENTRO del <label>. Vale igual, y es lo normal en
    // las casillas de consentimiento, donde el texto es la etiqueta.
    const porAnidamiento = new Set();
    for (const [, dentro] of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)) {
      for (const m of dentro.matchAll(/<(?:input|select|textarea)[^>]*\bid="([^"]+)"/g)) {
        porAnidamiento.add(m[1]);
      }
    }

    for (const [entero, atributos] of html.matchAll(/<(?:input|select|textarea)([^>]*)>/g)) {
      if (/type="(?:hidden|submit|button)"/.test(atributos)) continue;
      if (/aria-label=|aria-labelledby=/.test(atributos)) continue;

      const id = (atributos.match(/\bid="([^"]+)"/) || [])[1];
      if (!id || (!porFor.has(id) && !porAnidamiento.has(id))) {
        huerfanos.push(`${pagina}: ${entero.slice(0, 80)}`);
      }
    }
  }

  assert.deepStrictEqual(huerfanos, [],
    `hay campos sin etiqueta:\n  ${huerfanos.join('\n  ')}`);
});

// --- Gestion de clanes (#29) -------------------------------------------------------

test('el clan al que perteneces lo puedes escribir, pero solo si el clan te lista', () => {
  // Estaba fuera de las dos listas de campos escribibles, asi que NADIE podia
  // escribirlo: crear un clan, aceptar a alguien o expulsarlo fallaban contra
  // las reglas y la gestion de clanes no funcionaba desde el navegador.
  const usuarios = bloque('usuarios');
  assert.match(usuarios, /cambia\(\)\.hasOnly\(\['clanId'\]\)/,
    'nadie puede escribir clanId: la gestion de clanes no funciona');

  // Y la comprobacion que impide declararse miembro de cualquier clan.
  assert.match(usuarios, /clanes\/\$\(datos\(\)\.clanId\)\)\.data\.miembros\.hasAny/,
    'cualquiera puede declararse miembro de cualquier clan');
});

test('la puntuacion de un clan no se fia de un campo que escribe el usuario', () => {
  // `clanId` lo escribe cada uno en su documento. Sumar consultando por el
  // significaba que bastaba con ponerselo a mano para inflarle los puntos a un
  // clan ajeno con cuentas nuevas.
  const puntuacion = leerCodigo('backend/src/puntuacion.js');
  const funcion = puntuacion.slice(puntuacion.indexOf('async function recalcularClan'));
  const cuerpo = funcion.slice(0, funcion.indexOf('\n}'));

  assert.ok(!/where\('clanId'/.test(cuerpo),
    'la puntuacion del clan sale de un campo que escribe el propio usuario');
  assert.match(cuerpo, /\.miembros/, 'la plantilla del clan es la fuente de verdad');
});

test('los tres papeles del clan pueden cosas distintas', () => {
  const clanes = bloque('clanes');

  // Si un oficial pudiera tocar el liderazgo, ser oficial y ser lider serian lo
  // mismo y el rol no significaria nada.
  const deOficial = clanes.match(/allow update: if esOficial\(\)[\s\S]*?;/)[0];
  assert.ok(!/'lider'/.test(deOficial), 'un oficial puede cambiar el liderazgo');
  assert.ok(!/'oficiales'/.test(deOficial), 'un oficial puede nombrarse mas oficiales');

  // El lider si, pero solo a alguien de dentro: cederlo a alguien de fuera deja
  // el clan sin nadie que pueda gestionarlo.
  const deLider = clanes.match(/allow update: if esLider\(\)[\s\S]*?;/)[0];
  assert.match(deLider, /datos\(\)\.miembros\.hasAny\(\[datos\(\)\.lider\]\)/);
});

test('el lider no puede irse dejando el clan sin nadie al mando', () => {
  const clanes = bloque('clanes');
  const salida = clanes.match(/allow update: if autenticado\(\)\s*&& cambia\(\)\.hasOnly\(\['miembros', 'numMiembros', 'oficiales'\]\)[\s\S]*?;/)[0];

  assert.match(salida, /previo\(\)\.lider != request\.auth\.uid/);
  // Y al irse solo se saca a si mismo.
  assert.match(salida, /previo\(\)\.miembros\.hasOnly\(datos\(\)\.miembros\.concat\(\[request\.auth\.uid\]\)\)/);
});

test('un clan tiene tope de miembros', () => {
  // Sin tope acaba todo el mundo en el mismo clan y el mapa se queda sin
  // partida.
  const clanes = bloque('clanes');
  assert.match(clanes, /datos\(\)\.miembros\.size\(\) <= \d+/);

  // Y el navegador usa el mismo numero, no uno parecido.
  const acciones = leerCodigo('assets/js/acciones.js');
  const enReglas = Number(clanes.match(/datos\(\)\.miembros\.size\(\) <= (\d+)/)[1]);
  const enCliente = Number(acciones.match(/MAX_MIEMBROS = (\d+)/)[1]);
  assert.strictEqual(enCliente, enReglas,
    `las reglas admiten ${enReglas} y el cliente cree que son ${enCliente}`);
});

test('los codigos de invitacion no se pueden listar', () => {
  // El id del documento ES el codigo, y es lo unico que hace falta para entrar.
  // Con `list`, cualquiera se descarga todos los vigentes.
  const invitaciones = bloque('invitaciones');
  assert.match(invitaciones, /allow list: if false/);
  assert.match(invitaciones, /allow get: if autenticado\(\)/);
});

test('una invitacion no puede ser eterna, y la crea quien manda', () => {
  const invitaciones = bloque('invitaciones');

  assert.match(invitaciones, /datos\(\)\.caduca > request\.time/);
  assert.match(invitaciones, /duration\.value\(\d+, 'd'\)/,
    'una invitacion sin tope de caducidad es una puerta abierta');

  // Y solo el lider del clan al que invita.
  assert.match(invitaciones, /\.data\.lider == request\.auth\.uid/);
  assert.match(invitaciones, /datos\(\)\.usos == 0/);
});

test('el codigo de invitacion no se puede adivinar', () => {
  // `Math.random()` es predecible: con el codigo en la URL y sin poder listar la
  // coleccion, adivinarlo es la unica via de entrada, y no puede estar abierta.
  const acciones = leerCodigo('assets/js/acciones.js');
  const funcion = acciones.slice(acciones.indexOf('export async function crearInvitacion'));
  const cuerpo = funcion.slice(0, funcion.indexOf('\n}'));

  assert.match(cuerpo, /crypto\.getRandomValues/);
  assert.ok(!/Math\.random/.test(cuerpo), 'el codigo de invitacion es predecible');
});

// --- Microinteracciones (#51) ------------------------------------------------------

test('con prefers-reduced-motion no se mueve nada, pero se ve todo', () => {
  // Es EL fallo de esto: dejar las partes en `opacity: 0` confiando en que la
  // animacion las traiga. Con `animation: none !important` — que es justo lo
  // que hace el bloque de movimiento reducido — se quedan invisibles para
  // siempre, y quien pidio que no se moviera nada se queda sin contenido.
  const css = leerCodigo('assets/css/app.css');

  assert.match(css, /\.aparece\s*\{[^}]*opacity:\s*0/,
    'el test ya no mira lo que cree mirar');

  const reducido = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reducido, /\.aparece\s*\{\s*opacity:\s*1/,
    'con movimiento reducido el contenido animado se queda invisible');
});

test('la clase que oculta solo se pone si se va a animar de verdad', () => {
  // El cinturon del test de arriba: el JS tampoco debe marcar nodos para
  // aparecer cuando sabe que no habra animacion.
  const celebrar = leerCodigo('assets/js/celebrar.js');
  const funcion = celebrar.slice(celebrar.indexOf('export function aparecerPorPartes'));
  const cuerpo = funcion.slice(0, funcion.indexOf('\n}'));

  assert.match(cuerpo, /sinMovimiento\(\)/,
    'se marcan nodos para aparecer sin comprobar si el sistema anima');
  assert.ok(cuerpo.indexOf('sinMovimiento()') < cuerpo.indexOf("classList.add('aparece')"),
    'se marca el nodo antes de comprobar si va a animarse');
});

test('el sonido esta apagado por defecto', () => {
  // Una web que suena sola la primera vez que la abres en el metro es una web
  // que se cierra.
  const celebrar = leerCodigo('assets/js/celebrar.js');
  const funcion = celebrar.slice(celebrar.indexOf('export function sonidoActivo'));
  const cuerpo = funcion.slice(0, funcion.indexOf('\n}'));

  assert.match(cuerpo, /=== '1'/, 'el sonido no esta apagado salvo opt-in explicito');
  assert.match(cuerpo, /catch/, 'en modo privado leer localStorage lanza');

  // Y hay donde apagarlo.
  assert.match(leer('yo/index.html'), /id="sonido"/, 'no hay ajuste para el sonido');
});

test('la celebracion no bloquea ni tapa la pantalla', () => {
  // La animacion acompana. La persona acaba de subir algo y lo que quiere es
  // ver el resultado, no cerrar una ventana.
  const celebrar = leerCodigo('assets/js/celebrar.js');

  assert.ok(!/showModal|dialog|position:\s*fixed/i.test(celebrar),
    'la celebracion monta un dialogo o tapa la pantalla');
  assert.ok(!/setTimeout/.test(celebrar),
    'la aparicion se escalona con temporizadores en vez de con CSS');
});

test('el desglose de puntos no ensena multiplicadores que no multiplican', () => {
  // Un "x1" es ruido y ademas hace pensar que se ha perdido algo.
  const celebrar = leerCodigo('assets/js/celebrar.js');
  assert.match(celebrar, /valor === 1\) continue/);
});
