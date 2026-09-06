'use strict';

/**
 * Recogida de errores del cliente.
 *
 * Se prueba sobre el CODIGO, no ejecutandolo: son modulos de navegador y aqui
 * no hay DOM. Lo que se vigila son las tres cosas que salen caras si se rompen:
 * que no se filtren datos personales, que un bucle de errores no se coma la
 * cuota, y que el CSV no ejecute formulas al abrirlo.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const RECOGIDA = leer('assets/js/errores.js');
const PANEL = leer('assets/js/paginas/admin-errores.js');
const REGLAS = leer('firestore.rules');

// --- Privacidad --------------------------------------------------------------

test('no se guarda nada que identifique a la persona', () => {
  // La coleccion existe para arreglar fallos, no para saber quien los sufre.
  const bloque = RECOGIDA.slice(RECOGIDA.indexOf('setDoc('), RECOGIDA.indexOf('{ merge: true }'));

  for (const prohibido of ['uid', 'email', 'correo', 'username', 'currentUser']) {
    assert.ok(!bloque.includes(prohibido),
      `el registro de errores incluye "${prohibido}"`);
  }

  // `conSesion` es un booleano, que dice si habia cuenta sin decir cual.
  assert.match(bloque, /conSesion: Boolean\(/);
});

test('la pila se normaliza antes de guardarse', () => {
  // Sin normalizar, la traza lleva el origen completo, y ademas el mismo fallo
  // en dos navegadores genera huellas distintas y no se agrupa nunca.
  const normalizar = RECOGIDA.slice(
    RECOGIDA.indexOf('function normalizarPila'),
    RECOGIDA.indexOf('function huella'));

  assert.ok(normalizar.includes('https?:'), 'no se quita el origen de la traza');
  assert.ok(normalizar.includes('slice(0, 6)'), 'se guardaria la traza entera');

  // Y lo que acaba en el documento es la version normalizada, no la original.
  assert.match(RECOGIDA, /pila: normalizarPila\(pila\)/);
});

// --- Cuota -------------------------------------------------------------------

test('un bucle de errores no se come la cuota', () => {
  // Es la coleccion que escribe gente SIN sesion: sin tope, un bucle de render
  // que lance 500 errores iguales son 500 escrituras.
  assert.match(RECOGIDA, /if \(vistas\.has\(id\)\) return;/,
    'la misma huella se escribiria mas de una vez por sesion');
  assert.match(RECOGIDA, /if \(vistas\.size >= MAX_POR_SESION\) return;/,
    'no hay tope de huellas distintas por sesion');
});

test('registrar nunca lanza', () => {
  // Si registrar un error fallara y eso disparara otro registro, el bucle se
  // lleva la cuota del dia por delante.
  const cuerpo = RECOGIDA.slice(RECOGIDA.indexOf('export async function registrar'));
  assert.match(cuerpo.slice(0, 1400), /try \{[\s\S]*\} catch \{/);
});

// --- Reglas ------------------------------------------------------------------

test('la coleccion de errores esta acotada', () => {
  const inicio = REGLAS.indexOf('match /errores_cliente/');
  const bloque = REGLAS.slice(inicio, REGLAS.indexOf('match /', inicio + 10));

  // Solo la administracion los lee: llevan rutas y trazas de la app.
  assert.match(bloque, /allow read: if esAdmin\(\)/);

  // El id tiene que ser una huella, no cualquier cosa.
  assert.match(bloque, /huella\.matches\('\^e\[a-z0-9\]\{1,12\}\$'\)/);

  // Campos y tamaños acotados: cada documento tiene que ser pequeño.
  assert.match(bloque, /hasOnly\(\[/);
  assert.match(bloque, /mensaje\.size\(\) <= 300/);
  assert.match(bloque, /pila\.size\(\) <= 1000/);
});

// --- CSV ---------------------------------------------------------------------

test('el CSV no ejecuta formulas al abrirlo', () => {
  // Un mensaje de error que empiece por `=`, `+`, `-` o `@` lo interpreta Excel
  // como formula. El mensaje viene de una excepcion, o sea texto que puede
  // controlar un tercero.
  assert.match(PANEL, /\[=\+\\-@/, 'no se escapan los caracteres que abren formula');
  assert.match(PANEL, /texto = `'\$\{texto\}`/, 'no se antepone el apostrofo');
});

test('el CSV lo abre Excel en espanol sin romperse', () => {
  // Separador `;` y BOM UTF-8. Con `,` y sin BOM, Excel en español mete todo en
  // una columna y parte los acentos.
  assert.match(PANEL, /join\(';'\)/, 'el separador no es punto y coma');
  assert.match(PANEL, /\\uFEFF|﻿/, 'falta el BOM UTF-8');
});

test('el panel no construye interfaz con innerHTML', () => {
  // Aqui se pinta el mensaje de una excepcion, que es texto de un tercero. El
  // XSS de la v1 fue exactamente esto, y ademas en el panel de administracion.
  assert.ok(!/\.innerHTML\s*\+?=/.test(PANEL));
});
