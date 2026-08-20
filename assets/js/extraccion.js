/**
 * Leer la captura EN EL NAVEGADOR, para poder preguntar "esto es lo que veo,
 * confirmas?" en el momento (issue #8).
 *
 * Antes habia que transcribir a mano las dos estaciones y el tiempo que ya
 * estaban en la imagen, y cada errata acababa en la cola de revision manual.
 * Ahora se escribe solo lo que haya que corregir.
 *
 * POR QUE AQUI Y NO EN EL WORKER. El worker tambien lee la captura, y va a
 * seguir haciendolo: es el unico que decide. Pero tarda minutos, y una pantalla
 * de confirmacion que llega minutos despues no es una confirmacion, es otra
 * espera. Lo de aqui es para la persona; lo del worker es para el veredicto.
 *
 * LO QUE CUESTA. El motor y el modelo de idioma son unos cinco megas que el
 * navegador se baja UNA vez, y solo cuando alguien va a subir un viaje de
 * verdad (esto se carga al elegir la foto, no al abrir la pagina). Si algo
 * falla — navegador antiguo, red mala, sin espacio — la pagina de subida cae al
 * formulario manual de siempre. Nunca se queda nadie sin poder subir.
 *
 * NADA DE ESTO ES SEGURIDAD. Lo que se lea aqui es una PROPUESTA que el usuario
 * confirma o corrige, y el worker vuelve a leer la captura por su cuenta y
 * compara. Quien manipule lo que sale de aqui se encuentra con esa comparacion.
 *
 * Este fichero no importa nada del proyecto a proposito: asi los tests pueden
 * cargarlo sin navegador (ver `backend/test/cliente.test.js`).
 */

const RUTA_OCR = '/assets/ocr';

/** Ancho al que se lee, el mismo que usa el worker (`backend/src/normalizar.js`). */
const ANCHO_OCR = 1400;

/** Por debajo de esta luminancia media la captura es de modo oscuro. */
const UMBRAL_OSCURO = 110;

/**
 * Modo de segmentacion de pagina. El mismo que el worker, y por el mismo
 * motivo: sin fijarlo, tesseract se come la linea de la duracion cuando va
 * grande y aislada.
 */
const SEGMENTACION = '3';

/**
 * Tope para una lectura. Si se pasa de aqui, se le da el formulario manual.
 *
 * Sin esto, un motor que se queda a medias (wasm que no instancia, memoria que
 * no llega) deja la pantalla esperando para siempre y sin decir nada, que es la
 * peor forma de fallar que existe.
 */
const TIMEOUT_MS = 45000;

// --- Parseo del texto ---------------------------------------------------------
/**
 * OJO: estas tres funciones son GEMELAS de las de `backend/src/ocr.js`.
 *
 * Estan duplicadas porque el backend es CommonJS y esto es un modulo ES que
 * ademas tiene que poder cargarse suelto; compartir el fichero exigiria un
 * empaquetador que este proyecto no tiene. Lo que impide que se separen es un
 * test que ejecuta LAS DOS sobre el mismo corpus de textos y exige que
 * devuelvan lo mismo. Si tocas una, toca la otra.
 */

const HORA = '\\b([01]?\\d|2[0-3]):([0-5]\\d)\\b';

export function horasEtiquetadas(texto) {
  const conEtiqueta = (etiquetas) => {
    const m = texto.match(new RegExp(`(?:${etiquetas})\\W{0,12}${HORA}`, 'i'));
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
  };

  return {
    salida: conEtiqueta('salida|inicio|comienzo|desde'),
    llegada: conEtiqueta('llegada|fin|final|hasta'),
  };
}

export function extraerHoras(texto) {
  const { salida, llegada } = horasEtiquetadas(texto);
  if (salida && llegada) return [salida, llegada];

  const encontradas = [...texto.matchAll(new RegExp(HORA, 'g'))]
    .map((m) => `${m[1].padStart(2, '0')}:${m[2]}`);
  return [...new Set(encontradas)];
}

export function extraerEstaciones(texto) {
  const conParentesis = [...texto.matchAll(/\((\d{1,3}[a-zA-Z]?)\)/g)].map((m) => m[1]);
  if (conParentesis.length >= 2) return conParentesis;

  const alPrincipio = [...texto.matchAll(/^\s*(\d{1,3})\s*[-–]\s*\S/gm)].map((m) => m[1]);
  return alPrincipio;
}

export function extraerDuracion(texto) {
  const conUnidades = texto.match(/(\d{1,3})\s*min(?:utos?)?(?:\s*(?:y\s*)?(\d{1,2})\s*s)?/i);
  if (conUnidades) return Number(conUnidades[1]) * 60 + Number(conUnidades[2] || 0);

  const junto = texto.match(/(?:duraci[oó]n|tiempo)\D{0,20}(\d{1,3}):([0-5]\d)/i);
  if (junto) return Number(junto[1]) * 60 + Number(junto[2]);

  return null;
}

/**
 * Trocea el texto de la captura en TRAYECTOS (issue #11).
 *
 * El historial de BiciMAD es una lista, asi que es de lo mas normal que una
 * captura recoja dos o tres viajes. Hasta ahora se leia como si siempre hubiera
 * uno: se cogian las dos primeras estaciones y la primera duracion, y el resto
 * de la imagen se ignoraba. Quien subia una captura de su dia acababa en la
 * cola de revision manual sin entender por que.
 *
 * COMO SE TROCEA. Por lineas, y con una regla simple: cada vez que aparece una
 * estacion cuando el trayecto que se esta montando ya tiene las dos suyas,
 * empieza uno nuevo. Las horas solo cuentan si van ETIQUETADAS (salida,
 * llegada), que es lo que evita que el reloj de la barra de estado se cuele
 * como hora de salida del primero.
 *
 * No se usa la geometria de la imagen (posiciones de cada linea) a proposito:
 * seria mas exacto, pero ata el parseo a lo que devuelva la version de turno
 * del OCR, y esto tiene que funcionar igual en el navegador y en el worker.
 */
export function extraerTrayectos(texto) {
  const trayectos = [];
  let actual = null;

  const guardar = () => {
    if (actual && actual.origen && actual.destino) trayectos.push(actual);
    actual = null;
  };

  const nuevo = () => ({
    origen: '', destino: '', horaSalida: '', horaLlegada: '', segundosDuracion: null,
  });

  for (const linea of String(texto || '').split(/\r?\n/)) {
    const estaciones = extraerEstaciones(linea);

    for (const estacion of estaciones) {
      if (!actual) actual = nuevo();
      // Ya tenia las dos: esta estacion abre el siguiente trayecto.
      if (actual.origen && actual.destino) { guardar(); actual = nuevo(); }

      if (!actual.origen) actual.origen = estacion;
      else actual.destino = estacion;
    }

    if (!actual) continue;

    const horas = horasEtiquetadas(linea);
    if (horas.salida && !actual.horaSalida) actual.horaSalida = horas.salida;
    if (horas.llegada && !actual.horaLlegada) actual.horaLlegada = horas.llegada;

    const duracion = extraerDuracion(linea);
    if (duracion !== null && actual.segundosDuracion === null) actual.segundosDuracion = duracion;
  }

  guardar();
  return trayectos;
}

/**
 * De todos los trayectos de la captura, el que dice ser este viaje.
 *
 * Sin esto, subir los tres viajes de una misma captura acabaria con dos
 * rechazados por `ruta_no_coincide`: el motor compararia los tres contra el
 * primer trayecto que se lea. Si ninguno encaja se devuelve el primero, y
 * entonces la señal salta con razon.
 */
export function elegirTrayecto(lectura, ruta) {
  const trayectos = (lectura && lectura.trayectos) || [];
  if (trayectos.length <= 1) return lectura;

  const sinCeros = (v) => String(v || '').replace(/^0+/, '');
  const [origen, destino] = String(ruta || '').split('-').map(sinCeros);

  const encaja = trayectos.find((t) => sinCeros(t.origen) === origen && sinCeros(t.destino) === destino);
  return { ...lectura, ...(encaja || trayectos[0]) };
}

export const MARCADORES = [
  'bicimad', 'emt', 'trayecto', 'recorrido', 'duracion', 'duración',
  'estacion', 'estación', 'salida', 'llegada', 'bicicleta',
];

/** Lo que se puede sacar de un texto ya leido. Sin navegador: se puede probar. */
export function interpretar(texto) {
  const plano = String(texto || '').toLowerCase();
  const horas = extraerHoras(texto);
  const estaciones = extraerEstaciones(texto);

  return {
    esBicimad: MARCADORES.some((m) => plano.includes(m)),
    // Todos los trayectos de la captura (#11). Los campos sueltos siguen siendo
    // los del primero, para quien solo espera uno.
    trayectos: extraerTrayectos(texto),
    origen: estaciones[0] || '',
    destino: estaciones[1] || '',
    horaSalida: horas[0] || '',
    horaLlegada: horas[1] || '',
    segundosDuracion: extraerDuracion(texto),
  };
}

// --- Motor --------------------------------------------------------------------

let worker = null;
let cargando = null;

/**
 * Arranca el worker de tesseract. Una sola vez por pestaña.
 *
 * `cargando` evita que dos fotos elegidas seguidas arranquen dos motores de
 * cinco megas cada uno.
 */
function arrancar(alProgresar) {
  if (worker) return Promise.resolve(worker);
  if (cargando) return cargando;

  cargando = (async () => {
    // La compilacion ESM de tesseract.js exporta TODO colgando de `default`, no
    // como exportaciones sueltas. Un `import { createWorker }` compila sin
    // quejarse y explota en ejecucion con "createWorker is not a function".
    const modulo = await import(`${RUTA_OCR}/tesseract.esm.min.js`);
    const { createWorker } = modulo.default || modulo;

    worker = await createWorker('spa', 1, {
      workerPath: `${RUTA_OCR}/worker.min.js`,
      // Un fichero concreto y no un directorio: asi tesseract no busca la
      // variante que toque y no hay que llevar las seis en el repositorio. Y
      // tiene que ser la que lleva el wasm incrustado, porque el worker corre
      // desde un `blob:` y desde ahi no se resuelve una ruta relativa.
      corePath: `${RUTA_OCR}/tesseract-core-simd-lstm.wasm.js`,
      langPath: RUTA_OCR,
      logger: (m) => {
        if (alProgresar && typeof m.progress === 'number') alProgresar(m.status, m.progress);
      },
    });

    await worker.setParameters({ tessedit_pageseg_mode: SEGMENTACION });
    return worker;
  })();

  // Si falla, que el siguiente intento pueda volver a probar.
  cargando.catch(() => { cargando = null; worker = null; });
  return cargando;
}

/** Suelta el motor y sus cinco megas de memoria. */
export async function cerrar() {
  const suyo = worker;
  worker = null;
  cargando = null;
  if (suyo) await suyo.terminate().catch(() => {});
}

/**
 * Deja la captura como la deja el worker antes de leerla: a un ancho fijo, en
 * gris y, si viene en modo oscuro, invertida.
 *
 * La inversion no es un capricho: tesseract acierta bastante mas con texto
 * oscuro sobre fondo claro, y sin ella una captura en modo oscuro se lee mucho
 * peor. Es la version de canvas de `backend/src/normalizar.js`; lo que no se
 * hace aqui es recortar margenes, que alli sirve para quitar la barra de estado
 * y aqui no compensa el codigo.
 */
export function prepararParaOcr(imagen) {
  const escala = Math.min(ANCHO_OCR / imagen.naturalWidth, 4);
  const lienzo = document.createElement('canvas');
  lienzo.width = Math.round(imagen.naturalWidth * escala);
  lienzo.height = Math.round(imagen.naturalHeight * escala);

  const ctx = lienzo.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, lienzo.width, lienzo.height);
  ctx.drawImage(imagen, 0, 0, lienzo.width, lienzo.height);

  const pixeles = ctx.getImageData(0, 0, lienzo.width, lienzo.height);
  const datos = pixeles.data;

  let suma = 0;
  for (let i = 0; i < datos.length; i += 4) {
    datos[i] = 0.299 * datos[i] + 0.587 * datos[i + 1] + 0.114 * datos[i + 2];
    suma += datos[i];
  }

  const media = suma / (datos.length / 4);
  const invertir = media < UMBRAL_OSCURO;

  for (let i = 0; i < datos.length; i += 4) {
    const gris = invertir ? 255 - datos[i] : datos[i];
    datos[i] = gris;
    datos[i + 1] = gris;
    datos[i + 2] = gris;
    // El alfa se deja en paz. Invertirlo es lo que dejaba las capturas oscuras
    // completamente transparentes en el worker, y el OCR leia una hoja blanca.
  }

  ctx.putImageData(pixeles, 0, 0);
  return { lienzo, oscura: invertir };
}

/**
 * Lee una captura y devuelve lo que ha entendido.
 *
 * Nunca lanza por culpa del OCR: si no se puede leer devuelve
 * `{ disponible: false }` y quien llama enseña el formulario manual.
 *
 * @param {HTMLImageElement} imagen  la captura ya decodificada
 * @param {(estado: string, progreso: number) => void} [alProgresar]
 */
export async function extraer(imagen, alProgresar) {
  let temporizador = null;

  try {
    const { lienzo, oscura } = prepararParaOcr(imagen);

    // El reloj cuenta desde el principio: la descarga del motor tambien puede
    // quedarse colgada, y para quien espera es el mismo problema.
    const conReloj = (promesa) => Promise.race([
      promesa,
      new Promise((_, mal) => {
        temporizador = setTimeout(() => mal(new Error('La lectura ha tardado demasiado.')), TIMEOUT_MS);
      }),
    ]);

    const motor = await conReloj(arrancar(alProgresar));
    const { data } = await conReloj(motor.recognize(lienzo));
    const texto = String(data.text || '');

    return {
      disponible: true,
      oscura,
      confianza: Math.max(0, Math.min(100, Math.round(data.confidence ?? 0))),
      texto,
      ...interpretar(texto),
    };
  } catch (error) {
    // Un navegador sin SIMD, sin espacio o sin red se queda aqui. No es un
    // error del usuario y no se le cuenta como tal: se le da el formulario.
    console.debug('No se ha podido leer la captura en el navegador', error);
    return { disponible: false, error: error?.message || 'No se ha podido leer la captura.' };
  } finally {
    // Cancelarlo importa: un temporizador de 45 s que sobrevive a cada lectura
    // mantiene la pestaña despierta sin motivo. Es el mismo fallo que tenia el
    // worker y que se encontro midiendo el banco.
    clearTimeout(temporizador);
  }
}
