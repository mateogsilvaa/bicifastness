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

test('cada dia hay una de fondo, una de ritmo y una de constancia o explorar', () => {
  // Sin esto, un dia podrian salir tres de velocidad y el fondista se queda sin
  // poder completar ninguna. Cada hueco rota entre sus familias (HUECOS).
  const vistas = new Set();
  for (let d = 0; d < 90; d++) {
    const fecha = new Date(Date.UTC(2026, 7, 1 + d, 12)).toISOString().slice(0, 10);
    const tipos = misiones.generar(fecha).misiones.map((m) => m.tipo);
    tipos.forEach((t) => vistas.add(t));

    assert.strictEqual(tipos.length, 3);
    assert.ok(['distancia', 'minutos', 'estaciones'].includes(tipos[0]), `${fecha}: el primer hueco es de volumen`);
    assert.ok(['velocidad', 'largo'].includes(tipos[1]), `${fecha}: el segundo es de ritmo`);
    assert.ok(['trayectos', 'exploracion', 'temprano', 'tarde'].includes(tipos[2]), `${fecha}: el tercero, de habito`);
  }
  // En tres meses salen todas las familias.
  assert.deepStrictEqual([...vistas].sort(), Object.keys(misiones.FAMILIAS).sort());
});

test('las misiones de hora cuentan la hora de salida de la captura', () => {
  let t = misiones.acumular(null, '2026-10-05', { ruta: '124-115', horaSalida: '08:40' });
  t = misiones.acumular(t, '2026-10-05', { ruta: '115-002', horaSalida: '21:05' });
  t = misiones.acumular(t, '2026-10-05', { ruta: '002-124', horaSalida: null });
  const [temprano, tarde, estaciones] = misiones.progresoDeTotales(
    [{ tipo: 'temprano', objetivo: 1 }, { tipo: 'tarde', objetivo: 1 }, { tipo: 'estaciones', objetivo: 3 }], t,
  );
  assert.ok(temprano.completada);
  assert.ok(tarde.completada);
  assert.strictEqual(estaciones.hecho, 3, 'tres estaciones distintas, sin repetir');
  assert.ok(estaciones.completada);
});

test('cuantas misiones completa un viaje, para las insignias', () => {
  const antes = [{ completada: true }, { completada: false }, { completada: false }];
  const despues = [{ completada: true }, { completada: true }, { completada: true }];
  assert.strictEqual(misiones.cuantasCompletadas(antes, despues), 2);
  assert.strictEqual(misiones.cuantasCompletadas(null, despues), 3);
});

test('trayecto largo y minutos se llevan con los totales del dia', () => {
  let t = misiones.acumular(null, '2026-09-30', { distanciaMetros: 2000, velocidadKmh: 12, tiempoSegundos: 600 });
  t = misiones.acumular(t, '2026-09-30', { distanciaMetros: 3200, velocidadKmh: 14, tiempoSegundos: 900 });
  const [largo, minutos] = misiones.progresoDeTotales(
    [{ tipo: 'largo', objetivo: 3000 }, { tipo: 'minutos', objetivo: 1500 }], t,
  );
  assert.strictEqual(largo.hecho, 3200);
  assert.ok(largo.completada, 'el trayecto de 3,2 km cumple el de 3 km');
  assert.strictEqual(minutos.hecho, 1500);
  assert.ok(minutos.completada, '10 + 15 minutos cumplen los 25');
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

test('el progreso acumulado da lo mismo que recorrer los viajes', () => {
  // El worker acumula en el perfil en vez de consultar los viajes de hoy cada
  // vez que aprueba uno. Las dos formas tienen que coincidir, o el progreso que
  // ve la gente dependeria de por donde se calculo.
  const { misiones: delDia } = misiones.generar('2026-09-14');
  const previas = new Set(['110']);

  const viajes = [
    { ruta: '002-110', distanciaMetros: 2400, velocidadKmh: 17.5 },
    { ruta: '045-118', distanciaMetros: 3100, velocidadKmh: 21.2 },
    { ruta: '118-207', distanciaMetros: 1800, velocidadKmh: 14.0 },
  ];

  let totales = null;
  const yaVistas = new Set(previas);
  for (const v of viajes) {
    const destino = v.ruta.split('-')[1];
    totales = misiones.acumular(totales, '2026-09-14', v, !yaVistas.has(destino));
    yaVistas.add(destino);
  }

  assert.deepStrictEqual(
    misiones.progresoDeTotales(delDia, totales),
    misiones.progreso(delDia, viajes, previas)
  );
});

test('el acumulador se vacia al cambiar de dia', () => {
  // Si no, el progreso de ayer contaria para las misiones de hoy y saldrian
  // completadas sin haber pedaleado.
  const ayer = misiones.acumular(null, '2026-09-13',
    { distanciaMetros: 9000, velocidadKmh: 30 }, true);
  assert.strictEqual(ayer.metros, 9000);

  const hoy = misiones.acumular(ayer, '2026-09-14',
    { distanciaMetros: 1000, velocidadKmh: 12 }, false);

  assert.strictEqual(hoy.metros, 1000, 'los metros de ayer siguen contando hoy');
  assert.strictEqual(hoy.trayectos, 1);
  assert.strictEqual(hoy.mejorVelocidad, 12, 'la velocidad de ayer sigue contando hoy');
  assert.strictEqual(hoy.nuevas, 0);
});

// --- Puntos por mision (02 Hoy: "+20") -------------------------------------------

test('cada mision del dia trae sus puntos', () => {
  for (const m of misiones.generar('2026-09-29').misiones) {
    assert.ok(Number.isInteger(m.puntos) && m.puntos > 0, `${m.tipo} sin puntos`);
  }
});

test('una mision solo se cobra el viaje que la completa, no los siguientes', () => {
  const delDia = misiones.generar('2026-09-29').misiones;
  const objetivo = delDia[0].objetivo;

  const tras1 = misiones.progresoDeTotales(delDia, { metros: objetivo, mejorVelocidad: 0, trayectos: 1, nuevas: 0 });
  assert.strictEqual(misiones.puntosCompletadas(delDia, null, tras1), delDia[0].puntos);

  const tras2 = misiones.progresoDeTotales(delDia, { metros: objetivo * 2, mejorVelocidad: 0, trayectos: 2, nuevas: 0 });
  const segunda = misiones.puntosCompletadas(delDia, tras1, tras2);
  const nuevasHechas = tras2.filter((p, i) => p.completada && !tras1[i].completada);
  assert.strictEqual(segunda, nuevasHechas.reduce((t, p) => t + delDia[tras2.indexOf(p)].puntos, 0),
    'la de distancia se ha vuelto a cobrar');
});

test('sin completar nada, cero', () => {
  const delDia = misiones.generar('2026-09-29').misiones;
  const nada = misiones.progresoDeTotales(delDia, { metros: 0, mejorVelocidad: 0, trayectos: 0, nuevas: 0 });
  assert.strictEqual(misiones.puntosCompletadas(delDia, null, nada), 0);
});

// --- Rutas destacadas planificadas (data/rutas-destacadas.csv) ------------------

test('el plan de rutas destacadas cubre un año con tramos de 5 a 20 minutos', () => {
  const fs = require('fs');
  const { leerPlan, FICHERO } = require('../src/rutas-destacadas');
  const plan = leerPlan();
  assert.ok(plan.size >= 365, `el plan tiene ${plan.size} dias`);
  const filas = fs.readFileSync(FICHERO, 'utf8').trim().split('\n').slice(1);
  for (const fila of filas) {
    const campos = fila.match(/(?:"[^"]*"|[^,])+/g);
    const km = Number(campos[campos.length - 2]);
    const minutos = Number(campos[campos.length - 1]);
    assert.ok(km >= 0.5 && km <= 6.7, `${campos[0]}: ${km} km fuera de 0,5-6,7`);
    assert.ok(minutos >= 5 && minutos <= 20, `${campos[0]}: ${minutos} min fuera de 5-20`);
  }
});

test('un dia fuera del plan no tiene ruta planificada', () => {
  const { rutaPlanificada } = require('../src/rutas-destacadas');
  assert.strictEqual(rutaPlanificada('1999-01-01'), null);
  assert.match(rutaPlanificada('2026-10-01'), /^\d{3,4}[A-Z]?-\d{3,4}[A-Z]?$/);
});
