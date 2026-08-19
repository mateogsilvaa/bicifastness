'use strict';

/**
 * Pruebas del motor de verificacion. Sin framework: `node --test` basta.
 *   npm test
 */

const test = require('node:test');
const assert = require('node:assert');

const { evaluar, distanciaCalleMetros, velocidadKmh } = require('../src/verificacion');

// Ruta real: 002 (Metro Callao) -> 110 (Intercambiador de Moncloa).
const RUTA = '002-110';
const METROS = distanciaCalleMetros('002', '110');

/** Auditoria de IA "perfecta" para un tiempo dado. */
function iaLimpia(segundos, ruta = RUTA) {
  const [o, d] = ruta.split('-').map((v) => v.replace(/^0+/, ''));
  const salida = 10 * 3600;
  const llegada = salida + segundos;
  const hhmmss = (s) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, '0')).join(':');
  return {
    disponible: true, esBicimad: true, integridadVisual: true, confianza: 95,
    motivoManipulacion: '', origen: o, destino: d,
    segundosDuracion: segundos, horaSalida: hhmmss(salida), horaLlegada: hhmmss(llegada),
  };
}

function contextoBase(overrides = {}) {
  const tiempoSegundos = overrides.tiempoSegundos ?? 600;
  return {
    ruta: RUTA,
    tiempoSegundos,
    ia: iaLimpia(tiempoSegundos),
    hashSha: 'a'.repeat(64),
    hashPerceptual: '0f0f0f0f0f0f0f0f',
    shaPrevios: [],
    hashesPrevios: [],
    mejorTiempoRuta: null,
    mejorTiempoPropio: null,
    edicionSospechosa: false,
    software: null,
    ...overrides,
  };
}

test('la ruta de prueba tiene una distancia razonable', () => {
  assert.ok(METROS > 2000 && METROS < 6000, `distancia inesperada: ${METROS}`);
});

test('un viaje limpio y plausible se aprueba solo', () => {
  const r = evaluar(contextoBase());
  assert.strictEqual(r.decision, 'aprobado');
  assert.strictEqual(r.señales.length, 0);
});

test('un tiempo fisicamente imposible se rechaza solo', () => {
  // Recorrer ~3,5 km en 120 s son mas de 100 km/h.
  const r = evaluar(contextoBase({ tiempoSegundos: 120 }));
  assert.strictEqual(r.decision, 'rechazado');
  assert.ok(r.señales.some((s) => s.codigo === 'velocidad_imposible'));
  assert.match(r.resumen, /imposible/);
});

test('una velocidad alta pero posible va a revision, no a la basura', () => {
  // Ajustamos el tiempo para caer entre 21 y 25 km/h.
  const segundos = Math.round((METROS / 1000) / 23 * 3600);
  const r = evaluar(contextoBase({ tiempoSegundos: segundos }));
  assert.strictEqual(r.decision, 'revision');
  assert.ok(r.señales.some((s) => s.codigo === 'velocidad_sospechosa'));
});

test('descuadre entre las horas y el recuadro de duracion = manipulacion', () => {
  const ia = iaLimpia(600);
  ia.segundosDuracion = 300; // el usuario ha retocado solo el numero grande
  const r = evaluar(contextoBase({ tiempoSegundos: 300, ia }));
  assert.strictEqual(r.decision, 'rechazado');
  assert.ok(r.señales.some((s) => s.codigo === 'captura_incoherente'));
});

test('la captura reenviada byte a byte se rechaza', () => {
  const r = evaluar(contextoBase({
    shaPrevios: [{ sha: 'a'.repeat(64), tripId: 'viaje-viejo', uid: 'otro' }],
  }));
  assert.strictEqual(r.decision, 'rechazado');
  assert.ok(r.señales.some((s) => s.codigo === 'captura_reutilizada'));
});

test('la misma captura recomprimida tambien se rechaza (hash perceptual)', () => {
  const r = evaluar(contextoBase({
    hashPerceptual: '0f0f0f0f0f0f0f0f',
    // Un solo bit de diferencia: misma imagen, otro fichero.
    hashesPrevios: [{ dhash: '0f0f0f0f0f0f0f0e', tripId: 'viaje-viejo' }],
  }));
  assert.strictEqual(r.decision, 'rechazado');
  assert.ok(r.señales.some((s) => s.codigo === 'captura_casi_identica'));
});

test('una captura distinta no se confunde con un duplicado', () => {
  const r = evaluar(contextoBase({
    hashPerceptual: '0f0f0f0f0f0f0f0f',
    hashesPrevios: [{ dhash: 'f0f0f0f0f0f0f0f0', tripId: 'otro' }],
  }));
  assert.strictEqual(r.decision, 'aprobado');
});

test('la IA declara la imagen manipulada y se rechaza', () => {
  const ia = iaLimpia(600);
  ia.integridadVisual = false;
  ia.motivoManipulacion = 'La hora de llegada usa otra fuente';
  const r = evaluar(contextoBase({ ia }));
  assert.strictEqual(r.decision, 'rechazado');
  assert.ok(r.señales.some((s) => s.codigo === 'manipulacion_visual'));
});

test('si la IA no responde, el viaje va a revision (no se aprueba a ciegas)', () => {
  const r = evaluar(contextoBase({
    ia: { disponible: false, error: 'timeout' },
  }));
  assert.strictEqual(r.decision, 'revision');
  assert.ok(r.señales.some((s) => s.codigo === 'ia_no_disponible'));
});

test('romper el record por mucho margen siempre pasa por revision humana', () => {
  const r = evaluar(contextoBase({ tiempoSegundos: 600, mejorTiempoRuta: 900 }));
  assert.strictEqual(r.decision, 'revision');
  assert.ok(r.señales.some((s) => s.codigo === 'record_pulverizado'));
});

test('mejorar el record por poco margen no molesta a nadie', () => {
  const r = evaluar(contextoBase({ tiempoSegundos: 600, mejorTiempoRuta: 620 }));
  assert.strictEqual(r.decision, 'aprobado');
});

test('los metadatos de un editor de imagen levantan sospecha', () => {
  const r = evaluar(contextoBase({ edicionSospechosa: true, software: 'Photoshop' }));
  assert.strictEqual(r.decision, 'revision');
  assert.ok(r.señales.some((s) => s.codigo === 'metadatos_edicion'));
});

test('la ruta leida en la foto no coincide con la declarada', () => {
  const ia = iaLimpia(600);
  ia.origen = '999';
  const r = evaluar(contextoBase({ ia }));
  assert.ok(['revision', 'rechazado'].includes(r.decision));
  assert.ok(r.señales.some((s) => s.codigo === 'ruta_no_coincide'));
});

test('el veredicto es serializable y explica siempre el motivo', () => {
  const r = evaluar(contextoBase({ tiempoSegundos: 120 }));
  assert.doesNotThrow(() => JSON.stringify(r));
  assert.ok(r.resumen.length > 0);
  assert.ok(Number.isFinite(r.riesgo));
  assert.ok(r.señales.every((s) => s.codigo && s.mensaje));
  // Las marcas internas no se filtran al documento guardado.
  assert.ok(r.señales.every((s) => !('decisiva' in s)));
});

test('velocidadKmh calcula bien', () => {
  assert.strictEqual(Math.round(velocidadKmh(1000, 360)), 10);
});

// --- Deteccion estadistica ----------------------------------------------------

test('un tiempo muy fuera de la distribucion de la ruta se marca', () => {
  // La ruta se corre habitualmente en torno a 600 s con poca dispersion.
  const tiemposRuta = [590, 600, 605, 610, 615, 620, 625, 630];
  const r = evaluar(contextoBase({ tiempoSegundos: 450, tiemposRuta, mejorTiempoRuta: 590 }));
  assert.ok(r.señales.some((s) => s.codigo === 'atipico_estadistico'));
});

test('con pocas marcas no se aplica la estadistica (no hay muestra)', () => {
  const r = evaluar(contextoBase({ tiempoSegundos: 450, tiemposRuta: [600, 620] }));
  assert.ok(!r.señales.some((s) => s.codigo === 'atipico_estadistico'));
});

test('un tiempo normal dentro de la distribucion no molesta', () => {
  const tiemposRuta = [560, 580, 600, 610, 620, 640, 660, 700];
  const r = evaluar(contextoBase({ tiempoSegundos: 595, tiemposRuta }));
  assert.ok(!r.señales.some((s) => s.codigo === 'atipico_estadistico'));
  assert.strictEqual(r.decision, 'aprobado');
});

test('una ruta donde todos hacen el mismo tiempo no genera falsos positivos', () => {
  // Desviacion tipica cero: dividir por ella daria Infinity.
  const tiemposRuta = [600, 600, 600, 600, 600, 600, 600];
  const r = evaluar(contextoBase({ tiempoSegundos: 600, tiemposRuta }));
  assert.ok(!r.señales.some((s) => s.codigo === 'atipico_estadistico'));
});

// --- Perfil del piloto ---------------------------------------------------------

test('un salto brusco sobre el ritmo habitual del piloto se marca', () => {
  // Va siempre a ~12 km/h y de golpe aparece muy por encima.
  const r = evaluar(contextoBase({
    tiempoSegundos: 400,
    velocidadesPrevias: [11.5, 12, 12.4, 11.8, 12.1],
  }));
  assert.ok(r.señales.some((s) => s.codigo === 'salto_de_ritmo'));
});

test('sin historial suficiente no se juzga el ritmo del piloto', () => {
  const r = evaluar(contextoBase({ tiempoSegundos: 400, velocidadesPrevias: [12, 12] }));
  assert.ok(!r.señales.some((s) => s.codigo === 'salto_de_ritmo'));
});

test('mantener el ritmo de siempre no levanta ninguna alerta', () => {
  const r = evaluar(contextoBase({
    tiempoSegundos: 600,
    velocidadesPrevias: [20, 21, 20.5, 21.2, 20.8],
  }));
  assert.ok(!r.señales.some((s) => s.codigo === 'salto_de_ritmo'));
});

// --- Horario -------------------------------------------------------------------

test('un trayecto de madrugada se anota como contexto', () => {
  const ia = iaLimpia(600);
  ia.horaSalida = '03:20:00';
  ia.horaLlegada = '03:30:00';
  const r = evaluar(contextoBase({ ia }));
  assert.ok(r.señales.some((s) => s.codigo === 'horario_inusual'));
  // Por si sola no basta para sacarlo de aprobado: es solo un dato.
  assert.strictEqual(r.decision, 'aprobado');
});

test('un trayecto a media tarde no genera nada', () => {
  const r = evaluar(contextoBase());
  assert.ok(!r.señales.some((s) => s.codigo === 'horario_inusual'));
});

// --- Combinacion ---------------------------------------------------------------

test('varias señales debiles juntas mandan el viaje a revision', () => {
  // Ninguna es concluyente, pero sumadas pasan del umbral de aprobacion.
  const ia = iaLimpia(600);
  ia.horaSalida = '03:00:00';
  ia.horaLlegada = '03:10:00';
  const r = evaluar(contextoBase({
    tiempoSegundos: 600,
    ia,
    tiemposRuta: [700, 710, 715, 720, 725, 730, 740, 750],
    velocidadesPrevias: [9, 9.5, 10, 9.8, 10.2],
  }));
  assert.strictEqual(r.decision, 'revision');
  assert.ok(r.señales.length >= 3, `esperaba varias señales, hay ${r.señales.length}`);
});
