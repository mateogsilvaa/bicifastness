'use strict';

/**
 * Correo transaccional.
 *
 * Lo que se prueba aqui no es que Resend funcione, sino las tres cosas que
 * pueden salir caras: que no se envie nada en simulacion, que no se filtre como
 * funciona el antifraude, y que el nombre del usuario no pueda inyectar HTML en
 * el correo de otra persona.
 */

const test = require('node:test');
const assert = require('node:assert');

const correo = require('../src/correo');
const plantillas = require('../src/plantillas');

// --- Envio -------------------------------------------------------------------

test('en simulacion no se envia nada', async () => {
  // El worker corre con --simular a menudo. Mandar correo de verdad desde una
  // simulacion es justo el efecto secundario que una simulacion no debe tener.
  const r = await correo.enviar({
    para: 'alguien@ejemplo.es',
    asunto: 'prueba',
    html: '<p>hola</p>',
    texto: 'hola',
    apiKey: 'clave-de-verdad',
    simular: true,
  });

  assert.strictEqual(r.enviado, false);
  assert.strictEqual(r.simulado, true);
});

test('sin clave no se intenta enviar, y se explica', async () => {
  const r = await correo.enviar({ para: 'a@b.es', asunto: 'x', apiKey: '' });
  assert.strictEqual(r.enviado, false);
  assert.match(r.error, /RESEND_API_KEY/);
});

test('sin destinatario no se envia', async () => {
  const r = await correo.enviar({ asunto: 'x', apiKey: 'k' });
  assert.strictEqual(r.enviado, false);
  assert.match(r.error, /destinatario/);
});

// --- Cupo diario -------------------------------------------------------------

test('lo urgente se envia antes que lo prescindible', () => {
  const cola = [
    { tipo: 'resumen_semanal', para: '1@a.es' },
    { tipo: 'viaje_rechazado', para: '2@a.es' },
    { tipo: 'viajes_verificados', para: '3@a.es' },
    { tipo: 'bienvenida', para: '4@a.es' },
  ];

  const { ahora } = correo.repartirCupo(cola, 0);
  assert.deepStrictEqual(ahora.map((c) => c.tipo),
    ['viaje_rechazado', 'bienvenida', 'viajes_verificados', 'resumen_semanal']);
});

test('al agotar el cupo del dia, lo que sobra espera en vez de perderse', () => {
  const cola = Array.from({ length: 5 }, (_, i) => ({ tipo: 'resumen_semanal', para: `${i}@a.es` }));
  const { ahora, esperan } = correo.repartirCupo(cola, correo.MAX_DIARIO - 2);

  assert.strictEqual(ahora.length, 2);
  assert.strictEqual(esperan.length, 3, 'los que no caben no se descartan');
});

test('con el cupo agotado no se envia nada', () => {
  const cola = [{ tipo: 'viaje_rechazado', para: 'a@b.es' }];
  const { ahora, esperan } = correo.repartirCupo(cola, correo.MAX_DIARIO);

  assert.strictEqual(ahora.length, 0);
  assert.strictEqual(esperan.length, 1);
});

test('el tope propio deja margen contra el limite real de Resend', () => {
  // Resend corta en 100 al dia en el plan gratuito. Apurar hasta 100 significa
  // que el correo numero 100 falla en vez de encolarse.
  assert.ok(correo.MAX_DIARIO < 100, 'sin margen se choca con el limite de Resend');
});

// --- Plantillas --------------------------------------------------------------

test('el nombre del usuario no puede inyectar HTML', () => {
  // El nombre de piloto lo elige la persona y acaba dentro del HTML del correo.
  const malicioso = '<img src=x onerror="alert(1)">';
  const { html, asunto } = plantillas.bienvenida({ nombre: malicioso });

  assert.ok(!html.includes('<img src=x'), 'el HTML del usuario ha sobrevivido');
  assert.ok(html.includes('&lt;img'), 'deberia estar escapado');
  assert.ok(!asunto.includes('<'), 'ni siquiera en el asunto');
});

test('un rechazo no revela como funciona el antifraude', () => {
  // Quien intenta colar una captura aprenderia exactamente que ajustar.
  const { html, texto } = plantillas.viajeRechazado({
    nombre: 'Ana',
    ruta: '002-110',
    motivo: 'No hemos podido verificar la captura.',
  });

  for (const filtracion of ['riesgo', 'umbral', 'dHash', 'hamming', 'perceptual', 'EXIF']) {
    assert.ok(!html.toLowerCase().includes(filtracion.toLowerCase()),
      `el correo menciona "${filtracion}"`);
    assert.ok(!texto.toLowerCase().includes(filtracion.toLowerCase()),
      `el texto plano menciona "${filtracion}"`);
  }
});

test('un rechazo dice que hacer, no solo que ha fallado', () => {
  const { html } = plantillas.viajeRechazado({ nombre: 'Ana', ruta: '002-110', motivo: 'x' });
  assert.match(html, /volviendo a subir/i, 'no explica como arreglarlo');
  assert.match(html, /reclamarlo/i, 'no ofrece impugnar, que exige el RGPD art. 22.3');
});

test('todas las plantillas traen version en texto plano', () => {
  // Sin ella, varios clientes marcan el correo como sospechoso.
  const casos = [
    plantillas.bienvenida({ nombre: 'Ana' }),
    plantillas.viajeRechazado({ nombre: 'Ana', ruta: '002-110', motivo: 'x' }),
    plantillas.viajeAnulado({ nombre: 'Ana', ruta: '002-110', motivo: 'x' }),
    plantillas.viajesVerificados({ nombre: 'Ana', viajes: [{ ruta: '002-110', puntos: 40, distanciaMetros: 2000 }] }),
    plantillas.revisionLenta({ nombre: 'Ana', ruta: '002-110' }),
  ];

  for (const c of casos) {
    assert.ok(c.asunto && c.asunto.length > 0, 'falta asunto');
    assert.ok(c.html && c.html.includes('<html'), 'falta HTML');
    assert.ok(c.texto && c.texto.length > 20, 'falta version en texto plano');
    assert.ok(!c.texto.includes('<'), 'la version de texto lleva HTML dentro');
  }
});

test('el aviso de verificados va agrupado y suma bien', () => {
  const { asunto, html, texto } = plantillas.viajesVerificados({
    nombre: 'Ana',
    viajes: [
      { ruta: '002-110', puntos: 40, distanciaMetros: 2000 },
      { ruta: '110-002', puntos: 35, distanciaMetros: 2000 },
    ],
  });

  assert.match(asunto, /^2 trayectos verificados$/);
  assert.ok(html.includes('75 puntos'), 'no suma los puntos');
  assert.ok(texto.includes('4.0 km'), 'no suma la distancia');
});

test('un solo viaje no dice "1 trayectos"', () => {
  const { asunto } = plantillas.viajesVerificados({
    nombre: 'Ana',
    viajes: [{ ruta: '002-110', puntos: 40, distanciaMetros: 2000 }],
  });
  assert.match(asunto, /^1 trayecto verificado$/);
});

test('todo correo lleva el aviso de independencia', () => {
  // El aviso legal del proyecto lo exige: no hay relacion con BiciMAD ni la EMT.
  const { html } = plantillas.bienvenida({ nombre: 'Ana' });
  assert.match(html, /Proyecto independiente/);
});

// --- Baja sin iniciar sesion -------------------------------------------------

test('el token de baja es largo e impredecible', () => {
  const a = correo.generarTokenBaja();
  const b = correo.generarTokenBaja();

  assert.notStrictEqual(a, b, 'dos tokens seguidos no pueden coincidir');
  // El mismo rango y alfabeto que exigen las reglas de Firestore.
  assert.match(a, /^[A-Za-z0-9_-]{32,128}$/);
});

test('el token no lleva dentro nada del usuario', () => {
  // Es una llave suelta: el worker la cambia por el usuario mirando quien la
  // tiene guardada. Si llevara el uid, interceptar un correo revelaria quien es.
  const token = correo.generarTokenBaja();
  assert.ok(!/@/.test(token), 'parece contener un correo');
  assert.ok(!/=/.test(token), 'base64url no lleva relleno, y el relleno delata la longitud del contenido');
});

test('todos los correos llevan enlace de baja, en HTML y en texto', () => {
  // Quien no encuentra como darse de baja marca el correo como spam, y eso
  // hunde la reputacion del dominio para todo el mundo.
  const token = 'a'.repeat(43);
  const casos = [
    plantillas.bienvenida({ nombre: 'Ana', tokenBaja: token }),
    plantillas.viajeRechazado({ nombre: 'Ana', ruta: '002-110', motivo: 'x', tokenBaja: token }),
    plantillas.viajeAnulado({ nombre: 'Ana', ruta: '002-110', motivo: 'x', tokenBaja: token }),
    plantillas.viajesVerificados({ nombre: 'Ana', viajes: [{ ruta: 'a', puntos: 1, distanciaMetros: 1 }], tokenBaja: token }),
    plantillas.revisionLenta({ nombre: 'Ana', ruta: '002-110', tokenBaja: token }),
  ];

  for (const c of casos) {
    assert.ok(c.html.includes(`/baja/?t=${token}`), `sin enlace de baja en el HTML de "${c.asunto}"`);
    assert.ok(c.texto.includes(`/baja/?t=${token}`), `sin enlace de baja en el texto de "${c.asunto}"`);
  }
});

test('el token viaja escapado en la URL', () => {
  const { html } = plantillas.bienvenida({ nombre: 'Ana', tokenBaja: 'a b&c' });
  assert.ok(!html.includes('t=a b&c'), 'el token va crudo en la URL');
  assert.ok(html.includes('a%20b%26c'));
});

// --- Reintentos --------------------------------------------------------------

const AHORA = new Date('2026-08-20T10:00:00Z');

test('un envio correcto no se reintenta', () => {
  const d = correo.decidirReintento({ intentos: 0 }, { enviado: true }, AHORA);

  assert.strictEqual(d.estado, 'enviado');
  assert.ok(!d.reintentarTras, 'no deberia programar otro intento');
});

test('un error definitivo no se reintenta', () => {
  // Un 422 por direccion invalida no mejora reintentando: solo gasta cupo.
  const d = correo.decidirReintento(
    { intentos: 0 },
    { enviado: false, reintentable: false, error: 'Resend HTTP 422' },
    AHORA);

  assert.strictEqual(d.estado, 'fallido');
  assert.strictEqual(d.intentos, 1);
});

test('un error temporal se reintenta con espera creciente', () => {
  // Reintentar cada minuto contra un servicio saturado solo empuja mas.
  let entrada = { intentos: 0 };
  const esperas = [];

  for (let i = 0; i < 3; i++) {
    const d = correo.decidirReintento(entrada, { enviado: false, reintentable: true }, AHORA);
    assert.strictEqual(d.estado, 'pendiente');
    esperas.push(Math.round((d.reintentarTras - AHORA) / 60000));
    entrada = { intentos: d.intentos };
  }

  assert.deepStrictEqual(esperas, [5, 20, 90]);
  for (let i = 1; i < esperas.length; i++) {
    assert.ok(esperas[i] > esperas[i - 1], 'la espera deberia crecer');
  }
});

test('se abandona tras agotar los intentos', () => {
  const d = correo.decidirReintento(
    { intentos: correo.MAX_INTENTOS - 1 },
    { enviado: false, reintentable: true },
    AHORA);

  assert.strictEqual(d.estado, 'fallido');
  assert.match(d.error, /agotados/);
});

test('una direccion que rebota deja de recibir intentos', () => {
  // Seguir escribiendo a direcciones muertas hunde la reputacion del dominio, y
  // con ella la entregabilidad de todos los demas correos.
  assert.strictEqual(correo.debeDejarDeIntentar({ rebotes: 0 }), false);
  assert.strictEqual(correo.debeDejarDeIntentar({ rebotes: 1 }), false);
  assert.strictEqual(correo.debeDejarDeIntentar({ rebotes: 2 }), true);
});

test('el ultimo intento cae mas de una hora despues', () => {
  // Da margen a que una caida corta se arregle sin que nadie intervenga.
  const total = [0, 1, 2, 3].reduce((t, i) => t + correo.esperaMinutos(i), 0);
  assert.ok(total > 60, `los reintentos se agotan en ${total} min`);
});
