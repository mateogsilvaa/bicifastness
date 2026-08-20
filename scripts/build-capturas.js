#!/usr/bin/env node
/**
 * Genera el banco de capturas de prueba del pipeline (issue #16).
 *
 * POR QUE SINTETICAS Y NO REALES. Una captura de BiciMAD es el trayecto de una
 * persona: hora, estaciones y recorrido. Eso son datos personales, y este
 * repositorio va a ser publico. "Anonimizar" tapando el nombre no arregla nada
 * cuando lo que identifica es justo el resto. Asi que aqui no entra ni una
 * captura de nadie.
 *
 * La medicion sobre capturas REALES ya existe y corre donde viven los datos:
 * `scripts/medir-ocr.js`, que lee de Firestore y de la que solo sale un informe
 * con numeros. Las dos cosas se complementan y ninguna sustituye a la otra:
 *
 *   banco sintetico  -> regresion: el mismo fichero, el mismo numero, en cada
 *                       PR y en cualquier maquina. Dice si un cambio ROMPE algo.
 *   medir-ocr.js     -> realidad: tipografias, compresiones y recortes que no
 *                       se me han ocurrido. Dice si el extractor SIRVE.
 *
 * POR QUE SE VERSIONAN LAS IMAGENES Y NO SE PINTAN EN CADA TEST. Pintarlas al
 * vuelo dependeria de las tipografias instaladas en cada maquina, y el mismo
 * commit daria un porcentaje distinto en mi portatil y en CI. Un banco de
 * regresion que se mueve solo no sirve para nada. Se pintan una vez, se
 * versionan, y este script solo se ejecuta cuando se quiera ampliar el banco.
 *
 * Uso: node scripts/build-capturas.js
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const DESTINO = path.join(RAIZ, 'backend/test/banco');

// sharp es dependencia del worker, no del utillaje de la raiz (el package.json
// de arriba solo tiene eslint). Se resuelve a mano en vez de duplicar una
// dependencia de 30 MB.
const sharp = require(path.join(RAIZ, 'backend/node_modules/sharp'));

// --- Trayectos que aparecen en las capturas ----------------------------------
/**
 * Los tiempos son COHERENTES a proposito: llegada - salida tiene que dar la
 * duracion que muestra el recuadro. Es la comprobacion mas potente del motor
 * (verificacion.js), asi que una captura de prueba que no cuadre haria fallar
 * al antifraude por culpa del banco, no del codigo.
 *
 * Las velocidades resultantes quedan sobre 13 km/h, lejos de los umbrales por
 * arriba y por abajo: lo que se mide aqui es la EXTRACCION, y un caso limite
 * mezclaria las dos cosas.
 */
const TRAYECTO_A = {
  origen: '002', nombreOrigen: 'Metro Callao',
  destino: '110', nombreDestino: 'Intercambiador de Moncloa',
  salida: '18:42', llegada: '18:54', segundos: 720,
};

const TRAYECTO_B = {
  origen: '045', nombreOrigen: 'Metro Puerta de Toledo',
  destino: '118', nombreDestino: 'Oficina del SER',
  salida: '08:05', llegada: '08:19', segundos: 840,
};

const escapar = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const duracionLarga = (s) => `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
const duracionCorta = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// --- Plantillas ---------------------------------------------------------------
/**
 * Android: barra de estado arriba, todo alineado a la izquierda, duracion con
 * unidades ("12 min 00 s").
 */
function plantillaAndroid(trayecto, { oscuro = false, duracion = null } = {}) {
  const fondo = oscuro ? '#101114' : '#ffffff';
  const tinta = oscuro ? '#f2f2f4' : '#111214';
  const suave = oscuro ? '#a9abb2' : '#6b6d73';
  const barra = oscuro ? '#000000' : '#f0f0f2';
  const texto = duracion ?? duracionLarga(trayecto.segundos);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="2280">
  <rect width="1080" height="2280" fill="${fondo}"/>
  <rect width="1080" height="120" fill="${barra}"/>
  <text x="60" y="80" font-family="sans-serif" font-size="42" fill="${suave}">19:03</text>
  <text x="900" y="80" font-family="sans-serif" font-size="42" fill="${suave}">84%</text>

  <text x="70" y="300" font-family="sans-serif" font-size="86" font-weight="bold" fill="${tinta}">BiciMAD</text>
  <text x="70" y="400" font-family="sans-serif" font-size="52" fill="${suave}">Trayecto finalizado</text>

  <text x="70" y="620" font-family="sans-serif" font-size="50" fill="${tinta}">${escapar(trayecto.origen)} - ${escapar(trayecto.nombreOrigen)} (${escapar(trayecto.origen)})</text>
  <text x="70" y="720" font-family="sans-serif" font-size="50" fill="${tinta}">${escapar(trayecto.destino)} - ${escapar(trayecto.nombreDestino)} (${escapar(trayecto.destino)})</text>

  <text x="70" y="960" font-family="sans-serif" font-size="50" fill="${tinta}">Salida ${trayecto.salida}</text>
  <text x="70" y="1060" font-family="sans-serif" font-size="50" fill="${tinta}">Llegada ${trayecto.llegada}</text>

  <text x="70" y="1300" font-family="sans-serif" font-size="46" fill="${suave}">Duracion</text>
  <text x="70" y="1400" font-family="sans-serif" font-size="96" font-weight="bold" fill="${tinta}">${escapar(texto)}</text>

  <text x="70" y="1700" font-family="sans-serif" font-size="44" fill="${suave}">Bicicleta 1042 - EMT Madrid</text>
</svg>`;
}

/**
 * iOS: titulo centrado, los datos en una tarjeta y la duracion en formato
 * "14:00" etiquetado, que es el que mas se parece a una hora y el que mas
 * facilmente confunde al extractor.
 */
function plantillaIos(trayecto, { oscuro = false } = {}) {
  const fondo = oscuro ? '#000000' : '#f7f7f9';
  const tarjeta = oscuro ? '#1c1c1f' : '#ffffff';
  const tinta = oscuro ? '#ffffff' : '#0a0a0b';
  const suave = oscuro ? '#9c9ca4' : '#6d6d75';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1170" height="2532">
  <rect width="1170" height="2532" fill="${fondo}"/>
  <text x="80" y="90" font-family="sans-serif" font-size="40" fill="${tinta}">9:41</text>

  <text x="585" y="290" text-anchor="middle" font-family="sans-serif" font-size="72" font-weight="bold" fill="${tinta}">Resumen del recorrido</text>
  <text x="585" y="370" text-anchor="middle" font-family="sans-serif" font-size="46" fill="${suave}">BiciMAD - EMT Madrid</text>

  <rect x="70" y="480" width="1030" height="620" rx="36" fill="${tarjeta}"/>
  <text x="120" y="600" font-family="sans-serif" font-size="46" fill="${suave}">Estacion de salida</text>
  <text x="120" y="680" font-family="sans-serif" font-size="52" fill="${tinta}">${escapar(trayecto.origen)} - ${escapar(trayecto.nombreOrigen)} (${escapar(trayecto.origen)})</text>
  <text x="120" y="820" font-family="sans-serif" font-size="46" fill="${suave}">Estacion de llegada</text>
  <text x="120" y="900" font-family="sans-serif" font-size="52" fill="${tinta}">${escapar(trayecto.destino)} - ${escapar(trayecto.nombreDestino)} (${escapar(trayecto.destino)})</text>
  <text x="120" y="1040" font-family="sans-serif" font-size="48" fill="${tinta}">Salida ${trayecto.salida}   Llegada ${trayecto.llegada}</text>

  <rect x="70" y="1180" width="1030" height="380" rx="36" fill="${tarjeta}"/>
  <text x="585" y="1300" text-anchor="middle" font-family="sans-serif" font-size="46" fill="${suave}">Duracion</text>
  <text x="585" y="1450" text-anchor="middle" font-family="monospace" font-size="120" font-weight="bold" fill="${tinta}">${duracionCorta(trayecto.segundos)}</text>
</svg>`;
}

/** El tercer trayecto de la captura multiple. */
const TRAYECTO_C = {
  origen: '001', nombreOrigen: 'Metro Sol',
  destino: '003', nombreDestino: 'Plaza Conde Suchil',
  salida: '21:10', llegada: '21:26', segundos: 960,
};

/** Una captura con tres trayectos del dia, que es como llega mucha gente (#11). */
function plantillaVarios() {
  const filas = [TRAYECTO_A, TRAYECTO_B, TRAYECTO_C];

  const bloques = filas.map((t, i) => `
  <rect x="60" y="${520 + i * 480}" width="960" height="420" rx="24" fill="#ffffff" stroke="#dddde2"/>
  <text x="110" y="${610 + i * 480}" font-family="sans-serif" font-size="46" fill="#111214">${escapar(t.origen)} - ${escapar(t.nombreOrigen)} (${escapar(t.origen)})</text>
  <text x="110" y="${690 + i * 480}" font-family="sans-serif" font-size="46" fill="#111214">${escapar(t.destino)} - ${escapar(t.nombreDestino)} (${escapar(t.destino)})</text>
  <text x="110" y="${790 + i * 480}" font-family="sans-serif" font-size="44" fill="#4a4b50">Salida ${t.salida}  Llegada ${t.llegada}</text>
  <text x="110" y="${880 + i * 480}" font-family="sans-serif" font-size="52" font-weight="bold" fill="#111214">Duracion ${duracionLarga(t.segundos)}</text>`).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="2400">
  <rect width="1080" height="2400" fill="#f2f2f4"/>
  <text x="70" y="220" font-family="sans-serif" font-size="80" font-weight="bold" fill="#111214">BiciMAD</text>
  <text x="70" y="320" font-family="sans-serif" font-size="50" fill="#6b6d73">Mis trayectos de hoy</text>
  ${bloques}
</svg>`;
}

/**
 * Algo que no es una captura de BiciMAD.
 * Cuidado al tocarla: no puede contener ninguno de los MARCADORES de `ocr.js`
 * ("salida", "llegada", "trayecto", "duracion"...) o dejaria de ser un caso
 * negativo. Por eso es una lista de la compra y no la pantalla del tiempo, que
 * habla de la salida del sol.
 */
function plantillaOtraApp() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="2280">
  <rect width="1080" height="2280" fill="#ffffff"/>
  <text x="70" y="240" font-family="sans-serif" font-size="80" font-weight="bold" fill="#111214">Notas</text>
  <text x="70" y="360" font-family="sans-serif" font-size="52" fill="#6b6d73">Lista de la compra</text>
  <text x="70" y="520" font-family="sans-serif" font-size="52" fill="#111214">Pan de molde</text>
  <text x="70" y="620" font-family="sans-serif" font-size="52" fill="#111214">Dos litros de leche</text>
  <text x="70" y="720" font-family="sans-serif" font-size="52" fill="#111214">Cafe molido</text>
  <text x="70" y="820" font-family="sans-serif" font-size="52" fill="#111214">Manzanas y platanos</text>
  <text x="70" y="960" font-family="sans-serif" font-size="46" fill="#6b6d73">Editada el martes</text>
</svg>`;
}

// --- El banco -----------------------------------------------------------------
/**
 * Cada entrada declara la VERDAD de la imagen: lo que de verdad pone. El test
 * mide cuanto de eso consigue extraer el pipeline.
 *
 * `exigido` separa dos cosas que no se pueden mezclar en un mismo numero:
 *   true  -> tiene que salir bien SIEMPRE. Si falla, el test falla.
 *   false -> es un caso hostil a proposito (foto movida, reenvio de WhatsApp).
 *            Se mide y se informa, pero no se exige: el pipeline ya tiene
 *            respuesta para no poder leer, que es mandarlo a revision humana.
 */
const BANCO = [
  {
    id: 'android-claro',
    descripcion: 'Android, modo claro, duracion con unidades',
    svg: () => plantillaAndroid(TRAYECTO_A),
    formato: 'png',
    exigido: true,
    verdad: TRAYECTO_A,
    antifraude: { decision: 'aprobado' },
  },
  {
    id: 'android-oscuro',
    descripcion: 'Android, modo oscuro: el normalizador tiene que invertirla',
    svg: () => plantillaAndroid(TRAYECTO_A, { oscuro: true }),
    formato: 'png',
    exigido: true,
    verdad: TRAYECTO_A,
    antifraude: { decision: 'aprobado' },
  },
  {
    id: 'ios-claro',
    descripcion: 'iOS, modo claro, duracion en mm:ss (el formato que se puede confundir con una hora)',
    svg: () => plantillaIos(TRAYECTO_B),
    formato: 'png',
    exigido: true,
    verdad: TRAYECTO_B,
    antifraude: { decision: 'aprobado' },
  },
  {
    id: 'ios-oscuro',
    descripcion: 'iOS, modo oscuro',
    svg: () => plantillaIos(TRAYECTO_B, { oscuro: true }),
    formato: 'png',
    exigido: true,
    verdad: TRAYECTO_B,
    antifraude: { decision: 'aprobado' },
  },
  {
    id: 'recortada',
    descripcion: 'Recorte que se come la barra de estado y los margenes',
    svg: () => plantillaAndroid(TRAYECTO_A),
    formato: 'png',
    transformar: (img, meta) => img.extract({
      left: Math.round(meta.width * 0.05),
      top: Math.round(meta.height * 0.09),
      width: Math.round(meta.width * 0.9),
      height: Math.round(meta.height * 0.78),
    }),
    exigido: true,
    verdad: TRAYECTO_A,
    antifraude: { decision: 'aprobado' },
  },
  {
    id: 'whatsapp',
    descripcion: 'Reenviada por mensajeria: reescalada a 720 px y recomprimida',
    svg: () => plantillaAndroid(TRAYECTO_A),
    formato: 'jpeg',
    calidad: 28,
    transformar: (img) => img.resize({ width: 720 }),
    exigido: false,
    verdad: TRAYECTO_A,
  },
  {
    id: 'pequena',
    descripcion: 'Captura de 480 px de ancho: el normalizador tiene que ampliarla',
    svg: () => plantillaAndroid(TRAYECTO_A),
    formato: 'png',
    transformar: (img) => img.resize({ width: 480 }),
    exigido: false,
    verdad: TRAYECTO_A,
  },
  {
    id: 'movida',
    descripcion: 'Foto hecha a otra pantalla, desenfocada',
    svg: () => plantillaAndroid(TRAYECTO_A),
    formato: 'jpeg',
    calidad: 80,
    transformar: (img) => img.blur(3.5),
    exigido: false,
    verdad: TRAYECTO_A,
  },
  {
    id: 'varios-trayectos',
    descripcion: 'Tres trayectos del dia en una sola captura (#11)',
    svg: () => plantillaVarios(),
    formato: 'png',
    exigido: true,
    // Los campos sueltos son los del PRIMERO, que es lo que devuelve la lectura
    // de siempre; `trayectos` es la lista entera, que es lo que #11 añade.
    verdad: TRAYECTO_A,
    trayectos: [TRAYECTO_A, TRAYECTO_B, TRAYECTO_C],
  },
  {
    id: 'duracion-mmss',
    descripcion: 'Android con la duracion escrita como 12:00',
    svg: () => plantillaAndroid(TRAYECTO_A, { duracion: duracionCorta(TRAYECTO_A.segundos) }),
    formato: 'png',
    exigido: true,
    verdad: TRAYECTO_A,
    antifraude: { decision: 'aprobado' },
  },
  {
    id: 'manipulada',
    descripcion: 'Retocada: el numero grande dice 6 min, pero las horas siguen diciendo 12',
    svg: () => plantillaAndroid(TRAYECTO_A, { duracion: '6 min 00 s' }),
    formato: 'png',
    exigido: true,
    // La verdad de la IMAGEN: eso es lo que tiene que leer el extractor. Que no
    // cuadre con las horas es cosa del motor de decision, no del OCR.
    verdad: { ...TRAYECTO_A, segundos: 360 },
    antifraude: { decision: 'rechazado', codigo: 'captura_incoherente', tiempoDeclarado: 360 },
  },
  {
    id: 'no-es-bicimad',
    descripcion: 'Captura de otra aplicacion: no puede colarse como trayecto',
    svg: () => plantillaOtraApp(),
    formato: 'png',
    exigido: true,
    verdad: null,
    antifraude: { decision: 'rechazado', codigo: 'no_es_bicimad' },
  },
];

// --- Generacion ---------------------------------------------------------------

async function principal() {
  fs.mkdirSync(DESTINO, { recursive: true });

  const indice = [];

  for (const entrada of BANCO) {
    const base = sharp(Buffer.from(entrada.svg(), 'utf8'));
    const meta = await base.metadata();

    let img = sharp(await base.png().toBuffer());
    if (entrada.transformar) img = entrada.transformar(img, meta);

    const fichero = `${entrada.id}.${entrada.formato === 'jpeg' ? 'jpg' : 'png'}`;
    const salida = entrada.formato === 'jpeg'
      ? img.jpeg({ quality: entrada.calidad || 80 })
      : img.png({ compressionLevel: 9 });

    const bytes = await salida.toBuffer();
    fs.writeFileSync(path.join(DESTINO, fichero), bytes);

    const t = entrada.verdad;
    indice.push({
      id: entrada.id,
      fichero,
      descripcion: entrada.descripcion,
      exigido: entrada.exigido,
      bytes: bytes.length,
      // `null` en `verdad` = la imagen no es una captura de BiciMAD.
      verdad: t ? {
        esBicimad: true,
        origen: t.origen,
        destino: t.destino,
        horaSalida: t.salida,
        horaLlegada: t.llegada,
        segundosDuracion: t.segundos,
      } : { esBicimad: false },
      antifraude: entrada.antifraude || null,
      // Solo lo llevan las capturas con mas de un trayecto.
      trayectos: entrada.trayectos
        ? entrada.trayectos.map((t) => ({
          origen: t.origen,
          destino: t.destino,
          horaSalida: t.salida,
          horaLlegada: t.llegada,
          segundosDuracion: t.segundos,
        }))
        : null,
    });

    console.log(`${fichero.padEnd(26)} ${String(bytes.length).padStart(7)} B  ${entrada.descripcion}`);
  }

  const cabecera = {
    _: 'GENERADO por scripts/build-capturas.js. No editar a mano.',
    _porQue: 'Banco de regresion del extractor (#16). Capturas SINTETICAS: no hay '
      + 'ninguna imagen de ninguna persona en este repositorio. La medicion sobre '
      + 'capturas reales vive en scripts/medir-ocr.js y corre contra Firestore.',
    capturas: indice,
  };

  fs.writeFileSync(path.join(DESTINO, 'esperado.json'), `${JSON.stringify(cabecera, null, 2)}\n`);
  console.log(`\nOK: ${indice.length} capturas en backend/test/banco/`);
}

principal().catch((error) => {
  console.error(error);
  process.exit(1);
});
