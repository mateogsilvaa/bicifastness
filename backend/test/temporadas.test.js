'use strict';

/**
 * Temporadas y divisiones.
 *
 * Aqui se prueban las REGLAS, que es lo que puede estar mal sin que nadie se
 * entere hasta que ya ha pasado. Cerrar una temporada toca a todos los usuarios
 * y pone contadores a cero: es la operacion mas destructiva del proyecto, y no
 * hay vuelta atras si sale mal.
 */

const test = require('node:test');
const assert = require('node:assert');

const temporadas = require('../src/temporadas');
const divisiones = require('../src/divisiones');

// --- Temporadas --------------------------------------------------------------

test('la temporada es el mes natural', () => {
  assert.strictEqual(temporadas.idTemporada(new Date('2026-08-20T10:00:00Z')), '2026-08');
  assert.strictEqual(temporadas.idTemporada(new Date('2026-01-01T00:00:00Z')), '2026-01');
});

test('la anterior a enero es diciembre del año pasado', () => {
  // El caso que se olvida siempre y que solo falla una vez al año.
  assert.strictEqual(temporadas.temporadaAnterior('2026-01'), '2025-12');
  assert.strictEqual(temporadas.temporadaAnterior('2026-08'), '2026-07');
});

test('el podio va a los tres primeros', () => {
  const premios = temporadas.insigniasDeCierre([
    { uid: 'a', puntos: 300 },
    { uid: 'b', puntos: 200 },
    { uid: 'c', puntos: 100 },
    { uid: 'd', puntos: 50 },
  ], '2026-08');

  assert.deepStrictEqual(premios.get('a'), ['temporada-2026-08-oro']);
  assert.deepStrictEqual(premios.get('b'), ['temporada-2026-08-plata']);
  assert.deepStrictEqual(premios.get('c'), ['temporada-2026-08-bronce']);
  assert.strictEqual(premios.get('d'), undefined);
});

test('no se premia a quien no ha puntuado', () => {
  // Con pocos pilotos, dar un podio a quien saco 0 pasaria cada mes y vaciaria
  // la insignia de significado.
  const premios = temporadas.insigniasDeCierre([
    { uid: 'a', puntos: 10 },
    { uid: 'b', puntos: 0 },
    { uid: 'c', puntos: 0 },
  ], '2026-08');

  assert.deepStrictEqual(premios.get('a'), ['temporada-2026-08-oro']);
  assert.strictEqual(premios.get('b'), undefined);
  assert.strictEqual(premios.get('c'), undefined);
});

test('hay reconocimiento por modo, no solo por puntos', () => {
  // Es lo que impide que gane siempre el mismo perfil de piloto.
  const premios = temporadas.insigniasDeCierre([
    { uid: 'veloz', puntos: 300, metros: 1000, mejorRacha: 2 },
    { uid: 'fondista', puntos: 200, metros: 90000, mejorRacha: 3 },
    { uid: 'constante', puntos: 100, metros: 5000, mejorRacha: 40 },
  ], '2026-08');

  assert.ok(premios.get('fondista').includes('temporada-2026-08-fondo'));
  assert.ok(premios.get('constante').includes('temporada-2026-08-constancia'));
  assert.ok(premios.get('veloz').includes('temporada-2026-08-oro'));
});

test('una temporada sin nadie con puntos no reparte nada', () => {
  const premios = temporadas.insigniasDeCierre([{ uid: 'a', puntos: 0 }], '2026-08');
  assert.strictEqual(premios.size, 0);
});

// --- Divisiones --------------------------------------------------------------

const piloto = (uid, puntos, division = 'plata') => ({ uid, puntos, division });

test('los grupos son de 30 como mucho', () => {
  const pilotos = Array.from({ length: 75 }, (_, i) => piloto(`u${i}`, 100 - i));
  const grupos = divisiones.repartirEnGrupos(pilotos);

  assert.strictEqual(grupos.size, 3);
  for (const miembros of grupos.values()) {
    assert.ok(miembros.length <= divisiones.POR_GRUPO);
  }
});

test('los grupos se reparten por puntos, no al azar', () => {
  // Repartiendo al azar, a alguien le tocaria el grupo con los tres mejores.
  const pilotos = Array.from({ length: 60 }, (_, i) => piloto(`u${i}`, i));
  const grupos = divisiones.repartirEnGrupos(pilotos);

  const primero = grupos.get('plata-1');
  const segundo = grupos.get('plata-2');

  const minPrimero = Math.min(...primero.map((p) => p.puntos));
  const maxSegundo = Math.max(...segundo.map((p) => p.puntos));

  assert.ok(minPrimero >= maxSegundo, 'el grupo 1 deberia llevar a los mejores');
});

test('suben los primeros y bajan los ultimos', () => {
  const pilotos = Array.from({ length: 30 }, (_, i) => piloto(`u${i}`, 100 - i));
  const { suben, bajan } = divisiones.movimientos('plata-1', pilotos);

  assert.strictEqual(suben.length, divisiones.MUEVEN);
  assert.strictEqual(bajan.length, divisiones.MUEVEN);
  assert.strictEqual(suben[0].uid, 'u0');
  assert.strictEqual(suben[0].division, 'oro');
  assert.strictEqual(bajan[bajan.length - 1].division, 'bronce');
});

test('quien no ha competido no baja', () => {
  // Castigar la ausencia con un descenso empuja a abandonar del todo, que es lo
  // contrario de lo que busca una liga.
  const pilotos = [
    ...Array.from({ length: 10 }, (_, i) => piloto(`activo${i}`, 100 - i)),
    ...Array.from({ length: 8 }, (_, i) => piloto(`ausente${i}`, 0)),
  ];

  const { bajan } = divisiones.movimientos('plata-1', pilotos);

  for (const p of bajan) {
    assert.ok(!p.uid.startsWith('ausente'), `${p.uid} baja sin haber competido`);
  }
});

test('quien no ha competido tampoco sube', () => {
  const pilotos = [piloto('a', 50), piloto('b', 40), piloto('c', 30), piloto('d', 0), piloto('e', 0)];
  const { suben } = divisiones.movimientos('plata-1', pilotos);

  for (const p of suben) assert.ok(p.puntos > 0, `${p.uid} sube con 0 puntos`);
});

test('un grupo pequeño no mueve a casi todo el mundo', () => {
  // Con 7 personas, subir 5 y bajar 5 moveria a todas menos dos y el grupo
  // dejaria de significar nada.
  const pilotos = Array.from({ length: 7 }, (_, i) => piloto(`u${i}`, 70 - i * 10));
  const { suben, bajan } = divisiones.movimientos('plata-1', pilotos);

  assert.ok(suben.length + bajan.length < pilotos.length,
    'se mueve el grupo entero');
  assert.ok(suben.length <= 2, `suben ${suben.length} de 7`);
});

test('un grupo casi vacio no mueve a nadie', () => {
  const { suben, bajan } = divisiones.movimientos('plata-1', [piloto('a', 10), piloto('b', 5)]);
  assert.strictEqual(suben.length + bajan.length, 0);
});

test('de leyenda no se sube y de hierro no se baja', () => {
  const enLeyenda = Array.from({ length: 30 }, (_, i) => piloto(`u${i}`, 100 - i, 'leyenda'));
  assert.strictEqual(divisiones.movimientos('leyenda-1', enLeyenda).suben.length, 0);

  const enHierro = Array.from({ length: 30 }, (_, i) => piloto(`h${i}`, 100 - i, 'hierro'));
  assert.strictEqual(divisiones.movimientos('hierro-1', enHierro).bajan.length, 0);
});

test('nadie sube y baja a la vez', () => {
  const pilotos = Array.from({ length: 12 }, (_, i) => piloto(`u${i}`, 100 - i));
  const { suben, bajan } = divisiones.movimientos('plata-1', pilotos);

  const idsSuben = new Set(suben.map((p) => p.uid));
  for (const p of bajan) {
    assert.ok(!idsSuben.has(p.uid), `${p.uid} sube y baja a la vez`);
  }
});

test('solo se escriben los que cambian', () => {
  // Escribir 400 documentos cuando se mueven 40 es tirar cuota.
  const pilotos = Array.from({ length: 60 }, (_, i) => piloto(`u${i}`, 100 - i));
  const cambios = divisiones.calcularSemana(pilotos);

  assert.ok(cambios.length < pilotos.length, 'se escriben todos');
  assert.ok(cambios.length > 0, 'no se mueve nadie');
});
