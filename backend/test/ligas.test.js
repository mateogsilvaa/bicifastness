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

test('una liga dura dos semanas, de lunes a domingo', () => {
  const inicio = divisiones.inicioLiga('2026-10-14');
  assert.strictEqual(inicio, '2026-10-05');
  assert.strictEqual(divisiones.finLiga('2026-10-14'), '2026-10-18');
  assert.strictEqual(new Date(`${inicio}T12:00:00Z`).getUTCDay(), 1, 'empieza en lunes');
  // El lunes siguiente NO cambia; el de dos semanas despues, si.
  assert.ok(!divisiones.esCambioDeLiga('2026-10-12'));
  assert.ok(divisiones.esCambioDeLiga('2026-10-19'));
  assert.ok(divisiones.esCambioDeLiga('2026-11-02'));
  // Y cruzando de año sigue la cuenta.
  assert.strictEqual(divisiones.inicioLiga('2027-01-01'), '2026-12-28');
});

test('el navegador y el worker cuentan las ligas igual', async () => {
  const cliente = await cargarLigasCliente();
  assert.strictEqual(cliente.ANCLA_LIGA, divisiones.ANCLA_LIGA);
  assert.strictEqual(cliente.DIAS_POR_LIGA, divisiones.DIAS_POR_LIGA);
  assert.deepStrictEqual(cliente.NIVELES, divisiones.NIVELES);
  for (let d = 0; d < 60; d++) {
    const dia = divisiones.sumarDias('2026-10-01', d);
    assert.strictEqual(cliente.inicioLiga(dia), divisiones.inicioLiga(dia), dia);
    assert.strictEqual(cliente.proximoCambio(dia), divisiones.sumarDias(divisiones.finLiga(dia), 1), dia);
  }
});

test('el resumen de ligas va de Leyenda a Hierro y solo publica lo publicable', () => {
  const pilotos = [
    ...Array.from({ length: 35 }, (_, i) => ({
      uid: `h${i}`, division: 'hierro', puntos: 100 - i,
      u: { username: `hierro${i}`, clanId: null, email: 'no@debe.salir' },
    })),
    { uid: 'o1', division: 'oro', puntos: 50, u: { username: 'dorada', clanId: 'c1', email: 'x@y.z' } },
  ];
  const grupos = divisiones.repartirEnGrupos(pilotos);
  const r = resumenLigas(grupos, '2026-10-14');

  assert.deepStrictEqual(r.niveles.map((n) => n.nivel), [...divisiones.NIVELES].reverse());
  const hierro = r.niveles.find((n) => n.nivel === 'hierro');
  assert.strictEqual(hierro.pilotos, 35);
  assert.strictEqual(hierro.grupos.length, 2, '35 pilotos son dos grupos de hasta 30');
  assert.deepStrictEqual(hierro.grupos[0].podio.map((p) => p.nombre), ['hierro0', 'hierro1', 'hierro2']);
  assert.strictEqual(r.niveles.find((n) => n.nivel === 'plata').pilotos, 0);
  assert.strictEqual(r.inicio, '2026-10-05');
  assert.strictEqual(r.fin, '2026-10-18');
  assert.ok(!JSON.stringify(r.niveles).includes('@'), 'el resumen no puede llevar correos');
  assert.ok(!JSON.stringify(r.niveles).includes('"uid"'), 'ni uids');
});

test('cada liga por encima de Hierro tiene su insignia, y se gana al llegar', () => {
  const logros = require('../src/logros');
  for (const nivel of divisiones.NIVELES.slice(1)) {
    assert.ok(logros.CATALOGO.insignias[`liga-${nivel}`], `falta la insignia de ${nivel}`);
  }
  const nuevas = logros.nuevas({ division: 'oro', logros: [] });
  assert.ok(['liga-bronce', 'liga-plata', 'liga-oro'].every((k) => nuevas.includes(k)));
  assert.ok(!nuevas.includes('liga-platino'));
});

test('el cierre de liga solo actua el lunes que toca y no se repite', () => {
  const codigo = fs.readFileSync(path.join(RAIZ, 'backend', 'periodicas.js'), 'utf8');
  assert.match(codigo, /esCambioDeLiga\(hoy\)/, 'tiene que mirar si hoy cierra liga');
  assert.match(codigo, /config\/ligas\/cerradas\//, 'tiene que marcar la liga cerrada');
  assert.ok(codigo.indexOf('await marca.set(') < codigo.indexOf('lote.update('),
    'la marca va ANTES de tocar a nadie, como en el cierre de temporada');
  assert.match(codigo, /puntosLiga: 0/, 'los puntos de liga vuelven a cero');
});
