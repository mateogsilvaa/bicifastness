'use strict';

/**
 * Parseo de lo que devuelve el OCR.
 *
 * Se prueba el PARSEO, no el reconocimiento: pasar tesseract por cada test lo
 * haria lento y dependeria de los datos de idioma. Que el OCR acierte sobre
 * capturas reales es otra cosa, y depende del banco del issue #16.
 *
 * Estas funciones son la parte que puede fallar en silencio: si el parseo
 * confunde una hora con una duracion, el motor de decision compara numeros que
 * no son y empieza a rechazar viajes buenos.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ocr = require('../src/ocr');

const CAPTURA = `BiciMAD
Trayecto finalizado
002 - Metro Callao (002)
110 - Intercambiador de Moncloa (110)
Salida  18:42
Llegada 18:54
Duracion 12 min 15 s`;

test('lee las dos horas en orden', () => {
  assert.deepStrictEqual(ocr.extraerHoras(CAPTURA), ['18:42', '18:54']);
});

test('descarta lo que no puede ser una hora', () => {
  assert.deepStrictEqual(ocr.extraerHoras('25:00 y 12:99 y 09:30'), ['09:30']);
});

test('no repite una hora que aparece dos veces', () => {
  assert.deepStrictEqual(ocr.extraerHoras('18:42 ... 18:42 ... 19:00'), ['18:42', '19:00']);
});

test('lee las estaciones del formato de la app', () => {
  assert.deepStrictEqual(ocr.extraerEstaciones(CAPTURA), ['002', '110']);
});

test('si no hay parentesis, cae al numero al principio de linea', () => {
  assert.deepStrictEqual(ocr.extraerEstaciones('2 - Metro Callao\n110 - Moncloa'), ['2', '110']);
});

test('la duracion se lee con unidades y con mm:ss etiquetado', () => {
  assert.strictEqual(ocr.extraerDuracion(CAPTURA), 735);
  assert.strictEqual(ocr.extraerDuracion('Duración 12:15'), 735);
  assert.strictEqual(ocr.extraerDuracion('8 min'), 480);
});

test('una hora suelta NO se toma por una duracion', () => {
  // Es el error que mas dano haria: el motor compararia 18 min con el tiempo
  // declarado y rechazaria viajes correctos.
  assert.strictEqual(ocr.extraerDuracion('Salida 18:42'), null);
  assert.strictEqual(ocr.extraerDuracion('Llegada 09:05'), null);
});

test('sin duracion legible devuelve null, no un cero', () => {
  // Un 0 se colaria como duracion valida; null hace que el motor lo mande a
  // revision, que es lo correcto cuando no se sabe.
  assert.strictEqual(ocr.extraerDuracion('nada que ver aqui'), null);
});

test('los marcadores de BiciMAD estan en minusculas', () => {
  // El texto se compara en minusculas antes de buscarlos: un marcador con
  // mayusculas no coincidiria nunca y `esBicimad` seria siempre false.
  for (const marcador of ocr.MARCADORES) {
    assert.strictEqual(marcador, marcador.toLowerCase(), `"${marcador}" lleva mayusculas`);
  }
});

test('leerCaptura nunca lanza, aunque le des basura', async () => {
  // El pipeline entero depende de esto: si el OCR revienta, el viaje tiene que
  // ir a revision humana, no tumbar la pasada del worker.
  const resultado = await ocr.leerCaptura({ buffer: Buffer.from('esto no es una imagen') });
  assert.strictEqual(resultado.disponible, false);
  assert.ok(resultado.error, 'debe explicar por que no ha podido leer');
});

test('el reloj de la barra de estado no se cuela como hora de salida', () => {
  // Este es EL fallo de la captura mas comun que existe: Android sin recortar
  // lleva el reloj del sistema arriba del todo. Antes se cogian las dos
  // primeras horas del texto, asi que la salida real pasaba a ser la llegada y
  // la resta llegada-salida dejaba de cuadrar con la duracion. El motor lo veia
  // como descuadre y marcaba viajes legitimos.
  const conBarraDeEstado = `19:03 84%
BiciMAD
Trayecto finalizado
002 - Metro Callao (002)
110 - Intercambiador de Moncloa (110)
Salida 18:42
Llegada 18:54
Duracion 12 min 00 s`;

  assert.deepStrictEqual(ocr.extraerHoras(conBarraDeEstado), ['18:42', '18:54']);
});

test('las etiquetas mandan aunque vengan en otro orden', () => {
  assert.deepStrictEqual(
    ocr.extraerHoras('Llegada 08:19\nSalida 08:05'),
    ['08:05', '08:19']);
});

test('sin etiquetas legibles se vuelve al orden de aparicion', () => {
  // Si el OCR no ha podido leer ni "Salida" ni "Llegada", tampoco hay etiqueta
  // de la que fiarse: mejor dos horas en orden que ninguna.
  assert.deepStrictEqual(ocr.extraerHoras('S4lld4 08:05 ... Lleg4d4 08:19'), ['08:05', '08:19']);
});

test('una etiqueta suelta no basta: hacen falta las dos', () => {
  // Con solo "Salida" reconocida, dar por buena la etiqueta y dejar la llegada
  // al azar seria peor que aplicar el mismo criterio a las dos.
  assert.deepStrictEqual(ocr.extraerHoras('Salida 08:05 y luego 08:19'), ['08:05', '08:19']);
});

// --- Capturas con varios trayectos (#11) --------------------------------------

const HISTORIAL = `BiciMAD
Mis trayectos de hoy

002 - Metro Callao (002)
110 - Intercambiador de Moncloa (110)
Salida 18:42 Llegada 18:54
Duracion 12 min 00 s
Bicicleta 2471

045 - Metro Puerta de Toledo (045)
118 - Oficina del SER (118)
Salida 08:05 Llegada 08:19
Duracion 14 min 00 s`;

test('el historial se trocea en un trayecto por viaje', () => {
  const trayectos = ocr.extraerTrayectos(HISTORIAL);

  assert.strictEqual(trayectos.length, 2);
  assert.deepStrictEqual(trayectos[0], {
    origen: '002', destino: '110', horaSalida: '18:42', horaLlegada: '18:54', segundosDuracion: 720, numeroBici: '2471', fecha: '',
  });
  assert.deepStrictEqual(trayectos[1], {
    origen: '045', destino: '118', horaSalida: '08:05', horaLlegada: '08:19', segundosDuracion: 840, numeroBici: '', fecha: '',
  });
});

test('el numero de la bici se lee solo con la palabra delante', () => {
  assert.strictEqual(ocr.extraerBici('Bicicleta 1042 - EMT Madrid'), '1042');
  assert.strictEqual(ocr.extraerBici('Bici nº 10310'), '10310');
  assert.strictEqual(ocr.extraerBici('Bicicleta: 2471'), '2471');
  // "BiciMAD" no es "bici", y un numero suelto no es un numero de bici.
  assert.strictEqual(ocr.extraerBici('BiciMAD 2024'), '');
  assert.strictEqual(ocr.extraerBici('Importe 1042'), '');
});

test('una captura de un solo viaje sigue dando un solo trayecto', () => {
  assert.strictEqual(ocr.extraerTrayectos(CAPTURA).length, 1);
});

test('el reloj de la barra de estado no se cuela en el primer trayecto', () => {
  const conReloj = `19:03 84%\n${HISTORIAL}`;
  const [primero] = ocr.extraerTrayectos(conReloj);
  assert.strictEqual(primero.horaSalida, '18:42');
});

test('un bloque sin las dos estaciones no cuenta como trayecto', () => {
  // Media captura recortada: la segunda estacion se ha quedado fuera. Mejor
  // ningun trayecto que uno inventado a medias.
  const cortado = '002 - Metro Callao (002)\nSalida 18:42\nDuracion 12 min 00 s';
  assert.deepStrictEqual(ocr.extraerTrayectos(cortado), []);
});

test('elegirTrayecto no toca la lectura cuando solo hay uno', () => {
  const lectura = { origen: '002', destino: '110', trayectos: [{ origen: '002', destino: '110' }] };
  assert.strictEqual(ocr.elegirTrayecto(lectura, '002-110'), lectura);
});

test('el idioma del OCR sale del repositorio, no de la red', () => {
  // Sin `langPath`, tesseract.js baja el `.traineddata` de un CDN en cada
  // arranque en frio. Eso mete una dependencia de red DENTRO del pipeline de
  // verificacion: si el CDN tarda o no responde, la tanda entera acaba en
  // revision manual por un motivo que no tiene nada que ver con las capturas.
  // Es el mismo argumento por el que se quito Gemini (#10).
  //
  // El fichero ya esta en el repositorio porque lo usa el navegador, asi que la
  // descarga no aportaba mas que un punto de fallo y 2 MB por ejecucion.
  const fichero = path.join(__dirname, '..', '..', 'assets', 'ocr', 'spa.traineddata.gz');
  assert.ok(fs.existsSync(fichero), 'falta assets/ocr/spa.traineddata.gz, que usan el navegador y el worker');

  const fuente = fs.readFileSync(path.join(__dirname, '..', 'src', 'ocr.js'), 'utf8');
  assert.match(fuente, /langPath/, 'ocr.js volveria a bajar el idioma de la red en cada arranque');
});

test('la hora de la barra de estado sale de las primeras lineas y sin etiqueta', () => {
  assert.strictEqual(ocr.extraerRelojBarra('19:03 84%\nBiciMAD\nSalida 18:42'), '19:03');
  assert.strictEqual(ocr.extraerRelojBarra('BiciMAD\nSalida 18:42 Llegada 18:54'), '');
});

// El formato actual de la app (captura de referencia del diseño, ref/ejemplo.jpg):
// la bici suelta junto al icono, fecha y hora bajo cada estacion y "17m. 18s.".
// Los textos son lo que devuelve tesseract de verdad, con sus erratas.
const ACTUAL = '7 10310 O\n\nO 124 - Metro Bilbao (124)\n. 21/09/25 02:51:12\n\nQ 115 - Ferraz - Templo de Debod (115)\n21/09/25 03:08:30\n\n(O) 17m.18s. 0.50 €\n';
const ACTUAL_PEOR = '— 75 lo310\n\nO 124 - Metro Bilbao (124)\n\no\ne 21/09/25 02:51:12\no\n\n21/09/25 03:08:30\n\n(5) 17m.18s. 0.50 €\n\nO TI5 - Ferraz - Templo de Debod (115)\n';

test('la captura actual de BiciMAD se lee entera: estaciones, tiempo, bici y fecha', () => {
  for (const texto of [ACTUAL, ACTUAL_PEOR]) {
    const [t, ...resto] = ocr.extraerTrayectos(texto);
    assert.strictEqual(resto.length, 0);
    assert.deepStrictEqual(t, {
      origen: '124', destino: '115', horaSalida: '02:51', horaLlegada: '03:08',
      segundosDuracion: 17 * 60 + 18, numeroBici: '10310', fecha: '2025-09-21',
    });
  }
});

test('un parentesis suelto (el icono del reloj) no es una estacion', () => {
  assert.deepStrictEqual(ocr.extraerEstaciones(ACTUAL_PEOR), ['124', '115']);
});
