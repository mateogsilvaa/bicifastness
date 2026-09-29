/**
 * Recogida de errores del navegador.
 *
 * Sin esto, cuando a alguien le falla la web o escribe o no nos enteramos. Con
 * la verificacion automatica y sin tiempo para vigilar, esto es lo que impide
 * que un fallo dure semanas.
 *
 * DOS COSAS QUE NO SON NEGOCIABLES
 *
 * 1. No se guarda nada que identifique a la persona. Ni correo, ni nombre, ni
 *    uid. El identificador de sesion es aleatorio y se muere con la pestaña.
 *    Esta coleccion existe para arreglar fallos, no para saber quien los sufre.
 *
 * 2. Se escribe SIN SESION, y es la unica del proyecto que lo hace. Un fallo en
 *    el registro tambien hay que verlo, y ahi todavia no hay cuenta. Eso la
 *    convierte en una via de llenar la base de datos gratis, asi que:
 *      - cada huella se escribe UNA VEZ por sesion, no una por repeticion
 *      - hay un tope duro de escrituras por sesion
 *      - las reglas acotan campos y tamaños
 *
 * Un bucle de render que lance 500 errores iguales produce UNA escritura.
 */

import { db, doc, setDoc, increment, serverTimestamp } from './firebase.js';
import { VERSION_APP } from '../data/version.js';

/** Tope de huellas distintas por sesion. Mas que esto no es informacion util. */
const MAX_POR_SESION = 8;

/**
 * Huellas ya enviadas en esta sesion.
 *
 * Vive en memoria y se muere con la pestaña: no hace falta identificador de
 * sesion, ni cookie, ni almacenamiento. El conjunto ES la sesion.
 */
const vistas = new Set();

/**
 * Normaliza la pila para que el MISMO fallo produzca la MISMA huella.
 *
 * Sin esto, dos usuarios con el mismo error generan huellas distintas porque la
 * pila lleva el origen completo y los numeros de linea de su build. Se quedan
 * los nombres de fichero y funcion, que es lo que identifica el fallo.
 */
function normalizarPila(pila) {
  return String(pila || '')
    .split('\n')
    .slice(0, 6)
    .map((linea) => linea
      .replace(/https?:\/\/[^/]+/g, '')
      .replace(/:\d+:\d+/g, '')
      .trim())
    .join('|');
}

/**
 * Huella estable de un error. No es criptografica: solo tiene que agrupar.
 * Se devuelve en base36 y acotada, porque es el ID de un documento.
 */
function huella(mensaje, pila) {
  const texto = `${mensaje}|${normalizarPila(pila)}`;
  let h = 0;
  for (let i = 0; i < texto.length; i++) {
    h = (h * 31 + texto.charCodeAt(i)) | 0;
  }
  return `e${Math.abs(h).toString(36)}`;
}

/** Navegador y version, sin la cadena entera de user-agent. */
function navegador() {
  const ua = navigator.userAgent;
  const m = ua.match(/(Firefox|Edg|Chrome|Safari)\/(\d+)/);
  if (!m) return 'otro';
  // Chrome aparece dentro del UA de Edge, y Safari dentro del de los dos.
  if (/Edg\//.test(ua)) return `Edge ${ua.match(/Edg\/(\d+)/)[1]}`;
  if (/Chrome\//.test(ua)) return `Chrome ${ua.match(/Chrome\/(\d+)/)[1]}`;
  return `${m[1]} ${m[2]}`;
}

/**
 * Registra un error. Nunca lanza: un fallo aqui dentro no puede provocar otro
 * error, o se entra en un bucle que se come la cuota.
 */
export async function registrar(mensaje, pila = '', extra = {}) {
  try {
    const texto = String(mensaje || '').slice(0, 300);
    if (!texto) return;

    const id = huella(texto, pila);

    // Una vez por huella y sesion. Es lo que convierte un bucle de 500 errores
    // en una sola escritura.
    if (vistas.has(id)) return;
    if (vistas.size >= MAX_POR_SESION) return;
    vistas.add(id);

    await setDoc(doc(db, 'errores_cliente', id), {
      mensaje: texto,
      pila: normalizarPila(pila).slice(0, 1000),
      pagina: window.location.pathname.slice(0, 100),
      navegador: navegador(),
      version: VERSION_APP,
      ancho: window.innerWidth,
      conSesion: Boolean(extra.conSesion),
      // Cuenta SESIONES, no repeticiones, y es a proposito: como cada sesion
      // escribe una sola vez por huella, esto responde "a cuanta gente le
      // pasa", que es lo que decide que arreglar primero. Contar repeticiones
      // exigiria una escritura por cada una, que es justo lo que se evita.
      sesiones: increment(1),
      visto: serverTimestamp(),
    }, { merge: true });
  } catch {
    // Aqui no se hace nada a proposito. Si registrar un error fallara y eso
    // disparara otro registro, el bucle se lleva la cuota del dia por delante.
  }
}

/**
 * Engancha la recogida global.
 *
 * Se llama desde `iniciarPagina`, asi que cubre todas las pantallas sin que
 * cada una tenga que acordarse.
 */
export function vigilarErrores() {
  window.addEventListener('error', (evento) => {
    // Los fallos de carga de recursos (<img>, <script>) tambien disparan este
    // evento, pero sin `error` dentro. Interesan igual: un asset que no carga
    // deja media pantalla en blanco.
    if (evento.error) {
      registrar(evento.error.message, evento.error.stack);
    } else if (evento.target && evento.target.src) {
      registrar(`No se ha podido cargar ${String(evento.target.src).slice(0, 120)}`);
    }
  }, true); // en captura: los fallos de recurso no burbujean

  window.addEventListener('unhandledrejection', (evento) => {
    const motivo = evento.reason;
    registrar(
      motivo?.code ? `${motivo.code}: ${motivo.message}` : (motivo?.message || String(motivo)),
      motivo?.stack,
    );
  });
}
