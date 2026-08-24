'use strict';

/**
 * PWA instalable y pantalla offline (#52).
 *
 * Dos motivos concretos por los que esto no es decoracion:
 *
 *   1. En iOS NO hay avisos push si la web no esta anadida a la pantalla de
 *      inicio. Sin instalacion, la mitad de los usuarios se queda sin el aviso
 *      de racha en peligro (#33).
 *   2. La unica pagina pensada para cuando no hay red no puede depender de la
 *      red para pintarse. Es facil romperlo sin darse cuenta.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const leerCodigo = (rel) => leer(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  .replace(/<!--[\s\S]*?-->/g, '');

const manifiesto = () => JSON.parse(leer('manifest.webmanifest'));

// --- El manifiesto ----------------------------------------------------------

test('el manifiesto declara lo que hace falta para instalar', () => {
  const m = manifiesto();

  assert.ok(m.name && m.short_name);
  assert.strictEqual(m.display, 'standalone', 'sin esto se abre como una pestana mas');
  assert.ok(m.start_url, 'sin start_url el icono no sabe adonde ir');
  assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);

  const tamanos = m.icons.map((i) => i.sizes);
  for (const necesario of ['192x192', '512x512']) {
    assert.ok(tamanos.includes(necesario), `falta el icono de ${necesario}`);
  }

  // Android recorta el icono a la forma que tenga el sistema. Sin un maskable,
  // recorta el normal y se come el logo.
  assert.ok(m.icons.filter((i) => i.purpose === 'maskable').length >= 2,
    'falta el icono maskable en 192 y 512');
});

test('todos los iconos y destinos del manifiesto existen', () => {
  const m = manifiesto();

  const iconos = [
    ...m.icons.map((i) => i.src),
    ...(m.shortcuts || []).flatMap((a) => (a.icons || []).map((i) => i.src)),
  ];
  for (const ruta of iconos) {
    assert.ok(fs.existsSync(path.join(RAIZ, ruta)),
      `${ruta} no existe: el navegador descarta el manifiesto entero`);
  }

  // Un atajo a una ruta que ya no existe es un icono en la pantalla de inicio
  // que lleva a un 404. Aqui se colo la reestructuracion de rutas: /ranking/ y
  // /home/ ya no existen.
  for (const destino of [m.start_url, ...(m.shortcuts || []).map((a) => a.url)]) {
    const pagina = path.join(RAIZ, destino.split('?')[0], 'index.html');
    assert.ok(fs.existsSync(pagina), `el manifiesto apunta a ${destino}, que no existe`);
  }
});

test('las paginas de la app enlazan el manifiesto, y la de obras no', () => {
  for (const pagina of ['index.html', 'subir/index.html', 'clasificacion/index.html']) {
    assert.match(leer(pagina), /rel="manifest"/, `${pagina} no es instalable`);
  }
  // La pagina de obras no debe depender de nada del sitio.
  assert.ok(!/rel="manifest"/.test(leer('mantenimiento/index.html')));
});

// --- La pantalla offline ------------------------------------------------------

test('la pantalla offline no depende de la red para pintarse', () => {
  const html = leer('offline/index.html');

  assert.ok(!/https?:\/\//.test(html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')),
    'la pantalla offline referencia un origen remoto');
  assert.ok(!/<img[^>]+src="https?:/.test(html), 'la pantalla offline pide una imagen remota');

  // Y sobre todo: no puede llamar a `iniciarPagina()`, que monta navegacion,
  // pie y metricas, y arrastra Firebase entero. Es lo primero que se cuela al
  // copiar otra pagina como plantilla.
  const modulo = leerCodigo('assets/js/paginas/offline.js');
  assert.ok(!/iniciarPagina\(/.test(modulo),
    'la pagina offline arrancaria Firebase para pintarse');
});

test('el service worker sirve algo util sin red, y sigue sin cachear lo autenticado', () => {
  const sw = leerCodigo('sw.js');

  assert.match(sw, /mode === 'navigate'/, 'sin esto, sin red sale el error del navegador');
  assert.ok(sw.includes("'/offline/'"), 'la pagina offline tiene que estar precacheada');

  // La vulnerabilidad 11 de la v1: cachear respuestas con datos de sesion en
  // una cache compartida del origen.
  assert.match(sw, /peticion\.credentials === 'include'/);
  assert.match(sw, /url\.origin !== self\.location\.origin/);
  assert.match(sw, /peticion\.method !== 'GET'/);
  assert.match(sw, /SIN_CACHEAR/, 'la administracion no debe quedar cacheada');

  // El motor del OCR son casi seis megas y su cache la lleva Cache-Control.
  assert.match(sw, /assets\/ocr\//, 'el OCR volveria a bajarse por detras en cada subida');
});

test('lo que precachea el service worker existe', () => {
  const sw = leer('sw.js');
  const bloque = sw.slice(sw.indexOf('const ESTATICOS'), sw.indexOf('];', sw.indexOf('const ESTATICOS')));

  for (const [, ruta] of bloque.matchAll(/'(\/[^']*)'/g)) {
    const destino = ruta.endsWith('/') ? path.join(RAIZ, ruta, 'index.html') : path.join(RAIZ, ruta);
    assert.ok(fs.existsSync(destino), `el service worker precachea ${ruta}, que no existe`);
  }
});

// --- Cuando se pide instalar ------------------------------------------------------

test('la invitacion a instalar no aparece nada mas entrar', () => {
  // Pedirlo de entrada, antes de que la persona sepa para que sirve la app, es
  // como se pierde el permiso para siempre: el navegador recuerda el rechazo.
  const instalar = leerCodigo('assets/js/instalar.js');
  const cuerpo = instalar.slice(instalar.indexOf('export function ofrecerInstalacion'));

  assert.match(cuerpo, /CLAVE_VIAJE_SUBIDO/, 'la invitacion no espera al primer viaje');
  assert.match(cuerpo, /estaInstalada\(\)/, 'se ofreceria instalar una app ya instalada');
  assert.match(cuerpo, /CLAVE_RECHAZO/, 'no se recuerda que ya dijo que no');

  // Y la marca se pone al subir, no al cargar la pagina.
  assert.match(leerCodigo('assets/js/paginas/subir.js'), /marcarPrimerViaje\(\)/);
});

test('nada de la PWA escribe en localStorage sin red de seguridad', () => {
  // En modo privado de Safari, `localStorage` LANZA al escribir. Sin try/catch
  // eso tumba el modulo entero, y con el se lleva por delante el registro del
  // service worker, que es lo que hace que la app funcione sin red.
  const instalar = leerCodigo('assets/js/instalar.js');
  const accesos = instalar.match(/localStorage\.\w+\(/g) || [];
  assert.ok(accesos.length > 0, 'el test ya no mira lo que cree mirar');

  for (const trozo of instalar.split('function').slice(1)) {
    if (!/localStorage\./.test(trozo)) continue;
    assert.match(trozo, /catch/, `una funcion usa localStorage sin try/catch: ${trozo.slice(0, 60)}`);
  }
});
