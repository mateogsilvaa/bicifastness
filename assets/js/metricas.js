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

import { auth, db, doc, setDoc, increment, serverTimestamp } from './firebase.js';
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

/**
 * USO: cuanta gente entra, cuanto tiempo y a que lo dedica. Igual de anonimo
 * que el embudo, y sin guardar nada en el navegador: una "visita" es una
 * pagina a la que se llega DESDE FUERA (otra web, un enlace, la barra de
 * direcciones). Lo que se guarda son contadores, nunca quien: se sabe cuantas
 * visitas hay al dia sin poder seguir a nadie, ni dentro de la web.
 */
const SECCIONES = ['portada', 'hoy', 'ranking', 'mapa', 'yo', 'subir', 'bici', 'info', 'otra'];
const RUTAS = [
  [/^\/$/, 'portada'], [/^\/hoy\//, 'hoy'], [/^\/clasificacion\//, 'ranking'], [/^\/territorio\//, 'mapa'],
  [/^\/yo\//, 'yo'], [/^\/subir\//, 'subir'], [/^\/bici\//, 'bici'], [/^\/info\//, 'info'],
];
const seccion = () => (RUTAS.find(([r]) => r.test(window.location.pathname)) || [null, 'otra'])[1];

/** Segundos con la pestaña a la vista (no abierta en segundo plano). */
let vista = 0;
let desde = null;
const contarVista = () => {
  if (desde !== null) vista += (performance.now() - desde) / 1000;
  desde = document.visibilityState === 'visible' ? performance.now() : null;
};

function deDondeViene() {
  try { return document.referrer ? new URL(document.referrer).hostname : ''; } catch { return ''; }
}

/** ¿Empieza aqui una visita? Si se llega desde otra pagina de la web, no. */
const empiezaVisita = () => deDondeViene() !== window.location.hostname;

/** De donde llega la visita, por categorias. Nunca la URL. */
function fuente() {
  const host = deDondeViene();
  if (!host) return 'directo';
  if (/instagram\.com$/.test(host)) return 'instagram';
  if (/(^|\.)google\./.test(host)) return 'google';
  return 'otros';
}

function uso() {
  contarVista();
  const contadores = {};
  const sec = SECCIONES.includes(seccion()) ? seccion() : 'otra';
  const segundos = Math.min(7200, Math.round(vista));
  contadores[`v_${sec}`] = 1;
  if (segundos) {
    contadores[`s_${sec}`] = segundos;
    contadores.segundos = segundos;
  }
  if (empiezaVisita()) {
    contadores.visitas = 1;
    contadores[window.matchMedia('(min-width: 900px)').matches ? 'd_escritorio' : 'd_movil'] = 1;
    contadores[`f_${fuente()}`] = 1;
    // Un si/no: entra con la sesion abierta. Ni quien, ni nada que lo diga.
    if (auth.currentUser) contadores.con_cuenta = 1;
  }
  return contadores;
}

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
    for (const [clave, valor] of Object.entries(uso())) datos[clave] = valor;

    await setDoc(doc(db, 'sesiones_web', id), datos, { merge: true });
  } catch {
    // Perder una sesion de analitica no es motivo para molestar a nadie.
  }
}

/**
 * Escribe la sesion YA, antes de irse a otra pagina.
 *
 * Existe por el embudo del registro. `registro_completado` y `login_completado`
 * se anotan justo antes de un `location.replace`, y la escritura que dispara
 * `pagehide` sale con la pagina ya descargandose: casi nunca llega. Eran
 * justo los eventos que nunca aparecian en el panel.
 *
 * Con techo de tiempo: medir no puede hacer esperar a nadie. Si Firestore
 * tarda, se sigue sin la sesion.
 */
export function volcar(msMaximo = 1500) {
  return Promise.race([
    enviar(),
    new Promise((resolver) => { setTimeout(resolver, msMaximo); }),
  ]);
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
  contarVista();
  document.addEventListener('visibilitychange', contarVista);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') enviar();
  });

  // Red de seguridad para el caso en que la pestaña se descarte sin pasar por
  // `hidden`, que pasa en algunos navegadores de escritorio.
  window.addEventListener('pagehide', enviar);
}
