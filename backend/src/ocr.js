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

// Los datos de idioma se descargan una vez y se reutilizan. Sin esto, cada
// ejecucion del worker se los vuelve a bajar.
const CACHE = path.join(__dirname, '..', '.tesseract');

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

/** "HH:MM" o "H:MM" -> los devuelve normalizados, en orden de aparicion. */
function extraerHoras(texto) {
  const encontradas = [...texto.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)]
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

  let worker;
  try {
    const preparada = await normalizar.preparar(buffer);
    if (!preparada) {
      return { disponible: false, error: 'La captura no es una imagen legible.' };
    }

    // `errorHandler` NO es opcional aunque lo parezca. Sin el, tesseract hace
    // `throw Error(data)` desde el manejador de mensajes del worker, o sea
    // FUERA de cualquier promesa: no lo recoge este try/catch y tumba el
    // proceso entero. Una sola captura mala se llevaria por delante la tanda
    // completa del worker.
    let fallo = null;
    worker = await Tesseract.createWorker(IDIOMA, 1, {
      cachePath: CACHE,
      errorHandler: (datos) => { fallo = datos; },
    });

    const reconocer = worker.recognize(preparada.buffer);
    const limite = new Promise((_, rechazar) =>
      setTimeout(() => rechazar(new Error('Tiempo de espera agotado')), TIMEOUT_MS));

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
    return { disponible: false, error: `No se ha podido leer la captura: ${motivo}` };
  } finally {
    if (worker) await worker.terminate().catch(() => {});
  }
}

module.exports = {
  leerCaptura,
  // Exportadas sueltas para poder probar el parseo sin pasar por el OCR, que es
  // lento y depende de los datos de idioma.
  extraerHoras,
  extraerEstaciones,
  extraerDuracion,
  MARCADORES,
};
