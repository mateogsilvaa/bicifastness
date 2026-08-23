'use strict';

/**
 * El banco de capturas: la unica prueba que ejecuta el pipeline ENTERO.
 *
 * Normalizacion, OCR de verdad y motor de decision, sobre imagenes fijas y con
 * la verdad de cada una escrita al lado (`banco/esperado.json`). Todo lo demas
 * en este directorio prueba piezas sueltas con datos inventados; esto mide si
 * el conjunto sirve, que es otra pregunta.
 *
 * De donde salen las imagenes y por que son sinteticas: `scripts/build-capturas.js`.
 * Resumen: una captura de BiciMAD es el trayecto de una persona, y este
 * repositorio va a ser publico. La medicion sobre capturas reales corre contra
 * Firestore con `scripts/medir-ocr.js` y de ahi solo salen numeros.
 *
 * Lo que ya ha encontrado este banco, para que se vea que no es decorativo:
 *
 *   - `negate()` de sharp invertia tambien el canal alfa, asi que toda captura
 *     en modo oscuro con transparencia llegaba al OCR EN BLANCO
 *   - se tomaba el reloj de la barra de estado como hora de salida, lo que
 *     descuadraba la comprobacion de coherencia en viajes legitimos
 *   - tesseract se comia la linea de la duracion cuando va grande y aislada,
 *     por no fijar el modo de segmentacion de pagina
 *
 * Los tres fallos afectaban a capturas normales de gente normal, y ninguno se
 * veia leyendo el codigo.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ocr = require('../src/ocr');
const { evaluar } = require('../src/verificacion');

const DIRECTORIO = path.join(__dirname, 'banco');
const { capturas } = JSON.parse(fs.readFileSync(path.join(DIRECTORIO, 'esperado.json'), 'utf8'));

/**
 * Suelo del porcentaje de extraccion.
 *
 * Hoy el banco sale al 100%. El suelo se deja algo por debajo a proposito: una
 * version distinta de tesseract puede mover un campo suelto y eso no es una
 * regresion, es ruido. Lo que este numero tiene que pillar es que alguien rompa
 * el extractor, y eso no se lleva un campo: se lleva la mitad del banco.
 *
 * Si el porcentaje sube de forma estable, SUBE tambien este suelo. Un suelo que
 * se queda atras deja de proteger nada.
 */
const SUELO_EXTRACCION = 0.9;

/** Los cinco campos que el pipeline tiene que sacar de una captura. */
const CAMPOS = ['origen', 'destino', 'horaSalida', 'horaLlegada', 'segundosDuracion'];

/** "002" y "2" son la misma estacion; el OCR no tiene por que leer los ceros. */
const mismaEstacion = (a, b) => String(a ?? '').replace(/^0+/, '') === String(b ?? '').replace(/^0+/, '');

function comparar(lectura, verdad) {
  return {
    origen: mismaEstacion(lectura.origen, verdad.origen),
    destino: mismaEstacion(lectura.destino, verdad.destino),
    horaSalida: lectura.horaSalida === verdad.horaSalida,
    horaLlegada: lectura.horaLlegada === verdad.horaLlegada,
    segundosDuracion: lectura.segundosDuracion === verdad.segundosDuracion,
  };
}

/**
 * Un solo pase de OCR por captura para todo el fichero.
 *
 * Cada pasada cuesta alrededor de un segundo. Repetirla en cada test
 * multiplicaria por cuatro lo que tarda `npm test`, que es de las cosas que
 * hacen que la gente deje de ejecutarlo.
 */
const lecturas = new Map();

test.before(async () => {
  for (const captura of capturas) {
    const buffer = fs.readFileSync(path.join(DIRECTORIO, captura.fichero));
    lecturas.set(captura.id, await ocr.leerCaptura({ buffer }));
  }
});

// Sin esto el proceso NO termina: el worker de tesseract se comparte entre
// lecturas (#14) y, mientras exista, mantiene vivo el bucle de eventos. En el
// worker de produccion lo cierra `worker.js` al acabar la tanda.
test.after(async () => { await ocr.cerrar(); });

/** Sin tesseract (o sin red para bajar el idioma) no hay nada que medir. */
const sinOcr = () => [...lecturas.values()].every((l) => !l.disponible);

test('el pipeline sabe leer las capturas que tiene que leer', (t) => {
  if (sinOcr()) return t.skip('OCR no disponible en este entorno');

  for (const captura of capturas.filter((c) => c.exigido && c.verdad.esBicimad)) {
    const lectura = lecturas.get(captura.id);
    assert.ok(lectura.disponible, `${captura.id}: el OCR no ha podido leerla (${lectura.error})`);
    assert.ok(lectura.esBicimad, `${captura.id}: no la reconoce como captura de BiciMAD`);

    const resultado = comparar(lectura, captura.verdad);
    for (const campo of CAMPOS) {
      assert.ok(resultado[campo],
        `${captura.id} (${captura.descripcion}): ${campo} leido "${lectura[campo]}", esperado "${captura.verdad[campo]}"`);
    }
  }
});

test('una captura que no es de BiciMAD no se cuela', (t) => {
  if (sinOcr()) return t.skip('OCR no disponible en este entorno');

  for (const captura of capturas.filter((c) => c.verdad.esBicimad === false)) {
    const lectura = lecturas.get(captura.id);
    assert.strictEqual(lectura.esBicimad, false,
      `${captura.id}: se ha dado por buena una captura que no es de la app`);
  }
});

test('informe de extraccion del banco', (t) => {
  if (sinOcr()) return t.skip('OCR no disponible en este entorno');

  const medibles = capturas.filter((c) => c.verdad.esBicimad);
  let aciertos = 0;
  let total = 0;
  const lineas = [];

  for (const captura of medibles) {
    const lectura = lecturas.get(captura.id);
    const resultado = lectura.disponible
      ? comparar(lectura, captura.verdad)
      : Object.fromEntries(CAMPOS.map((c) => [c, false]));

    const bien = CAMPOS.filter((c) => resultado[c]).length;
    aciertos += bien;
    total += CAMPOS.length;

    const fallos = CAMPOS.filter((c) => !resultado[c]);
    lineas.push(`  ${captura.id.padEnd(18)} ${bien}/${CAMPOS.length}  confianza ${String(lectura.confianza ?? 0).padStart(3)}`
      + (fallos.length ? `  falla: ${fallos.join(', ')}` : ''));
  }

  const porcentaje = aciertos / total;

  // El informe sale SIEMPRE, pase o falle: el numero es el producto de este
  // test tanto como la asercion. Es lo que se mira en cada PR para ver si el
  // extractor mejora o empeora.
  console.log(`\n  Extraccion del banco: ${aciertos}/${total} campos (${(porcentaje * 100).toFixed(1)}%)`);
  console.log(lineas.join('\n'));

  assert.ok(porcentaje >= SUELO_EXTRACCION,
    `la extraccion ha bajado al ${(porcentaje * 100).toFixed(1)}%, por debajo del suelo del ${SUELO_EXTRACCION * 100}%`);
});

test('el motor decide sobre el banco lo que dice el banco', (t) => {
  if (sinOcr()) return t.skip('OCR no disponible en este entorno');

  for (const captura of capturas.filter((c) => c.antifraude)) {
    const lectura = lecturas.get(captura.id);
    const verdad = captura.verdad;

    // Una captura que no es de BiciMAD no trae ruta: se le pone una valida para
    // que lo unico que decida sea la lectura.
    const ruta = verdad.esBicimad ? `${verdad.origen}-${verdad.destino}` : '002-110';
    const tiempoSegundos = captura.antifraude.tiempoDeclarado ?? verdad.segundosDuracion ?? 720;

    const veredicto = evaluar({
      ruta,
      tiempoSegundos,
      lectura,
      hashSha: 'b'.repeat(64),
      hashPerceptual: '0f0f0f0f0f0f0f0f',
      shaPrevios: [],
      hashesPrevios: [],
      distribucionRuta: null,
      velocidadesPrevias: [],
      mejorTiempoRuta: null,
      mejorTiempoPropio: null,
      edicionSospechosa: false,
      software: null,
    });

    assert.strictEqual(veredicto.decision, captura.antifraude.decision,
      `${captura.id}: se esperaba ${captura.antifraude.decision} y ha salido ${veredicto.decision}`
      + ` (${veredicto.señales.map((s) => s.codigo).join(', ') || 'sin señales'})`);

    if (captura.antifraude.codigo) {
      assert.ok(veredicto.señales.some((s) => s.codigo === captura.antifraude.codigo),
        `${captura.id}: falta la señal ${captura.antifraude.codigo}`);
    }

    // Falsos positivos: una captura buena que levanta señales es peor que una
    // que no se lee. La que no se lee va a revision; esta se rechaza sola.
    if (captura.antifraude.decision === 'aprobado') {
      assert.deepStrictEqual(veredicto.señales, [],
        `${captura.id}: captura legitima con señales de fraude`);
    }
  }
});

test('el banco cubre las variantes que se ven en la calle', () => {
  // Sin esto, el banco se queda con lo comodo (una captura de Android en modo
  // claro) y deja de representar nada. No hace falta OCR para comprobarlo.
  const ids = capturas.map((c) => c.id).join(' ');
  for (const variante of ['android', 'ios', 'oscuro', 'recortada', 'whatsapp',
    'movida', 'pequena', 'varios-trayectos', 'manipulada', 'no-es-bicimad']) {
    assert.ok(ids.includes(variante), `el banco no cubre la variante "${variante}"`);
  }

  for (const captura of capturas) {
    assert.ok(fs.existsSync(path.join(DIRECTORIO, captura.fichero)),
      `falta la imagen ${captura.fichero}: regenera el banco con scripts/build-capturas.js`);
  }
});

test('una captura con tres trayectos se lee como tres, no como uno', (t) => {
  if (sinOcr()) return t.skip('OCR no disponible en este entorno');

  const captura = capturas.find((c) => c.trayectos);
  assert.ok(captura, 'el banco ya no tiene ninguna captura con varios trayectos');

  const lectura = lecturas.get(captura.id);
  assert.ok(lectura.disponible, `${captura.id}: no se ha podido leer`);

  const leidos = lectura.trayectos || [];
  assert.strictEqual(leidos.length, captura.trayectos.length,
    `se han leido ${leidos.length} trayectos y la captura tiene ${captura.trayectos.length}`);

  captura.trayectos.forEach((esperado, i) => {
    assert.ok(mismaEstacion(leidos[i].origen, esperado.origen),
      `trayecto ${i + 1}: origen leido "${leidos[i].origen}", esperado "${esperado.origen}"`);
    assert.ok(mismaEstacion(leidos[i].destino, esperado.destino),
      `trayecto ${i + 1}: destino leido "${leidos[i].destino}", esperado "${esperado.destino}"`);
    assert.strictEqual(leidos[i].segundosDuracion, esperado.segundosDuracion,
      `trayecto ${i + 1}: duracion`);
    assert.strictEqual(leidos[i].horaSalida, esperado.horaSalida, `trayecto ${i + 1}: hora de salida`);
  });
});

test('cada viaje se compara con SU trayecto, no con el primero de la captura', (t) => {
  if (sinOcr()) return t.skip('OCR no disponible en este entorno');

  // Sin esto, subir los tres viajes de una captura acabaria con dos rechazados
  // por `ruta_no_coincide`: los tres se compararian contra el primero.
  const captura = capturas.find((c) => c.trayectos);
  const lectura = lecturas.get(captura.id);
  const segundo = captura.trayectos[1];

  const elegido = ocr.elegirTrayecto(lectura, `${segundo.origen}-${segundo.destino}`);
  assert.ok(mismaEstacion(elegido.origen, segundo.origen));
  assert.strictEqual(elegido.segundosDuracion, segundo.segundosDuracion);

  // Y si la ruta declarada no esta en la captura, se queda con el primero: la
  // señal de que no coincide tiene que saltar.
  const ninguno = ocr.elegirTrayecto(lectura, '999-998');
  assert.ok(mismaEstacion(ninguno.origen, captura.trayectos[0].origen));
});
