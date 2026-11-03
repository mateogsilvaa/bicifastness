/**
 * Lector con PaddleOCR (PP-OCRv4 en ONNX, por CPU, sin claves ni cupo).
 *
 * Tesseract hace analisis de pagina completa sobre un render con suavizado y
 * fondo de color, y en las tarjetas del historial trocea mal: estaciones al
 * reves, cifras cambiadas. PaddleOCR detecta primero cada linea de texto y la
 * reconoce aparte, que es justo lo que es una captura de BiciMAD; con las
 * capturas reales que fallaban lee todo bien y en orden (unos 2,5 s).
 *
 * Devuelve una lectura con la MISMA forma que `ocr.leerCaptura`: el texto se
 * reconstruye de arriba abajo con la posicion de cada linea y pasa por los
 * mismos analizadores (extraerTrayectos, horas, fecha...). No decide nada: es
 * una lectura mas que el worker compara con lo declarado.
 *
 * Nunca lanza: si el paquete o el modelo no estan, `{ disponible: false }`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const ocr = require('./ocr');

let motor = null;
let roto = false;

async function obtenerMotor() {
  if (motor || roto) return motor;
  try {
    const { default: Ocr } = await import('@gutenye/ocr-node');
    motor = await Ocr.create();
  } catch (error) {
    roto = true;
    console.warn('PaddleOCR no disponible:', error.message);
  }
  return motor;
}

/**
 * Las lineas detectadas, de arriba abajo, juntando las que estan a la misma
 * altura (de izquierda a derecha). Pura, para poder probarla.
 *
 * @param {Array<{text: string, box: number[][]}>} lineas
 */
function textoDeLineas(lineas) {
  const ordenadas = (lineas || [])
    .filter((l) => String(l?.text || '').trim() && Array.isArray(l.box) && l.box.length >= 4)
    .map((l) => {
      const ys = l.box.map((p) => p[1]);
      const xs = l.box.map((p) => p[0]);
      return { texto: String(l.text).trim(), y0: Math.min(...ys), y1: Math.max(...ys), x0: Math.min(...xs) };
    })
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const filas = [];
  for (const l of ordenadas) {
    const fila = filas[filas.length - 1];
    const alto = Math.max(1, l.y1 - l.y0);
    if (fila && Math.abs(l.y0 - fila.y0) < alto * 0.5) fila.partes.push(l);
    else filas.push({ y0: l.y0, partes: [l] });
  }
  return filas.map((f) => f.partes.sort((a, b) => a.x0 - b.x0).map((p) => p.texto).join(' ')).join('\n');
}

/** La lectura de una captura a partir de su texto. Pura. */
function lecturaDeTexto(texto) {
  const estaciones = ocr.extraerEstaciones(texto);
  const horas = ocr.extraerHoras(texto);
  return ocr.conPrimerTrayecto({
    disponible: true,
    fuente: 'paddle',
    trayectos: ocr.extraerTrayectos(texto),
    origen: estaciones[0] || '',
    destino: estaciones[1] || '',
    horaSalida: horas[0] || '',
    horaLlegada: horas[1] || '',
    segundosDuracion: ocr.extraerDuracion(texto),
    numeroBici: ocr.extraerBici(texto),
    fecha: ocr.extraerFechas(texto)[0]?.fecha || '',
    texto,
  });
}

async function leerConPaddle({ buffer }) {
  const m = await obtenerMotor();
  if (!m) return { disponible: false, error: 'PaddleOCR no disponible' };
  // La libreria abre la imagen por ruta: un fichero temporal, que se borra.
  const fichero = path.join(os.tmpdir(), `bf-paddle-${process.pid}-${Date.now()}.png`);
  try {
    await require('sharp')(buffer).png().toFile(fichero);
    const { texts } = await m.detect(fichero);
    const texto = textoDeLineas(texts);
    if (!texto.trim()) return { disponible: false, error: 'sin texto' };
    const puntuaciones = (texts || []).map((t) => Number(t.mean ?? t.score)).filter(Number.isFinite);
    const confianza = puntuaciones.length
      ? Math.round((puntuaciones.reduce((a, b) => a + b, 0) / puntuaciones.length) * 100)
      : 70;
    return { ...lecturaDeTexto(texto), confianza };
  } catch (error) {
    return { disponible: false, error: `PaddleOCR: ${String(error?.message || error).slice(0, 120)}` };
  } finally {
    fs.promises.unlink(fichero).catch(() => { /* ya no estaba */ });
  }
}

module.exports = { leerConPaddle, textoDeLineas, lecturaDeTexto };
