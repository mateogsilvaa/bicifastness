const test = require('node:test');
const assert = require('node:assert');
const { aLectura } = require('../src/lector-ia');

test('la respuesta del modelo se convierte en una lectura como la del OCR', () => {
  const l = aLectura('```json\n{"esBicimad": true, "trayectos": [{"origen": "393", "destino": "53 - Metro", "horaSalida": "16:23:14", "horaLlegada": "16:36:54", "duracion": "00:13:40", "fecha": "2026-11-03", "bici": "18754"}]}\n```');
  assert.strictEqual(l.disponible, true);
  assert.strictEqual(l.fuente, 'ia');
  assert.deepStrictEqual(
    [l.origen, l.destino, l.horaSalida, l.horaLlegada, l.segundosDuracion, l.fecha, l.numeroBici],
    ['393', '53', '16:23:14', '16:36:54', 820, '2026-11-03', '18754'],
  );
});

test('una respuesta rota o sin trayectos no es una lectura', () => {
  assert.strictEqual(aLectura('no se').disponible, false);
  assert.strictEqual(aLectura('{"esBicimad": true, "trayectos": []}').disponible, false);
  assert.strictEqual(aLectura('{"trayectos": [{"origen": "", "destino": "5"}]}').disponible, false);
  // Horas sin cero delante y duracion en mm:ss.
  const l = aLectura('{"esBicimad": true, "trayectos": [{"origen": "1", "destino": "2", "horaSalida": "9:05", "horaLlegada": "9:20", "duracion": "15:00"}]}');
  assert.strictEqual(l.horaSalida, '09:05');
  assert.strictEqual(l.segundosDuracion, 900);
});
