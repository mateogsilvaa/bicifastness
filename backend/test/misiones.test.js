'use strict';

/**
 * Misiones diarias y ruta del dia.
 *
 * Lo que mas importa probar aqui es el DETERMINISMO. El worker corre cada pocos
 * minutos: si las misiones cambiaran entre pasadas, alguien que llevara media
 * hecha a las 11:00 se encontraria otra a las 11:05.
 */

const test = require('node:test');
const assert = require('node:assert');

const misiones = require('../src/misiones');

// --- Determinismo ------------------------------------------------------------

test('el mismo dia genera siempre las mismas misiones', () => {
  const a = misiones.generar('2026-08-20');
  const b = misiones.generar('2026-08-20');

  assert.deepStrictEqual(a, b);
});

test('dias distintos generan misiones distintas', () => {
  // Si salieran siempre iguales, la mision diaria dejaria de ser diaria.
  const dias = ['2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24'];
  const textos = new Set(dias.map((d) => JSON.stringify(misiones.generar(d).misiones)));

  assert.ok(textos.size > 1, 'todos los dias salen las mismas misiones');
});

// --- Composicion -------------------------------------------------------------

test('siempre hay una de distancia y una de velocidad', () => {
  // Sin esto, un dia podrian salir tres de velocidad y el fondista se queda sin
  // poder completar ninguna.
  for (let d = 1; d <= 28; d++) {
    const fecha = `2026-08-${String(d).padStart(2, '0')}`;
    const tipos = misiones.generar(fecha).misiones.map((m) => m.tipo);

    assert.ok(tipos.includes('distancia'), `${fecha} no tiene mision de distancia`);
    assert.ok(tipos.includes('velocidad'), `${fecha} no tiene mision de velocidad`);
    assert.strictEqual(tipos.length, 3);
  }
});

test('los objetivos son alcanzables en un dia normal', () => {
  // Una mision que no se puede completar en un trayecto normal no invita a
  // salir: invita a ignorarla.
  for (let d = 1; d <= 28; d++) {
    const { misiones: lista } = misiones.generar(`2026-08-${String(d).padStart(2, '0')}`);

    for (const m of lista) {
      if (m.tipo === 'distancia') assert.ok(m.objetivo <= 6000, `${m.objetivo} m es mucho`);
      if (m.tipo === 'velocidad') {
        // Por encima de 21 km/h el propio antifraude lo marca como sospechoso:
        // seria pedir que hagan algo que luego se revisa a mano.
        assert.ok(m.objetivo <= 16, `${m.objetivo} km/h roza el limite del antifraude`);
      }
      if (m.tipo === 'trayectos') assert.ok(m.objetivo <= 3, 'mas que el cupo diario');
    }
  }
});

test('cada mision explica que hay que hacer', () => {
  for (const m of misiones.generar('2026-08-20').misiones) {
    assert.ok(m.texto && m.texto.length > 8, 'falta el texto');
    assert.ok(m.ayuda && m.ayuda.length > 8, 'falta la aclaracion');
    assert.ok(m.objetivo > 0);
  }
});

// --- Progreso ----------------------------------------------------------------

const viaje = (metros, kmh, ruta = '001-002') => ({
  distanciaMetros: metros, velocidadKmh: kmh, ruta,
});

test('la distancia suma todos los trayectos del dia', () => {
  const lista = [{ tipo: 'distancia', objetivo: 5000 }];
  const p = misiones.progreso(lista, [viaje(2000, 12), viaje(3500, 14)]);

  assert.strictEqual(p[0].hecho, 5500);
  assert.strictEqual(p[0].completada, true);
});

test('la velocidad se cumple con el mejor trayecto, no con la media', () => {
  // Pedir la media castigaria salir tambien un dia tranquilo.
  const lista = [{ tipo: 'velocidad', objetivo: 15 }];
  const p = misiones.progreso(lista, [viaje(2000, 8), viaje(1000, 17)]);

  assert.strictEqual(p[0].hecho, 17);
  assert.strictEqual(p[0].completada, true);
});

test('la exploracion solo cuenta estaciones nuevas', () => {
  const lista = [{ tipo: 'exploracion', objetivo: 1 }];

  const yaConocida = misiones.progreso(lista, [viaje(2000, 12, '001-002')], new Set(['002']));
  assert.strictEqual(yaConocida[0].completada, false);

  const nueva = misiones.progreso(lista, [viaje(2000, 12, '001-999')], new Set(['002']));
  assert.strictEqual(nueva[0].completada, true);
});

test('sin viajes no hay progreso, pero tampoco error', () => {
  const p = misiones.progreso(misiones.generar('2026-08-20').misiones, []);

  for (const m of p) {
    assert.strictEqual(m.hecho, 0);
    assert.strictEqual(m.completada, false);
  }
});

// --- Ruta del dia ------------------------------------------------------------

test('no se elige un tramo sin actividad', () => {
  // El multiplicador x2 sobre un tramo que nadie hace es regalar puntos al
  // primero que pase, y ademas deja la ruta del dia desierta.
  const rutas = new Map([['001-002', 1], ['003-004', 2]]);
  assert.strictEqual(misiones.rutaDelDia(rutas, [], '2026-08-20'), null);
});

test('el mismo dia elige siempre la misma ruta', () => {
  const rutas = new Map([['001-002', 10], ['003-004', 8], ['005-006', 5]]);

  assert.strictEqual(
    misiones.rutaDelDia(rutas, [], '2026-08-20'),
    misiones.rutaDelDia(rutas, [], '2026-08-20'));
});

test('no se repite una ruta reciente', () => {
  const rutas = new Map([['001-002', 10], ['003-004', 8]]);
  const elegida = misiones.rutaDelDia(rutas, ['001-002'], '2026-08-20');

  assert.strictEqual(elegida, '003-004');
});

test('si todas son recientes, se repite antes que quedarse sin ruta', () => {
  const rutas = new Map([['001-002', 10]]);
  const elegida = misiones.rutaDelDia(rutas, ['001-002'], '2026-08-20');

  assert.strictEqual(elegida, '001-002', 'mejor repetir que no tener ruta del dia');
});
