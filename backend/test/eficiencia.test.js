'use strict';

/**
 * Lo que se quito de la carga de cada pagina (nov 2026) no puede volver solo.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const { grafoDeModulos, cssLigero } = require(path.join(RAIZ, 'scripts', 'construir-sitio.js'));

test('la portada no carga la verificacion en dos pasos ni el generador de QR', () => {
  const { propios } = grafoDeModulos(RAIZ, ['/assets/js/paginas/portada.js']);
  for (const pesado of ['/assets/js/dos-pasos.js', '/assets/vendor/qrcode/qrcode.js']) {
    assert.ok(!propios.includes(pesado), `${pesado} vuelve a ir en la carga de la portada`);
  }
});

test('en /yo/ el QR solo se pide al activar la verificacion en dos pasos', () => {
  const { propios } = grafoDeModulos(RAIZ, ['/assets/js/paginas/yo.js']);
  assert.ok(!propios.includes('/assets/vendor/qrcode/qrcode.js'));
});

test('el CSS publicado pierde los comentarios, no lo que va entre comillas', () => {
  assert.strictEqual(
    cssLigero('a { content: "/* no */"; } /* si */\n\n  b { x: 1 }  \n'),
    'a { content: "/* no */"; }\nb { x: 1 }\n',
  );
  assert.strictEqual(cssLigero("i::before { content: '\\'/*'; }"), "i::before { content: '\\'/*'; }");
});

test('el JS se minifica al publicar sin empaquetar: cada modulo en su URL', () => {
  const fuente = require('node:fs').readFileSync(path.join(RAIZ, 'scripts', 'construir-sitio.js'), 'utf8');
  const cuerpo = fuente.slice(fuente.indexOf('function minificarJs'));
  assert.match(fuente, /aligerarCss\(destino\);\s*minificarJs\(destino\);/, 'ya no se minifica al construir');
  assert.ok(!/bundle:\s*true/.test(cuerpo), 'empaquetar cambiaria las URLs de los modulos');
  assert.ok(!/format:/.test(cuerpo), 'con format, esbuild renombra lo de nivel superior');
  // Y el despliegue instala esbuild antes de montar la web.
  const ci = require('node:fs').readFileSync(path.join(RAIZ, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(ci.indexOf('npm ci') > -1 && ci.indexOf('npm ci') < ci.indexOf('node scripts/construir-sitio.js'));
});
