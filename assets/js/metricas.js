/**
 * Analitica de producto, propia y sin cookies.
 *
 * POR QUE PROPIA. Google Analytics obligaria a un banner de consentimiento de
 * verdad y a mandar datos de usuarios a un tercero. Los eventos que interesan
 * son pocos y muy concretos, asi que sale mas barato y mas limpio guardarlos.
 *
 * QUE NO HACE, Y ES LO IMPORTANTE
 *
 * No sigue a nadie. No hay cookie, ni almacenamiento persistente, ni huella del
 * navegador, ni identificador que sobreviva a la pestaña. Dos visitas de la
 * misma persona son, para esto, dos desconocidos.
 *
 * Eso deja fuera una pregunta que si importa: si la gente vuelve. La respuesta
 * no es rastrear mas, es que **esa pregunta no se contesta aqui**: el worker la
 * saca de `usuarios` y `tiempos_viaje`, que ya lee, cruzando fecha de alta con
 * fechas de trayecto verificado. Cohortes exactas, cero seguimiento.
 *
 * Aqui solo se mide el EMBUDO: por donde se cae la gente al subir un trayecto.
 * Y eso es agregado por naturaleza.
 *
 * COSTE. Un documento por evento seria inviable: 1.000 visitas al dia son 1.000
 * escrituras. Los eventos se acumulan en memoria y se escribe UN documento por
 * sesion al cerrarla. El worker los suma en contadores diarios y borra el
 * detalle.
 */

import { db, doc, setDoc, increment, serverTimestamp } from './firebase.js';
import { VERSION_APP } from '../data/version.js';
import { diaMadrid } from './dia.js';

/**
 * Eventos admitidos. La lista es cerrada a proposito: sin ella, cualquiera
 * puede escribir claves arbitrarias en un documento que acepta escritura sin
 * sesion, y ademas se acaba midiendo de todo y decidiendo con nada.
 */
export const EVENTOS = [
  'pagina_vista',
  'subida_abierta',
  'subida_con_foto',
  'subida_enviada',
  'subida_fallida',
  'registro_abierto',
  'registro_completado',
  'login_completado',
];

/** Contadores de esta sesion. Viven en memoria y mueren con la pestaña. */
const cuenta = Object.create(null);

let enviado = false;

/**
 * Anota un evento. No escribe nada todavia.
 * Ignora en silencio lo que no este en la lista: un evento mal escrito no puede
 * tumbar la pantalla que lo emite.
 */
export function anotar(evento) {
  if (!EVENTOS.includes(evento)) return;
  cuenta[evento] = (cuenta[evento] || 0) + 1;
}

// El dia va en hora de Madrid, no la del dispositivo: el panel agrupa las
// sesiones por ese mismo dia, y si cada punta usa el suyo las cifras de "hoy"
// se reparten entre dos casillas. Ademas, quien abra la web desde otro pais
// escribiria el dia de otro sitio.
const hoy = diaMadrid;

/**
 * Escribe la sesion. Se llama al ocultarse la pestaña.
 *
 * Una sola vez: `visibilitychange` dispara cada vez que se cambia de pestaña, y
 * sin esta guarda una sesion larga escribiria decenas de veces.
 */
async function enviar() {
  if (enviado) return;
  const eventos = Object.keys(cuenta);
  if (!eventos.length) return;
  enviado = true;

  try {
    // El id lo elige el navegador y es aleatorio. No identifica a nadie: solo
    // evita que dos sesiones simultaneas se pisen el documento.
    const id = `${hoy()}_${Math.random().toString(36).slice(2, 12)}`;

    const datos = { dia: hoy(), version: VERSION_APP, creado: serverTimestamp() };
    for (const evento of eventos) datos[evento] = increment(cuenta[evento]);

    await setDoc(doc(db, 'sesiones_web', id), datos, { merge: true });
  } catch {
    // Perder una sesion de analitica no es motivo para molestar a nadie.
  }
}

/**
 * Arranca la medicion. La llama `iniciarPagina`.
 *
 * `visibilitychange` y no `beforeunload`: en movil, cerrar el navegador o
 * cambiar de app muchas veces no dispara `beforeunload`, y la sesion se
 * perderia entera. `hidden` si llega.
 */
export function medir() {
  anotar('pagina_vista');

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') enviar();
  });

  // Red de seguridad para el caso en que la pestaña se descarte sin pasar por
  // `hidden`, que pasa en algunos navegadores de escritorio.
  window.addEventListener('pagehide', enviar);
}
