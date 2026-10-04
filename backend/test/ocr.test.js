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

test('en el historial de la app cada tarjeta se lleva su bici', () => {
  // Texto real de tesseract sobre una captura con dos tarjetas (bici arriba de cada una).
  const texto = '30 viajes realizados\n\n7 18853 O\n\nEP 47 - Estación de tren de Embajadores (47)\n30/09/26 21:22:13\n\n235 - Sodio - Embajadores (235)\n30/09/26 21:33:13\n\n(O) 11m. 00s. 0.00 €\n\n75 19461 O\n\nO 235 - Sodio - Embajadores (235)\ne 30/09/26 17:24:13\n\no 47 - Estación de tren de Embajadores 47)\n30/09/26 17:35:57\n\n(5) 11m. 44s. 0.00 €\n';
  const [a, b, ...resto] = ocr.extraerTrayectos(texto);
  assert.strictEqual(resto.length, 0);
  assert.deepStrictEqual([a.origen, a.destino, a.segundosDuracion, a.numeroBici], ['47', '235', 660, '18853']);
  // "Embajadores 47)": el OCR se comio el "(" y la estacion vale igual.
  assert.deepStrictEqual([b.origen, b.destino, b.segundosDuracion, b.numeroBici], ['235', '47', 704, '19461']);
});

// --- Lectura del historial: tiempo por horas, barras y bicis por altura -------

test('el tiempo sale de las horas con segundos, aunque la barra se lea mal', () => {
  const texto = '7 18853 O\nO 222 - Calle Uno (222)\n02/09/26 22:46:37\nQ 415 - Calle Dos (415)\n02/09/26 23:03:20\n(O lom. 455. 0.00 €\n';
  const [t] = ocr.extraerTrayectos(texto);
  assert.strictEqual(t.segundosDuracion, 16 * 60 + 43);
});

test('una estacion vale aunque la app corte su nombre', () => {
  const texto = 'O 235 - Calle Uno (235)\n18/09/26 21:45:56\nLo) 176 - Plaza de un nombre muy largo (17...\n18/09/26 21:49:18\n';
  const [t] = ocr.extraerTrayectos(texto);
  assert.deepStrictEqual([t.origen, t.destino, t.segundosDuracion], ['235', '176', 202]);
});

test('el tiempo de la barra entiende la letra de BiciMAD', () => {
  assert.strictEqual(ocr.tiempoDeBarra('llm. 44s.'), 11 * 60 + 44);
  assert.strictEqual(ocr.tiempoDeBarra('O2m. 24s.'), 144);
  assert.strictEqual(ocr.tiempoDeBarra('lom. 455.'), null);
});

test('la bici de la pasada de numeros quita el icono y no confunde estaciones', () => {
  assert.strictEqual(ocr.biciDeNumero('7518853'), '18853');
  assert.strictEqual(ocr.biciDeNumero('19419'), '19419');
  assert.strictEqual(ocr.biciDeNumero('235235'), '');
  assert.strictEqual(ocr.biciDeNumero('30092621'), '');
});

test('cada barra y cada bici van al trayecto que les toca por altura', () => {
  const lineas = [
    { texto: 'O 001 - Uno (001)', y: 100 }, { texto: 'O 002 - Dos (002)', y: 200 },
    { texto: 'O 003 - Tres (003)', y: 500 }, { texto: 'O 004 - Cuatro (004)', y: 600 },
  ];
  const trayectos = ocr.extraerTrayectos(lineas.map((l) => l.texto).join('\n'));
  const [a, b] = ocr.asignarPorAltura(trayectos, lineas,
    [{ segundos: 120, y: 300 }, { segundos: 240, y: 700 }],
    [{ bici: '11111', y: 50 }, { bici: '22222', y: 450 }]);
  assert.deepStrictEqual([a.segundosDuracion, a.numeroBici, b.segundosDuracion, b.numeroBici], [120, '11111', 240, '22222']);
});

test('una captura del historial sin palabras clave sigue siendo de BiciMAD', () => {
  // Lo que salia antes: la barra mal leida y ninguna palabra de la app. Se
  // rechazaba como "no es BiciMAD", y ese rechazo es directo.
  const texto = '30 viajes realizados\nO 047 - Uno (047)\n30/09/26 21:22:13\nO 235 - Dos (235)\n30/09/26 21:33:13\n(Y Tim. 00s. 0.00 €\n';
  const sinMarcas = texto.replace('30 viajes realizados\n', '');
  assert.ok(ocr.esCapturaBicimad(sinMarcas, sinMarcas.toLowerCase(), ocr.extraerEstaciones(sinMarcas)));
});

// --- Lo que el OCR hace con capturas reales ------------------------------------

test('un trayecto de mas de una hora no se lee como de cinco minutos', () => {
  assert.strictEqual(ocr.extraerDuracion('1h. 05m. 12s.'), 3912);
  assert.strictEqual(ocr.extraerDuracion('1 h 5 min'), 3900);
  assert.strictEqual(ocr.tiempoDeBarra('lh. O5m. l2s.'), 3912);
});

test('las cifras confundidas del tiempo y de la estacion se corrigen', () => {
  assert.strictEqual(ocr.extraerDuracion('Tiempo l7m. l8s.'), 1038);
  assert.deepStrictEqual(ocr.extraerEstaciones('124 - Puerta del Sol (l24)\n115 - Prado (1l5)'), ['124', '115']);
  // Y una palabra normal no se toca.
  assert.strictEqual(ocr.corregirCifras('Salida del Sol'), 'Salida del Sol');
});

test('la fecha pegada a la hora, o con guiones, se sigue leyendo', () => {
  const [a, b] = ocr.extraerFechas('21/09/2502:51:12 y 21-09-25 03:08:30');
  assert.strictEqual(a.fecha, '2025-09-21');
  assert.strictEqual(a.hora, '02:51');
  assert.strictEqual(b.hora, '03:08');
  // Un año imposible no es una fecha.
  assert.deepStrictEqual(ocr.extraerFechas('21/09/1890 10:00'), []);
});

test('la hora con etiqueta admite el punto que pone el OCR', () => {
  assert.deepStrictEqual(ocr.extraerHoras('Salida 18.42 Llegada 18;54'), ['18:42', '18:54']);
});

test('una captura con estaciones y tiempo es de BiciMAD aunque no lo diga', () => {
  const texto = '124 - Puerta del Sol (124)\n115 - Prado (115)\n17m. 18s.';
  assert.ok(ocr.esCapturaBicimad(texto, texto.toLowerCase(), ocr.extraerEstaciones(texto)));
  const nota = 'Notas\nComprar pan 18:42';
  assert.ok(!ocr.esCapturaBicimad(nota, nota.toLowerCase(), ocr.extraerEstaciones(nota)));
});

// --- Formatos reales: la version web del historial y tarjetas cortadas --------

const WEB = `ÓN

fsjoos7 O

9 110 - Intercambiador de Moncloa
| 16-04-2026 13:13:30

l

l

112 - Paseo de Moret - Parque del

Ó Oeste
16-04-2026 13:14:32

(5) 00:01:02 0,00 €`;
const WEB_EURO = `ÓN

712149 0)

€ 122 - Santa Engracia - Zurbarán
| 17-04-2026 13:44:28

I

ó

33 - Puerta del Sol
17-04-2026 13:55:00

(5) 00:10:32 0,00 €`;
const CORTADA = `Q 235 - Sodio - Embajadores (235)
13/09/26 13:51:08

(O) o2m.46s. 0.00 € 1
A 19346 o

O 29 - Marqués de Cubas (29)

.
» 12/09/26 16:04:05
.

Q 22 - Jacometrezo 3 (22)

12/09/26 16:24:41

(O) 20m. 3es. 0.00 € ]

>» 19129 O

O 177 - Metro Legazpi (177)

11/09/26 12-17-57`;
const CORTADA_SIN_EURO = `Q 235 - Sodio - Embajadores (235)
13/09/26 13:51:08

(O) o2m.46s.  1
A 19346 o

O 29 - Marqués de Cubas (29)

.
» 12/09/26 16:04:05
.

Q 22 - Jacometrezo 3 (22)

12/09/26 16:24:41

(O) 20m. 3es.  ]

>» 19129 O

O 177 - Metro Legazpi (177)

11/09/26 12-17-57`;

test('historial web: estaciones con simbolo delante, fecha con guiones y tiempo como reloj', () => {
  const [t] = ocr.extraerTrayectos(WEB);
  assert.strictEqual(t.origen, '110');
  assert.strictEqual(t.destino, '112', 'la fecha 16-04-2026 no es la estacion 16');
  assert.strictEqual(t.horaSalida, '13:13');
  assert.strictEqual(t.horaLlegada, '13:14');
  assert.strictEqual(t.segundosDuracion, 62);
  assert.strictEqual(t.fecha, '2026-04-16');
  assert.strictEqual(ocr.extraerDuracion('(5) 00:10:32 0,00 €'), 632);
  // La hora de una estacion no es un tiempo de trayecto.
  assert.strictEqual(ocr.extraerDuracion('17-04-2026 13:44:28'), null);
});

test('un euro delante de la estacion no cierra la tarjeta', () => {
  const [t] = ocr.extraerTrayectos(WEB_EURO);
  assert.strictEqual(t.origen, '122');
  assert.strictEqual(t.destino, '33');
  assert.strictEqual(t.segundosDuracion, 632);
});

test('una tarjeta cortada por arriba no se une con la siguiente', () => {
  // Arriba asoma solo la llegada de un viaje (235). Antes salia un viaje
  // inventado 235 -> 29 de dos horas uniendo dos tarjetas.
  for (const texto of [CORTADA, CORTADA_SIN_EURO]) {
    const trayectos = ocr.extraerTrayectos(texto);
    assert.strictEqual(trayectos.length, 1, JSON.stringify(trayectos));
    const [t] = trayectos;
    assert.strictEqual(t.origen, '29');
    assert.strictEqual(t.destino, '22');
    assert.strictEqual(t.segundosDuracion, 1236, 'de las horas con segundos');
    assert.strictEqual(t.fecha, '2026-09-12');
  }
});

test('la misma ruta dos veces en una captura: cada viaje con el suyo', () => {
  const lectura = {
    trayectos: [
      { origen: '177', destino: '235', segundosDuracion: 144, fecha: '2026-09-30' },
      { origen: '177', destino: '235', segundosDuracion: 132, fecha: '2026-09-29' },
    ],
  };
  assert.strictEqual(ocr.elegirTrayecto(lectura, '177-235', { tiempoSegundos: 132, fecha: '2026-09-29' }).segundosDuracion, 132);
  assert.strictEqual(ocr.elegirTrayecto(lectura, '177-235', { tiempoSegundos: 144, fecha: '2026-09-30' }).segundosDuracion, 144);
  assert.strictEqual(ocr.elegirTrayecto(lectura, '177-235').segundosDuracion, 144, 'sin pistas, el primero');
});

test('ninguna bici empieza por 0', () => {
  assert.strictEqual(ocr.biciDeNumero('0087'), '');
  assert.strictEqual(ocr.biciDeNumero('10087'), '10087');
});
