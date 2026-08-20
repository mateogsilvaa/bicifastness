'use strict';

/**
 * Pruebas de los modulos del navegador que dependen del backend.
 *
 * Aqui se prueban dos cosas que se rompen calladas:
 *
 *   1. Que cada motivo de rechazo del worker tenga un texto en castellano. Si
 *      alguien añade una señal nueva al motor de verificacion, el usuario
 *      empieza a recibir el motivo generico y nadie se entera hasta que alguien
 *      escribe preguntando por que le han rechazado el viaje.
 *   2. Que esos textos no cuenten como funciona el antifraude.
 *
 * COMO SE CARGA UN MODULO DEL NAVEGADOR DESDE NODE. `assets/js/*.js` son
 * modulos ES, pero el package.json de la raiz no declara `"type": "module"` (no
 * puede: `scripts/` es CommonJS), asi que un `require` o un `import` normal los
 * leeria como CommonJS y reventaria en la primera linea. Se cargan como data:
 * URL, que si se evalua como modulo ES.
 *
 * El precio de hacerlo asi: un modulo cargado desde una data: URL NO puede
 * tener imports relativos, porque no hay ruta desde la que resolverlos. Por eso
 * `motivos.js` y `precheck.js` no importan nada, y esta escrito en los dos.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..');
const leer = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

function cargarModuloCliente(rel) {
  const codigo = Buffer.from(leer(rel), 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${codigo}`);
}

// --- Motivos: del veredicto al castellano ------------------------------------

/** Todos los codigos de señal que puede llegar a escribir el worker. */
function codigosDelWorker() {
  const verificacion = leer('backend/src/verificacion.js');
  const worker = leer('backend/worker.js');

  const codigos = new Set();
  // `señal('codigo', ...)` y `fatal('codigo', ...)` en el motor.
  for (const m of verificacion.matchAll(/(?:señal|fatal)\(\s*'([a-z_]+)'/g)) codigos.add(m[1]);
  // Los cortes tempranos del worker, que no pasan por el motor.
  for (const m of worker.matchAll(/rechazoDirecto\(\s*'([a-z_]+)'/g)) codigos.add(m[1]);
  for (const m of worker.matchAll(/problema\(\s*'([a-z_]+)'/g)) codigos.add(m[1]);
  // El que se escribe cuando el propio analisis revienta.
  for (const m of worker.matchAll(/codigo:\s*'([a-z_]+)'/g)) codigos.add(m[1]);

  return [...codigos];
}

test('cada motivo de rechazo del worker tiene texto para el usuario', async () => {
  const { CODIGOS_CON_TEXTO } = await cargarModuloCliente('assets/js/motivos.js');
  const codigos = codigosDelWorker();

  assert.ok(codigos.length >= 20, `esperaba muchos codigos, encontrados ${codigos.length}`);
  for (const codigo of codigos) {
    assert.ok(CODIGOS_CON_TEXTO.includes(codigo),
      `el codigo '${codigo}' no tiene texto en assets/js/motivos.js: al usuario le llegaria el motivo generico`);
  }
});

test('ningun texto del usuario lleva numeros del antifraude', async () => {
  // La regla es simple a proposito: ni una cifra. Un umbral solo se puede
  // contar con numeros, asi que prohibirlos los prohibe a ellos. Y "riesgo 72
  // por dHash a distancia 4" es exactamente lo que no puede salir de aqui.
  const modulo = await cargarModuloCliente('assets/js/motivos.js');

  // Se preguntan al modulo, no se raspan del fichero: una version anterior de
  // este test buscaba los textos con una expresion regular sobre el codigo
  // fuente y se tragaba trozos de codigo en cuanto alguien tocaba el fichero.
  const textos = [
    ...modulo.CODIGOS_CON_TEXTO.flatMap((c) => {
      const motivo = modulo.textoDeMotivo(c);
      return [motivo.texto, motivo.queHacer];
    }),
    ...Object.values(modulo.ESTADOS).flatMap((e) => [e.titulo, e.texto]),
  ];

  assert.ok(textos.length > 40, `esperaba muchos textos, encontrados ${textos.length}`);
  for (const texto of textos) {
    assert.ok(!/\d/.test(texto), `este texto lleva un numero: ${texto}`);
  }

  // Y por si algun dia se compone alguno: tampoco al pasar por la funcion.
  const motivo = modulo.motivoDeViaje({
    estado: 'rechazado',
    auditoria: {
      riesgo: 72,
      señales: [{
        codigo: 'captura_casi_identica',
        gravedad: 100,
        mensaje: 'La captura es practicamente identica a la de otro viaje (distancia perceptual 4).',
      }],
    },
  });
  assert.ok(!/\d/.test(motivo.texto + motivo.queHacer), 'el motivo devuelto lleva numeros');
  assert.ok(!motivo.texto.includes('distancia'), 'el motivo repite el mensaje interno de la auditoria');
});

test('se explica la señal mas grave, no la primera', async () => {
  const { motivoDeViaje } = await cargarModuloCliente('assets/js/motivos.js');

  // El motor emite en el orden en que corren las comprobaciones: el horario
  // inusual (10) sale antes que la ruta que no coincide (60), que es la razon
  // de verdad del rechazo.
  const motivo = motivoDeViaje({
    auditoria: {
      señales: [
        { codigo: 'horario_inusual', gravedad: 10, mensaje: 'A las 03:12.' },
        { codigo: 'ruta_no_coincide', gravedad: 60, mensaje: 'Se lee 2-110 y se declara 2-115.' },
      ],
    },
  });

  assert.match(motivo.texto, /estaciones que has escrito/);
});

test('un codigo desconocido cae en el motivo generico, no en un hueco', async () => {
  const { motivoDeViaje } = await cargarModuloCliente('assets/js/motivos.js');

  const motivo = motivoDeViaje({
    auditoria: { señales: [{ codigo: 'inventado_manana', gravedad: 90, mensaje: 'lo que sea' }] },
  });

  assert.ok(motivo.texto.length > 0);
  assert.ok(!motivo.texto.includes('lo que sea'));
});

test('lo que escribe un administrador a mano gana a la tabla', async () => {
  const { motivoDeViaje } = await cargarModuloCliente('assets/js/motivos.js');

  const motivo = motivoDeViaje({
    motivoRevision: 'La captura es de otra persona: el nombre no coincide.',
    auditoria: { señales: [{ codigo: 'no_es_bicimad', gravedad: 100, mensaje: 'x' }] },
  });

  assert.strictEqual(motivo.texto, 'La captura es de otra persona: el nombre no coincide.');
  assert.strictEqual(motivo.dePersona, true);
});

test('hay texto para los tres veredictos que escribe el worker', async () => {
  const { ESTADOS } = await cargarModuloCliente('assets/js/motivos.js');
  for (const estado of ['aprobado', 'rechazado', 'revision', 'pendiente']) {
    assert.ok(ESTADOS[estado]?.texto, `falta el texto del estado ${estado}`);
    assert.ok(ESTADOS[estado]?.chip, `falta el chip del estado ${estado}`);
  }
});

// --- Comprobaciones previas en el navegador ----------------------------------

test('la varianza del laplaciano distingue nitido de movido', async () => {
  const { varianzaLaplaciano } = await cargarModuloCliente('assets/js/precheck.js');

  const lado = 32;
  const plano = new Float32Array(lado * lado).fill(128);
  const rayas = new Float32Array(lado * lado);
  const degradado = new Float32Array(lado * lado);

  for (let y = 0; y < lado; y++) {
    for (let x = 0; x < lado; x++) {
      // Bordes duros, como los del texto de una captura.
      rayas[y * lado + x] = x % 2 === 0 ? 0 : 255;
      // Transicion suave: lo que queda de un borde cuando la foto se mueve.
      degradado[y * lado + x] = (x / lado) * 255;
    }
  }

  assert.strictEqual(varianzaLaplaciano(plano, lado, lado), 0);
  assert.ok(varianzaLaplaciano(rayas, lado, lado) > 100000, 'una imagen con bordes duros deberia dar varianza alta');
  assert.ok(varianzaLaplaciano(degradado, lado, lado) < 1, 'un degradado suave deberia dar varianza casi nula');
});

test('una captura normal no genera ni un aviso', async () => {
  const { evaluarMedidas } = await cargarModuloCliente('assets/js/precheck.js');

  const avisos = evaluarMedidas({
    tipo: 'image/jpeg',
    ancho: 1170,
    alto: 2532,
    nitidez: 900,
    diasAntiguedad: 2,
    caracteresDataUrl: 380000,
  });

  assert.deepStrictEqual(avisos, [], 'la comprobacion previa se queja de una captura buena');
});

test('cada problema de la captura tiene su aviso', async () => {
  const { evaluarMedidas } = await cargarModuloCliente('assets/js/precheck.js');
  const buena = { tipo: 'image/jpeg', ancho: 1170, alto: 2532, nitidez: 900, diasAntiguedad: 2, caracteresDataUrl: 380000 };
  const codigos = (cambios) => evaluarMedidas({ ...buena, ...cambios }).map((a) => a.codigo);

  assert.deepStrictEqual(codigos({ tipo: 'application/pdf' }), ['tipo_no_admitido']);
  assert.deepStrictEqual(codigos({ ancho: 320, alto: 700 }), ['resolucion_baja']);
  assert.deepStrictEqual(codigos({ ancho: 1600, alto: 900 }), ['parece_apaisada']);
  assert.deepStrictEqual(codigos({ nitidez: 12 }), ['foto_movida']);
  assert.deepStrictEqual(codigos({ diasAntiguedad: 45 }), ['demasiado_antigua']);
  assert.deepStrictEqual(codigos({ caracteresDataUrl: 900000 }), ['demasiado_grande']);
});

test('lo que no se puede medir no genera avisos', async () => {
  // Si el navegador no da `lastModified`, o la imagen no se ha podido medir, la
  // ausencia de dato no puede convertirse en un aviso: seria acusar por no
  // saber.
  const { evaluarMedidas } = await cargarModuloCliente('assets/js/precheck.js');
  assert.deepStrictEqual(evaluarMedidas({}), []);
  assert.deepStrictEqual(evaluarMedidas({ diasAntiguedad: null, nitidez: null }), []);
});

test('los avisos previos avisan, no bloquean', async () => {
  // La comprobacion previa es cortesia: ahorra una espera de diez minutos por
  // una foto movida. Si ademas impidiera subir, seria una regla de negocio
  // puesta en el sitio donde cualquiera la desactiva desde la consola.
  const { evaluarMedidas } = await cargarModuloCliente('assets/js/precheck.js');
  for (const aviso of evaluarMedidas({ tipo: 'image/gif', ancho: 100, alto: 50, nitidez: 1 })) {
    assert.ok(['alta', 'baja'].includes(aviso.gravedad), `gravedad rara: ${aviso.gravedad}`);
    assert.ok(aviso.texto.length > 20, `el aviso ${aviso.codigo} no explica nada`);
  }

  const subir = leer('assets/js/paginas/subir.js');
  assert.match(subir, /insistido/, 'la pagina de subida no deja subir a pesar de los avisos');
});

test('los limites del navegador no divergen de los del servidor', async () => {
  const { LIMITES_CLIENTE } = await cargarModuloCliente('assets/js/precheck.js');
  const { LIMITES } = require('../src/config');
  const { ANCHO } = require('../src/normalizar');

  assert.deepStrictEqual(LIMITES_CLIENTE.MIMES, LIMITES.MIMES_IMAGEN);
  assert.strictEqual(LIMITES_CLIENTE.DIAS_MAX_ANTIGUEDAD, LIMITES.DIAS_MAX_ANTIGUEDAD);

  // Mandar la captura mas pequeña que el ancho al que normaliza el worker
  // obliga a AMPLIARLA alli, que es justo donde el OCR falla (#9).
  assert.strictEqual(LIMITES_CLIENTE.ANCHO_SUBIDA, ANCHO);

  // El tope de verdad no es `MAX_BYTES_IMAGEN`: es el que imponen las reglas al
  // campo `datos`. Si el navegador comprime por encima, la escritura la rechaza
  // la regla y el usuario ve un 'permission-denied' que no explica nada.
  const reglas = leer('firestore.rules');
  const tope = Number(reglas.match(/datos\(\)\.datos\.size\(\) < (\d+)/)[1]);
  assert.ok(LIMITES_CLIENTE.MAX_CARACTERES_DATA_URL <= tope,
    `el navegador admite ${LIMITES_CLIENTE.MAX_CARACTERES_DATA_URL} caracteres y las reglas cortan en ${tope}`);
});

// --- Estado en vivo -----------------------------------------------------------

test('solo se escucha en vivo un documento suelto, nunca una coleccion', async () => {
  // `onSnapshot` factura una lectura por cada documento que cambia mientras se
  // escucha. Sobre una coleccion, un solo viaje ajeno movido cuesta lecturas a
  // todo el que tenga la pagina abierta.
  const ficheros = ['assets/js/estado-viaje.js', 'assets/js/paginas/subir.js',
    'assets/js/paginas/portada.js', 'assets/js/paginas/yo.js'];

  for (const rel of ficheros) {
    const codigo = leer(rel);
    for (const m of codigo.matchAll(/onSnapshot\(\s*([a-zA-Z]+)/g)) {
      assert.strictEqual(m[1], 'doc', `${rel} escucha algo que no es un documento suelto`);
    }
  }
});

test('la escucha se cierra sola', async () => {
  const codigo = leer('assets/js/estado-viaje.js');
  assert.match(codigo, /addEventListener\('pagehide'/, 'no se corta al salir de la pagina');
  assert.match(codigo, /removeEventListener\('pagehide'/, 'deja el manejador puesto al cortar');
  assert.match(codigo, /RESUELTOS/, 'no se corta cuando el viaje ya tiene veredicto');
});

// --- Cola de revision manual ---------------------------------------------------

test('los motivos que puede elegir quien revisa existen de verdad', async () => {
  // Si un codigo de la lista no esta en la tabla, quien revisa elige un motivo
  // con sentido y al piloto le llega el texto generico. Y como ese texto acaba
  // en el correo, nadie se entera del desajuste.
  const { MOTIVOS_MANUALES, CODIGOS_CON_TEXTO, textoDeMotivo } = await cargarModuloCliente('assets/js/motivos.js');

  assert.ok(MOTIVOS_MANUALES.length >= 5, 'la lista de motivos manuales se ha quedado corta');
  for (const codigo of MOTIVOS_MANUALES) {
    assert.ok(CODIGOS_CON_TEXTO.includes(codigo), `el motivo manual '${codigo}' no tiene texto`);
    assert.ok(textoDeMotivo(codigo).texto.length > 15, `el motivo '${codigo}' no explica nada`);
  }
});

test('cada decision manual sobre un viaje deja rastro', async () => {
  // El rastro va en el MISMO lote que la decision: uno que se escribiera
  // "despues, si eso" seria un rastro con agujeros. Y `auditoria_admin` no
  // admite modificar ni borrar, asi que no se puede maquillar luego.
  const acciones = leer('assets/js/acciones.js');
  const resolver = acciones.slice(
    acciones.indexOf('export async function resolverViaje'),
    acciones.indexOf('export async function resolverReporte')
  );

  assert.match(resolver, /writeBatch\(db\)/, 'la decision y su rastro no van en el mismo lote');
  assert.match(resolver, /auditoria_admin/, 'una decision manual no deja rastro');
  assert.match(resolver, /lote\.commit\(\)/);
});

test('la cola de revision no vuelve a construir interfaz con texto sin escapar', () => {
  // La vulnerabilidad 4 de la v1 fue XSS almacenado justo en este panel:
  // `innerHTML +=` con el nombre de usuario dentro. La comprobacion global ya
  // existe, pero esta pantalla es la que se reescribe cada vez que se toca la
  // revision, asi que se vigila tambien aqui.
  const admin = leer('assets/js/paginas/admin.js');
  assert.ok(!/innerHTML/.test(admin), 'el panel de administracion usa innerHTML');
  assert.match(admin, /MOTIVOS_MANUALES/, 'la cola ya no usa la lista cerrada de motivos');
});

// --- El lector del navegador contra el del worker ------------------------------

/**
 * Corpus de textos tal y como los devuelve un OCR sobre capturas reales:
 * con la barra de estado delante, con las etiquetas mal leidas, con la duracion
 * en los dos formatos y con lo que no es una captura de BiciMAD.
 */
const TEXTOS = [
  '19:03 84%\nBiciMAD\nTrayecto finalizado\n002 - Metro Callao (002)\n110 - Moncloa (110)\nSalida 18:42\nLlegada 18:54\nDuracion 12 min 00 s',
  '9:41\nResumen del recorrido\nBiciMAD - EMT Madrid\nEstacion de salida\n045 - Puerta de Toledo (045)\nEstacion de llegada\n118 - Oficina del SER (118)\nSalida 08:05 Llegada 08:19\nDuracion\n14:00',
  'Duración 12:15',
  '8 min',
  'Salida 18:42',
  'S4lld4 08:05 ... Lleg4d4 08:19',
  '25:00 y 12:99 y 09:30',
  '2 - Metro Callao\n110 - Moncloa',
  'Notas\nLista de la compra\nPan de molde\nEditada el martes',
  '',
];

test('el lector del navegador entiende lo mismo que el del worker', async () => {
  // Las funciones de parseo estan DUPLICADAS entre `backend/src/ocr.js` y
  // `assets/js/extraccion.js`, porque una es CommonJS y la otra un modulo ES
  // que ademas tiene que poder cargarse suelta, y este proyecto no tiene
  // empaquetador. Lo unico que impide que se separen es este test.
  //
  // Si falla: has tocado una de las dos y no la otra.
  const cliente = await cargarModuloCliente('assets/js/extraccion.js');
  const servidor = require('../src/ocr');

  for (const texto of TEXTOS) {
    const donde = JSON.stringify(texto.slice(0, 40));
    assert.deepStrictEqual(cliente.extraerHoras(texto), servidor.extraerHoras(texto),
      `las horas no coinciden en ${donde}`);
    assert.deepStrictEqual(cliente.extraerEstaciones(texto), servidor.extraerEstaciones(texto),
      `las estaciones no coinciden en ${donde}`);
    assert.strictEqual(cliente.extraerDuracion(texto), servidor.extraerDuracion(texto),
      `la duracion no coincide en ${donde}`);
  }

  assert.deepStrictEqual(cliente.MARCADORES, servidor.MARCADORES,
    'los marcadores de "esto es una captura de BiciMAD" han divergido');
});

test('lo que lee el navegador es una propuesta, no un dato de confianza', () => {
  // `correcciones` viaja desde el navegador y las reglas lo admiten, asi que
  // hay que poder demostrar que NO se usa para decidir: quien quiera engañar
  // simplemente no manda la marca. Lo que compara de verdad es el worker,
  // releyendo la captura por su cuenta.
  const motor = leer('backend/src/verificacion.js');
  assert.ok(!/correcciones/.test(motor),
    'el motor de decision mira `correcciones`, que lo escribe el navegador');

  const worker = leer('backend/worker.js');
  const usos = [...worker.matchAll(/correcciones/g)];
  assert.strictEqual(usos.length, 0,
    'el worker usa `correcciones` para algo; hoy solo debe ser telemetria');
});
