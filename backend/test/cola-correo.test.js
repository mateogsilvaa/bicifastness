'use strict';

/**
 * La cola de correos pendientes (#65).
 *
 * Lo que se prueba aqui es lo unico que tiene decision: cuando toca reintentar
 * y que se cae primero cuando no hay cupo para todos. El envio en si es red, y
 * eso lo cubre `correo.test.js`.
 */

const test = require('node:test');
const assert = require('node:assert');

const cola = require('../src/cola-correo');
const correo = require('../src/correo');

const AHORA = new Date('2026-08-26T12:00:00Z');
const haceMinutos = (n) => new Date(AHORA.getTime() - n * 60000);
const enMinutos = (n) => new Date(AHORA.getTime() + n * 60000);

test('lo que se encola no lleva ni el destinatario ni el mensaje montado', () => {
  // Es la razon de que la cola exista con esta forma y no con otra. El correo
  // vive en Firebase Auth y el mensaje lleva dentro el nombre de la persona:
  // guardar cualquiera de las dos cosas en Firestore es lo que se saco de ahi
  // en #59 y #60. Se resuelven las dos al enviar.
  const e = cola.entrada('u1', 'viaje_rechazado', { ruta: '002-110' }, AHORA);

  const claves = Object.keys(e);
  assert.ok(!claves.some((k) => /correo|email|para|html|texto|asunto|nombre/i.test(k)),
    `la cola guarda algo que no deberia: ${claves.join(', ')}`);

  assert.strictEqual(e.uid, 'u1');
  assert.strictEqual(e.tipo, 'viaje_rechazado');
  assert.deepStrictEqual(e.extra, { ruta: '002-110' });
});

test('el primer reintento no es inmediato', () => {
  // Si Resend acaba de devolver un 429, volver a la carga en la misma pasada es
  // empujar mas fuerte justo cuando pide que pares.
  const e = cola.entrada('u1', 'bienvenida', {}, AHORA);

  assert.ok(e.reintentarTras > AHORA, 'se reintentaria en la misma pasada');
});

test('no se toca lo que todavia no le toca', () => {
  const { ahora } = cola.tocaAhora([
    { tipo: 'bienvenida', reintentarTras: enMinutos(30) },
  ], { ahora: AHORA });

  assert.deepStrictEqual(ahora, []);
});

test('cuando se acaba el cupo, lo que se cae es lo que menos importa', () => {
  // Es para lo que estaba `repartirCupo`, sin llamar desde el principio. Un
  // rechazo es informacion que la persona necesita para arreglar su viaje; un
  // resumen semanal, no.
  const { ahora, esperan } = cola.tocaAhora([
    { tipo: 'resumen_semanal', reintentarTras: haceMinutos(10) },
    { tipo: 'viaje_rechazado', reintentarTras: haceMinutos(10) },
  ], { enviadosHoy: correo.MAX_DIARIO - 1, ahora: AHORA });

  assert.deepStrictEqual(ahora.map((x) => x.tipo), ['viaje_rechazado']);
  assert.deepStrictEqual(esperan.map((x) => x.tipo), ['resumen_semanal']);
});

test('un tipo que nadie conoce va al final, no al principio', () => {
  // `PRIORIDAD` no lo tiene, asi que cae en el 9. Si cayera en 0 —un `||` en vez
  // de un `??`— un correo desconocido adelantaria a un rechazo.
  const { ahora } = cola.tocaAhora([
    { tipo: 'lo_que_sea', reintentarTras: haceMinutos(1) },
    { tipo: 'viaje_rechazado', reintentarTras: haceMinutos(1) },
  ], { enviadosHoy: correo.MAX_DIARIO - 1, ahora: AHORA });

  assert.deepStrictEqual(ahora.map((x) => x.tipo), ['viaje_rechazado']);
});

test('acepta la marca de tiempo tal y como la escribe Firestore', () => {
  // Firestore devuelve `Timestamp`, no `Date`. Compararlo a pelo con una fecha
  // da siempre falso y la cola no se vaciaria nunca.
  const comoFirestore = { toDate: () => haceMinutos(5) };

  const { ahora } = cola.tocaAhora([
    { tipo: 'bienvenida', reintentarTras: comoFirestore },
  ], { ahora: AHORA });

  assert.strictEqual(ahora.length, 1);
});

test('una entrada sin marca de tiempo se intenta, no se queda atascada', () => {
  const { ahora } = cola.tocaAhora([{ tipo: 'bienvenida' }], { ahora: AHORA });

  assert.strictEqual(ahora.length, 1);
});

test('se acaba rindiendo, no reintenta para siempre', () => {
  // Sin esto, una direccion que rebota siempre se queda dando vueltas en la cola
  // gastando cupo del resto.
  let entrada = { tipo: 'bienvenida', intentos: 0 };

  for (let i = 0; i < 10; i++) {
    const v = correo.decidirReintento(entrada, { enviado: false, reintentable: true }, AHORA);
    if (v.estado === 'fallido') {
      assert.ok(i < 5, `ha tardado ${i} intentos en rendirse`);
      return;
    }
    entrada = { ...entrada, intentos: v.intentos };
  }

  assert.fail('la cola reintentaria para siempre');
});
