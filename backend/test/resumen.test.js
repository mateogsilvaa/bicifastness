'use strict';

/**
 * El resumen de metricas, sin leer la coleccion de viajes (#34).
 *
 * DE DONDE SE VIENE. `resumir` leia `usuarios` y `tiempos_viaje` ENTEROS —
 * 15.441 lecturas con 15.000 viajes acumulados — y era el ULTIMO sitio del
 * worker que lo hacia. Mientras siguiera ahi, el coste del proyecto crecia solo
 * por llevar tiempo abierto, aunque no entrara nadie nuevo.
 *
 * LA IDEA. Una cohorte es "que porcentaje de los que se dieron de alta esa
 * semana seguia subiendo trayectos a los 1, 7, 14 y 30 dias". Pasados esos 30
 * dias el numero YA NO PUEDE CAMBIAR. Asi que solo hay que recalcular las
 * cohortes vivas; las demas se copian del resumen anterior.
 *
 * Lo que se prueba aqui es lo unico que importa de eso: que sale el MISMO
 * resultado y cuesta mucho menos.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const { FirestoreFalso, FieldValue, FieldPath } = require('./ayuda/firestore-falso');

let bd = new FirestoreFalso();

const rutaAdmin = require.resolve('firebase-admin');
require.cache[rutaAdmin] = new Module(rutaAdmin, null);
require.cache[rutaAdmin].exports = {
  firestore: Object.assign(() => bd, {
    FieldValue,
    FieldPath: Object.assign(FieldPath, { documentId: () => new FieldPath('__id__') }),
  }),
  initializeApp: () => {},
  credential: { cert: () => ({}), applicationDefault: () => ({}) },
};

const metricas = require('../src/metricas');

const HOY = new Date('2026-08-23T12:00:00Z');
const haceDias = (n) => new Date(HOY.getTime() - n * 86400000);
const dia = (f) => f.toISOString().slice(0, 10);

const USUARIOS = 120;
const POR_USUARIO = 6;

/**
 * Un proyecto con altas repartidas a lo largo de medio año: hace falta que haya
 * cohortes viejas (congeladas) y recientes (vivas), que es justo la frontera que
 * el calculo incremental tiene que respetar.
 */
function sembrar() {
  bd = new FirestoreFalso();

  const usuarios = [];
  const viajes = [];

  for (let i = 0; i < USUARIOS; i++) {
    // De hace medio año hasta hoy mismo: hacen falta cohortes viejas (ya
    // congeladas) y recientes (todavia vivas), que es la frontera que el
    // calculo incremental tiene que respetar.
    const alta = haceDias(Math.round((USUARIOS - 1 - i) * 1.5));
    usuarios.push({ id: `u${i}`, creado: alta, username: `p${i}` });

    // Cada uno sigue activo un numero distinto de dias tras el alta: asi las
    // cuatro ventanas de retencion salen con valores distintos y un fallo en
    // una no se disimula con las otras.
    const aguanta = i % 40;
    for (let k = 0; k <= aguanta; k += Math.max(1, Math.floor(aguanta / POR_USUARIO) || 1)) {
      const cuando = new Date(alta.getTime() + k * 86400000);
      if (cuando > HOY) break;
      viajes.push({
        id: `v${i}-${k}`,
        uid: `u${i}`,
        verificado: true,
        fechaViaje: dia(cuando),
        ruta: '001-002',
      });
    }
  }

  bd.sembrar('usuarios', usuarios);
  bd.sembrar('tiempos_viaje', viajes);

  return { usuarios, viajes };
}

/** Lo que hacia antes: las dos colecciones enteras, a pelo. */
function cohortesALoBestia(usuarios, viajes) {
  return metricas.calcularCohortes(
    usuarios.map((u) => ({ uid: u.id, ...u })),
    viajes);
}

test('un solo viaje por piloto, el ultimo, da la misma cohorte que su historial', () => {
  // Es lo que permite pedir una lectura por piloto en vez de sus viajes: la
  // pregunta de una cohorte es "¿hasta cuando siguio ahi?", y eso lo contesta
  // el trayecto MAS LEJANO.
  const { usuarios, viajes } = sembrar();

  const ultimoPorUid = new Map();
  for (const v of viajes) {
    const previo = ultimoPorUid.get(v.uid);
    if (!previo || v.fechaViaje > previo) ultimoPorUid.set(v.uid, v.fechaViaje);
  }

  const soloElUltimo = [...ultimoPorUid.entries()].map(([uid, fechaViaje]) => ({ uid, fechaViaje }));

  assert.deepStrictEqual(
    cohortesALoBestia(usuarios, soloElUltimo),
    cohortesALoBestia(usuarios, viajes));
});

test('las cohortes vivas salen igual que recalculandolo todo', async () => {
  const { usuarios, viajes } = sembrar();
  const completas = cohortesALoBestia(usuarios, viajes);

  // Se le pasan las de antes, como hace `resumir` con el resumen anterior.
  const incrementales = await metricas.cohortesVivas(completas);

  assert.deepStrictEqual(incrementales, completas);
});

test('la semana del corte sale entera, no a medias', async () => {
  // Se arranca a leer usuarios desde el LUNES de hace 45 dias, no desde el dia
  // 45. Si se cortara a media semana, esa semana saldria sin los que se dieron
  // de alta entre su lunes y el corte. Con un resumen anterior del que copiar no
  // se nota, porque la version completa esta guardada; en frio — que es como
  // arranca esto la primera vez — la semana se perderia entera.
  const { usuarios, viajes } = sembrar();

  const corte = metricas.lunesDe(haceDias(metricas.DIAS_COHORTE_VIVA));
  const completa = cohortesALoBestia(usuarios, viajes).find((c) => c.semana === corte);
  assert.ok(completa, 'el ensayo necesita altas en la semana del corte');

  const enFrio = await metricas.cohortesVivas([]);

  assert.deepStrictEqual(enFrio.find((c) => c.semana === corte), completa,
    'la semana del corte se ha quedado a medias o se ha perdido');
});

test('recalcular las cohortes no lee los viajes de todo el mundo', async () => {
  const { usuarios, viajes } = sembrar();
  const completas = cohortesALoBestia(usuarios, viajes);

  bd.reiniciarContador();
  await metricas.cohortesVivas(completas);

  assert.ok(bd.coste.lecturas < viajes.length,
    `${bd.coste.lecturas} lecturas con ${viajes.length} viajes: sigue leyendolos`);
  assert.ok(bd.coste.lecturas < USUARIOS,
    `${bd.coste.lecturas} lecturas con ${USUARIOS} usuarios: sigue leyendolos todos`);
});

test('sin resumen anterior no se inventa nada: solo salen las cohortes vivas', async () => {
  sembrar();

  const soloVivas = await metricas.cohortesVivas([]);
  const corte = metricas.lunesDe(haceDias(metricas.DIAS_COHORTE_VIVA));

  assert.ok(soloVivas.length > 0);
  for (const c of soloVivas) {
    assert.ok(c.semana >= corte, `${c.semana} es anterior al corte y no puede salir de la nada`);
  }
});

test('el resumen entero no toca la coleccion de viajes', async () => {
  const { viajes } = sembrar();

  // La PRIMERA vez si las lee: hay que calcular una vez las cohortes ya
  // congeladas, que no se pueden deducir de nada. Lo que se mide aqui es lo que
  // cuesta a partir de entonces, que es lo que pasa 1.460 veces al año.
  await metricas.resumir();

  bd.reiniciarContador();
  await metricas.resumir();

  assert.ok(bd.coste.lecturas < viajes.length / 2,
    `${bd.coste.lecturas} lecturas con ${viajes.length} viajes acumulados`);

  const doc = bd.leer('agregados/metricas');
  assert.strictEqual(doc.totales.usuarios, USUARIOS);
  assert.strictEqual(doc.totales.viajesVerificados, viajes.length);
  assert.ok(doc.cohortes.length > 0);
});

test('la pasada cara de las cohortes ocurre una vez, no cada seis horas', async () => {
  const { viajes } = sembrar();

  bd.reiniciarContador();
  await metricas.resumir();
  const primera = bd.coste.lecturas;

  bd.reiniciarContador();
  await metricas.resumir();
  const siguiente = bd.coste.lecturas;

  assert.ok(primera > viajes.length, 'la primera tiene que calcular las congeladas');
  assert.ok(siguiente < primera / 4,
    `la segunda cuesta ${siguiente} frente a ${primera}: se sigue recalculando todo`);
});

test('la primera pasada deja las doce semanas, no solo las vivas', async () => {
  // Se conservan doce semanas pero solo seis y pico siguen vivas. Si la primera
  // pasada no calculara las congeladas, esas cinco semanas no existirian nunca:
  // la grafica de retencion arrancaria coja y nadie sabria por que.
  const { usuarios, viajes } = sembrar();
  await metricas.resumir();

  assert.deepStrictEqual(
    bd.leer('agregados/metricas').cohortes,
    cohortesALoBestia(usuarios, viajes));
});

test('los viajes por ventana salen del conteo y cuadran con los datos', async () => {
  const { viajes } = sembrar();
  await metricas.resumir();

  const ventanas = bd.leer('agregados/metricas').ventanas;

  for (const [nombre, dias] of Object.entries(metricas.VENTANAS)) {
    const desde = dia(new Date(Date.now() - (dias - 1) * 86400000));
    const esperado = viajes.filter((v) => v.fechaViaje >= desde).length;
    assert.strictEqual(ventanas[nombre].viajesVerificados, esperado,
      `la ventana "${nombre}" no cuadra`);
  }
});

test('el resumen conserva las cohortes congeladas aunque desaparezcan sus datos', async () => {
  const { usuarios } = sembrar();

  await metricas.resumir();
  const primera = bd.leer('agregados/metricas').cohortes;
  const corte = metricas.lunesDe(haceDias(metricas.DIAS_COHORTE_VIVA));
  const congeladas = primera.filter((c) => c.semana < corte);

  assert.ok(congeladas.length > 0, 'el ensayo necesita cohortes ya congeladas');

  // Se borran los usuarios viejos y TODOS los viajes. Si las congeladas se
  // recalcularan, se irian a cero; tienen que salir del resumen anterior.
  bd.vaciar('tiempos_viaje');
  for (const u of usuarios) {
    const alta = u.creado.toISOString().slice(0, 10);
    if (metricas.lunesDe(u.creado) < corte) await bd.doc(`usuarios/${u.id}`).delete();
    assert.ok(alta);
  }

  await metricas.resumir();
  const segunda = bd.leer('agregados/metricas').cohortes;

  assert.deepStrictEqual(segunda.filter((c) => c.semana < corte), congeladas,
    'las cohortes congeladas se han recalculado y se han perdido');
});

test('si el conteo falla se conserva el numero anterior, no se pierde el resumen', async () => {
  // Pasa el dia del despliegue: un indice compuesto nuevo tarda unos minutos en
  // construirse y hasta entonces la consulta de conteo da error. Perder un
  // numero unas horas es molesto; perder tambien las cohortes, que no se pueden
  // recalcular hacia atras, no.
  const { viajes } = sembrar();

  await metricas.resumir();
  const bueno = bd.leer('agregados/metricas');
  assert.strictEqual(bueno.totales.viajesVerificados, viajes.length);

  // El prototipo de Consulta, no el de la coleccion: `where()` devuelve una
  // Consulta, asi que parchear el de la coleccion dejaria pasar justo las
  // consultas que interesa romper — y el ensayo saldria verde sobre nada.
  const consulta = Object.getPrototypeOf(bd.collection('tiempos_viaje').where('x', '==', 1));
  const original = consulta.count;
  consulta.count = () => { throw new Error('The query requires an index'); };

  try {
    await metricas.resumir();
  } finally {
    consulta.count = original;
  }

  const degradado = bd.leer('agregados/metricas');
  assert.strictEqual(degradado.totales.viajesVerificados, viajes.length,
    'el total se ha ido a cero en vez de conservarse');
  assert.deepStrictEqual(degradado.cohortes, bueno.cohortes,
    'las cohortes se han perdido por un conteo que fallaba');
});
