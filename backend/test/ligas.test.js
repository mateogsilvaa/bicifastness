'use strict';

/**
 * Ligas de dos semanas: el calendario, el gemelo del navegador y el resumen de
 * todas las ligas que lee el ranking.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const divisiones = require('../src/divisiones');
const { resumenLigas } = require('../src/agregados');

const RAIZ = path.join(__dirname, '..', '..');

/** Carga `assets/js/ligas.js` (modulo ES) apuntando su import a `dia.js` real. */
function cargarLigasCliente() {
  const dia = pathToFileURL(path.join(RAIZ, 'assets', 'js', 'dia.js')).href;
  const fuente = fs.readFileSync(path.join(RAIZ, 'assets', 'js', 'ligas.js'), 'utf8')
    .replace("from './dia.js'", `from '${dia}'`);
  return import(`data:text/javascript;base64,${Buffer.from(fuente).toString('base64')}`);
}

test('la primera liga empieza el dia del lanzamiento y llega al domingo 15', () => {
  assert.strictEqual(divisiones.inicioLiga('2026-11-01'), '2026-11-01');
  assert.strictEqual(divisiones.inicioLiga('2026-11-10'), '2026-11-01');
  assert.strictEqual(divisiones.finLiga('2026-11-01'), '2026-11-15');
  // Ni el dia del lanzamiento ni el lunes siguiente cierran nada.
  assert.ok(!divisiones.esCambioDeLiga('2026-11-01'));
  assert.ok(!divisiones.esCambioDeLiga('2026-11-02'));
  assert.ok(!divisiones.esCambioDeLiga('2026-11-09'));
  // Lo de antes del lanzamiento no cae en ninguna liga anterior: un viaje de
  // prueba de octubre es anterior al inicio de la liga en juego, y no suma.
  assert.strictEqual(divisiones.inicioLiga('2026-10-20'), '2026-11-01');
  assert.ok('2026-10-20' < divisiones.inicioLiga('2026-10-20'));
});

test('desde ahi, una liga dura dos semanas, de lunes a domingo', () => {
  assert.ok(divisiones.esCambioDeLiga('2026-11-16'), 'la primera se cierra el lunes 16');
  const inicio = divisiones.inicioLiga('2026-11-20');
  assert.strictEqual(inicio, '2026-11-16');
  assert.strictEqual(divisiones.finLiga('2026-11-20'), '2026-11-29');
  assert.strictEqual(new Date(`${inicio}T12:00:00Z`).getUTCDay(), 1, 'empieza en lunes');
  // El lunes siguiente NO cambia; el de dos semanas despues, si.
  assert.ok(!divisiones.esCambioDeLiga('2026-11-23'));
  assert.ok(divisiones.esCambioDeLiga('2026-11-30'));
  // Al cerrar la primera, la que se cierra es la del lanzamiento.
  assert.strictEqual(divisiones.inicioLiga(divisiones.sumarDias('2026-11-16', -1)), '2026-11-01');
  // Y cruzando de año sigue la cuenta.
  assert.strictEqual(divisiones.inicioLiga('2027-01-01'), '2026-12-28');
});

test('el navegador y el worker cuentan las ligas igual', async () => {
  const cliente = await cargarLigasCliente();
  assert.strictEqual(cliente.ANCLA_LIGA, divisiones.ANCLA_LIGA);
  assert.strictEqual(cliente.LANZAMIENTO, divisiones.LANZAMIENTO);
  assert.strictEqual(cliente.DIAS_POR_LIGA, divisiones.DIAS_POR_LIGA);
  assert.deepStrictEqual(cliente.NIVELES, divisiones.NIVELES);
  assert.strictEqual(cliente.SIN_CLASIFICAR, divisiones.SIN_CLASIFICAR);
  for (let d = 0; d < 90; d++) {
    const dia = divisiones.sumarDias('2026-10-15', d);
    assert.strictEqual(cliente.inicioLiga(dia), divisiones.inicioLiga(dia), dia);
    assert.strictEqual(cliente.proximoCambio(dia), divisiones.sumarDias(divisiones.finLiga(dia), 1), dia);
  }
});

test('el resumen de ligas va de Leyenda a Hierro y solo publica lo publicable', () => {
  const pilotos = [
    ...Array.from({ length: 35 }, (_, i) => ({
      uid: `h${i}`, division: 'cobre', puntos: 100 - i,
      u: { username: `cobre${i}`, clanId: null, email: 'no@debe.salir' },
    })),
    { uid: 'o1', division: 'oro', puntos: 50, u: { username: 'dorada', clanId: 'c1', email: 'x@y.z' } },
    { uid: 'n1', division: 'sin-clasificar', puntos: 30, u: { username: 'novata', clanId: null } },
  ];
  const grupos = divisiones.repartirEnGrupos(pilotos);
  const r = resumenLigas(grupos, '2026-11-20');

  assert.deepStrictEqual(r.niveles.map((n) => n.nivel), [...[...divisiones.NIVELES].reverse(), 'sin-clasificar']);
  const cobre = r.niveles.find((n) => n.nivel === 'cobre');
  assert.strictEqual(cobre.pilotos, 35);
  assert.strictEqual(cobre.grupos.length, 2, '35 pilotos son dos grupos de hasta 20');
  // Parejos: los dos mejores, cada uno en un grupo.
  assert.deepStrictEqual(cobre.grupos.map((g) => g.podio[0].nombre).sort(), ['cobre0', 'cobre1']);
  const sin = r.niveles.find((n) => n.nivel === 'sin-clasificar');
  assert.strictEqual(sin.pilotos, 1);
  assert.strictEqual(sin.grupos[0].mueven, 0, 'sin clasificar no sube ni baja');
  assert.strictEqual(r.niveles.find((n) => n.nivel === 'plata').pilotos, 0);
  assert.strictEqual(r.inicio, '2026-11-16');
  assert.strictEqual(r.fin, '2026-11-29');
  assert.ok(!JSON.stringify(r.niveles).includes('@'), 'el resumen no puede llevar correos');
  assert.ok(!JSON.stringify(r.niveles).includes('"uid"'), 'ni uids');
});

test('cada division tiene su insignia, y se gana al llegar', () => {
  const logros = require('../src/logros');
  for (const nivel of divisiones.NIVELES) {
    assert.ok(logros.CATALOGO.insignias[`liga-${nivel}`], `falta la insignia de ${nivel}`);
  }
  const nuevas = logros.nuevas({ division: 'oro', logros: [] });
  assert.ok(['liga-cobre', 'liga-plata', 'liga-oro'].every((k) => nuevas.includes(k)));
  assert.ok(!nuevas.includes('liga-platino'));
  // Vuelta a sin clasificar: las de lo mejor que tuvo no se pierden ni se piden de nuevo.
  const vuelta = logros.nuevas({ division: 'sin-clasificar', divisionMaxima: 4, logros: [] });
  assert.ok(vuelta.includes('liga-esmeralda'));
  assert.deepStrictEqual(logros.nuevas({ division: 'sin-clasificar', logros: [] }).filter((k) => k.startsWith('liga-')), []);
});

test('las insignias del diseño se piden donde estan y con su version oscura', () => {
  const ligas = fs.readFileSync(path.join(RAIZ, 'assets', 'js', 'ligas.js'), 'utf8');
  assert.match(ligas, /\/assets\/img\/divisiones/);
  assert.match(ligas, /-oscuro\.svg/);
});

test('el cierre de liga solo actua el lunes que toca y no se repite', () => {
  const codigo = fs.readFileSync(path.join(RAIZ, 'backend', 'periodicas.js'), 'utf8');
  assert.match(codigo, /esCambioDeLiga\(hoy\)/, 'tiene que mirar si hoy cierra liga');
  assert.match(codigo, /config\/ligas\/cerradas\//, 'tiene que marcar la liga cerrada');
  assert.ok(codigo.indexOf('await marca.set(', codigo.indexOf('actualizarDivisiones')) < codigo.lastIndexOf('lote.update('),
    'la marca va ANTES de tocar a nadie, como en el cierre de temporada');
  assert.match(codigo, /puntosLiga: 0/, 'los puntos de liga vuelven a cero');
  assert.match(codigo, /divisiones\.cerrarLiga\(/, 'la regla vive en divisiones.cerrarLiga, no en el script');
});
