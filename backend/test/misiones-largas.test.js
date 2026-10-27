'use strict';

/**
 * Misiones de la semana y del mes: deterministas, variadas (una familia no se
 * repite hasta que han salido las demas) y con el progreso bien acumulado.
 */

const test = require('node:test');
const assert = require('node:assert');

const largas = require('../src/misiones-largas');

const lunes = (n) => new Date(Date.UTC(2026, 0, 5 + 7 * n)).toISOString().slice(0, 10);

test('el mismo periodo genera siempre lo mismo', () => {
  assert.deepStrictEqual(largas.generar('semana', '2026-10-26'), largas.generar('semana', '2026-10-26'));
  assert.deepStrictEqual(largas.generar('mes', '2026-10'), largas.generar('mes', '2026-10'));
});

test('cada periodo trae sus tres, sin familias repetidas dentro', () => {
  for (let n = 0; n < 60; n++) {
    const { misiones } = largas.generar('semana', lunes(n));
    assert.strictEqual(misiones.length, largas.POR_PERIODO.semana);
    assert.strictEqual(new Set(misiones.map((m) => m.tipo)).size, misiones.length);
    for (const m of misiones) assert.ok(m.objetivo > 0 && m.puntos > 0 && m.texto.includes('semana'));
  }
});

test('una familia no vuelve hasta que han salido todas las demas del ciclo', () => {
  const familias = Object.keys(largas.FAMILIAS).length;
  const porCiclo = Math.floor(familias / largas.POR_PERIODO.semana);
  // Las semanas de un ciclo completo empiezan donde el indice es multiplo.
  let inicio = 0;
  while (largas.indiceDe('semana', lunes(inicio)) % porCiclo !== 0) inicio++;
  const vistas = [];
  for (let n = inicio; n < inicio + porCiclo; n++) vistas.push(...largas.generar('semana', lunes(n)).misiones.map((m) => m.tipo));
  assert.strictEqual(new Set(vistas).size, vistas.length, 'una familia se ha repetido dentro del ciclo');
});

test('en un año salen casi todas las familias, con objetivos distintos', () => {
  const tipos = new Set();
  const textos = new Set();
  for (let n = 0; n < 52; n++) {
    for (const m of largas.generar('semana', lunes(n)).misiones) { tipos.add(m.tipo); textos.add(m.texto); }
  }
  assert.ok(tipos.size >= Object.keys(largas.FAMILIAS).length - 1);
  assert.ok(textos.size > 30);
});

test('periodos: lunes, mes y dias que quedan', () => {
  assert.strictEqual(largas.periodoDe('semana', '2026-11-01'), '2026-10-26'); // domingo
  assert.strictEqual(largas.periodoDe('semana', '2026-10-26'), '2026-10-26');
  assert.strictEqual(largas.periodoDe('mes', '2026-10-31'), '2026-10');
  assert.strictEqual(largas.diasQuedan('semana', '2026-10-26'), 7);
  assert.strictEqual(largas.diasQuedan('semana', '2026-11-01'), 1);
  assert.strictEqual(largas.diasQuedan('mes', '2026-10-31'), 1);
});

test('acumula el periodo y empieza de cero al cambiar', () => {
  const viaje = { distanciaMetros: 3200, velocidadKmh: 16, tiempoSegundos: 720, ruta: '12-40', horaSalida: '08:10', dia: '2026-10-31' };
  let t = largas.acumular(null, '2026-10-26', viaje, { esEstacionNueva: true, esRecord: true, racha: 4, diarias: 2 });
  t = largas.acumular(t, '2026-10-26', { ...viaje, ruta: '40-12', horaSalida: '21:00', dia: '2026-11-01' }, { racha: 5 });
  assert.strictEqual(t.metros, 6400);
  assert.strictEqual(t.trayectos, 2);
  assert.strictEqual(t.rapidos, 2);
  assert.strictEqual(t.largos, 2);
  assert.strictEqual(t.temprano, 1);
  assert.strictEqual(t.tarde, 1);
  assert.strictEqual(t.finde, 2); // sabado y domingo
  assert.strictEqual(t.records, 1);
  assert.strictEqual(t.nuevas, 1);
  assert.strictEqual(t.diarias, 2);
  assert.strictEqual(t.mejorRacha, 5);
  assert.deepStrictEqual(t.estaciones.sort(), ['12', '40']);
  assert.strictEqual(t.rutas.length, 2);
  assert.strictEqual(t.dias.length, 2);
  const otra = largas.acumular(t, '2026-11-02', viaje, {});
  assert.strictEqual(otra.trayectos, 1);
});

test('aplicarViaje cobra cada mision una sola vez y no cuenta periodos cerrados', () => {
  const dia = '2026-10-28';
  const { misiones } = largas.generar('semana', largas.periodoDe('semana', dia));
  // Un viaje enorme que lo completa casi todo.
  const enorme = { distanciaMetros: 9000, velocidadKmh: 24, tiempoSegundos: 9000, ruta: '1-2', horaSalida: '07:00' };
  const ctx = { esEstacionNueva: true, esRecord: true, esRutaSemana: true, racha: 30, diarias: 40 };
  const primera = largas.aplicarViaje({}, dia, enorme, ctx, dia);
  assert.ok(primera.campos.misionesSemana && primera.campos.misionesMes);
  assert.ok(primera.extra >= 0);
  const segunda = largas.aplicarViaje(primera.campos, dia, enorme, ctx, dia);
  const yaHechas = primera.campos.misionesSemana.progreso.filter((p) => p.completada).length;
  const ahora = segunda.campos.misionesSemana.progreso.filter((p) => p.completada).length;
  assert.ok(ahora >= yaHechas);
  assert.strictEqual(misiones.length, primera.campos.misionesSemana.progreso.length);
  // Un viaje de la semana pasada, subido hoy: ni semana ni (si es otro mes) mes.
  const tarde = largas.aplicarViaje({}, '2026-09-30', enorme, ctx, dia);
  assert.deepStrictEqual(tarde.campos, {});
  assert.strictEqual(tarde.extra, 0);
});
