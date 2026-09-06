'use strict';

/**
 * Metricas y retencion.
 *
 * Lo que se prueba de verdad es el calculo de cohortes, que es la unica parte
 * con logica: el resto es sumar y escribir. Y sobre todo, que la retencion NO
 * necesita seguir a nadie: se saca de datos que ya existen.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const metricas = require('../src/metricas');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

/** Usuario con fecha de alta, como lo devuelve Firestore. */
const alta = (uid, iso) => ({ uid, creado: { toDate: () => new Date(iso) } });
const viaje = (uid, fecha) => ({ uid, fechaViaje: fecha });

// --- Cohortes ----------------------------------------------------------------

test('agrupa las altas por semana', () => {
  // Lunes 2026-09-07 y miercoles 2026-09-09 son la misma cohorte.
  const cohortes = metricas.calcularCohortes(
    [alta('a', '2026-09-07T10:00:00Z'), alta('b', '2026-09-09T10:00:00Z')],
    []
  );

  assert.strictEqual(cohortes.length, 1);
  assert.strictEqual(cohortes[0].total, 2);
  assert.strictEqual(cohortes[0].semana, '2026-09-07');
});

test('quien no vuelve no cuenta en ninguna ventana', () => {
  const cohortes = metricas.calcularCohortes([alta('a', '2026-09-07T10:00:00Z')], []);

  assert.strictEqual(cohortes[0].total, 1);
  assert.strictEqual(cohortes[0].d1, 0);
  assert.strictEqual(cohortes[0].d30, 0);
});

test('un trayecto al dia siguiente cuenta solo en d1', () => {
  const cohortes = metricas.calcularCohortes(
    [alta('a', '2026-09-07T10:00:00Z')],
    [viaje('a', '2026-09-08')]
  );

  assert.strictEqual(cohortes[0].d1, 1);
  assert.strictEqual(cohortes[0].d7, 0, 'un dia despues no es seguir activo a la semana');
});

test('quien sigue a los 30 dias cuenta en todas las ventanas anteriores', () => {
  // Es la lectura correcta de una curva de retencion: seguir ahi el dia 30
  // implica haber seguido el 1, el 7 y el 14.
  const cohortes = metricas.calcularCohortes(
    [alta('a', '2026-09-07T10:00:00Z')],
    [viaje('a', '2026-10-10')]
  );

  assert.strictEqual(cohortes[0].d1, 1);
  assert.strictEqual(cohortes[0].d7, 1);
  assert.strictEqual(cohortes[0].d14, 1);
  assert.strictEqual(cohortes[0].d30, 1);
});

test('un usuario con muchos viajes no cuenta varias veces', () => {
  // Sin el corte, quien sube treinta trayectos inflaria su cohorte al 3.000%.
  const cohortes = metricas.calcularCohortes(
    [alta('a', '2026-09-07T10:00:00Z')],
    Array.from({ length: 30 }, (_, i) => viaje('a', `2026-09-${String(9 + i).padStart(2, '0')}`))
  );

  assert.strictEqual(cohortes[0].total, 1);
  assert.ok(cohortes[0].d1 <= 1, `d1 = ${cohortes[0].d1}, deberia ser como mucho 1`);
});

test('cuenta el trayecto MAS LEJANO, no el primero que aparezca', () => {
  // Alguien que hizo un viaje el dia 2 y otro el dia 40 sigue activo a los 30.
  // Mirando solo el primero contaba como que se fue en el dia 2, y ademas cual
  // se miraba dependia del orden en que llegaran los viajes.
  const cohortes = metricas.calcularCohortes(
    [alta('a', '2026-09-07T10:00:00Z')],
    [viaje('a', '2026-09-09'), viaje('a', '2026-10-17')]
  );

  assert.strictEqual(cohortes[0].d1, 1);
  assert.strictEqual(cohortes[0].d30, 1, 'el viaje del dia 40 se estaba ignorando');
});

test('el orden de los viajes no cambia el resultado', () => {
  const alReves = metricas.calcularCohortes(
    [alta('a', '2026-09-07T10:00:00Z')],
    [viaje('a', '2026-10-17'), viaje('a', '2026-09-09')]
  );
  const enOrden = metricas.calcularCohortes(
    [alta('a', '2026-09-07T10:00:00Z')],
    [viaje('a', '2026-09-09'), viaje('a', '2026-10-17')]
  );

  assert.deepStrictEqual(alReves, enOrden);
});

test('un alta sin fecha valida no rompe el calculo', () => {
  const cohortes = metricas.calcularCohortes(
    [{ uid: 'a' }, { uid: 'b', creado: 'no es una fecha' }, alta('c', '2026-09-07T10:00:00Z')],
    []
  );

  assert.strictEqual(cohortes.length, 1, 'solo la que tiene fecha valida');
});

test('la semana de un alta de madrugada es la semana de esa madrugada', () => {
  // El fallo que esto sujeta. `lunesDe` sacaba el dia de la semana en UTC y
  // formateaba el resultado en Madrid, que son dos calendarios distintos.
  // Entre las 00:00 y las 02:00 de Madrid el dia UTC va uno por detras, asi
  // que preguntaba por el dia de AYER y restaba una semana de mas.
  //
  // 2026-07-06 fue lunes. Quien se dio de alta a las 00:30 de ese lunes salia
  // en la cohorte '2026-06-30' — un martes, y de la semana anterior.
  const madrugada = metricas.calcularCohortes(
    [alta('a', '2026-07-05T22:30:00Z')], []); // 00:30 del lunes 6, en Madrid

  assert.strictEqual(madrugada[0].semana, '2026-07-06');
});

test('quien entra de madrugada cae en la misma cohorte que quien entra de dia', () => {
  // Es lo que de verdad se rompia: no una etiqueta fea, sino DOS cohortes donde
  // hay una. La de madrugada quedaba con una persona sola, y como solo se
  // guardan doce semanas, cada fantasma echaba fuera una semana de verdad.
  const cohortes = metricas.calcularCohortes([
    alta('madrugador', '2026-07-05T22:30:00Z'), // lunes 6, 00:30 en Madrid
    alta('normal', '2026-07-08T10:00:00Z'),     // miercoles 8
  ], []);

  assert.strictEqual(cohortes.length, 1, 'se han abierto dos cohortes para una misma semana');
  assert.strictEqual(cohortes[0].total, 2);
});

test('lunesDe siempre devuelve un lunes, a cualquier hora del año', () => {
  // La comprobacion que hace falta aqui no es un caso, es la propiedad: si el
  // resultado no es lunes, la funcion ha mezclado zonas otra vez. Se barre un
  // año entero hora a hora, cambios de horario incluidos — que es donde se
  // esconden estas cosas.
  //
  // La version anterior fallaba en 576 de estos 8.784 instantes: las dos horas
  // de cada noche en que Madrid y UTC no estan en el mismo dia.
  const fallos = [];

  for (let d = 0; d < 366; d++) {
    for (let h = 0; h < 24; h++) {
      const instante = new Date(Date.UTC(2026, 0, 1, h) + d * 86400000);
      const lunes = metricas.lunesDe(instante);
      // Mediodia para preguntar el dia de la semana sin rozar ningun borde.
      if (new Date(`${lunes}T12:00:00Z`).getUTCDay() !== 1) {
        fallos.push(`${instante.toISOString()} -> ${lunes}`);
      }
    }
  }

  assert.deepStrictEqual(fallos.slice(0, 5), [], `${fallos.length} instantes no caen en lunes`);
});

test('el lunes de una fecha no depende de la hora que traiga', () => {
  // Un alta es un instante cualquiera del dia. Si la hora movia la semana, dos
  // personas del mismo dia acababan en cohortes distintas.
  const dia = '2026-07-08'; // miercoles
  const semanas = new Set();

  for (let h = 0; h < 24; h++) {
    semanas.add(metricas.lunesDe(new Date(`${dia}T${String(h).padStart(2, '0')}:30:00+02:00`)));
  }

  assert.deepStrictEqual([...semanas], ['2026-07-06']);
});

// --- Privacidad --------------------------------------------------------------

test('la analitica del navegador no identifica a nadie', () => {
  const cliente = leer('assets/js/metricas.js');
  const bloque = cliente.slice(cliente.indexOf('const datos = {'), cliente.indexOf('setDoc('));

  for (const prohibido of ['uid', 'email', 'username', 'currentUser', 'localStorage', 'cookie']) {
    assert.ok(!bloque.includes(prohibido), `la analitica incluye "${prohibido}"`);
  }
});

test('no hay identificador que sobreviva a la pestaña', () => {
  // Sin esto seria seguimiento entre visitas, y haria falta banner.
  const cliente = leer('assets/js/metricas.js');

  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(cliente),
    'la analitica guarda un identificador persistente');
});

test('la lista de eventos es cerrada', () => {
  // El documento acepta escritura SIN sesion: sin lista cerrada, cualquiera
  // escribe las claves que quiera.
  const cliente = leer('assets/js/metricas.js');
  assert.match(cliente, /if \(!EVENTOS\.includes\(evento\)\) return;/);

  // Y las reglas repiten la lista, porque el cliente no es quien la impone.
  const reglas = leer('firestore.rules');
  const inicio = reglas.indexOf('match /sesiones_web/');
  const bloque = reglas.slice(inicio, reglas.indexOf('match /', inicio + 10));
  assert.match(bloque, /hasOnly\(\[/);
  assert.match(bloque, /allow read: if esAdmin\(\)/);
});

test('la retencion se calcula sin datos del navegador', () => {
  // Es la decision que evita elegir entre saber si el producto funciona y no
  // rastrear a la gente.
  const servidor = leer('backend/src/metricas.js');
  const funcion = servidor.slice(
    servidor.indexOf('function calcularCohortes'),
    servidor.indexOf('async function ultimoDiaConViaje'));

  assert.ok(!funcion.includes('sesiones_web'),
    'las cohortes dependen de la analitica del navegador');
  assert.ok(funcion.includes('fechaViaje') && funcion.includes('creado'),
    'las cohortes deberian salir de altas y trayectos');
});

// --- Limitador del resumen caro (#34) ----------------------------------------

test('el resumen caro no se rehace en cada pasada del worker', () => {
  // Cuando `resumir` leia `usuarios` y `tiempos_viaje` ENTEROS, hacerlo en cada
  // pasada costaba 288 x (usuarios + viajes) lecturas al dia: 402.000 con los
  // datos de hoy, ocho veces la cuota, con seis personas usando la web y aunque
  // no pasara nada. Ya no las lee, pero el limitador sigue teniendo sentido:
  // nadie mira la retencion a 30 dias esperando verla cambiar en cinco minutos.
  assert.ok(metricas.MINUTOS_ENTRE_RESUMENES >= 60,
    'un intervalo corto no aporta nada: la retencion a 30 dias no cambia en minutos');

  const ahora = Date.parse('2026-08-23T12:00:00Z');
  const hace = (minutos) => new Date(ahora - minutos * 60000).toISOString();

  assert.strictEqual(metricas.hayQueResumir(hace(5), ahora), false, 'recien hecho');
  assert.strictEqual(metricas.hayQueResumir(hace(metricas.MINUTOS_ENTRE_RESUMENES), ahora), true,
    'justo en el limite');
  assert.strictEqual(metricas.hayQueResumir(hace(metricas.MINUTOS_ENTRE_RESUMENES - 1), ahora), false,
    'un minuto antes del limite');
});

test('ante la duda se recalcula, en vez de dejar el panel congelado', () => {
  const ahora = Date.now();
  // Un panel congelado para siempre es peor que una lectura de mas.
  assert.strictEqual(metricas.hayQueResumir(null, ahora), true, 'no existe todavia');
  assert.strictEqual(metricas.hayQueResumir(undefined, ahora), true, 'sin marca');
  assert.strictEqual(metricas.hayQueResumir('lo que sea', ahora), true, 'marca ilegible');
});

test('acepta la marca tal y como la escribe Firestore', () => {
  // `serverTimestamp()` no vuelve como cadena, vuelve como Timestamp. Si solo
  // se contemplara el string, el limitador no limitaria nada: diria siempre que
  // toca y volveriamos a las 288 pasadas.
  const ahora = Date.parse('2026-08-23T12:00:00Z');
  const timestamp = (minutos) => ({ toMillis: () => ahora - minutos * 60000 });

  assert.strictEqual(metricas.hayQueResumir(timestamp(10), ahora), false);
  assert.strictEqual(metricas.hayQueResumir(timestamp(60 * 24), ahora), true);
});
