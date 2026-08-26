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

test('toda coleccion que toca el navegador tiene su regla', () => {
  // El cierre por defecto deniega lo que no este declarado. Eso esta bien —es
  // lo que hace que una coleccion nueva no nazca abierta— pero significa que
  // olvidarse de la regla no se nota hasta que alguien usa la pantalla en
  // produccion y se lleva un `permission-denied`. Aqui se nota antes.
  const usadas = new Set();

  for (const fichero of recorrerProyecto(/\.js$/)) {
    const rel = path.relative(RAIZ, fichero);
    if (!rel.startsWith('assets/js/')) continue;

    const codigo = leerCodigo(rel);
    for (const m of codigo.matchAll(/collection\(db,\s*'([a-z_]+)'/g)) usadas.add(m[1]);
    for (const m of codigo.matchAll(/doc\(db,\s*'([a-z_]+)'/g)) usadas.add(m[1]);
  }

  assert.ok(usadas.size >= 10, `esperaba varias colecciones, encontradas ${usadas.size}`);

  const declaradas = new Set([...REGLAS.matchAll(/match \/([a-z_]+)\//g)].map((m) => m[1]));
  const sinRegla = [...usadas].filter((c) => !declaradas.has(c)).sort();

  assert.deepStrictEqual(sinRegla, [],
    `el navegador usa estas colecciones y no tienen regla: ${sinRegla.join(', ')}`);
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

test('lo que mandan hacer los documentos se puede hacer', () => {
  // Una guia que manda ejecutar algo que no existe es peor que no tenerla: se
  // descubre el dia que hace falta, con prisa. `MANTENIMIENTO.md` decia mirar
  // una coleccion `distancias_pendientes` que no ha existido nunca y lanzar una
  // bandera que el script no reconocia.
  //
  // La bandera se busca en el fichero entero, comentarios incluidos: cada script
  // documenta las suyas en su cabecera, y algunas no aparecen como literal en el
  // codigo — `--simular` suele ser el valor por defecto (`!includes('--aplicar')`)
  // y `--proyecto` se lee con un parser generico. Lo que se quiere cazar es una
  // bandera que el script no conoce DE NINGUNA forma.
  const guias = ['docs/MANTENIMIENTO.md', 'docs/LANZAMIENTO.md', 'docs/MIGRACION.md',
    'docs/ENSAYO.md', 'docs/DISTANCIAS.md', 'docs/COSTE.md', 'docs/ROADMAP.md', 'README.md'];

  const rotos = [];

  for (const guia of guias) {
    for (const [, comando, banderas] of leer(guia).matchAll(/node (scripts\/[a-z-]+\.js)((?: --[a-z]+)*)/g)) {
      if (!fs.existsSync(path.join(RAIZ, comando))) {
        rotos.push(`${guia}: ${comando} no existe`);
        continue;
      }

      const fuente = leer(comando);
      for (const bandera of banderas.trim().split(/\s+/).filter(Boolean)) {
        if (!fuente.includes(bandera)) rotos.push(`${guia}: ${comando} no conoce ${bandera}`);
      }
    }
  }

  assert.deepStrictEqual(rotos, [], `documentacion que manda hacer lo imposible:\n  ${rotos.join('\n  ')}`);
});

test('el CI regenera todo lo que despues comprueba', () => {
  // La comprobacion es `git diff --exit-code assets/data backend/lib`, y solo
  // vale lo que se haya regenerado antes. Con un generador de los tres, cazaba
  // a quien editaba a mano un fichero generado pero NO a quien editaba la FUENTE
  // y se olvidaba de regenerar: ahi el generado sigue coincidiendo con git, el
  // diff sale limpio, y el catalogo de insignias que ven el navegador y el
  // worker se queda con los textos viejos.
  const flujo = leer('.github/workflows/ci.yml');
  const scripts = JSON.parse(leer('package.json')).scripts;

  assert.match(flujo, /npm run datos:fuente/,
    'el CI regenera solo una parte de lo que luego compara');

  // Y `datos:fuente` tiene que llevar todos los deterministas. Si aparece un
  // generador nuevo y no entra ahi, su salida deja de comprobarse.
  //
  // Los que NO entran, y por que. Cada uno esta aqui a proposito: si aparece un
  // generador nuevo, esta prueba obliga a decidir en cual de los dos grupos cae
  // en vez de dejarlo fuera sin querer.
  const FUERA = {
    // Escribe el SHA del commit: siempre difiere, asi que no puede entrar en una
    // comprobacion de "esto no ha cambiado". Lo lanza Vercel al desplegar.
    'build-version.js': 'su salida cambia en cada commit',
    // El banco de capturas de prueba vive en `backend/test/banco`, que no es una
    // de las dos carpetas que compara el CI.
    'build-capturas.js': 'no escribe en assets/data ni en backend/lib',
    // Los binarios del OCR van a `assets/ocr`, tampoco comparada, y son megas.
    'build-ocr.js': 'no escribe en assets/data ni en backend/lib',
    // Su fuente NO esta en el repositorio: consulta un router de rutas por la
    // red. El CI no puede reproducirlo, y aunque pudiera, no deberia depender de
    // que un servicio de fuera este en pie.
    'build-distancias.js': 'su fuente es un servicio externo, no un fichero de aqui',
  };

  const generadores = fs.readdirSync(path.join(RAIZ, 'scripts'))
    .filter((f) => f.startsWith('build-') && f.endsWith('.js'))
    .filter((f) => !FUERA[f]);

  for (const generador of generadores) {
    assert.ok(scripts['datos:fuente'].includes(generador),
      `${generador} no esta en datos:fuente: lo que genere no se comprueba en el CI`);
  }

  // El orden importa: `build-push.js` lee de `backend/src/push.js`, que carga
  // `web-push`. Regenerar antes de instalar las dependencias del worker revienta.
  const pasos = flujo.slice(0, flujo.indexOf('desplegar:'));
  assert.ok(pasos.indexOf('npm ci') < pasos.indexOf('npm run datos:fuente'),
    'se regenera antes de instalar las dependencias del worker, y build-push necesita web-push');
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

test('el borrado de cuenta no se deja ninguna coleccion con uid dentro', () => {
  // No hay forma de preguntarle a Firestore "donde aparece esta persona": cada
  // coleccion que guarde un uid hay que anadirla a mano a `borrado.js`. Esta
  // prueba compara las colecciones que existen —las que declara
  // `firestore.rules`— con las que ese fichero toca, y falla cuando aparece una
  // que nadie ha decidido que hacer con ella.
  const reglas = leerCodigo('firestore.rules');
  const declaradas = new Set(
    [...reglas.matchAll(/match \/([a-z_]+)\/\{/g)].map((m) => m[1])
      .filter((c) => c !== 'databases'),
  );

  // Y las que NO tienen bloque de reglas porque solo las toca el Admin SDK: el
  // cierre por defecto las deja fuera del navegador sin decir nada, asi que no
  // aparecen arriba. `correos_pendientes` es una de esas y lleva uid dentro:
  // mirando solo las reglas, se escapaba de esta comprobacion entera.
  for (const rel of ['backend/worker.js', ...fs.readdirSync(path.join(__dirname, '..', 'src'))
    .filter((f) => f.endsWith('.js')).map((f) => `backend/src/${f}`)]) {
    for (const [, nombre] of leerCodigo(rel).matchAll(/\.collection\('([a-z_]+)'\)/g)) {
      declaradas.add(nombre);
    }
  }

  // Colecciones sin ningun uid dentro, o donde quedarse es la decision.
  const SIN_UID = new Set([
    // Datos agregados o de configuracion: no llevan a nadie.
    'agregados', 'config', 'estaciones_stats', 'metricas', 'cuota', 'secrets',
    // La analitica es anonima a proposito: `conSesion` es un booleano, no un
    // uid. Si algun dia guardara uno, hay que sacarlo de esta lista.
    'sesiones_web', 'errores_cliente',
    // El rastro de administracion NO se reescribe: es lo que permite auditar
    // quien suspendio a quien. Las reglas lo dejan escrito
    // (`allow update, delete: if false`) y es una decision, no un olvido.
    'auditoria_admin',
  ]);

  const borrado = leerCodigo('backend/src/borrado.js');
  const olvidadas = [...declaradas]
    .filter((c) => !SIN_UID.has(c))
    .filter((c) => !borrado.includes(c));

  assert.deepStrictEqual(olvidadas, [],
    `el borrado de cuenta no toca estas colecciones: ${olvidadas.join(', ')}. `
    + 'Si no llevan uid, anadelas a SIN_UID a proposito.');
});

test('el borrado rehace el agregado publico del clan', () => {
  // `agregados/clan-{id}` lleva la plantilla CON NOMBRES y lo lee cualquiera.
  // Sacar a alguien de `clanes.miembros` no lo actualiza: sin esto, el nombre de
  // quien acaba de borrar su cuenta seguiria publicado hasta la siguiente
  // reconstruccion, y "en algun momento" no es un plazo.
  const borrado = leerCodigo('backend/src/borrado.js');
  assert.match(borrado, /recalcularClan\(/,
    'el agregado del clan se queda con el nombre de quien se ha borrado');
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

// --- Denuncias (#61) ----------------------------------------------------------

test('denunciar un tiempo tiene por donde, y suspender tambien', () => {
  // El circuito de moderacion estaba entero MENOS el principio: `reportes` con
  // sus reglas, la cola del panel y `resolverReporte` funcionando, y ningun
  // sitio desde el que crear una denuncia. La cola no podia llenarse nunca.
  assert.match(leerCodigo('assets/js/paginas/clasificacion.js'), /reportarViaje\(/,
    'nadie llama a reportarViaje: la cola de moderacion no puede llenarse');

  // Y el otro extremo: el panel resolvia un caso y no podia hacer nada con
  // quien reincide.
  assert.match(leerCodigo('assets/js/paginas/admin.js'), /suspenderUsuario\(/,
    'el panel no puede suspender a nadie');
});

test('denunciar no obliga a publicar el uid de nadie', () => {
  // Es la razon de que esto no estuviera hecho. Denunciar necesitaba mandar
  // `reportadoUid`, y para eso el uid del denunciado tendria que estar
  // publicado en la clasificacion — justo lo que la lista blanca de agregados
  // prohibe desde la fuga de correos (#60).
  //
  // Se manda el id del VIAJE, que es opaco y no lleva a nadie: `tiempos_viaje`
  // no lo lee quien no sea su dueño o la administracion.
  const reportes = bloque('reportes');
  const alta = reportes.match(/allow create[\s\S]*?hasOnly\(\[([^\]]+)\]\)/)[1];

  assert.ok(!alta.includes('reportadoUid'),
    'el cliente manda a quien señala, y para eso habria que publicar los uid');
  assert.ok(alta.includes('viajeId'));

  assert.ok(!leerCodigo('backend/src/agregados.js').includes("'uid',"),
    'el uid ha entrado en la lista blanca de agregados');
});

test('el worker es quien decide a quien señala una denuncia', () => {
  // La comprobacion de "no te denuncies a ti mismo" la hacia la regla, y dejo
  // de poder hacerla cuando el uid del denunciado salio del documento. Si no la
  // recoge nadie, se pierde.
  // La decision vive en `src/denuncias.js`, que es una funcion pura y tiene sus
  // propias pruebas de comportamiento (`test/denuncias.test.js`). Aqui solo se
  // comprueba el cableado: que el worker la use y que se ejecute.
  const worker = leerCodigo('backend/worker.js');

  assert.match(worker, /denuncias\.decidir\(/,
    'el worker decide por su cuenta en vez de usar la funcion probada');
  assert.match(worker.slice(worker.indexOf('async function main')), /await resolverDenuncias\(\)/,
    'la funcion existe y no la llama nadie');

  // Y la regla de seguridad que bajo de las reglas de Firestore a codigo
  // normal tiene que seguir estando en el sitio que se prueba.
  assert.match(leerCodigo('backend/src/denuncias.js'), /dueño === denuncia\.reportanteUid/,
    'se ha perdido la comprobacion de autodenuncia al mudarla de las reglas');
});

test('a la cola de la administracion solo llega lo ya comprobado', () => {
  // Una denuncia nace `sin_resolver` y el worker la pasa a `pendiente` solo si
  // el viaje existe, no es tuyo y no la habias mandado ya. El panel pide
  // `pendiente`: lo descartado no le llega, que es de lo que se trata.
  const reportes = bloque('reportes');
  assert.match(reportes, /datos\(\)\.estado == 'sin_resolver'/,
    'el cliente puede crear una denuncia ya encolada, sin pasar por el worker');

  assert.match(leerCodigo('assets/js/paginas/admin.js'), /where\('estado', '==', 'pendiente'\)/,
    'el panel se traeria tambien las descartadas');
});

test('una cuenta sola no puede parar la cola de todos los demas', () => {
  // Nada impide hoy que alguien escriba miles de viajes: las reglas de Firestore
  // no saben contar y el cupo de tres al dia se comprueba en el worker, o sea
  // cuando el documento ya existe (#62). Mientras eso se decide, el daño que
  // hacia no era solo la cuota: la cola es FIFO, asi que con mil viajes de una
  // misma cuenta delante, los 25 de cada pasada eran suyos y quien subia su
  // trayecto legitimo se quedaba detras DURANTE DIAS.
  const worker = leerCodigo('backend/worker.js');

  assert.match(worker, /async function despejarInundacion/,
    'una cuenta que inunda la cola la para para todo el mundo');
  assert.match(worker.slice(worker.indexOf('async function procesarCola')), /despejarInundacion\(cola\)/,
    'la funcion existe y la cola no la usa');

  const despeje = worker.slice(worker.indexOf('async function despejarInundacion'));

  // Se dejan los del cupo diario: entre ellos puede estar el viaje de verdad.
  assert.match(despeje.slice(0, 3000), /slice\(LIMITES\.VIAJES_POR_DIA\)/,
    'se estarian tirando tambien los viajes que si entran en el cupo');

  // Y las capturas, que son lo que ocupa: 700 KB cada una.
  assert.match(despeje.slice(0, 3000), /borrarCapturaSiSobra/,
    'los viajes se rechazan y sus capturas se quedan ocupando');

  // No suspende: eso es una decision con una persona detras, y se toma en el
  // panel (#61).
  assert.ok(!/suspendido: true/.test(despeje.slice(0, 3000)),
    'el worker suspende cuentas por su cuenta');
});

test('a la administracion se le avisa por un solo canal', () => {
  // Dos canales distintos a proposito: al piloto hay que mirarle la preferencia
  // y meterle el enlace de baja; a la administracion no, porque estos avisos son
  // la unica forma de enterarse de algo que esta pasando y darse de baja de
  // ellos es quedarse sin saberlo. Lo que no puede haber es tres.
  const worker = leerCodigo('backend/worker.js');
  assert.match(worker, /async function enviarAAdmin/);
  assert.match(worker, /enviarAAdmin\(plantillas\.cuotaEnPeligro/,
    'el aviso de cuota va por su cuenta en vez de por el canal comun');
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

test('ceder el mando no deja a nadie en las dos listas', () => {
  // El comentario decia que el nuevo lider deja de ser oficial y el codigo hacia
  // solo la otra mitad: metia al anterior y no sacaba al nuevo. No se puede
  // arreglar con `arrayUnion` y `arrayRemove` a la vez — Firestore no admite las
  // dos sobre el mismo campo en una escritura — asi que la lista va entera.
  const acciones = leerCodigo('assets/js/acciones.js');
  const ceder = acciones.slice(
    acciones.indexOf('export async function cederLiderazgo'),
    acciones.indexOf('export async function abandonarClan'),
  );

  assert.ok(!/arrayUnion/.test(ceder),
    'no se puede combinar arrayUnion y arrayRemove sobre oficiales en una escritura');
  assert.match(ceder, /uid !== nuevoLiderUid/,
    'el nuevo lider se queda tambien de oficial');
});

test('a un lider no se le ofrece salir del clan', () => {
  // `abandonarClan` se niega si eres el lider. Ensenarle el boton es ofrecerle
  // algo que siempre va a fallar; y si es el ultimo, lo unico que puede hacer es
  // disolver.
  const pantalla = leerCodigo('assets/js/mi-clan.js');
  const salida = pantalla.slice(pantalla.indexOf('function bloqueSalida'));

  assert.match(salida.slice(0, 2200), /if \(soyLider && !solo\)/);
  assert.match(salida.slice(0, 2200), /if \(soyLider\) \{/,
    'el lider que se queda solo tiene que poder disolver');
});

test('la pantalla del clan no depende de que exista el agregado', () => {
  // `agregados/clan-{id}` lo escribe `recalcularClan`, que solo corre cuando
  // cambian los puntos de alguien del clan. Un clan RECIEN CREADO no lo tiene:
  // leyendo solo de ahi, quien acababa de fundar su clan veia "todavia no estas
  // en ningun clan" y la pantalla le ofrecia crear otro.
  //
  // Y ademas el agregado va por detras: al aceptar a un candidato, la plantilla
  // del documento cambia en el momento y el agregado no.
  const pantalla = leerCodigo('assets/js/mi-clan.js');

  assert.match(pantalla, /getDoc\(doc\(db, 'clanes', cual\)\)/,
    'el documento del clan tiene que ser la fuente de la plantilla');
  assert.match(pantalla, /agregado\?\.exists\(\)/,
    'el agregado tiene que poder faltar sin romper la pantalla');
});

test('a quien aceptan no se le queda la pantalla en blanco', () => {
  // Aceptar a alguien toca solo el documento del clan; el `clanId` lo escribe
  // esa persona. Entre lo uno y lo otro hay un limbo: la plantilla te cuenta, tu
  // perfil dice que no tienes clan, y nada lo explica. Se detecta buscando el
  // clan que ya te lista, no con un parametro en la URL: ni la via de la
  // invitacion ni la del lider dejan rastro en la direccion.
  const pantalla = leerCodigo('assets/js/mi-clan.js');

  assert.match(pantalla, /array-contains/,
    'no se busca el clan que ya te lista: quien es aceptado se queda en el limbo');
  assert.match(pantalla, /confirmarEntrada\(/);
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
  //
  // La version anterior de esta prueba nombraba TRES plantillas a mano, y por
  // eso se le escapo una cuarta: `viajesVerificados` tampoco la manda nadie, y
  // no salio hasta que hubo que montar el registro por tipos de #65. Una lista
  // escrita a mano solo vigila lo que alguien se acordo de escribir.
  //
  // Ahora se recorren TODAS las que exporta el modulo.
  const worker = leerCodigo('backend/worker.js');
  const plantillas = require('../src/plantillas');

  // Las que no van a un usuario: van a una direccion fija y por otro canal.
  const DE_ADMINISTRACION = new Set(['avisoAdmin', 'cuotaEnPeligro']);

  // Con su motivo escrito, como el resto de listas de excepciones del proyecto.
  const FUERA = {
    // No es un reintento, es una funcion nueva con una decision dentro: el
    // worker dice que estos avisos van AGRUPADOS para no comerse el cupo de
    // Resend, y agrupar exige decidir cada cuanto y con que ventana. Una pasada
    // son cinco minutos, asi que un resumen por pasada no es un resumen.
    viajesVerificados: 'nadie lo manda todavia: falta decidir el agrupado',
    // La manda el script de migracion, no el worker.
    historialMigrado: 'lo manda scripts/migrar-datos.js',
  };

  const sinRemitente = [];

  for (const [nombre, valor] of Object.entries(plantillas)) {
    if (typeof valor !== 'function') continue;
    if (nombre === 'envolver') continue;
    if (DE_ADMINISTRACION.has(nombre) || nombre in FUERA) continue;

    // Desde #65 el worker las nombra por su tipo (`'viaje_rechazado'`), que es
    // como se pueden encolar. Vale cualquiera de las dos formas.
    const porTipo = Object.entries(plantillas.POR_TIPO)
      .find(([, fn]) => fn === valor)?.[0];

    const enviada = new RegExp(`plantillas\\.${nombre}\\b`).test(worker)
      || (porTipo && new RegExp(`'${porTipo}'`).test(worker));

    if (!enviada) sinRemitente.push(nombre);
  }

  assert.deepStrictEqual(sinRemitente, [],
    `estas plantillas estan escritas y no las envia nadie: ${sinRemitente.join(', ')}. `
    + 'Si es a proposito, va a FUERA con el motivo escrito.');
});

test('el envio de correo esta en un solo sitio', () => {
  // "Mira la preferencia, saca el correo de Auth, crea el token de baja si no
  // lo tiene" son las tres cosas que hay que hacer bien SIEMPRE. Repetidas por
  // plantilla, basta con que una copia se quede atras para escribirle a alguien
  // que pidio no recibir nada.
  const worker = leerCodigo('backend/worker.js');

  const envios = (worker.match(/correo\.enviar\(/g) || []).length;
  assert.ok(envios <= 2,
    `hay ${envios} sitios que llaman a correo.enviar: el envio a pilotos va por avisarPorCorreo`);

  // Y quien comprueba la preferencia tambien tiene que ser uno solo.
  const preferencia = (worker.match(/avisosCorreo === false/g) || []).length;
  assert.strictEqual(preferencia, 1,
    'la comprobacion de la preferencia esta duplicada: una copia se quedara atras');
});

test('los avisos repetibles llevan marca para no salir en cada pasada', () => {
  // El worker corre cada cinco minutos: un aviso sin marca sale 288 veces al
  // dia a la misma persona.
  const worker = leerCodigo('backend/worker.js');

  const bienvenida = worker.slice(worker.indexOf('async function darBienvenidas'));
  assert.match(bienvenida.slice(0, 1400), /bienvenidaEnviada: true/,
    'la bienvenida se enviaria en cada pasada');

  const revision = worker.slice(worker.indexOf('async function avisarRevisionesLentas'));
  assert.match(revision.slice(0, 2600), /avisoRevision: true/,
    'el aviso de revision lenta se enviaria en cada pasada');

  // Y la marca tiene que poder FILTRARSE, no solo mirarse en memoria. Un viaje
  // sigue en revision hasta que una persona lo resuelve: descartando en memoria
  // sobre los primeros 50, los ya avisados se quedan ocupando el hueco y con la
  // cola cargada los nuevos no llegan a mirarse nunca.
  assert.match(revision.slice(0, 2600), /where\('avisoRevision', '==', false\)/,
    'la consulta no filtra por la marca: los avisados tapan a los nuevos');
  assert.match(worker.slice(worker.indexOf('async function resolver')), /avisoRevision: false/,
    'nadie escribe la marca al mandar un viaje a revision, asi que la consulta no lo encuentra');

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

  // El navegador tiene su propio `dia.js`, que es la pareja de `util.diaMadrid`.
  // Se comprueba el modulo, no cada pantalla: si alguien vuelve a calcular el
  // dia a mano en una pagina, lo que falla es la prueba de abajo.
  const dia = leerCodigo('assets/js/dia.js');
  assert.match(dia, /timeZone: ZONA/);
  assert.match(dia, /Europe\/Madrid/,
    'el dia del navegador no es el de Madrid: desde otro pais se pediria otro dia');

  for (const pagina of ['portada', 'subir']) {
    assert.match(leerCodigo(`assets/js/paginas/${pagina}.js`), /from '\/assets\/js\/dia\.js'/,
      `${pagina} calcula el dia por su cuenta en vez de usar dia.js`);
  }
});

test('el unico dia que no es de Madrid es el de la cuota', () => {
  // Regla del proyecto, y merece la pena que sea una sola: el juego cuenta los
  // dias en Madrid. La excepcion es la cuota diaria de Firestore, que se
  // reinicia a medianoche del Pacifico porque eso no lo decidimos nosotros.
  //
  // Un modulo que calcule el dia por su cuenta vuelve a abrir la puerta a que
  // las dos puntas no coincidan, que es de donde salieron las misiones que
  // desaparecian de noche y el contador de cuota que se reiniciaba antes de
  // tiempo.
  const fuera = [];

  for (const fichero of recorrerProyecto(/\.js$/)) {
    const rel = path.relative(RAIZ, fichero);
    if (!rel.startsWith('backend/src/')) continue;
    if (['backend/src/util.js', 'backend/src/cuota.js'].includes(rel)) continue;

    const codigo = leerCodigo(rel);
    // Las dos formas de sacar un dia o un mes en UTC. `getUTCHours` no cuenta:
    // esa se usa para saber la HORA, que no depende del calendario.
    if (/toISOString\(\)\.slice\(0, (?:10|7)\)/.test(codigo)
      || /getUTCFullYear\(\)/.test(codigo)) fuera.push(rel);
  }

  assert.deepStrictEqual(fuera, [],
    `estos calculan el dia en UTC: ${fuera.join(', ')}. El del juego es el de Madrid.`);
});

test('nadie vuelve a calcular el dia a mano en el navegador', () => {
  // Tres copias de "hoy en YYYY-MM-DD" con la hora del dispositivo es como se
  // llego a que las misiones desaparecieran de noche, a que `subir/` no dejara
  // elegir hoy entre medianoche y las 02:00, y a que las sesiones se guardaran
  // en un dia y se agruparan en otro.
  const fuera = [];

  for (const fichero of recorrerProyecto(/\.js$/)) {
    const rel = path.relative(RAIZ, fichero);
    if (!rel.startsWith('assets/js/')) continue;
    if (rel === 'assets/js/dia.js') continue;

    // Un nombre de fichero con la fecha dentro no cuenta: no decide nada, solo
    // sirve para que la descarga no se llame igual dos veces.
    const codigo = leerCodigo(rel)
      .split('\n')
      .filter((linea) => !/\bdownload\b/.test(linea))
      .join('\n');

    const sospechoso = /getFullYear\(\)[\s\S]{0,120}getMonth\(\)/.test(codigo)
      || /toISOString\(\)\.slice\(0, 10\)/.test(codigo);

    if (sospechoso) fuera.push(rel);
  }

  assert.deepStrictEqual(fuera, [],
    `estos calculan el dia a mano en vez de usar dia.js: ${fuera.join(', ')}`);
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
  {
    donde: 'worker.avisarRevisionesLentas(): los que esperan y aun no se han avisado',
    coleccion: 'tiempos_viaje',
    campos: [['estado', 'ASCENDING'], ['avisoRevision', 'ASCENDING']],
  },
  {
    donde: 'worker.resolverDenuncias(): si esta persona ya habia denunciado este viaje',
    coleccion: 'reportes',
    campos: [['viajeId', 'ASCENDING'], ['reportanteUid', 'ASCENDING']],
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

test('una prueba con su propio "hoy" se lo pasa al codigo, no se lo guarda', () => {
  // COMO SE LLEGO AQUI. `resumen.test.js` sembraba sus datos alrededor de un
  // "hoy" escrito a mano, pero `metricas` no recibe la fecha: la pide con
  // `Date.now()`. Los dos lados hablaban de dias distintos, y dos dias despues
  // de escribirlo el fichero se puso en rojo solo, sin que nadie tocara nada.
  //
  // LA REGLA. Una fecha fija en una prueba vale — es lo que la hace repetible —
  // SIEMPRE que se le PASE al codigo que se esta probando, para que los dos
  // lados cuenten desde el mismo sitio. Lo que no vale es guardarsela para
  // sembrar mientras el codigo mira el reloj de verdad.
  //
  // Se busca el nombre del ancla usado como ARGUMENTO, que es justo lo que
  // separa un caso del otro: `clanes.test.js` hace `elegirSucesor(clan,
  // miembros, AHORA)` y no puede pudrirse; la version rota de `resumen.test.js`
  // solo la usaba para sembrar.
  //
  // No se pasa por `recorrerProyecto`, que se salta `test/` a proposito. Y se
  // quitan antes los comentarios: si no, esta misma prueba se delataria por
  // hablar del asunto.
  const sinComentarios = (codigo) => codigo
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const sinInyectar = [];

  for (const nombreFichero of fs.readdirSync(__dirname)) {
    if (!nombreFichero.endsWith('.test.js')) continue;

    const codigo = sinComentarios(
      fs.readFileSync(path.join(__dirname, nombreFichero), 'utf8'));

    for (const [, ancla] of codigo.matchAll(
      /const (HOY|AHORA|ANCLA|NOW) = (?:new Date\()?['"`]\d{4}-\d{2}-\d{2}/g)) {
      if (!new RegExp(`[(,]\\s*${ancla}\\s*[,)]`).test(codigo)) {
        sinInyectar.push(`${nombreFichero} (${ancla})`);
      }
    }
  }

  assert.deepStrictEqual(sinInyectar, [],
    'estas pruebas se guardan su "hoy" en vez de pasarselo al codigo, asi que se '
    + `pondran en rojo solas cuando pase el tiempo: ${sinInyectar.join(', ')}`);
});

test('ningun modulo de backend/src se queda sin que lo requiera nadie', () => {
  // COMO SE LLEGO AQUI (#64). `backend/src/clanes.js` eran 220 lineas y siete
  // funciones exportadas que no requeria NADIE: ni el worker, ni el navegador,
  // ni sus propias pruebas — `test/clanes.test.js` prueba
  // `clan-mantenimiento.js`, que es el que si esta enchufado.
  //
  // Era de la v1, de cuando habia Cloud Functions, y su cabecera seguia
  // diciendo que las operaciones de clan pasaban por transacciones del
  // servidor. Ya no: escribe el navegador y autorizan las reglas. Un fichero
  // asi no es solo peso muerto, es una respuesta equivocada a quien vaya a
  // buscar como funciona el sistema.
  //
  // Y arrastraba consigo el unico llamante del filtro de palabras, que es como
  // se descubrio que los nombres de piloto y de clan no los filtra nadie.
  //
  // Es el decimo caso del patron "escrito, probado y sin llamar" del roadmap, y
  // el unico que se puede comprobar de forma generica: una funcion suelta sin
  // llamar no se distingue de una funcion interna, pero un MODULO que no
  // requiere nadie no tiene ninguna lectura inocente.
  //
  // Las pruebas no cuentan a proposito: un modulo que solo usan sus pruebas es
  // exactamente el caso que se quiere pillar.
  const FUERA = {
    // Se conserva entero porque el arreglo de #64 lo necesita tal cual: la
    // lista de 169 palabras y, sobre todo, las excepciones ("Cassandra",
    // "competitivo") que costo afinar. Su unico llamante era el modulo muerto.
    'badwords.js': 'sin llamante desde #64; la lista se conserva porque el arreglo la necesita',
    // No es que se haya olvidado enchufarlo: NO PUEDE correr donde hace falta.
    // Cuenta escrituras para frenar a una cuenta suelta, y eso hay que hacerlo
    // ANTES de escribir, cosa que el worker no puede porque llega despues y con
    // el Admin SDK, que se salta las reglas. Se queda hasta que #62 decida
    // entre App Check y un contador en reglas.
    'limites.js': 'no puede correr donde hace falta; a la espera de la decision de #62',
  };

  const SRC = path.join(__dirname, '..', 'src');

  // Todo lo que puede requerir algo, menos las pruebas.
  const requeridores = [];
  (function anda(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'lib', 'data', 'test'].includes(e.name)) continue;
      const completo = path.join(dir, e.name);
      if (e.isDirectory()) anda(completo);
      else if (/\.(js|mjs)$/.test(e.name)) requeridores.push(completo);
    }
  })(RAIZ);

  const codigos = requeridores.map((f) => [f, fs.readFileSync(f, 'utf8')]);
  const sueltos = [];

  for (const nombre of fs.readdirSync(SRC)) {
    if (!nombre.endsWith('.js') || nombre in FUERA) continue;

    const ruta = path.join(SRC, nombre);
    const sinExtension = nombre.replace(/\.js$/, '');
    // `require('./clanes')` y `require('./src/clanes.js')` valen los dos.
    const requerido = new RegExp(`require\\(['"][^'"]*/${sinExtension}(\\.js)?['"]\\)`);

    if (!codigos.some(([f, codigo]) => f !== ruta && requerido.test(codigo))) {
      sueltos.push(`backend/src/${nombre}`);
    }
  }

  assert.deepStrictEqual(sueltos, [],
    'estos modulos no los requiere nadie fuera de las pruebas, asi que no se '
    + `ejecutan nunca: ${sueltos.join(', ')}`);
});

test('la captura que se sube siempre pasa por el lienzo, que es lo que borra el EXIF', () => {
  // POR QUE ESTO MERECE UNA PRUEBA. El EXIF de una foto lleva DONDE se hizo, y
  // las capturas se guardan en Firestore: fueron parte de la fuga de #59. Si
  // llevaran EXIF, habrian llevado la casa de la gente.
  //
  // Quien lo quita es el navegador, y no porque nadie lo decidiera asi: es un
  // efecto secundario de comprimir. Un `<canvas>` solo guarda pixeles, asi que
  // al recodificar no sobrevive ni un metadato. La funcion que DOCUMENTA esa
  // garantia — `imagen.normalizarParaGuardar`, con su nota de RGPD — no la
  // llama nadie, porque el servidor nunca vuelve a guardar la imagen.
  //
  // O sea que la unica limpieza de metadatos del proyecto es implicita, y la
  // rompe un cambio que parece una mejora evidente: "si la imagen ya cabe, nos
  // ahorramos comprimirla". Eso es lo que vigila esta prueba.
  const precheck = leerCodigo('assets/js/precheck.js');
  const subir = leerCodigo('assets/js/paginas/subir.js');

  // 1. Se recodifica, y a JPEG: es el paso que tira el EXIF.
  assert.match(precheck, /toDataURL\('image\/jpeg'/,
    'ya no se recodifica en el lienzo: el EXIF de la captura llegaria entero a Firestore');

  // 2. Y se recodifica SIEMPRE. El primer ancho que se prueba esta acotado por
  //    arriba, nunca condicionado a que la imagen sobre: una captura pequeña
  //    tiene que pasar por el lienzo igual que una grande.
  assert.match(precheck, /Math\.min\(img\.naturalWidth, LIMITES_CLIENTE\.ANCHO_SUBIDA\)/,
    'el primer ancho ha dejado de ser incondicional: puede haber un camino que no recodifique');

  // 3. Lo que se sube es SIEMPRE el resultado del lienzo, nunca el fichero.
  assert.match(subir, /datos: preparada\.dataUrl/,
    'lo que se sube ya no sale del lienzo');

  // 4. Y no hay forma de leer los bytes originales para mandarlos. `readAsDataURL`
  //    sobre el fichero devolveria la imagen TAL CUAL, EXIF incluido, y es la
  //    manera mas natural de escribir esto mal.
  for (const pagina of ['assets/js/precheck.js', 'assets/js/paginas/subir.js']) {
    assert.doesNotMatch(leerCodigo(pagina), /readAsDataURL/,
      `${pagina} lee el fichero original: eso manda el EXIF sin tocar`);
  }
});

test('toda señal del antifraude recibe de verdad el dato que mira', () => {
  // LA FAMILIA DE #66. Una comprobacion puede estar llamada, probada y en verde
  // y aun asi no saltar NUNCA, porque el dato que mira le llega siempre igual.
  // Paso con `metadatos_edicion`, que vale 45 puntos: el navegador recodifica
  // la captura en un lienzo y el EXIF —donde se buscaban las firmas de
  // Photoshop— no llega jamas al worker.
  //
  // Esa variante no la pilla ningun `grep`: la funcion se llama, y la prueba
  // pasa porque le mete el valor a mano. Lo que si se puede comprobar es el
  // caso mas tonto y mas probable de todos — que el worker no le pase el
  // campo. Un `contexto.loQueSea` que nadie rellena llega como `undefined`, la
  // señal no salta nunca y no falla nada.
  const verificacion = leerCodigo('backend/src/verificacion.js');
  const worker = leerCodigo('backend/worker.js');

  // Lo que desestructura cada comprobacion es exactamente lo que mira.
  const mirados = new Set();
  for (const [, campos] of verificacion.matchAll(/function comprobar\w*\(\{([^}]*)\}/g)) {
    for (const campo of campos.split(',')) {
      const nombre = campo.split(/[:=]/)[0].trim();
      if (nombre) mirados.add(nombre);
    }
  }

  assert.ok(mirados.size >= 10, 'no se han encontrado las comprobaciones: ¿han cambiado de forma?');

  // El worker monta el contexto como un objeto, asi que cada campo tiene que
  // aparecer ahi como propiedad.
  const sinRellenar = [...mirados].filter((n) => !new RegExp(`\\b${n}\\s*[:,]`).test(worker));

  assert.deepStrictEqual(sinRellenar, [],
    'el antifraude mira estos campos y el worker no los pone en el contexto, '
    + `asi que su señal no puede saltar nunca: ${sinRellenar.join(', ')}`);
});

test('nadie puede reescribir su avatar para que lo pida el navegador de los demas', () => {
  // `avatarUrl` se publica TAL CUAL en los agregados de las clasificaciones
  // (`agregados.js` lo copia a `avatar`), asi que lo que apunte ahi lo pide el
  // navegador de cualquiera que abra un ranking. Estaba en la lista de campos
  // que el propio usuario puede actualizar, y sin ninguna validacion de formato
  // — el `color` de los clanes si la tiene.
  //
  // Con eso, cualquiera podia apuntarlo a un servidor suyo y quedarse con las
  // IP de todo el que mirase la clasificacion. En un proyecto que viene de #59
  // y #60 eso no puede quedarse abierto.
  //
  // Y no costaba nada cerrarlo: se escribe UNA vez, al crear el perfil, y
  // desde que se retiro la subida de avatar no hay una sola linea que lo
  // modifique.
  const usuarios = bloque('usuarios');
  const actualizaciones = usuarios.match(/allow update:[\s\S]*?;/g) || [];

  assert.ok(actualizaciones.length > 0, 'no se han encontrado las reglas de actualizacion');

  for (const regla of actualizaciones) {
    assert.doesNotMatch(regla, /'avatarUrl'/,
      'avatarUrl vuelve a ser escribible: eso lo publica el ranking a todo el mundo');
  }

  // Y sigue naciendo con el perfil, que es donde si tiene que estar.
  assert.match(usuarios, /allow create:[\s\S]*?'avatarUrl'/,
    'avatarUrl ya no se puede escribir al crear el perfil: nadie tendria avatar');

  // Si algun dia vuelve la subida de avatar, que vuelva con un patron, como el
  // color de los clanes. Esta comprobacion falla y obliga a pasar por aqui.
  const perfil = leerCodigo('assets/js/paginas/yo.js');
  assert.doesNotMatch(perfil, /updateDoc\([^)]*\{[^}]*avatarUrl/,
    'el perfil escribe avatarUrl pero la regla ya no lo permite: la subida fallaria');
});

test('el contador de cuota no tiene ninguna puerta sin vigilar', () => {
  // COMO SE LLEGO AQUI. `contar()` envuelve Firestore y suma lo que pasa, con
  // un `switch` sobre los metodos de entrada y un `default` que deja pasar todo
  // lo demas tal cual. `runTransaction` caia en ese `default`: una lectura y
  // una escritura por CADA viaje aprobado que el contador no veia.
  //
  // Ese `default` es lo correcto —envolver a ciegas lo que no se conoce seria
  // peor— pero significa que una puerta nueva no se nota. No falla nada: el
  // contador simplemente dice menos de lo que hay, y como `docs/COSTE.md`
  // modela lo que DEBERIA costar y esto mide lo que cuesta, la comparacion sale
  // mal sin que nadie lo sepa.
  //
  // Asi que aqui se mira al reves: por que puertas entra de verdad el backend a
  // Firestore, y estan todas atendidas.
  const cuota = leerCodigo('backend/src/cuota.js');

  // Metodos que no abren nada: no leen, no escriben y no devuelven referencias.
  const INOFENSIVOS = new Set([
    // `db.js` — el punto unico desde el que se coge Firestore. No es de
    // Firestore, es del proyecto.
    'usar',
  ]);

  const puertas = new Set();
  for (const rel of ['backend/worker.js', ...fs.readdirSync(path.join(__dirname, '..', 'src'))
    .filter((f) => f.endsWith('.js')).map((f) => `backend/src/${f}`)]) {
    for (const [, metodo] of leerCodigo(rel).matchAll(/\bdb\(\)?\.(\w+)\s*\(/g)) {
      if (!INOFENSIVOS.has(metodo)) puertas.add(metodo);
    }
  }

  assert.ok(puertas.size >= 4, `solo se han encontrado ${puertas.size} puertas: ¿ha cambiado la forma?`);

  const sinVigilar = [...puertas].filter((m) => !new RegExp(`case '${m}':`).test(cuota));

  assert.deepStrictEqual(sinVigilar, [],
    'el backend entra a Firestore por estos metodos y el contador de cuota no los '
    + `envuelve, asi que lo que pase por ahi no se cuenta: ${sinVigilar.join(', ')}`);
});

test('la cola de solicitudes de un clan tiene tope, como el resto de listas', () => {
  // Era la UNICA lista del esquema sin tope. La plantilla corta en 50, los
  // oficiales tienen que estar dentro de la plantilla, las rutas ancladas son
  // tres — y las solicitudes crecian sin freno.
  //
  // Importa mas de lo que parece porque el documento del clan lo lee CUALQUIERA
  // sin sesion (`allow read: if true`): cada solicitud pendiente se la descarga
  // todo el que abra ese clan. Y al final del camino un documento de Firestore
  // se planta en 1 MiB y deja de poder escribirse — el clan se quedaria
  // congelado, sin poder aceptar a nadie ni echar a nadie.
  const clanes = bloque('clanes');

  const propia = (clanes.match(/allow update:[\s\S]*?;/g) || [])
    .find((r) => /hasOnly\(\['solicitudes'\]\)/.test(r));

  assert.ok(propia, 'no se encuentra la regla de meter la solicitud propia');
  assert.match(propia, /solicitudes\.size\(\) <= (\d+)/,
    'cualquiera puede anadirse a la cola de un clan y nada la corta');

  // El tope tiene que dejar RETIRAR aunque este llena: quitar deja la lista mas
  // corta, asi que un `<=` cumple y un `<` no. La diferencia es que con `<`
  // quien entrase el ultimo no podria salir.
  assert.doesNotMatch(propia, /solicitudes\.size\(\) < \d/,
    'con `<` en vez de `<=`, quien entre el ultimo en una cola llena no puede retirarse');

  // Y el navegador avisa antes, para no dar un permission-denied pelado.
  const acciones = leerCodigo('assets/js/acciones.js');
  const tope = Number(propia.match(/solicitudes\.size\(\) <= (\d+)/)[1]);
  const enCliente = Number(acciones.match(/MAX_SOLICITUDES = (\d+)/)[1]);

  assert.strictEqual(enCliente, tope,
    `el navegador corta en ${enCliente} y las reglas en ${tope}`);
});

test('la lista de suscripciones push tiene tope, y el mapa `push` no admite lo que sea', () => {
  // POR QUE ESTE TOPE IMPORTA MAS QUE LOS OTROS. `push.enviar` recorre la lista
  // y hace UNA peticion al servicio de avisos por cada entrada. Sin limite, una
  // sola cuenta con la lista inflada convierte cada aviso en miles de
  // peticiones salientes: se come el tiempo de ejecucion del worker —que es de
  // GitHub Actions y esta contado— y ademas lo pone a aporrear servidores de
  // terceros en nombre del proyecto.
  //
  // Y era el unico `allow update` del fichero sin ninguna comprobacion de lo
  // que se escribe (`cambia().hasOnly(['push'])` y nada mas). `push` es un
  // mapa: cabia dentro cualquier cosa, hasta llenar el documento.
  const usuarios = bloque('usuarios');
  const regla = (usuarios.match(/allow update:[\s\S]*?;/g) || [])
    .find((r) => /hasOnly\(\['push'\]\)/.test(r));

  assert.ok(regla, 'no se encuentra la regla de avisos push');

  assert.match(regla, /push\.suscripciones\.size\(\) <= (\d+)/,
    'la lista de suscripciones no tiene tope: un aviso puede salir multiplicado');
  assert.match(regla, /push\.keys\(\)\.hasOnly\(/,
    'el mapa `push` admite cualquier clave, o sea cualquier cosa dentro del perfil');

  // Las claves permitidas tienen que cubrir lo que escribe el worker, o su
  // siguiente escritura dejaria el documento imposible de actualizar desde el
  // navegador.
  for (const clave of ['suscripciones', 'avisos', 'ultimoAvisoRacha']) {
    assert.match(regla, new RegExp(`'${clave}'`),
      `'${clave}' se escribe de verdad y la regla no lo admite`);
  }

  // Y el navegador avisa antes, con el mismo numero.
  const tope = Number(regla.match(/push\.suscripciones\.size\(\) <= (\d+)/)[1]);
  const enCliente = Number(
    leerCodigo('assets/js/acciones.js').match(/MAX_SUSCRIPCIONES_PUSH = (\d+)/)[1]);

  assert.strictEqual(enCliente, tope,
    `el navegador corta en ${enCliente} y las reglas en ${tope}`);
});

test('el registro de consentimiento tiene forma, no es un cajon', () => {
  // El RGPD exige poder demostrar QUE se acepto, CUANDO y sobre QUE version.
  // La regla decia `consentimiento is map` y nada mas, o sea que el interesado
  // podia escribir ahi dentro cualquier cosa de cualquier tamaño. En un campo
  // cualquiera eso ya sobra; en el que sirve de PRUEBA de un consentimiento,
  // un registro donde el interesado escribe lo que quiere vale poco.
  const usuarios = bloque('usuarios');

  assert.match(usuarios, /function consentimientoValido\(\)/,
    'el consentimiento vuelve a ser un mapa sin forma');
  assert.match(usuarios, /hasOnly\(\['terminos', 'privacidad'\]\)/);
  assert.match(usuarios, /hasOnly\(\['version', 'aceptadoEn'\]\)/);

  // Se exige al crear el perfil, que es cuando nace.
  const create = usuarios.match(/allow create:[\s\S]*?;/)[0];
  assert.match(create, /consentimientoValido\(\)/,
    'un perfil puede nacer con el consentimiento en cualquier forma');

  // Y al escribirlo despues. Pero SOLO al escribirlo: exigirlo en cada
  // actualizacion dejaria sin poder tocar sus preferencias a cualquier perfil
  // cuyo registro no tenga hoy exactamente esta forma.
  const cosmetico = (usuarios.match(/allow update:[\s\S]*?;/g) || [])
    .find((r) => /'avisosCorreo'/.test(r));

  assert.ok(cosmetico, 'no se encuentra la regla de preferencias');
  assert.match(cosmetico, /!\('consentimiento' in cambia\(\)\) \|\| consentimientoValido\(\)/,
    'o no se comprueba al escribirlo, o se exige siempre y deja fuera a los perfiles viejos');
});

test('ninguna lista o mapa que escriba el navegador se queda sin acotar', () => {
  // TRES VECES EL MISMO FALLO. `solicitudes` de un clan crecia sin freno en un
  // documento que lee cualquiera; `push` no tenia ni claves ni tamaño, y el
  // worker manda una peticion por cada entrada de su lista; `consentimiento`
  // era `is map` a secas, en el campo que sirve de prueba del RGPD.
  //
  // Los tres son la misma forma: un campo estructurado que escribe el
  // navegador y que nada corta. El final del camino siempre es el mismo — un
  // documento de Firestore se planta en 1 MiB y deja de poder escribirse — y
  // por el camino hay cosas peores, segun quien lea ese documento y que haga el
  // worker con lo que hay dentro.
  //
  // Asi que la regla del proyecto: un campo declarado `is list` o `is map` va
  // acompañado de un tope de tamaño o de una lista cerrada de claves.
  const reglas = leerCodigo('firestore.rules');

  // Se mira por bloques: el tope puede estar unas lineas mas abajo, pero
  // siempre dentro de la misma coleccion.
  const bloques = reglas.split(/(?=\n    match \/)/);
  const sueltos = [];

  for (const trozo of bloques) {
    const coleccion = (trozo.match(/match \/(\w+)\//) || [])[1];
    if (!coleccion) continue;

    // Sin escritura de usuario no hay nada que acotar.
    if (!/allow (create|update|write)/.test(trozo)) continue;

    const sinComentarios = trozo.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    for (const [, campo] of sinComentarios.matchAll(/(\w+(?:\.\w+)*)\s+is\s+(?:list|map)/g)) {
      const hoja = campo.split('.').pop();

      // El tope tiene que ser DEL MISMO CAMPO. Buscarlo "cerca" no vale: la
      // primera version de esta prueba miraba 200 caracteres a la redonda y
      // daba por acotado un campo nuevo porque el de al lado si lo estaba.
      const acotado = new RegExp(`\\b${hoja}\\s*\\.\\s*(size|keys)\\s*\\(`)
        .test(sinComentarios);

      if (!acotado) sueltos.push(`${coleccion}.${campo}`);
    }
  }

  assert.deepStrictEqual(sueltos, [],
    'estos campos los escribe el navegador y nada limita lo que cabe dentro: '
    + `${sueltos.join(', ')}. Un tope de tamaño, o una lista cerrada de claves.`);
});

test('todo lo que hace el trabajo diario esta en el modelo de coste', () => {
  // COMO SE LLEGO AQUI. `cerrarRachas` lee `usuarios` ENTERA una vez al dia, y
  // no estaba en `scripts/auditar-lecturas.js`. Su gemelo
  // `avisarRachasEnPeligro` —misma forma, misma frecuencia— si lo estaba, asi
  // que no fue que nadie conociera el patron: fue que la tabla se quedo atras.
  // Con ella se habian quedado fuera tambien el mantenimiento de clanes y el
  // cierre de temporada. 537 lecturas al dia que `--comprobar` no miraba.
  //
  // Duele justo aqui porque estas son las lecturas que crecen con las ALTAS DE
  // SIEMPRE, no con la gente que entra hoy: el coste sube solo por llevar
  // tiempo abierto, que es de lo que iba #34.
  //
  // Se vigila el trabajo diario y no cada funcion del backend a proposito. El
  // modelo habla de OPERACIONES, no de ayudantes: `cargarBase` lee dos
  // colecciones enteras y no tiene por que salir, porque quien la llama
  // (`metricas.resumir`, `reconstruirAgregados`) si esta. Lo que no puede
  // faltar es una tarea que se lanza sola todos los dias.
  const worker = leerCodigo('backend/worker.js');
  const auditoria = leerCodigo('scripts/auditar-lecturas.js');

  const cuerpo = worker.slice(worker.indexOf('async function trabajoDiario'));
  const diario = cuerpo.slice(0, cuerpo.indexOf('\n}\n'));

  // Lo que no es una tarea: la marca que evita repetir el dia.
  const MARCA = new Set(['ref.get', 'ref.set']);

  const tareas = [...new Set(
    [...diario.matchAll(/await ([\w.]+)\(/g)].map((m) => m[1]).filter((n) => !MARCA.has(n)),
  )];

  assert.ok(tareas.length >= 3, `solo se han encontrado ${tareas.length} tareas diarias`);

  // El modelo las nombra por la funcion, con o sin su modulo delante.
  const sinModelar = tareas.filter((t) => {
    const corta = t.split('.').pop();
    return !new RegExp(`\\b${corta}\\b`, 'i').test(auditoria);
  });

  assert.deepStrictEqual(sinModelar, [],
    'el trabajo diario lanza esto y el modelo de coste no lo conoce, asi que '
    + `\`--comprobar\` no lo mira: ${sinModelar.join(', ')}`);
});

test('las tablas de COSTE.md son las que sale del modelo, no una copia vieja', () => {
  // COMO SE LLEGO AQUI, y da algo de vergüenza. Las tres tablas de
  // `docs/COSTE.md` las genera `auditar-lecturas.js --markdown`, y se copiaban
  // A MANO. Al anadir operaciones al modelo se reemplazaron las dos primeras y
  // la tercera se pego DEBAJO de la anterior: el documento acabo con tres
  // tablas de escenarios y tres totales distintos, todos con pinta de ser el
  // bueno.
  //
  // Es la familia de "documentacion que se queda atras" del roadmap, pero en su
  // version peor: no es que el documento diga algo que ya no es verdad, es que
  // dice tres cosas a la vez.
  //
  // Ahora las tablas van entre marcas y las escribe `--escribir`. Esto
  // comprueba que nadie las haya tocado a mano por el camino.
  const { execFileSync } = require('node:child_process');

  const salida = execFileSync('node',
    [path.join(RAIZ, 'scripts', 'auditar-lecturas.js'), '--markdown'],
    { encoding: 'utf8' }).trim();

  const [pantallas, worker, escenarios] = salida.split('\n\n');

  // `leer` y no `leerCodigo`: el segundo quita los comentarios, y las marcas
  // que delimitan las tablas SON comentarios de HTML.
  const coste = leer('docs/COSTE.md');

  for (const [nombre, tabla] of Object.entries({ pantallas, worker, escenarios })) {
    const marcada = coste.match(
      new RegExp(`<!-- tabla:${nombre} -->\\n([\\s\\S]*?)\\n<!-- fin:${nombre} -->`));

    assert.ok(marcada, `docs/COSTE.md no tiene la marca <!-- tabla:${nombre} -->`);
    assert.strictEqual(marcada[1], tabla,
      `la tabla "${nombre}" de docs/COSTE.md no es la que sale del modelo. `
      + 'Se regenera con `node scripts/auditar-lecturas.js --escribir`.');
  }

  // Y una sola de cada, que el fallo original fue tener tres.
  for (const nombre of ['pantallas', 'worker', 'escenarios']) {
    const veces = (coste.match(new RegExp(`<!-- tabla:${nombre} -->`, 'g')) || []).length;
    assert.strictEqual(veces, 1, `hay ${veces} tablas "${nombre}" en docs/COSTE.md`);
  }
});

test('en modo degradado tampoco se poda: podar son escrituras', () => {
  // El modo degradado (#38) existe para que, por encima del 95% de la cuota, el
  // worker deje de hacer todo menos lo unico que la gente espera: verificar
  // viajes. Su propio comentario lo dice.
  //
  // `agregarSesiones` se quedaba fuera de esa puerta por considerarse "la
  // barata". Y lo es en LECTURAS —una consulta acotada a 450— pero poda el
  // detalle viejo, y podar son ESCRITURAS: hasta 450 por pasada, 288 pasadas al
  // dia. El techo son 129.600 borrados, seis veces la cuota entera de
  // escrituras.
  //
  // Importa porque en `sesiones_web` puede escribir cualquiera sin sesion
  // (#67): una inundacion pone al worker a gastarse el dia borrando basura
  // mientras los viajes de verdad se quedan en la cola. Y `cuota.nivel` mira
  // las dos cuotas y se queda con la que mas apriete, asi que ahi `degradado`
  // ya esta encendido — solo faltaba mirarlo.
  const worker = leerCodigo('backend/worker.js');

  const llamada = worker.indexOf('metricas.agregarSesiones()');
  assert.ok(llamada > 0, 'no se encuentra la llamada a agregarSesiones');

  // La guarda que la envuelve, mirando hacia atras hasta el `if` mas cercano.
  const antes = worker.slice(Math.max(0, llamada - 300), llamada);
  const guarda = antes.slice(antes.lastIndexOf('if ('));

  assert.match(guarda, /!degradado/,
    'se poda tambien en degradado, y podar son escrituras: es justo el recurso '
    + 'que aprieta cuando alguien inunda sesiones_web');
});

test('los nombres nuevos los revisa alguien, y llegan a la cola de moderacion', () => {
  // #64. `badwords` y `util.limpiarTexto` llevaban sin un solo llamante desde
  // que se borro `src/clanes.js`, asi que los nombres de piloto y de clan no
  // los miraba nada — y los dos salen en clasificaciones publicas.
  //
  // Las reglas no pueden hacerlo: no recorren una lista de 169 palabras, y para
  // los invisibles harian falta clases Unicode en `matches()` que sin emulador
  // no hay forma de comprobar. El navegador tampoco, que no es seguridad. Queda
  // el worker.
  const worker = leerCodigo('backend/worker.js');

  assert.match(worker, /require\('\.\/src\/nombres'\)/, 'el worker no revisa ningun nombre');

  // El de piloto, DENTRO del bucle de bienvenidas: es la unica vez que el
  // worker ve a esa persona, porque las reglas no dejan cambiar `username`
  // despues de crear el perfil. Y ahi el documento ya esta leido, o sea gratis.
  const bienvenidas = worker.slice(worker.indexOf('async function darBienvenidas'));
  assert.match(bienvenidas.slice(0, 1200), /revisarNombre\(/,
    'el nombre de piloto no se revisa donde ya se lee el perfil: o cuesta lecturas, o no se hace');

  // El de clan, en el trabajo diario y acotado por fecha.
  assert.match(worker, /async function revisarNombresDeClan/);
  assert.match(worker, /collection\('clanes'\)\.where\('creado', '>=', desde\)/,
    'la revision de nombres de clan lee la coleccion entera');

  // Y el id del reporte es determinista, que es lo que permite repetir sin
  // llenar la cola de copias del mismo caso.
  assert.match(worker, /nombre-clan-\$\{clanId\}/);
  assert.match(worker, /nombre-piloto-\$\{uid\}/);
});

test('el panel sabe resolver un reporte de nombre, que no tiene captura ni viaje', () => {
  // Un reporte de nombre no tiene captura que mirar ni viaje que quitar del
  // ranking. Pintarle "Eliminar viaje" seria un boton que no puede hacer nada,
  // y "Ver captura reportada" abriria un visor vacio.
  const admin = leerCodigo('assets/js/paginas/admin.js');

  assert.match(admin, /tipo === 'nombre'/, 'el panel trata igual los dos tipos de reporte');
  assert.match(admin, /esDeNombre \? null : el\('button'/,
    'el boton de ver captura se pinta tambien en los reportes de nombre');

  // Suspender si tiene que estar: es la unica accion que queda contra un nombre.
  assert.match(admin, /botonSuspender\(reporte\)/);
});

test('las dos listas de caracteres invisibles no divergen', () => {
  // Estan duplicadas porque el backend es CommonJS y el navegador es un modulo
  // ES, igual que las funciones de extraccion. Si se movieran de un lado y no
  // del otro, el navegador dejaria pasar una marca que el worker luego manda a
  // la cola: la persona no habria hecho nada raro y acabaria revisada a mano.
  const rangos = (codigo) => {
    const bloque = codigo.slice(codigo.indexOf('INVISIBLES = ['));
    return bloque.slice(0, bloque.indexOf('];'))
      .match(/0x[0-9a-f]{4}/g).join(',');
  };

  assert.strictEqual(
    rangos(leerCodigo('assets/js/acciones.js')),
    rangos(leerCodigo('backend/src/util.js')),
    'el navegador y el worker no quitan los mismos caracteres invisibles');
});
