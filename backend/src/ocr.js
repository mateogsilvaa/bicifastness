'use strict';

/**
 * Lectura de la captura con OCR local. Sustituye a la auditoria con Gemini.
 *
 * Por que se quito la IA: el proyecto no depende ya de ningun modelo externo.
 * Eso elimina una clave que rotar, una cuota que agotar, un servicio que puede
 * caerse y una llamada de red de hasta 45 s por viaje. A cambio se pierde una
 * cosa concreta, y conviene tenerla escrita:
 *
 *   ANTES  Gemini hacia DOS trabajos: leer la captura y juzgar si estaba
 *          retocada (tipografia que no encaja, restos de clonado, bordes).
 *   AHORA  el OCR solo hace el primero. La deteccion de retoque visual no
 *          tiene sustituto directo sin IA.
 *
 * Lo que la cubre, y no es poco, porque son comprobaciones DETERMINISTAS:
 *
 *   - Coherencia interna: `llegada - salida` tiene que dar la duracion que
 *     muestra el recuadro. Quien retoca una captura cambia el numero grande y
 *     se deja las horas; esta resta lo pilla, y es mas fiable que un juicio
 *     visual.
 *   - Plausibilidad fisica: la geografia no negocia (verificacion.js).
 *   - Huella exacta y perceptual: reenvios y recortes de la misma imagen.
 *   - EXIF: rastros de Photoshop, Snapseed y companía (imagen.js).
 *
 * Y sobre todo: lo que no se lee con claridad NO se aprueba solo. Va a la cola
 * de revision humana, que es donde debe acabar la duda.
 *
 * OJO: la precision del OCR sobre capturas reales no se ha podido medir
 * todavia. Depende del banco de capturas del issue #16. Hasta entonces los
 * umbrales son deliberadamente conservadores.
 */

const fs = require('fs');
const path = require('path');
const normalizar = require('./normalizar');

// tesseract.js trae binarios y datos de idioma. Si el entorno no lo tiene, el
// pipeline sigue en pie: sin lectura, todo va a revision manual.
let Tesseract = null;
try {
  Tesseract = require('tesseract.js');
} catch {
  console.warn('tesseract.js no disponible: los viajes iran a revision manual.');
}

const IDIOMA = 'spa';
const TIMEOUT_MS = 60000;

/**
 * Modo de segmentacion de pagina: 3 = analisis automatico completo.
 *
 * Parece redundante — 3 es el valor "por defecto" de tesseract — pero NO lo es:
 * el que aplica tesseract.js si no se le dice nada depende de su version, y con
 * el que traia se perdian lineas enteras. En concreto se comia la duracion
 * cuando la captura la muestra grande y aislada ("12:00" en su propio bloque),
 * que es justo como la enseña la app. La duracion salia `null`, el motor no
 * podia comparar, y el viaje acababa en revision manual.
 *
 * Lo encontro el banco de capturas (#16): la misma imagen recortada a la zona
 * de la duracion se leia perfectamente, y entera no.
 *
 * Si algun dia las capturas reales dan problemas de maquetacion (tarjetas,
 * columnas), la alternativa a probar es 11 (texto disperso): sobre el banco da
 * el mismo resultado, pero pierde el orden de lectura.
 */
const SEGMENTACION = '3';

/**
 * Resolucion que se le declara a tesseract.
 *
 * Si no se le dice, la estima y ESCRIBE UN AVISO en cada lectura ("Estimating
 * resolution as 608"). Emscripten manda ese aviso por `printErr`, que en el
 * navegador es `console.error`: una linea roja por captura, en la pantalla
 * donde la gente sube sus viajes. Parece que la web esta rota.
 *
 * El valor no es un 300 copiado de un tutorial: la captura se normaliza a 1400
 * px de ancho y una pantalla de movil mide unos 7 cm, o sea unos 600 puntos por
 * pulgada de verdad, que es ademas lo que estimaba tesseract solo. Sobre el
 * banco de capturas da los mismos aciertos que sin declararlo (55/55, medido
 * con 300, con 600 y sin nada), asi que esto solo calla el aviso.
 */
const RESOLUCION = '600';

/**
 * Donde se guardan los datos de idioma para no volver a bajarlos.
 *
 * OJO con el directorio: tesseract.js escribe el `.traineddata` en `cachePath`
 * solo si el directorio YA EXISTE. Si no, no protesta, no lo crea y se baja el
 * idioma otra vez en cada ejecucion — que es lo que llevaba pasando, porque
 * `.tesseract` no estaba en el repositorio ni lo creaba nadie. Por eso se crea
 * aqui y no se da por hecho.
 */
const CACHE = path.join(__dirname, '..', '.tesseract');
try {
  fs.mkdirSync(CACHE, { recursive: true });
} catch {
  // Sin sitio donde cachear se sigue funcionando: solo se paga la descarga.
}

/**
 * De donde sale el `.traineddata`, y por que no de internet.
 *
 * El fichero ya esta en el repositorio: `assets/ocr/spa.traineddata.gz`, que es
 * el que usa el navegador. Sin `langPath`, tesseract.js lo baja de un CDN en
 * cada arranque en frio, y eso mete una dependencia de red DENTRO del pipeline
 * de verificacion: si el CDN tarda o no responde, la tanda entera se va a
 * revision manual por un motivo que no tiene nada que ver con las capturas.
 * Es el mismo argumento por el que se quito Gemini (#10).
 *
 * Ademas hace que los tests corran sin red y que el arranque del worker deje de
 * pagar 2 MB de descarga en cada ejecucion de Actions.
 *
 * Si el fichero no estuviera, se deja `langPath` sin poner y tesseract vuelve a
 * bajarlo: preferimos el camino lento al que no funciona.
 */
const IDIOMA_LOCAL = path.join(__dirname, '..', '..', 'assets', 'ocr');
const HAY_IDIOMA_LOCAL = fs.existsSync(path.join(IDIOMA_LOCAL, `${IDIOMA}.traineddata.gz`));
if (!HAY_IDIOMA_LOCAL) {
  console.warn(`Sin ${IDIOMA}.traineddata.gz en assets/ocr: tesseract lo bajara de la red.`);
}

/**
 * Marcadores de que la imagen es de la app BiciMAD.
 *
 * Sustituye al veredicto `es_bicimad` de la IA por algo comprobable. Es una
 * heuristica, asi que basta con uno: se trata de descartar una foto del gato,
 * no de certificar la captura.
 */
const MARCADORES = [
  'bicimad', 'emt', 'trayecto', 'recorrido', 'duracion', 'duración',
  'estacion', 'estación', 'salida', 'llegada', 'bicicleta',
];

/** Una hora suelta: "HH:MM" o "H:MM". */
const HORA = '\\b([01]?\\d|2[0-3]):([0-5]\\d)\\b';

/**
 * Horas de salida y de llegada, normalizadas a HH:MM.
 *
 * Antes se cogian las dos PRIMERAS horas del texto, y eso esta mal en la
 * captura mas comun que existe: la de Android sin recortar lleva el reloj del
 * sistema en la barra de estado. Ese reloj es la primera hora del texto, asi
 * que pasaba por hora de salida, la salida real pasaba por llegada, y la resta
 * llegada - salida dejaba de cuadrar con la duracion.
 *
 * Consecuencia, que no es teorica: la comprobacion de coherencia interna — la
 * mejor defensa que queda contra el retoque desde que no hay IA — disparaba
 * `captura_desviada` en viajes legitimos. Lo encontro el banco de capturas
 * (#16) en cuanto hubo con que medir.
 *
 * Ahora manda la ETIQUETA, y solo si no hay etiquetas legibles se vuelve al
 * criterio de orden, que sigue siendo mejor que nada.
 */
function horasEtiquetadas(texto) {
  const conEtiqueta = (etiquetas) => {
    // Hasta 12 caracteres que no sean parte de la hora entre la etiqueta y el
    // numero: cabe "Salida:  ", "Salida ---" y lo que el OCR meta por medio,
    // pero no la siguiente linea entera.
    const m = texto.match(new RegExp(`(?:${etiquetas})\\W{0,12}${HORA}`, 'i'));
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
  };

  return {
    salida: conEtiqueta('salida|inicio|comienzo|desde'),
    llegada: conEtiqueta('llegada|fin|final|hasta'),
  };
}

function extraerHoras(texto) {
  const { salida, llegada } = horasEtiquetadas(texto);
  if (salida && llegada) return [salida, llegada];

  const encontradas = [...texto.matchAll(new RegExp(HORA, 'g'))]
    .map((m) => `${m[1].padStart(2, '0')}:${m[2]}`);
  return [...new Set(encontradas)];
}

/**
 * Numeros de estacion. En la app el formato es "Numero - Nombre (Numero)", que
 * ya venia contemplado en el prompt de la IA y sigue siendo cierto.
 */
function extraerEstaciones(texto) {
  const conParentesis = [...texto.matchAll(/\((\d{1,3}[a-zA-Z]?)\)/g)].map((m) => m[1]);
  if (conParentesis.length >= 2) return conParentesis;

  // Respaldo: numero al principio de linea seguido de guion.
  const alPrincipio = [...texto.matchAll(/^\s*(\d{1,3})\s*[-–]\s*\S/gm)].map((m) => m[1]);
  return alPrincipio;
}

/**
 * Duracion mostrada, en segundos.
 * Acepta "12:34", "12 min 34 s" y "12 min".
 */
function extraerDuracion(texto) {
  const conUnidades = texto.match(/(\d{1,3})\s*min(?:utos?)?(?:\s*(?:y\s*)?(\d{1,2})\s*s)?/i);
  if (conUnidades) {
    return Number(conUnidades[1]) * 60 + Number(conUnidades[2] || 0);
  }

  // "mm:ss" pegado a una etiqueta de duracion, para no confundirlo con una hora.
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
function extraerTrayectos(texto) {
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
function elegirTrayecto(lectura, ruta) {
  const trayectos = (lectura && lectura.trayectos) || [];
  if (trayectos.length <= 1) return lectura;

  const sinCeros = (v) => String(v || '').replace(/^0+/, '');
  const [origen, destino] = String(ruta || '').split('-').map(sinCeros);

  const encaja = trayectos.find((t) => sinCeros(t.origen) === origen && sinCeros(t.destino) === destino);
  return { ...lectura, ...(encaja || trayectos[0]) };
}

/**
 * UN worker de tesseract para toda la tanda, no uno por captura.
 *
 * Arrancar el worker y cargar el modelo de idioma cuesta lo mismo tanto si se
 * lee una captura como si se leen veinticinco, y el worker de verificacion
 * procesa hasta veinticinco por ejecucion. Creando uno por captura, ese coste
 * se pagaba entero cada vez, y ademas cada worker deja procesos y temporizadores
 * que tardan en soltarse: en los tests, doce capturas tardaban 72 segundos, de
 * los cuales solo doce eran leer (#14).
 *
 * A cambio hay que acordarse de cerrarlo: mientras viva, mantiene vivo el bucle
 * de eventos y el proceso no termina. Lo hace `worker.js` al acabar la tanda.
 */
let worker = null;

/**
 * Aviso del `errorHandler` de la lectura en curso.
 *
 * `errorHandler` NO es opcional aunque lo parezca. Sin el, tesseract hace
 * `throw Error(data)` desde el manejador de mensajes del worker, o sea FUERA de
 * cualquier promesa: no lo recoge ningun try/catch y tumba el proceso entero.
 * Una sola captura mala se llevaria por delante la tanda completa.
 */
let fallo = null;

async function obtenerWorker() {
  if (worker) return worker;

  worker = await Tesseract.createWorker(IDIOMA, 1, {
    cachePath: CACHE,
    ...(HAY_IDIOMA_LOCAL ? { langPath: IDIOMA_LOCAL, gzip: true } : {}),
    errorHandler: (datos) => { fallo = datos; },
  });
  await worker.setParameters({
    tessedit_pageseg_mode: SEGMENTACION,
    user_defined_dpi: RESOLUCION,
  });
  return worker;
}

/**
 * Suelta el worker. Llamarlo al terminar de leer capturas, o el proceso se
 * queda vivo esperando a un worker que ya no va a hacer nada.
 * Es idempotente: llamarlo dos veces no es un error.
 */
async function cerrar() {
  if (!worker) return;
  const suyo = worker;
  worker = null;
  await suyo.terminate().catch(() => {});
}

/**
 * Lee la captura. Nunca lanza: si algo falla devuelve `{ disponible: false }`
 * y el pipeline manda el viaje a revision humana en vez de romperse.
 *
 * Devuelve la misma forma que devolvia la auditoria con IA, para que el motor
 * de decision no tenga que distinguir de donde viene la lectura.
 */
async function leerCaptura({ buffer }) {
  if (!Tesseract) {
    return { disponible: false, error: 'OCR no disponible en este entorno.' };
  }

  // Fuera del try para poder cancelarlo pase lo que pase.
  let temporizador = null;

  try {
    const preparada = await normalizar.preparar(buffer);
    if (!preparada) {
      return { disponible: false, error: 'La captura no es una imagen legible.' };
    }

    const worker = await obtenerWorker();

    // El aviso del `errorHandler` es de ESTA lectura: se limpia antes de
    // pedirla, porque el manejador se instala una vez y el worker se reutiliza.
    fallo = null;

    const reconocer = worker.recognize(preparada.buffer);
    const limite = new Promise((_, rechazar) => {
      temporizador = setTimeout(() => rechazar(new Error('Tiempo de espera agotado')), TIMEOUT_MS);
    });

    const { data } = await Promise.race([reconocer, limite]);

    // Tesseract puede avisar de un problema por `errorHandler` sin llegar a
    // rechazar la promesa. Si eso pasa, lo leido no es de fiar y vale mas
    // mandarlo a revision que dar por buena una lectura a medias.
    if (fallo) {
      return { disponible: false, error: `El OCR ha fallado: ${fallo}` };
    }

    const texto = String(data.text || '');
    const plano = texto.toLowerCase();

    const horas = extraerHoras(texto);
    const estaciones = extraerEstaciones(texto);

    return {
      disponible: true,
      // Todos los trayectos que hay en la captura (#11). Los campos sueltos de
      // abajo siguen siendo los del primero, para no cambiarle la forma a quien
      // solo espera uno.
      trayectos: extraerTrayectos(texto),
      esBicimad: MARCADORES.some((m) => plano.includes(m)),
      // De donde venia la captura. No decide nada: sirve para poder MEDIR
      // despues donde falla la extraccion. Sin esto, "el OCR falla a veces" no
      // se convierte nunca en "falla en recortes de iPhone".
      variante: preparada.variante,
      oscura: preparada.oscura,
      // Confianza real que da tesseract, no una opinion.
      confianza: Math.max(0, Math.min(100, Math.round(data.confidence ?? 0))),
      origen: estaciones[0] || '',
      destino: estaciones[1] || '',
      horaSalida: horas[0] || '',
      horaLlegada: horas[1] || '',
      segundosDuracion: extraerDuracion(texto),
      texto,
    };
  } catch (err) {
    // Tesseract rechaza con una cadena suelta, no con un Error, asi que
    // `err.message` sale undefined y el motivo se pierde. El motivo acaba en la
    // auditoria del viaje y en la cola de revision: sin el, quien revisa no
    // sabe que ha pasado.
    const motivo = (err && err.message) || String(err) || 'motivo desconocido';

    // Una lectura que revienta o que agota el tiempo puede dejar el worker en
    // mal estado, y como ahora se REUTILIZA, ese mal estado se lo comerian
    // todas las capturas siguientes de la tanda. Se tira y la proxima lectura
    // arranca uno limpio.
    await cerrar();

    return { disponible: false, error: `No se ha podido leer la captura: ${motivo}` };
  } finally {
    // Cuando gana la lectura, el temporizador de la carrera SEGUIA vivo: un
    // `setTimeout` de un minuto colgando por cada captura. En el worker no se
    // notaba porque acaba con `process.exit`, pero mantenia el proceso en pie
    // un minuto entero despues de terminar el trabajo — que es justo lo que
    // hacia que los tests del banco tardasen setenta segundos en salir.
    clearTimeout(temporizador);
  }
}

module.exports = {
  leerCaptura,
  extraerTrayectos,
  elegirTrayecto,
  // Hay que llamarlo al terminar la tanda: el worker de tesseract se comparte y
  // mantiene vivo el proceso mientras exista.
  cerrar,
  // Exportadas sueltas para poder probar el parseo sin pasar por el OCR, que es
  // lento y depende de los datos de idioma.
  extraerHoras,
  horasEtiquetadas,
  extraerEstaciones,
  extraerDuracion,
  MARCADORES,
  // El navegador lee la captura con estos mismos dos ajustes (`AJUSTES_WORKER`
  // en `assets/js/extraccion.js`). Se exportan para que una prueba compare los
  // dos lados: si se movieran solo aqui, el navegador propondria una lectura
  // distinta de la que va a hacer el worker y el viaje acabaria en revision
  // manual sin que nada fallara ni avisara.
  SEGMENTACION,
  RESOLUCION,
};
