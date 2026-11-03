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

test('las claves de Gemini se turnan: si una se queda sin cupo, la siguiente', async () => {
  const antes = { ...process.env };
  const fetchAntes = global.fetch;
  process.env.GEMINI_API_1 = 'k1';
  process.env.GEMINI_API_2 = 'k2';
  process.env.GEMINI_API_3 = '';
  const usadas = [];
  global.fetch = async (_url, opciones) => {
    const clave = opciones.headers['x-goog-api-key'];
    usadas.push(clave);
    if (clave === 'k1') return new Response('{"error":"quota"}', { status: 429 });
    const texto = JSON.stringify({ esBicimad: true, trayectos: [{ origen: '1', destino: '2', duracion: '00:10:00' }] });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: texto }] } }] }), { status: 200 });
  };
  try {
    delete require.cache[require.resolve('../src/lector-ia')];
    const { leerConIA } = require('../src/lector-ia');
    const png = await require('sharp')({ create: { width: 20, height: 40, channels: 3, background: '#fff' } }).png().toBuffer();
    const l = await leerConIA({ buffer: png });
    assert.strictEqual(l.disponible, true);
    assert.strictEqual(l.segundosDuracion, 600);
    // La 1 sin cupo no se vuelve a probar en esta ejecucion.
    await leerConIA({ buffer: png });
    assert.deepStrictEqual(usadas, ['k1', 'k2', 'k2']);
  } finally {
    global.fetch = fetchAntes;
    process.env = antes;
    delete require.cache[require.resolve('../src/lector-ia')];
  }
});

test('si un modelo de Gemini ya no existe (404), se prueba el siguiente con la misma clave', async () => {
  const antes = { ...process.env };
  const fetchAntes = global.fetch;
  process.env.GEMINI_API_1 = 'k1';
  process.env.GEMINI_API_2 = '';
  process.env.GEMINI_API_3 = '';
  delete process.env.MODELO_IA;
  const pedidos = [];
  global.fetch = async (url) => {
    pedidos.push(String(url).match(/models\/([^:]+)/)[1]);
    if (String(url).includes('gemini-2.5-flash')) return new Response('{"error":{"message":"not found"}}', { status: 404 });
    const texto = JSON.stringify({ esBicimad: true, trayectos: [{ origen: '1', destino: '2', duracion: '00:10:00' }] });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: texto }] } }] }), { status: 200 });
  };
  try {
    delete require.cache[require.resolve('../src/lector-ia')];
    const { leerConIA } = require('../src/lector-ia');
    const png = await require('sharp')({ create: { width: 20, height: 40, channels: 3, background: '#fff' } }).png().toBuffer();
    const l = await leerConIA({ buffer: png });
    assert.strictEqual(l.disponible, true);
    assert.deepStrictEqual(pedidos, ['gemini-2.5-flash', 'gemini-flash-latest']);
  } finally {
    global.fetch = fetchAntes;
    process.env = antes;
    delete require.cache[require.resolve('../src/lector-ia')];
  }
});
