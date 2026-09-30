/**
 * Las plantillas de 10 · Correos que no existian: error al procesar, mensaje
 * del equipo, suspension, contraseña cambiada y la de Firebase para
 * restablecer.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const plantillas = require('../src/plantillas');
const correo = require('../src/correo');

const MALO = '<script>alert(1)</script>';

test('cada tipo de correo tiene plantilla y prioridad', () => {
  for (const tipo of ['error_procesar', 'mensaje_equipo', 'cuenta_suspendida', 'clave_cambiada']) {
    assert.strictEqual(typeof plantillas.POR_TIPO[tipo], 'function', tipo);
    assert.ok(tipo in correo.PRIORIDAD, `${tipo} sin prioridad en la cola`);
  }
});

test('el mensaje del equipo escapa lo que escribe la administracion', () => {
  const m = plantillas.mensajeEquipo({
    nombre: MALO, asunto: MALO, texto: `Hola\n\n${MALO}`, sobre: MALO, tokenBaja: 't'.repeat(40),
  });
  assert.ok(!m.html.includes('<script>'));
  assert.ok(!m.asunto.includes('<'));
  // 10d: lo escribe una persona a una persona; el diseño no lleva baja.
  assert.doesNotMatch(m.html, /\/baja\/\?t=/);
});

test('suspension y cambio de contraseña no llevan baja: no son producto', () => {
  const s = plantillas.cuentaSuspendida({ nombre: 'Ana', motivo: 'Capturas editadas' });
  const c = plantillas.contrasenaCambiada({ nombre: 'Ana', cuando: 'hoy', dispositivo: 'Chrome en Android' });
  for (const m of [s, c]) {
    assert.ok(!m.html.includes('/baja/'));
    assert.ok(m.texto.length > 50);
  }
  assert.match(s.html, /Sin fecha de fin/);
  assert.match(c.html, /Chrome en Android/);
});

test('el error al procesar no culpa a la persona ni cuenta el antifraude', () => {
  const m = plantillas.errorAlProcesar({ nombre: 'Ana', ruta: 'Sol → Ópera', tokenBaja: 'x'.repeat(40) });
  assert.match(m.html, /El fallo es nuestro, no de tu trayecto/);
  assert.doesNotMatch(m.html, /riesgo|umbral|dHash|EXIF/i);
});

test('el rechazo hecho por una persona no ofrece pedir revision otra vez', () => {
  const m = plantillas.viajeRechazado({
    nombre: 'Ana', ruta: 'Sol → Ópera', motivo: 'La hora no cuadra', dePersona: true, puedePedirRevision: false,
  });
  assert.match(m.html, /quien lo ha revisado/);
  assert.doesNotMatch(m.html, /reclamarlo/);
});

test('la plantilla de Firebase lleva sus comodines y el boton de Outlook', () => {
  const html = plantillas.PLANTILLA_FIREBASE_RESTABLECER;
  assert.match(html, /%LINK%/);
  assert.match(html, /%EMAIL%/);
  assert.match(html, /v:roundrect/);
  assert.match(html, /prefers-color-scheme: ?dark/);
});
