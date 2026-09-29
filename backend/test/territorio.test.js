'use strict';

/**
 * Influencia y decaimiento del territorio.
 *
 * Lo que importa probar aqui es que un clan de FONDISTAS pueda disputarle una
 * estacion a uno de velocistas. Ese es el problema que el issue viene a
 * resolver: antes el mapa solo repartia por tiempos.
 */

const test = require('node:test');
const assert = require('node:assert');

const t = require('../src/territorio');

const viaje = (uid, ruta, segundos, metros) => ({
  uid, ruta, tiempoSegundos: segundos, distanciaMetros: metros,
});

// --- Componentes -------------------------------------------------------------

test('un clan de fondistas puede disputar a uno de velocistas', () => {
  // Es el motivo entero del cambio. Antes, repartiendo solo por tiempos, el
  // fondista no tocaba el mapa por bien que pedaleara.
  const clanes = new Map([['veloz', 'A'], ['fondo1', 'B'], ['fondo2', 'B'], ['fondo3', 'B']]);

  const viajes = [
    // Uno solo, pero el mas rapido de todos.
    viaje('veloz', '001-002', 300, 2000),
    // Tres pilotos, mas lentos, pero muchos mas kilometros.
    viaje('fondo1', '001-002', 900, 9000),
    viaje('fondo2', '001-003', 950, 9500),
    viaje('fondo3', '001-004', 1000, 10000),
  ];

  const bruta = t.influenciaDelPeriodo('001', viajes, clanes);

  assert.ok(bruta.B > 0, 'el clan de fondistas no puntua nada');
  assert.ok(bruta.B > bruta.A,
    `fondistas ${bruta.B?.toFixed(1)} deberian superar a velocistas ${bruta.A?.toFixed(1)}`);
});

test('el clan mas rapido sigue sacando ventaja en su componente', () => {
  // El cambio no puede convertirse en lo contrario: la velocidad sigue pesando.
  const clanes = new Map([['a', 'A'], ['b', 'B']]);
  const viajes = [
    viaje('a', '001-002', 300, 2000),
    viaje('b', '001-002', 900, 2000),
  ];

  const bruta = t.influenciaDelPeriodo('001', viajes, clanes);
  assert.ok(bruta.A > bruta.B, 'a igualdad de todo lo demas, deberia ganar el rapido');
});

test('solo cuenta la mejor marca de cada piloto', () => {
  // Si no, quien sube diez veces la misma ruta se lleva medio reparto.
  const clanes = new Map([['a', 'A'], ['b', 'B']]);

  const unaVez = t.influenciaDelPeriodo('001',
    [viaje('a', '001-002', 300, 2000), viaje('b', '001-002', 400, 2000)], clanes);

  const diezVeces = t.influenciaDelPeriodo('001', [
    ...Array.from({ length: 10 }, () => viaje('a', '001-002', 300, 2000)),
    viaje('b', '001-002', 400, 2000),
  ], clanes);

  assert.deepStrictEqual(diezVeces, unaVez, 'repetir el mismo viaje cambia el reparto');
});

test('los viajes que no tocan la estacion no cuentan', () => {
  const clanes = new Map([['a', 'A']]);
  const bruta = t.influenciaDelPeriodo('001', [viaje('a', '500-600', 300, 2000)], clanes);
  assert.deepStrictEqual(bruta, {});
});

test('un piloto sin clan no aporta a nadie', () => {
  const bruta = t.influenciaDelPeriodo('001', [viaje('suelto', '001-002', 300, 2000)], new Map());
  assert.deepStrictEqual(bruta, {});
});

test('el volumen no aplasta a las demas componentes', () => {
  // En crudo, los metros (decenas de miles) contra la presencia (unidades)
  // harian que los pesos no significaran nada.
  const clanes = new Map([['a', 'A'], ['b', 'B']]);
  const viajes = [
    viaje('a', '001-002', 300, 100),      // rapido, poquisima distancia
    viaje('b', '001-003', 3000, 500000),  // lentisimo, media maraton
  ];

  const bruta = t.influenciaDelPeriodo('001', viajes, clanes);
  const mayor = Math.max(bruta.A, bruta.B);
  const menor = Math.min(bruta.A, bruta.B);

  assert.ok(mayor / menor < 4,
    `una componente domina: ${bruta.A.toFixed(1)} contra ${bruta.B.toFixed(1)}`);
});

// --- Decaimiento -------------------------------------------------------------

test('sin dias transcurridos no decae nada', () => {
  const antes = { A: 100 };
  assert.deepStrictEqual(t.decaer(antes, '2026-08-20', '2026-08-20'), { A: 100 });
});

test('ejecutarlo dos veces el mismo dia no descuenta dos veces', () => {
  // Es la razon de calcularlo por diferencia de fechas y no "una vez al dia".
  const unaVez = t.decaer({ A: 100 }, '2026-08-19', '2026-08-20');
  const otraVez = t.decaer(unaVez, '2026-08-20', '2026-08-20');
  assert.deepStrictEqual(otraVez, unaVez);
});

test('un dia sin ejecutar se recupera solo', () => {
  // Si el worker no corre un dia, al siguiente aplica los dos. Un cron que se
  // salta un dia dejaria el territorio congelado sin que nadie lo note.
  const deGolpe = t.decaer({ A: 100 }, '2026-08-18', '2026-08-20');
  const enDosPasos = t.decaer(t.decaer({ A: 100 }, '2026-08-18', '2026-08-19'), '2026-08-19', '2026-08-20');

  assert.ok(Math.abs(deGolpe.A - enDosPasos.A) < 0.1,
    `${deGolpe.A} contra ${enDosPasos.A}`);
});

test('un clan parado pierde la mitad en unas tres semanas', () => {
  // El numero elegido: lento como para no castigar una semana mala, rapido como
  // para que abandonar se note.
  const tresSemanas = t.decaer({ A: 100 }, '2026-08-01', '2026-08-24');
  assert.ok(tresSemanas.A > 45 && tresSemanas.A < 55,
    `a los 23 dias queda ${tresSemanas.A}, se esperaba la mitad`);
});

test('lo que ya no pinta nada se descarta', () => {
  // Un residuo de 0,01 en cada estacion solo ocupa sitio en el documento.
  const casiNada = t.decaer({ A: 0.4 }, '2026-08-19', '2026-08-20');
  assert.deepStrictEqual(casiNada, {});
});

// --- Reparto y control -------------------------------------------------------

test('dominar exige pasar del 50%, no ir primero', () => {
  // Con 34/33/33 la estacion esta EN DISPUTA, que es informacion distinta y mas
  // util que declarar un dueño por un punto.
  const reparto = t.repartir({}, { A: 34, B: 33, C: 33 });

  assert.strictEqual(reparto.dominante, null);
  assert.strictEqual(reparto.lider, 'A');
  assert.strictEqual(reparto.enDisputa, true);
});

test('con mayoria clara si hay dueño', () => {
  const reparto = t.repartir({}, { A: 80, B: 20 });

  assert.strictEqual(reparto.dominante, 'A');
  assert.strictEqual(reparto.enDisputa, false);
  assert.strictEqual(reparto.cuota.A, 80);
});

test('las cuotas suman 100', () => {
  const reparto = t.repartir({ A: 10 }, { B: 20, C: 30 });
  const suma = Object.values(reparto.cuota).reduce((t2, v) => t2 + v, 0);
  assert.ok(Math.abs(suma - 100) < 0.5, `las cuotas suman ${suma}`);
});

test('una estacion sin actividad no tiene dueño', () => {
  const reparto = t.repartir({}, {});
  assert.strictEqual(reparto.dominante, null);
  assert.deepStrictEqual(reparto.cuota, {});
});

test('lo acumulado se suma a lo nuevo', () => {
  // Es lo que hace que el territorio se construya con el tiempo en vez de
  // recalcularse desde cero cada vez.
  const reparto = t.repartir({ A: 90 }, { B: 10 });
  assert.strictEqual(reparto.dominante, 'A', 'lo acumulado deberia pesar');
});
