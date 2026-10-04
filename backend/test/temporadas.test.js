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
  // 01:00 en Madrid del 1 de enero: el mes ya ha cambiado aqui, y aqui es donde
  // se juega. (En UTC son las 00:00 del 1, asi que las dos coinciden.)
  assert.strictEqual(temporadas.idTemporada(new Date('2026-01-01T00:00:00Z')), '2026-01');
});

test('el mes es el de Madrid, no el de UTC', () => {
  // Una o dos horas al mes de diferencia, y caen justo donde mas duele.
  //
  // Lanzando el cierre a mano a las 00:30 del dia 1, en UTC todavia es el mes
  // anterior: `temporadaAnterior` devolvia el mes de ANTES, uno que ya estaba
  // cerrado. Y como cerrar es idempotente, no fallaba — contestaba "ya cerrada",
  // quien lo lanzo se quedaba tranquilo y el mes recien terminado no se
  // archivaba nunca.
  const medianocheLarga = new Date('2026-08-31T22:30:00Z');   // 00:30 del 1-sep en Madrid

  assert.strictEqual(temporadas.idTemporada(medianocheLarga), '2026-09',
    'con el mes UTC diria 2026-08 y se cerraria la temporada equivocada');
  assert.strictEqual(
    temporadas.temporadaAnterior(temporadas.idTemporada(medianocheLarga)), '2026-08',
    'el cierre tiene que archivar el mes que acaba de terminar');

  // Y el cambio de año, por el mismo camino.
  const finDeAnio = new Date('2026-12-31T23:30:00Z');          // 00:30 del 1-ene en Madrid
  assert.strictEqual(temporadas.idTemporada(finDeAnio), '2027-01');
  assert.strictEqual(temporadas.temporadaAnterior(temporadas.idTemporada(finDeAnio)), '2026-12');
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

const piloto = (uid, puntos, division = 'plata', grupo = undefined) => ({ uid, puntos, division, grupo });

test('la escala va de cobre a diamante, y sin clasificar va aparte', () => {
  assert.deepStrictEqual(divisiones.NIVELES, ['cobre', 'plata', 'oro', 'platino', 'esmeralda', 'rubi', 'diamante']);
  assert.ok(!divisiones.esClasificado('sin-clasificar'));
  assert.ok(!divisiones.esClasificado(undefined), 'un perfil nuevo, sin division, esta sin clasificar');
  assert.ok(!divisiones.esClasificado('hierro'), 'la escala vieja no vale');
  assert.strictEqual(divisiones.divisionDeClave('plata-4'), 'plata');
  assert.strictEqual(divisiones.divisionDeClave('sin-clasificar'), 'sin-clasificar');
});

test('los grupos son de 20 como mucho y parejos', () => {
  const pilotos = Array.from({ length: 55 }, (_, i) => piloto(`u${i}`, 100 - i));
  const grupos = divisiones.repartirEnGrupos(pilotos);
  assert.strictEqual(grupos.size, 3);
  const tamanos = [...grupos.values()].map((g) => g.length);
  for (const t of tamanos) assert.ok(t <= divisiones.POR_GRUPO);
  assert.ok(Math.max(...tamanos) - Math.min(...tamanos) <= 1, `grupos descompensados: ${tamanos}`);
  // En serpiente: los tres mejores no caen en el mismo grupo.
  const deLosTres = new Set(['u0', 'u1', 'u2'].map((u) => [...grupos].find(([, m]) => m.some((p) => p.uid === u))[0]));
  assert.strictEqual(deLosTres.size, 3);
});

test('el grupo guardado en el cierre manda: no cambia en mitad de la liga', () => {
  const pilotos = [piloto('a', 999, 'plata', 'plata-2'), piloto('b', 1, 'plata', 'plata-1')];
  const grupos = divisiones.repartirEnGrupos(pilotos);
  assert.deepStrictEqual(grupos.get('plata-2').map((p) => p.uid), ['a']);
  assert.deepStrictEqual(grupos.get('plata-1').map((p) => p.uid), ['b']);
});

test('los sin clasificar con puntos van en una sola tabla; sin puntos, en ninguna', () => {
  const grupos = divisiones.repartirEnGrupos([
    piloto('nuevo', 50, 'sin-clasificar'), piloto('otro', 20, null), piloto('dormido', 0, 'sin-clasificar'),
  ]);
  assert.deepStrictEqual(grupos.get('sin-clasificar').map((p) => p.uid), ['nuevo', 'otro']);
  assert.strictEqual(grupos.size, 1);
});

test('con pocos grupos hay uno por division, empezando por abajo', () => {
  assert.deepStrictEqual(divisiones.gruposPorNivel(45),
    { cobre: 1, plata: 1, oro: 1, platino: 0, esmeralda: 0, rubi: 0, diamante: 0 });
  assert.deepStrictEqual(Object.values(divisiones.gruposPorNivel(140)), [1, 1, 1, 1, 1, 1, 1]);
  // El octavo grupo nace abajo.
  assert.strictEqual(divisiones.gruposPorNivel(141).cobre, 2);
});

test('la piramide: diamante 1, rubi hasta 3, esmeralda hasta 7 y el resto 40/30/20/10', () => {
  for (let n = 1; n <= 8000; n += 7) {
    const g = divisiones.gruposPorNivel(n);
    const total = Object.values(g).reduce((a, b) => a + b, 0);
    assert.strictEqual(total, Math.ceil(n / 20), `con ${n} pilotos los grupos no cuadran`);
    assert.ok(g.diamante <= 1 && g.rubi <= 3 && g.esmeralda <= 7, `tope de gemas roto con ${n}: ${JSON.stringify(g)}`);
    if (total > 7) {
      assert.ok(g.esmeralda <= g.platino, `con ${n}, mas esmeralda que platino: ${JSON.stringify(g)}`);
      assert.ok(g.rubi <= g.esmeralda, `con ${n}, mas rubi que esmeralda`);
      assert.ok(g.cobre >= g.plata && g.plata >= g.oro && g.oro >= g.platino, `metales sin piramide con ${n}: ${JSON.stringify(g)}`);
    }
  }
  const g = divisiones.gruposPorNivel(5000);
  const resto = g.cobre + g.plata + g.oro + g.platino;
  assert.ok(Math.abs(g.cobre / resto - 0.4) < 0.02 && Math.abs(g.platino / resto - 0.1) < 0.02);
  assert.deepStrictEqual([g.esmeralda, g.rubi, g.diamante], [7, 3, 1]);
});

test('suben los 4 primeros y bajan los 4 ultimos de un grupo de 20', () => {
  const pilotos = Array.from({ length: 20 }, (_, i) => piloto(`u${i}`, 100 - i));
  const { suben, bajan } = divisiones.movimientos('plata-1', pilotos);
  assert.strictEqual(suben.length, 4);
  assert.strictEqual(bajan.length, 4);
  assert.strictEqual(suben[0].uid, 'u0');
  assert.strictEqual(suben[0].division, 'oro');
  assert.strictEqual(bajan[bajan.length - 1].division, 'cobre');
});

test('quien no ha competido no baja ni sube', () => {
  const pilotos = [
    ...Array.from({ length: 10 }, (_, i) => piloto(`activo${i}`, 100 - i)),
    ...Array.from({ length: 8 }, (_, i) => piloto(`ausente${i}`, 0)),
  ];
  const { suben, bajan } = divisiones.movimientos('plata-1', pilotos);
  for (const p of [...suben, ...bajan]) assert.ok(!p.uid.startsWith('ausente'), `${p.uid} se mueve sin haber competido`);
});

test('un grupo pequeño no mueve a casi todo el mundo, y uno casi vacio a nadie', () => {
  const siete = Array.from({ length: 7 }, (_, i) => piloto(`u${i}`, 70 - i * 10));
  const { suben, bajan } = divisiones.movimientos('plata-1', siete);
  assert.ok(suben.length <= 2 && bajan.length <= 2);
  assert.strictEqual(divisiones.movimientos('plata-1', [piloto('a', 10), piloto('b', 5)]).suben.length, 0);
});

test('de diamante no se sube y de cobre no se baja', () => {
  const arriba = Array.from({ length: 20 }, (_, i) => piloto(`d${i}`, 100 - i, 'diamante'));
  assert.strictEqual(divisiones.movimientos('diamante-1', arriba).suben.length, 0);
  const abajo = Array.from({ length: 20 }, (_, i) => piloto(`c${i}`, 100 - i, 'cobre'));
  assert.strictEqual(divisiones.movimientos('cobre-1', abajo).bajan.length, 0);
});

// --- El cierre ------------------------------------------------------------------

/** Una escalera estable: `n` pilotos con un historial de cierres. */
function escalera(n, ligas, { semilla = 7, inactivos = 0.1 } = {}) {
  let r = semilla;
  const azar = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
  let estado = Array.from({ length: n }, (_, i) => ({ uid: `u${i}`, puntos: Math.round(azar() * 400) }));
  for (let k = 0; k <= ligas; k++) {
    const salida = divisiones.cerrarLiga(estado);
    estado = salida.map((x) => ({
      uid: x.uid, division: x.division, grupo: x.grupo, ligasInactivas: x.ligasInactivas,
      divisionMaxima: x.divisionMaxima, ligasJugadas: x.ligasJugadas,
      puntos: azar() < inactivos ? 0 : Math.round(azar() * 400),
    }));
  }
  return estado;
}

test('el primer cierre: los nuevos entran, al menos el 80% en cobre', () => {
  const nuevos = Array.from({ length: 300 }, (_, i) => ({ uid: `u${i}`, puntos: 10 + i }));
  const salida = divisiones.cerrarLiga(nuevos);
  const en = (d) => salida.filter((x) => x.division === d).length;
  assert.strictEqual(en('sin-clasificar'), 0, 'todos han pedaleado: todos entran');
  assert.ok(en('cobre') >= 240, `solo ${en('cobre')} de 300 en cobre`);
  assert.strictEqual(en('platino') + en('esmeralda') + en('rubi') + en('diamante'), 0);
  // Los que entran por encima de cobre son los que mas han destacado.
  const minimoArriba = Math.min(...salida.filter((x) => x.division !== 'cobre').map((x) => x.puntos));
  const maximoCobre = Math.max(...salida.filter((x) => x.division === 'cobre').map((x) => x.puntos));
  assert.ok(minimoArriba >= maximoCobre);
  // Y todos salen con grupo de 20 como mucho y con su division.
  for (const x of salida) {
    assert.strictEqual(divisiones.divisionDeClave(x.grupo), x.division);
    assert.ok(x.cambia);
  }
});

test('quien no ha pedaleado y es nuevo se queda sin clasificar, sin grupo', () => {
  const [x] = divisiones.cerrarLiga([{ uid: 'a', puntos: 0 }]);
  assert.strictEqual(x.division, 'sin-clasificar');
  assert.strictEqual(x.grupo, null);
  assert.strictEqual(x.cambia, false);
});

test('dos ligas sin pedalear devuelven a sin clasificar; una sola, no', () => {
  // Con gente de sobra para que exista oro (con un solo grupo, solo hay cobre).
  const otros = Array.from({ length: 160 }, (_, i) => ({ uid: `o${i}`, division: 'cobre', grupo: `cobre-${1 + (i % 8)}`, puntos: 10 + i }));
  const cerrar = (yo) => divisiones.cerrarLiga([yo, ...otros]);
  const base = { uid: 'a', division: 'oro', grupo: 'oro-1', puntos: 0, divisionMaxima: 2 };
  const [una] = cerrar({ ...base, ligasInactivas: 0 });
  assert.strictEqual(una.division, 'oro', 'una liga mala no te saca de la escalera');
  assert.strictEqual(una.ligasInactivas, 1);
  const [dos] = cerrar({ ...base, ligasInactivas: 1 });
  assert.strictEqual(dos.division, 'sin-clasificar');
  assert.strictEqual(dos.divisionMaxima, 2, 'se recuerda lo mejor que tuvo');
});

test('con poca gente las divisiones de arriba no existen: se baja por cupo', () => {
  // Un piloto de oro solo en la escalera: un grupo es solo cobre.
  const [x] = divisiones.cerrarLiga([{ uid: 'a', division: 'oro', grupo: 'oro-1', puntos: 50 }]);
  assert.strictEqual(x.division, 'cobre');
});

test('quien vuelve tras estar arriba entra mas alto, como mucho en oro', () => {
  const todos = Array.from({ length: 100 }, (_, i) => i * 3);
  assert.strictEqual(divisiones.nivelDeEntrada({ puntos: 150, divisionMaxima: -1 }, todos), 0, 'un nuevo normal, a cobre');
  assert.strictEqual(divisiones.nivelDeEntrada({ puntos: 150, divisionMaxima: 6 }, todos), 2, 'un ex diamante normal, a oro');
  assert.strictEqual(divisiones.nivelDeEntrada({ puntos: 150, divisionMaxima: 3 }, todos), 1, 'un ex platino, a plata');
  assert.strictEqual(divisiones.nivelDeEntrada({ puntos: 296, divisionMaxima: 2 }, todos), 1, 'un ex oro que vuelve fuerte, a plata');
  assert.strictEqual(divisiones.nivelDeEntrada({ puntos: 9999, divisionMaxima: -1 }, todos), 3, 'un nuevo fuera de serie apunta a platino');
});

test('platino al entrar es rarisimo: el 0,05% como mucho', () => {
  // 500 que destacan muchisimo, todos con historial de esmeralda: aun asi, al
  // ser menos de 2.000, nadie entra en platino.
  const vuelven = Array.from({ length: 500 }, (_, i) => ({ uid: `v${i}`, puntos: 1000 + i, divisionMaxima: 5 }));
  const normales = Array.from({ length: 2000 }, (_, i) => ({ uid: `n${i}`, puntos: 1 + (i % 50) }));
  const salida = divisiones.cerrarLiga([...vuelven, ...normales]);
  assert.strictEqual(salida.filter((x) => x.division === 'platino').length, 1, 'con 2.500 entrando, uno');
  const solos = divisiones.cerrarLiga(vuelven);
  assert.strictEqual(solos.filter((x) => x.division === 'platino').length, 0);
});

test('tras muchas ligas, la escalera respeta los cupos de cada division', () => {
  const estado = escalera(600, 15);
  const clasificados = estado.filter((x) => divisiones.esClasificado(x.division));
  const cupos = divisiones.gruposPorNivel(clasificados.length);
  const por = {};
  for (const x of clasificados) por[x.division] = (por[x.division] || 0) + 1;
  for (const nivel of divisiones.NIVELES.slice(1)) {
    assert.ok((por[nivel] || 0) <= cupos[nivel] * divisiones.POR_GRUPO,
      `${nivel}: ${por[nivel]} pilotos para ${cupos[nivel]} grupos`);
  }
  assert.ok((por.diamante || 0) <= 20, 'Diamante es un solo grupo');
  // Las gemas se llenan con el tiempo: la escalera no se queda abajo.
  assert.ok((por.diamante || 0) > 0, 'en 15 ligas alguien deberia llegar a diamante');
  // Cada uno, en un grupo de su division y de 20 como mucho.
  const grupos = {};
  for (const x of clasificados) {
    assert.strictEqual(divisiones.divisionDeClave(x.grupo), x.division);
    grupos[x.grupo] = (grupos[x.grupo] || 0) + 1;
  }
  for (const [g, n] of Object.entries(grupos)) assert.ok(n <= 20, `${g} tiene ${n}`);
});

test('cuando arriba no cabe, se queda quien ya estaba y entran los que suben con mas puntos', () => {
  // Diamante lleno (20) y un rubi con 4 que suben: si no caben todos, los que
  // estaban en diamante y no han quedado abajo no pueden caerse por ellos.
  const diamantes = Array.from({ length: 20 }, (_, i) => ({ uid: `d${i}`, division: 'diamante', grupo: 'diamante-1', puntos: 200 - i, divisionMaxima: 6 }));
  const rubis = Array.from({ length: 20 }, (_, i) => ({ uid: `r${i}`, division: 'rubi', grupo: 'rubi-1', puntos: 500 - i, divisionMaxima: 5 }));
  const resto = Array.from({ length: 100 }, (_, i) => ({ uid: `c${i}`, division: 'cobre', grupo: `cobre-${1 + (i % 5)}`, puntos: 50 + i, divisionMaxima: 0 }));
  const salida = new Map(divisiones.cerrarLiga([...diamantes, ...rubis, ...resto]).map((x) => [x.uid, x]));
  const enDiamante = [...salida.values()].filter((x) => x.division === 'diamante');
  assert.strictEqual(enDiamante.length, 20);
  // Bajan los 4 ultimos de diamante (d16..d19) y suben los 4 primeros de rubi.
  for (const u of ['r0', 'r1', 'r2', 'r3']) assert.strictEqual(salida.get(u).division, 'diamante', u);
  for (const u of ['d16', 'd17', 'd18', 'd19']) assert.strictEqual(salida.get(u).division, 'rubi', u);
  for (const u of ['d0', 'd10', 'd15']) assert.strictEqual(salida.get(u).division, 'diamante', u);
});

test('solo cambia lo que tiene que cambiar', () => {
  const estado = escalera(300, 6);
  const salida = divisiones.cerrarLiga(estado);
  const cambian = salida.filter((x) => x.cambia).length;
  assert.ok(cambian > 0 && cambian < salida.length / 2, `cambian ${cambian} de ${salida.length}`);
});
