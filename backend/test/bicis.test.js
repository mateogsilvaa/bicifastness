const { test } = require('node:test');
const assert = require('node:assert');
const bicis = require('../src/bicis');

const DIA = 86400000;
const AHORA = Date.UTC(2026, 8, 29, 12);
const hace = (dias) => AHORA - dias * DIA;

test('con menos de tres valoraciones no hay media, solo las sueltas', () => {
  const f = bicis.resumirBici([
    { nota: 4, creado: hace(3), estacion: '1', comentario: 'Todo bien' },
    { nota: 3, creado: hace(9), estacion: '2' },
  ], { ahora: AHORA });
  assert.strictEqual(f.media, null);
  assert.strictEqual(f.valoraciones60, 2);
  assert.strictEqual(f.ultimas.length, 2);
  assert.strictEqual(f.ultimas[0].comentario, 'Todo bien');
});

test('la media es de los ultimos 60 dias y cuenta el reparto y los fallos', () => {
  const f = bicis.resumirBici([
    { nota: 1, fallos: ['frenos'], creado: hace(1) },
    { nota: 2, fallos: ['frenos', 'asistencia'], creado: hace(2) },
    { nota: 4, fallos: [], creado: hace(5) },
    { nota: 5, creado: hace(70) }, // fuera de la ventana
  ], { ahora: AHORA });
  assert.strictEqual(f.media, 2.3);
  assert.strictEqual(f.valoraciones60, 3);
  assert.deepStrictEqual(f.reparto, { 1: 1, 2: 1, 3: 0, 4: 1, 5: 0 });
  assert.deepStrictEqual(f.fallos[0], { codigo: 'frenos', veces: 2 });
  assert.strictEqual(f.total, 4);
});

test('la ficha publica no lleva autor ni viaje', () => {
  const f = bicis.resumirBici([
    { nota: 3, uid: 'secreto', viajeId: 'v1', creado: hace(1), comentario: 'x' },
  ], { ahora: AHORA });
  const texto = JSON.stringify(f);
  assert.ok(!texto.includes('secreto'));
  assert.ok(!texto.includes('v1'));
});

test('un comentario con insultos no se publica, pero la nota si', () => {
  assert.strictEqual(bicis.limpiarComentario('esta bici es una mierda'), '');
  assert.strictEqual(bicis.limpiarComentario('  freno​   flojo '), 'freno flojo');
});

test('el numero de bici se normaliza como en las reglas', () => {
  assert.strictEqual(bicis.normalizarBici('02471'), '2471');
  assert.strictEqual(bicis.normalizarBici('0000'), null);
  assert.strictEqual(bicis.normalizarBici('123456'), null);
  assert.strictEqual(bicis.normalizarBici('12a'), null);
});

test('la tendencia compara con el mismo tramo de hace un mes', () => {
  const f = bicis.resumirBici([
    { nota: 2, creado: hace(1) }, { nota: 2, creado: hace(2) }, { nota: 3, creado: hace(3) },
    { nota: 4, creado: hace(40) }, { nota: 4, creado: hace(45) }, { nota: 3, creado: hace(50) },
  ], { ahora: AHORA });
  assert.strictEqual(f.tendencia.direccion, 'bajando');
});

// --- Averias que se arreglan y valoraciones sin viaje ---------------------------

test('un fallo se da por arreglado tras 3 valoraciones seguidas que no lo mencionan', () => {
  const ahora = Date.parse('2026-09-30T12:00:00Z');
  const dia = (d) => new Date(ahora - d * 864e5);
  const conFrenos = [
    { nota: 2, fallos: ['frenos'], creado: dia(10) },
    { nota: 4, fallos: [], creado: dia(3) },
    { nota: 4, fallos: [], creado: dia(2) },
  ];
  // Dos sin mencionarlo: sigue roto.
  let ficha = bicis.resumirBici(conFrenos, { ahora });
  assert.deepStrictEqual(ficha.fallos.map((f) => f.codigo), ['frenos']);
  assert.deepStrictEqual(ficha.resueltos, []);
  // La tercera sin mencionarlo: arreglado.
  ficha = bicis.resumirBici([...conFrenos, { nota: 5, fallos: [], creado: dia(1) }], { ahora });
  assert.deepStrictEqual(ficha.fallos, []);
  assert.deepStrictEqual(ficha.resueltos, ['frenos']);
});

test('una valoracion sin viaje cuya captura no demostraba la bici no cuenta', () => {
  const ahora = Date.parse('2026-09-30T12:00:00Z');
  const ficha = bicis.resumirBici([
    { nota: 1, fallos: ['frenos'], creado: new Date(ahora - 864e5), rechazada: true },
    { nota: 5, fallos: [], creado: new Date(ahora - 2 * 864e5) },
  ], { ahora });
  assert.strictEqual(ficha.total, 1);
  assert.deepStrictEqual(ficha.fallos, []);
});
