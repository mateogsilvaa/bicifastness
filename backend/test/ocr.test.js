'use strict';

/**
 * Parseo de lo que devuelve el OCR.
 *
 * Se prueba el PARSEO, no el reconocimiento: pasar tesseract por cada test lo
 * haria lento y dependeria de los datos de idioma. Que el OCR acierte sobre
 * capturas reales es otra cosa, y depende del banco del issue #16.
 *
 * Estas funciones son la parte que puede fallar en silencio: si el parseo
 * confunde una hora con una duracion, el motor de decision compara numeros que
 * no son y empieza a rechazar viajes buenos.
 */

const test = require('node:test');
const assert = require('node:assert');

const ocr = require('../src/ocr');

const CAPTURA = `BiciMAD
Trayecto finalizado
002 - Metro Callao (002)
110 - Intercambiador de Moncloa (110)
Salida  18:42
Llegada 18:54
Duracion 12 min 15 s`;

test('lee las dos horas en orden', () => {
  assert.deepStrictEqual(ocr.extraerHoras(CAPTURA), ['18:42', '18:54']);
});

test('descarta lo que no puede ser una hora', () => {
  assert.deepStrictEqual(ocr.extraerHoras('25:00 y 12:99 y 09:30'), ['09:30']);
});

test('no repite una hora que aparece dos veces', () => {
  assert.deepStrictEqual(ocr.extraerHoras('18:42 ... 18:42 ... 19:00'), ['18:42', '19:00']);
});

test('lee las estaciones del formato de la app', () => {
  assert.deepStrictEqual(ocr.extraerEstaciones(CAPTURA), ['002', '110']);
});

test('si no hay parentesis, cae al numero al principio de linea', () => {
  assert.deepStrictEqual(ocr.extraerEstaciones('2 - Metro Callao\n110 - Moncloa'), ['2', '110']);
});

test('la duracion se lee con unidades y con mm:ss etiquetado', () => {
  assert.strictEqual(ocr.extraerDuracion(CAPTURA), 735);
  assert.strictEqual(ocr.extraerDuracion('Duración 12:15'), 735);
  assert.strictEqual(ocr.extraerDuracion('8 min'), 480);
});

test('una hora suelta NO se toma por una duracion', () => {
  // Es el error que mas dano haria: el motor compararia 18 min con el tiempo
  // declarado y rechazaria viajes correctos.
  assert.strictEqual(ocr.extraerDuracion('Salida 18:42'), null);
  assert.strictEqual(ocr.extraerDuracion('Llegada 09:05'), null);
});

test('sin duracion legible devuelve null, no un cero', () => {
  // Un 0 se colaria como duracion valida; null hace que el motor lo mande a
  // revision, que es lo correcto cuando no se sabe.
  assert.strictEqual(ocr.extraerDuracion('nada que ver aqui'), null);
});

test('los marcadores de BiciMAD estan en minusculas', () => {
  // El texto se compara en minusculas antes de buscarlos: un marcador con
  // mayusculas no coincidiria nunca y `esBicimad` seria siempre false.
  for (const marcador of ocr.MARCADORES) {
    assert.strictEqual(marcador, marcador.toLowerCase(), `"${marcador}" lleva mayusculas`);
  }
});

test('leerCaptura nunca lanza, aunque le des basura', async () => {
  // El pipeline entero depende de esto: si el OCR revienta, el viaje tiene que
  // ir a revision humana, no tumbar la pasada del worker.
  const resultado = await ocr.leerCaptura({ buffer: Buffer.from('esto no es una imagen') });
  assert.strictEqual(resultado.disponible, false);
  assert.ok(resultado.error, 'debe explicar por que no ha podido leer');
});
