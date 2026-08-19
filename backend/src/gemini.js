'use strict';

/**
 * Auditoria forense de la captura con Gemini.
 *
 * Antes esto corria en el NAVEGADOR del admin, con una API key que cualquier
 * usuario registrado podia leer de la coleccion `secrets` de Firestore. Ahora
 * corre aqui y la key vive en Secret Manager: no sale nunca del servidor.
 */

const MODELO = 'gemini-2.0-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`;
const TIMEOUT_MS = 45000;

const PROMPT = `Eres un auditor forense digital especializado en detectar capturas de pantalla manipuladas de la app BiciMAD (bicicleta publica de Madrid).

Analiza la imagen y responde SOLO con el JSON del esquema indicado.

PASO 1 — INTEGRIDAD VISUAL
- Compara el renderizado del texto de las horas de salida y llegada con el resto del texto de la interfaz. Fijate en el grosor del trazo, el suavizado de bordes, el interletraje y el ruido de compresion alrededor. El texto superpuesto a posteriori casi nunca coincide.
- Comprueba la alineacion vertical y horizontal respecto a los elementos de la interfaz.
- Busca bordes borrosos, rectangulos de un color plano ligeramente distinto al fondo, o restos de clonado alrededor de las cifras.
- El formato de estacion "Numero - Nombre (Numero)" es correcto en la app real: NO lo marques como anomalia.

PASO 2 — EXTRACCION (solo si el paso 1 no ha detectado manipulacion)
Extrae literalmente lo que se ve, sin corregir ni inferir nada.

PASO 3 — VEREDICTO
- es_bicimad: false si no es una captura de la app BiciMAD.
- integridad_visual: false si detectas manipulacion.
- confianza: 0 a 100, lo seguro que estas del veredicto.
Si un dato no se lee con claridad, deja el campo vacio en vez de inventarlo.`;

const ESQUEMA = {
  type: 'OBJECT',
  properties: {
    es_bicimad: { type: 'BOOLEAN' },
    integridad_visual: { type: 'BOOLEAN' },
    confianza: { type: 'INTEGER' },
    motivo_manipulacion: { type: 'STRING' },
    origen: { type: 'STRING' },
    destino: { type: 'STRING' },
    segundos_duracion: { type: 'INTEGER' },
    hora_salida: { type: 'STRING' },
    hora_llegada: { type: 'STRING' },
  },
  required: ['es_bicimad', 'integridad_visual', 'confianza'],
};

/**
 * Llama a Gemini y devuelve el veredicto ya parseado.
 * Nunca lanza por fallo de red o de la IA: devuelve `{ disponible: false }`
 * para que el pipeline lo mande a revision manual en vez de romperse.
 */
async function auditarCaptura({ buffer, mime, apiKey }) {
  if (!apiKey) {
    return { disponible: false, error: 'No hay API key de Gemini configurada.' };
  }

  const cuerpo = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inline_data: { mime_type: mime, data: buffer.toString('base64') } },
      ],
    }],
    // Salida estructurada: elimina el frágil parseo de bloques ```json que
    // hacia la version anterior y que petaba con cualquier texto extra.
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: ESQUEMA,
    },
    safetySettings: [
      'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT',
    ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
  };

  const control = new AbortController();
  const temporizador = setTimeout(() => control.abort(), TIMEOUT_MS);

  try {
    const respuesta = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(cuerpo),
      signal: control.signal,
    });

    if (!respuesta.ok) {
      const detalle = await respuesta.text().catch(() => '');
      return { disponible: false, error: `Gemini HTTP ${respuesta.status}: ${detalle.slice(0, 200)}` };
    }

    const datos = await respuesta.json();
    const texto = datos?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!texto) return { disponible: false, error: 'Gemini no ha devuelto contenido.' };

    let veredicto;
    try {
      veredicto = JSON.parse(texto);
    } catch {
      return { disponible: false, error: 'La respuesta de Gemini no es JSON valido.' };
    }

    return {
      disponible: true,
      esBicimad: veredicto.es_bicimad === true,
      integridadVisual: veredicto.integridad_visual === true,
      confianza: Number.isFinite(veredicto.confianza)
        ? Math.max(0, Math.min(100, veredicto.confianza))
        : 0,
      motivoManipulacion: String(veredicto.motivo_manipulacion || '').slice(0, 300),
      origen: String(veredicto.origen || '').trim(),
      destino: String(veredicto.destino || '').trim(),
      segundosDuracion: Number.isFinite(veredicto.segundos_duracion)
        ? veredicto.segundos_duracion
        : null,
      horaSalida: String(veredicto.hora_salida || '').trim(),
      horaLlegada: String(veredicto.hora_llegada || '').trim(),
    };
  } catch (err) {
    const motivo = err.name === 'AbortError' ? 'Tiempo de espera agotado' : err.message;
    return { disponible: false, error: `No se ha podido contactar con Gemini: ${motivo}` };
  } finally {
    clearTimeout(temporizador);
  }
}

module.exports = { auditarCaptura };
