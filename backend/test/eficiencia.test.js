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
