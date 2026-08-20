'use strict';

/**
 * Pruebas del motor de juego: puntuacion por viaje, rachas y distancias.
 *
 * Lo que se comprueba aqui no es que el codigo corra, sino que las REGLAS de
 * docs/JUEGO.md se cumplen. En particular la que sostiene todo el diseno: que
 * un fondista y un velocista puntuan parecido. Si alguien toca los numeros de
 * `config.js` y rompe ese equilibrio, tiene que enterarse aqui.
 */

const test = require('node:test');
const assert = require('node:assert');

const { calcularPuntosViaje } = require('../src/puntuacion');
const rachas = require('../src/rachas');
const distancias = require('../src/distancias');
const { RACHA, VIAJE } = require('../src/config');

// --- Puntuacion por viaje ----------------------------------------------------

test('los tres perfiles de piloto puntuan en el mismo orden de magnitud', () => {
  const velocista = calcularPuntosViaje({ distanciaMetros: 1500, velocidadKmh: 20 });
  const fondista = calcularPuntosViaje({ distanciaMetros: 6000, velocidadKmh: 12 });
  const diario = calcularPuntosViaje({ distanciaMetros: 2500, velocidadKmh: 13 });

  // Los valores de la tabla de docs/JUEGO.md.
  assert.strictEqual(velocista.total, 49);
  assert.strictEqual(fondista.total, 56);
  assert.strictEqual(diario.total, 38);

  // La regla de verdad: que ninguno aplaste al otro. Si esto se rompe, el juego
  // vuelve a ser solo de velocistas, que es el problema que venimos a arreglar.
  const mayor = Math.max(velocista.total, fondista.total);
  const menor = Math.min(velocista.total, fondista.total);
  assert.ok(mayor / menor < 1.5, `desequilibrio ${mayor}/${menor}`);
});

test('ir despacio no resta puntos', () => {
  const lento = calcularPuntosViaje({ distanciaMetros: 2000, velocidadKmh: 4 });

  assert.strictEqual(lento.desglose.velocidad, 0, 'no puntua por velocidad');
  assert.ok(lento.total > 0, 'pero sigue sumando por base y distancia');
  assert.strictEqual(lento.total, VIAJE.BASE + 12);
});

test('la velocidad solo puntua por encima del umbral', () => {
  const justo = calcularPuntosViaje({ distanciaMetros: 1000, velocidadKmh: VIAJE.VELOCIDAD_UMBRAL_KMH });
  assert.strictEqual(justo.desglose.velocidad, 0);

  const algoMas = calcularPuntosViaje({ distanciaMetros: 1000, velocidadKmh: VIAJE.VELOCIDAD_UMBRAL_KMH + 4 });
  assert.strictEqual(algoMas.desglose.velocidad, 10);
});

test('los multiplicadores se aplican sobre el subtotal, no sobre cada parte', () => {
  const sinNada = calcularPuntosViaje({ distanciaMetros: 3000, velocidadKmh: 16 });
  const conRuta = calcularPuntosViaje({ distanciaMetros: 3000, velocidadKmh: 16, multiplicadorRuta: 2 });

  assert.strictEqual(conRuta.total, sinNada.desglose.subtotal * 2);
});

test('el bonus de territorio es del 10% y se ve en el desglose', () => {
  const fuera = calcularPuntosViaje({ distanciaMetros: 4000, velocidadKmh: 15 });
  const dentro = calcularPuntosViaje({ distanciaMetros: 4000, velocidadKmh: 15, territorioPropio: true });

  assert.strictEqual(dentro.desglose.multiplicadorTerritorio, 1.1);
  assert.strictEqual(dentro.total, Math.round(fuera.desglose.subtotal * 1.1));
});

test('pasado el cupo diario el viaje no da puntos pero se registra', () => {
  const fuera = calcularPuntosViaje({ distanciaMetros: 5000, velocidadKmh: 18, puntua: false });

  assert.strictEqual(fuera.total, 0);
  assert.strictEqual(fuera.puntua, false);
  // El desglose se conserva: hace falta para las estadisticas del perfil.
  assert.ok(fuera.desglose.subtotal > 0);
});

test('un viaje sin datos no revienta ni regala puntos', () => {
  assert.strictEqual(calcularPuntosViaje().total, VIAJE.BASE);
  assert.strictEqual(calcularPuntosViaje({ distanciaMetros: null }).total, VIAJE.BASE);
  assert.strictEqual(calcularPuntosViaje({ distanciaMetros: -5000 }).desglose.distancia, 0);
});

// --- Rachas ------------------------------------------------------------------

const dia = (iso) => new Date(`${iso}T12:00:00Z`);

test('la racha crece un dia por dia seguido', () => {
  let estado = rachas.estadoInicial();

  estado = rachas.registrarDiaActivo(estado, dia('2026-09-01'));
  assert.strictEqual(estado.racha, 1);

  estado = rachas.registrarDiaActivo(estado, dia('2026-09-02'));
  assert.strictEqual(estado.racha, 2);

  estado = rachas.registrarDiaActivo(estado, dia('2026-09-03'));
  assert.strictEqual(estado.racha, 3);
  assert.strictEqual(estado.mejorRacha, 3);
});

test('varios viajes el mismo dia cuentan como uno', () => {
  // Importa: el worker procesa la cola por lotes y puede resolver varios viajes
  // del mismo piloto en la misma pasada.
  let estado = rachas.registrarDiaActivo(rachas.estadoInicial(), dia('2026-09-01'));
  const antes = estado.racha;

  estado = rachas.registrarDiaActivo(estado, new Date('2026-09-01T20:00:00Z'));
  assert.strictEqual(estado.racha, antes);
  assert.strictEqual(estado.gano, false);
});

test('se gana un escudo cada 7 dias activos, con tope', () => {
  let estado = rachas.estadoInicial();

  for (let d = 1; d <= 7; d++) {
    estado = rachas.registrarDiaActivo(estado, dia(`2026-09-0${d}`));
  }
  assert.strictEqual(estado.escudos, 1);

  for (let d = 8; d <= 14; d++) {
    estado = rachas.registrarDiaActivo(estado, dia(`2026-09-${String(d).padStart(2, '0')}`));
  }
  assert.strictEqual(estado.escudos, 2);

  for (let d = 15; d <= 21; d++) {
    estado = rachas.registrarDiaActivo(estado, dia(`2026-09-${String(d).padStart(2, '0')}`));
  }
  assert.strictEqual(estado.escudos, RACHA.MAX_ESCUDOS, 'no se acumulan mas de dos');
});

test('fallar un dia con escudo salva la racha y gasta el escudo', () => {
  let estado = rachas.estadoInicial();
  for (let d = 1; d <= 7; d++) estado = rachas.registrarDiaActivo(estado, dia(`2026-09-0${d}`));

  assert.strictEqual(estado.escudos, 1);
  const rachaAntes = estado.racha;

  // Se salta el dia 8 y la pasada diaria se ejecuta el 9.
  const cerrado = rachas.cerrarDiasPerdidos(estado, dia('2026-09-09'));

  assert.strictEqual(cerrado.rota, false, 'la racha debe sobrevivir');
  assert.strictEqual(cerrado.racha, rachaAntes);
  assert.strictEqual(cerrado.escudos, 0);
  assert.strictEqual(cerrado.escudosGastados, 1);
});

test('fallar un dia sin escudo rompe la racha', () => {
  let estado = rachas.estadoInicial();
  estado = rachas.registrarDiaActivo(estado, dia('2026-09-01'));
  estado = rachas.registrarDiaActivo(estado, dia('2026-09-02'));

  assert.strictEqual(estado.escudos, 0);

  const cerrado = rachas.cerrarDiasPerdidos(estado, dia('2026-09-04'));
  assert.strictEqual(cerrado.rota, true);
  assert.strictEqual(cerrado.racha, 0);
});

test('el dia de hoy no cuenta como perdido hasta que termina', () => {
  let estado = rachas.registrarDiaActivo(rachas.estadoInicial(), dia('2026-09-01'));

  // La pasada del dia 2: el usuario todavia esta a tiempo de salvar la racha.
  const cerrado = rachas.cerrarDiasPerdidos(estado, dia('2026-09-02'));
  assert.strictEqual(cerrado.rota, false);
  assert.strictEqual(cerrado.racha, 1);
  assert.strictEqual(cerrado.escudosGastados, 0);
});

test('el cierre no cobra dos veces por los mismos dias', () => {
  let estado = rachas.estadoInicial();
  for (let d = 1; d <= 14; d++) {
    estado = rachas.registrarDiaActivo(estado, dia(`2026-09-${String(d).padStart(2, '0')}`));
  }
  assert.strictEqual(estado.escudos, 2);

  // Falla el 15; la pasada del 16 gasta un escudo.
  const primera = rachas.cerrarDiasPerdidos(estado, dia('2026-09-16'));
  assert.strictEqual(primera.escudosGastados, 1);
  assert.strictEqual(primera.escudos, 1);

  // La pasada del mismo dia no debe volver a gastar nada.
  const segunda = rachas.cerrarDiasPerdidos(primera, dia('2026-09-16'));
  assert.strictEqual(segunda.escudosGastados, 0);
  assert.strictEqual(segunda.escudos, 1);
});

test('el multiplicador de racha crece hasta x1,5 y ahi se queda', () => {
  assert.strictEqual(rachas.multiplicador(0), 1);
  assert.strictEqual(Number(rachas.multiplicador(10).toFixed(2)), 1.5);
  assert.strictEqual(Number(rachas.multiplicador(365).toFixed(2)), 1.5);
});

test('un viaje a las 23:30 de Madrid cuenta como de ese dia, no del siguiente', () => {
  // En horario de verano Madrid va dos horas por delante de UTC: las 23:30 del
  // dia 1 son las 21:30 UTC. Si se calculara en UTC, el usuario perderia la
  // racha por un viaje que hizo a tiempo.
  const nocheDelUno = new Date('2026-07-01T21:30:00Z');
  const mananaDelUno = new Date('2026-07-01T08:00:00Z');

  assert.strictEqual(rachas.diaDe(nocheDelUno), rachas.diaDe(mananaDelUno));
});

test('el cambio de hora no descuadra el conteo de dias', () => {
  // En 2026 el horario de verano en Europa termina el 25 de octubre.
  const antes = rachas.diaDe(new Date('2026-10-24T12:00:00Z'));
  const durante = rachas.diaDe(new Date('2026-10-25T12:00:00Z'));
  const despues = rachas.diaDe(new Date('2026-10-26T12:00:00Z'));

  assert.strictEqual(rachas.diasEntre(antes, durante), 1);
  assert.strictEqual(rachas.diasEntre(durante, despues), 1);
});

// --- Distancias --------------------------------------------------------------

test('la tabla precalculada manda sobre la estimacion', () => {
  distancias._usarTabla({ '100-101': 1234 });

  const conTabla = distancias.resolver('100', '101');
  assert.strictEqual(conTabla.metros, 1234);
  assert.strictEqual(conTabla.estimada, false);

  distancias._usarTabla({});
});

test('sin tabla se estima y queda marcado como estimado', () => {
  distancias._usarTabla({});

  const estimada = distancias.resolver('100', '101');
  assert.ok(estimada.metros > 0);
  assert.strictEqual(estimada.estimada, true, 'hay que poder distinguirlo despues');
});

test('una estacion inexistente no da distancia inventada', () => {
  assert.strictEqual(distancias.resolver('100', '99999'), null);
});

test('la estimacion normaliza el id de estacion igual que el resto', () => {
  // "1", "01" y "001" son la misma estacion en todo el proyecto: la forma
  // canonica son 3 digitos.
  const canonica = distancias.resolver('001', '100').metros;
  assert.strictEqual(distancias.resolver('1', '100').metros, canonica);
  assert.strictEqual(distancias.resolver('01', '100').metros, canonica);

  // Y la tabla precalculada se consulta con la clave ya normalizada, o un viaje
  // con la estacion escrita "1" no encontraria su distancia real.
  distancias._usarTabla({ '001-100': 4321 });
  assert.strictEqual(distancias.resolver('1', '100').metros, 4321);
  distancias._usarTabla({});
});

test('la cache evita recalcular, y si falla no tumba el viaje', async () => {
  distancias._usarTabla({});

  const cache = { leer: async () => 2500, escribir: async () => {} };
  const cacheada = await distancias.resolverConCache('100', '101', cache);
  assert.strictEqual(cacheada.metros, 2500);
  assert.strictEqual(cacheada.fuente, 'cache');

  const rota = { leer: async () => { throw new Error('Firestore caido'); }, escribir: async () => {} };
  const degradada = await distancias.resolverConCache('100', '101', rota);
  assert.strictEqual(degradada.estimada, true, 'se degrada a estimacion en vez de fallar');
});

test('la velocidad sale de la distancia y el tiempo', () => {
  // 3.600 m en 600 s = 21,6 km/h
  assert.strictEqual(distancias.velocidadKmh(3600, 600), 21.6);
  assert.strictEqual(distancias.velocidadKmh(0, 600), null);
  assert.strictEqual(distancias.velocidadKmh(1000, 0), null);
});
