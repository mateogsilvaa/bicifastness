'use strict';

/**
 * Avisos push (#33).
 *
 * El aviso mas util del juego es "te quedan cuatro horas de racha". Por correo
 * llega tarde y molesta; por push llega a tiempo.
 *
 * Y es el canal mas facil de estropear para siempre: un aviso de mas, o uno a
 * quien ya no hacia falta, y la persona lo desactiva. El navegador no vuelve a
 * preguntar. Por eso casi todo lo que se prueba aqui es a quien NO se avisa.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const { FirestoreFalso, FieldValue } = require('./ayuda/firestore-falso');

let bd = new FirestoreFalso();

const rutaAdmin = require.resolve('firebase-admin');
require.cache[rutaAdmin] = new Module(rutaAdmin, null);
require.cache[rutaAdmin].exports = {
  firestore: Object.assign(() => bd, { FieldValue }),
  initializeApp: () => {},
  credential: { cert: () => ({}), applicationDefault: () => ({}) },
};

const push = require('../src/push');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const conSuscripcion = (extra = {}) => ({
  push: { suscripciones: [{ endpoint: 'https://push.example/abc' }] },
  ...extra,
});

// --- A quien no se avisa -----------------------------------------------------------

test('sin suscripcion no se avisa, aunque el tipo venga activado por defecto', () => {
  // No es una promesa que haya que mantener a mano: sin suscripcion no hay a
  // donde enviar. Pero conviene que este escrito.
  assert.strictEqual(push.quiere({}, 'viajeResuelto'), false);
  assert.strictEqual(push.quiere({ push: { suscripciones: [] } }, 'viajeResuelto'), false);
  assert.strictEqual(push.quiere({ push: { avisos: { viajeResuelto: true } } }, 'viajeResuelto'), false);
});

test('no haber tocado la preferencia no es haberla desactivado', () => {
  // Confundir `undefined` con `false` deja a todo el mundo sin avisos; con
  // `true`, se los manda a quien no los quiere. Las dos cosas acaban igual: el
  // canal desactivado.
  const usuario = conSuscripcion();

  assert.strictEqual(push.quiere(usuario, 'viajeResuelto'), true, 'por defecto si');
  assert.strictEqual(push.quiere(usuario, 'cambioDivision'), false, 'por defecto no');
});

test('apagar un tipo lo apaga de verdad', () => {
  const usuario = conSuscripcion({
    push: {
      suscripciones: [{ endpoint: 'https://push.example/abc' }],
      avisos: { viajeResuelto: false, cambioDivision: true },
    },
  });

  assert.strictEqual(push.quiere(usuario, 'viajeResuelto'), false);
  assert.strictEqual(push.quiere(usuario, 'cambioDivision'), true);
});

// --- La racha, que es el aviso que justifica todo esto ---------------------------------

const HOY = '2026-08-23';

test('solo se avisa a quien tiene racha que perder y no ha salido hoy', () => {
  const usuarios = [
    { uid: 'a', racha: 5, ultimoDiaActivo: '2026-08-22', ...conSuscripcion() },
    // Ya ha salido: la racha esta salvada y el aviso sobra.
    { uid: 'b', racha: 5, ultimoDiaActivo: HOY, ...conSuscripcion() },
    // Sin racha no hay nada que perder y el aviso no significa nada.
    { uid: 'c', racha: 0, ultimoDiaActivo: '2026-08-01', ...conSuscripcion() },
    // Sin suscripcion.
    { uid: 'd', racha: 9, ultimoDiaActivo: '2026-08-22' },
  ];

  assert.deepStrictEqual(push.rachaEnPeligro(usuarios, HOY).map((u) => u.uid), ['a']);
});

test('quien ya ha salido hoy no recibe el aviso, con el dato real', () => {
  // `ultimoDiaActivo` NO es un 'YYYY-MM-DD': es la medianoche del dia en Madrid
  // en milisegundos, que es lo que escribe `rachas.diaDe`. El corte comparaba
  // los dos directamente, asi que nunca coincidian y el aviso de "tu racha esta
  // en peligro" salia cada tarde tambien a quien ya habia salido. La forma mas
  // rapida de que alguien apague los avisos.
  //
  // Las pruebas de arriba usan texto y siguen valiendo — una fecha de texto se
  // interpreta bien — pero ninguna probaba lo que guarda produccion.
  const rachas = require('../src/rachas');
  const mediodia = new Date('2026-08-23T12:00:00Z');
  const hoy = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(mediodia);

  const yaSalio = { uid: 'a', racha: 5, ultimoDiaActivo: rachas.diaDe(mediodia), ...conSuscripcion() };
  const noSalio = {
    uid: 'b', racha: 5,
    ultimoDiaActivo: rachas.diaDe(new Date('2026-08-22T12:00:00Z')),
    ...conSuscripcion(),
  };

  assert.deepStrictEqual(
    push.rachaEnPeligro([yaSalio, noSalio], hoy).map((u) => u.uid),
    ['b'],
    'se esta avisando a quien ya ha salido hoy'
  );
});

test('no se avisa dos veces el mismo dia', () => {
  // El worker corre cada cinco minutos. Sin esta marca, quien no salga se lleva
  // doce avisos en la hora que dura la ventana.
  const yaAvisado = {
    uid: 'a', racha: 5, ultimoDiaActivo: '2026-08-22',
    push: { suscripciones: [{ endpoint: 'x' }], ultimoAvisoRacha: HOY },
  };

  assert.deepStrictEqual(push.rachaEnPeligro([yaAvisado], HOY), []);

  // Pero al dia siguiente si.
  assert.strictEqual(push.rachaEnPeligro([yaAvisado], '2026-08-24').length, 1);
});

test('quien apago el aviso de racha no lo recibe', () => {
  const noQuiere = {
    uid: 'a', racha: 5, ultimoDiaActivo: '2026-08-22',
    push: { suscripciones: [{ endpoint: 'x' }], avisos: { rachaEnPeligro: false } },
  };

  assert.deepStrictEqual(push.rachaEnPeligro([noQuiere], HOY), []);
});

// --- Sin claves, y con suscripciones muertas -------------------------------------------

test('sin claves VAPID no se envia nada, y no es un error', async () => {
  // Es el estado normal hasta que alguien las genere. Que el worker reviente
  // por eso seria peor que quedarse sin avisos.
  bd = new FirestoreFalso();
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;

  const resultado = await push.enviar('u1', 'viajeResuelto', { titulo: 'x' });
  assert.deepStrictEqual(resultado, { enviados: 0, motivo: 'sin claves VAPID' });
});

test('una suscripcion que el servicio ya no reconoce se olvida', async () => {
  bd = new FirestoreFalso();
  bd.sembrar('usuarios', [{
    id: 'u1',
    push: {
      suscripciones: [
        { endpoint: 'https://push.example/viva' },
        { endpoint: 'https://push.example/muerta' },
      ],
    },
  }]);

  // El navegador revoca la suscripcion al desinstalar la app o al limpiar los
  // datos del sitio. Reintentarla es tirar tiempo en cada pasada, para siempre.
  await push.olvidar('u1', [{ endpoint: 'https://push.example/muerta' }]);

  const quedan = bd.leer('usuarios/u1').push.suscripciones;
  assert.deepStrictEqual(quedan.map((s) => s.endpoint), ['https://push.example/viva']);
});

// --- Lo que tiene que cuadrar entre los dos lados -----------------------------------------

test('los tipos que pinta el navegador son los que conoce el worker', () => {
  // Un interruptor para un tipo que el worker no conoce no apaga nada, y quien
  // lo use pensara que si.
  const generado = leer('assets/data/push-tipos.js');
  const enCliente = JSON.parse(generado.match(/export const TIPOS = ([\s\S]+);/)[1]);

  assert.deepStrictEqual(Object.keys(enCliente).sort(), Object.keys(push.TIPOS).sort());
  for (const [tipo, info] of Object.entries(push.TIPOS)) {
    assert.strictEqual(enCliente[tipo].porDefecto, info.porDefecto,
      `${tipo}: el cliente y el worker no coinciden en si va activado`);
  }
});

test('la clave privada no sale nunca al navegador', () => {
  // Con ella, cualquiera manda notificaciones en nombre del sitio.
  for (const fichero of ['assets/js/push.js', 'assets/data/push-config.js']) {
    const contenido = leer(fichero);
    assert.ok(!/VAPID_PRIVATE|privateKey/.test(contenido),
      `${fichero} menciona la clave privada`);
  }
});

test('el permiso se pide despues del primer trayecto, no al entrar', () => {
  // El permiso de notificaciones es de una sola oportunidad: si alguien dice
  // que no, el navegador lo recuerda y no lo vuelve a preguntar.
  const cliente = leer('assets/js/push.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const funcion = cliente.slice(cliente.indexOf('export async function ofrecerAvisos'));
  const cuerpo = funcion.slice(0, funcion.indexOf('\n}'));

  assert.match(cuerpo, /bf_primer_viaje_subido/,
    'se ofrecen los avisos sin esperar al primer trayecto');
  assert.match(cuerpo, /CLAVE_RECHAZO/, 'no se recuerda que ya dijo que no');
});

test('el service worker siempre ensena algo al recibir un aviso', () => {
  // `userVisibleOnly: true` obliga a ello: si el manejador no muestra
  // notificacion, el navegador ensena una generica y, si se repite, revoca el
  // permiso.
  const sw = leer('sw.js');
  assert.match(sw, /addEventListener\('push'/);
  assert.match(sw, /showNotification/);

  // Y ante una carga ilegible tambien: por eso el `catch` no puede salir sin
  // enseñar nada.
  const manejador = sw.slice(sw.indexOf("addEventListener('push'"));
  assert.ok(manejador.indexOf('showNotification') > manejador.indexOf('catch'),
    'una carga ilegible deja el aviso sin enseñar y el navegador revoca el permiso');
});

test('el generador no pisa la clave cuando no viene por entorno', () => {
  // La trampa: el CI corre `npm run datos` SIN la variable y despues comprueba
  // que los ficheros generados no han cambiado. Si el generador escribiera el
  // marcador, tener la clave puesta haria fallar el CI en cada pasada — y la
  // salida obvia, quitarla del control de versiones, dejaria el sitio
  // desplegado sin avisos.
  const generador = leer('scripts/build-push.js');

  assert.match(generador, /function claveAEscribir/);
  assert.match(generador, /readFileSync\(DESTINO/,
    'el generador no lee la clave que ya hay: la pisaria con el marcador');
});
