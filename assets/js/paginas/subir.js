// Modulo de la pagina /subir/ (03 Subir; en escritorio, 8b, 8f y 8g).
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// EL FLUJO:
//
//   captura (elegida, pegada, soltada o compartida desde Fotos)
//     -> comprobaciones previas (#12): avisos que NO bloquean (3h)
//     -> lectura en el navegador (#8), con la franja recorriendo la imagen (3b)
//     -> un trayecto:  el billete, todo tocable para corregirlo (3c, 3f, 3j)
//     -> varios (#11): cuales de estos (3g)
//     -> no se pudo leer: los mismos datos, a mano (3i)
//     -> subido (3d), y el veredicto en vivo (3e) si llega con la pagina abierta
//
// Si la lectura no se puede hacer (navegador viejo, red mala, captura
// ilegible), no se bloquea a nadie: se escribe a mano, como toda la vida.

import {
  auth, db, onAuthStateChanged, traducirError,
  collection, doc, getDoc, getDocs, query, where, orderBy, limit,
  writeBatch, serverTimestamp,
} from '/assets/js/firebase.js';
import {
  iniciarPagina, normalizarEstacion, nombreEstacion, formatearTiempo, formatearFecha,
  anotarSubidaAbierta, VERSION_LEGAL, pedirReaceptacion, kmEstimados,
} from '/assets/js/ui.js';
import { id, el, icono, reemplazar, abrirHoja, avisar } from '/assets/js/dom.js';
import { diaMadrid, diaMadridHace, diaProbableDelViaje } from '/assets/js/dia.js';
import { revisar, LIMITES_CLIENTE } from '/assets/js/precheck.js';
import { leerExif } from '/assets/js/exif.js';
import { extraer, cerrar as cerrarLector } from '/assets/js/extraccion.js';
import { seguirViaje, recordarViaje, olvidarViaje } from '/assets/js/estado-viaje.js';
import { marcarPrimerViaje } from '/assets/js/instalar.js';
import { tomarPendiente, imagenesDe } from '/assets/js/captura-pendiente.js';
import { anotar } from '/assets/js/metricas.js';
import { leerCache, guardarCache } from '/assets/js/cache.js';
import { abrirVerificado, abrirResuelto } from '/assets/js/veredicto.js';
import { ESTACIONES } from '/assets/data/estaciones.js';
import { aceptarLegal, guardarSuscripcionPush } from '/assets/js/acciones.js';
import { soportado as pushSoportado, configurado as pushConfigurado, suscripcionActual, suscribir } from '/assets/js/push.js';
import { sumarDias } from '/assets/js/anillo.js';
import { encuestaBici } from '/assets/js/encuesta-bici.js';

iniciarPagina('subir');
anotarSubidaAbierta();

const CUPO = LIMITES_CLIENTE.VIAJES_POR_DIA;
const TOPE = CUPO + LIMITES_CLIENTE.VIAJES_SIN_PUNTOS_POR_DIA;
const PASOS = ['inicio', 'avisos', 'leyendo', 'confirmar', 'manual', 'varios', 'subido'];
const entradaFoto = id('foto');
const vista = id('vista-lectura');

let perfil = null;
/** Cuantos lleva hoy segun el contador de `cupos/{uid}` (#62). */
let cupo = null;
let rutaDelDia = null;
/** Las capturas que quedan por leer, si se eligieron o soltaron varias. */
let cola = [];
/** La captura ya mirada, comprimida y leida. */
let preparada = null;
/** Lo que se va a subir, con lo que haya corregido la persona. */
let borrador = null;

const coma = (n, dec = 1) => Number(n).toFixed(dec).replace('.', ',');
const ordinal = (n) => `${n}.º`;
const llevaHoy = () => cupo?.viajes || 0;

// --- Pasos ----------------------------------------------------------------------

function mostrar(paso) {
  for (const p of PASOS) id(`s-${p}`).classList.toggle('oculto', p !== paso);
  // En movil, fuera del inicio no hay barra: cada paso es una pantalla entera.
  document.body.classList.toggle('en-paso', paso !== 'inicio');
  window.scrollTo(0, 0);
}

/** Barra superior de los pasos: cerrar, titulo y, si hay, la miniatura. */
function barra(titulo, { atras = false, miniatura = true } = {}) {
  return el('div', { clase: 'subir-barra' }, [
    el('button', {
      clase: 'boton-icono', attrs: { type: 'button', 'aria-label': atras ? 'Atrás' : 'Cancelar' },
      on: { click: cancelar },
    }, [icono(atras ? 'atras' : 'cerrar')]),
    el('span', { clase: 'subir-barra-titulo', texto: titulo }),
    // 8f: en escritorio, "Esc para cancelar" junto a la X.
    el('span', { clase: 'subir-barra-esc', texto: 'Esc para cancelar' }),
    miniatura && preparada?.url
      ? el('button', {
        clase: 'subir-miniatura', attrs: { type: 'button', 'aria-label': 'Ver la captura' },
        on: { click: verCaptura },
      }, [el('img', { attrs: { src: preparada.url, alt: '' } })])
      : el('span', { clase: 'subir-barra-hueco' }),
  ]);
}

function cancelar() {
  cola = [];
  preparada = null;
  borrador = null;
  entradaFoto.value = '';
  pintarInicio();
  mostrar('inicio');
}

function verCaptura() {
  if (!preparada?.url) return;
  abrirHoja([
    el('img', { clase: 'captura-grande', attrs: { src: preparada.url, alt: 'Tu captura' } }),
  ], { etiqueta: 'Tu captura', clase: 'dialogo-escritorio' });
}

// Esc cancela desde cualquier paso (8f: "Esc para cancelar").
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('.hoja, .pantalla-veredicto')) return;
  if (!id('s-inicio').classList.contains('oculto') || !id('s-subido').classList.contains('oculto')) return;
  cancelar();
});

// --- Sesion y bloqueos (3n) ---------------------------------------------------------

async function leerCupo() {
  // El dia es UTC porque es lo unico que las reglas saben mirar (#62). Por eso
  // el tope es holgado y el cupo del juego lo sigue poniendo el worker.
  const dia = Math.floor(Date.now() / 86400000);
  const snap = await getDoc(doc(db, 'cupos', perfil.uid));
  const previo = snap.exists() ? snap.data() : null;
  if (!previo || previo.dia !== dia) return { dia, viajes: 0, capturas: 0 };
  return { dia, viajes: previo.viajes || 0, capturas: previo.capturas || 0 };
}

async function configGeneral() {
  const guardado = leerCache('config-general');
  if (guardado !== undefined) return guardado;
  const snap = await getDoc(doc(db, 'config', 'general'));
  const datos = snap.exists() ? snap.data() : null;
  guardarCache('config-general', datos);
  return datos;
}

/** Lo que impide subir, si hay algo. Cada bloqueo con su salida. */
function bloqueo() {
  if (!perfil) return null;
  if (perfil.sinPerfil) {
    return { titulo: 'Falta tu nombre de piloto', texto: 'Termina el alta para subir trayectos.', enlace: ['Elegir nombre →', '/'] };
  }
  if (perfil.suspendido) {
    return { titulo: 'Tu cuenta está suspendida', texto: 'No puedes subir trayectos. Si crees que es un error, escríbenos desde Aviso legal.', grave: true };
  }
  const aceptada = perfil.consentimiento?.terminos?.version;
  if (aceptada && aceptada !== VERSION_LEGAL) {
    return { titulo: 'Hemos actualizado los términos', texto: 'Revísalos y acéptalos para seguir subiendo.', aceptar: true };
  }
  return null;
}

onAuthStateChanged(auth, async (usuario) => {
  if (!usuario) { window.location.replace('/entrar/'); return; }
  const snap = await getDoc(doc(db, 'usuarios', usuario.uid));
  perfil = snap.exists() ? { uid: usuario.uid, ...snap.data() } : { uid: usuario.uid, sinPerfil: true };

  if (!perfil.sinPerfil) {
    // Al aceptar se quita el bloqueo sin recargar.
    pedirReaceptacion(perfil, async () => {
      await aceptarLegal();
      perfil.consentimiento = { ...perfil.consentimiento, terminos: { version: VERSION_LEGAL } };
      pintarInicio();
    });
    try { cupo = await leerCupo(); } catch { cupo = null; /* sin contador se sube igual; lo cuenta el worker */ }
    configGeneral().then((c) => { rutaDelDia = c?.rutaDestacada || null; }).catch(() => { /* sin ruta del dia, no se anuncia */ });
  }

  // El embudo de subida (abierta -> con foto -> enviada) es LA medida de
  // friccion del producto: donde se cae la gente entre querer subir y subir.
  anotar('subida_abierta');
  pintarInicio();

  // Llega con una captura ya elegida: desde el + de otra pantalla, pegada,
  // soltada o compartida desde Fotos (share_target, sw.js).
  if (!bloqueo() && new URLSearchParams(location.search).has('pendiente')) {
    history.replaceState(null, '', '/subir/');
    const pendientes = await tomarPendiente();
    if (pendientes.length) elegirFicheros(pendientes);
  }
});

// --- 3a · Inicio ------------------------------------------------------------------

async function hayImagenCopiada() {
  // Solo se mira si el permiso YA esta concedido: preguntar por el
  // portapapeles al abrir la pantalla seria un dialogo del sistema sin motivo.
  try {
    const permiso = await navigator.permissions?.query({ name: 'clipboard-read' });
    if (permiso?.state !== 'granted') return false;
    const items = await navigator.clipboard.read();
    return items.some((i) => i.types.some((t) => t.startsWith('image/')));
  } catch {
    return false;
  }
}

async function pegarDelPortapapeles() {
  try {
    const items = await navigator.clipboard.read();
    const ficheros = [];
    for (const item of items) {
      const tipo = item.types.find((t) => t.startsWith('image/'));
      if (tipo) ficheros.push(new File([await item.getType(tipo)], 'captura.png', { type: tipo }));
    }
    if (ficheros.length) elegirFicheros(ficheros);
  } catch {
    // Sin permiso o sin imagen: el boton solo sale si la habia, asi que esto es
    // que la han borrado entre medias. Se queda en el inicio.
  }
}

function pintarInicio() {
  const b = bloqueo();
  const usados = llevaHoy();
  const pegar = el('button', {
    clase: 'subir-opcion tonal oculto', attrs: { type: 'button' },
    on: { click: pegarDelPortapapeles },
  }, [icono('pegar'), el('span', {}, [el('strong', { texto: 'Pegar' }), el('small', { texto: 'Hay una imagen copiada' })])]);
  hayImagenCopiada().then((si) => pegar.classList.toggle('oculto', !si));

  reemplazar(id('s-inicio'), el('div', { clase: 'subir-inicio' }, [
    el('div', { clase: 'subir-inicio-cabeza' }, [
      el('h2', { texto: 'Subir trayecto' }),
      perfil && !perfil.sinPerfil ? el('span', { texto: `Puntúan ${CUPO} hoy · ${usados} ${usados === 1 ? 'usado' : 'usados'}` }) : null,
    ]),
    b ? tarjetaBloqueo(b) : el('div', { clase: 'subir-opciones' }, [
      el('button', {
        clase: 'subir-opcion azul', attrs: { type: 'button' },
        on: { click: () => entradaFoto.click() },
      }, [icono('imagen'), el('strong', { texto: 'Elegir captura' })]),
      pegar,
    ]),
    el('div', { clase: 'subir-ejemplo' }, [
      el('img', { attrs: { src: '/images/ejemplo.jpg', alt: 'Captura de ejemplo de la app de BiciMAD', loading: 'lazy' } }),
      el('div', { clase: 'subir-ejemplo-texto' }, [
        el('strong', { texto: 'La que sale al acabar' }),
        el('span', { clase: 'bien' }, [icono('check', 'icono peq'), el('span', { texto: 'Entera, sin recortar' })]),
        el('span', { clase: 'bien' }, [icono('check', 'icono peq'), el('span', { texto: 'Varios viajes a la vez, vale' })]),
        el('span', { clase: 'mal' }, [icono('cerrar', 'icono peq'), el('span', { texto: 'Reenviada por WhatsApp' })]),
      ]),
    ]),
    el('span', { clase: 'subir-truco' }, [icono('compartir', 'icono peq'), el('span', { texto: 'Más rápido: en Fotos, Compartir → bicifastness' })]),
    el('span', { clase: 'subir-truco solo-escritorio' }, [el('kbd', { texto: 'Ctrl V' }), el('span', { texto: 'pega una captura copiada, o arrástrala a la ventana' })]),
  ]));
}

function tarjetaBloqueo(b) {
  return el('div', { clase: `tarjeta-grande media bloqueo ${b.grave ? 'grave' : ''}` }, [
    el('strong', { texto: b.titulo }),
    el('span', { clase: 'apagado', texto: b.texto }),
    b.enlace ? el('a', { texto: b.enlace[0], attrs: { href: b.enlace[1] } }) : null,
    // La tarjeta para aceptar ya esta abajo (pedirReaceptacion); esto lleva a leerlos.
    b.aceptar ? el('a', { texto: 'Revisar y aceptar →', attrs: { href: '/legal/terminos/' } }) : null,
  ]);
}

entradaFoto.addEventListener('change', () => {
  if (entradaFoto.files?.length) elegirFicheros([...entradaFoto.files]);
});

// En /subir/ la imagen se lee en el acto: pegar o soltar aqui no pasa por otra
// pagina (ui.js se aparta de estos atajos en esta ruta).
document.addEventListener('paste', (e) => {
  if (/^(input|textarea)$/i.test(e.target?.tagName || '')) return;
  const imagenes = imagenesDe(e.clipboardData);
  if (imagenes.length && !bloqueo()) { e.preventDefault(); elegirFicheros(imagenes); }
});
let capa = null;
window.addEventListener('dragover', (e) => {
  if (![...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) return;
  e.preventDefault();
  if (!capa) {
    capa = el('div', { clase: 'capa-soltar', attrs: { 'aria-hidden': 'true' } }, [
      el('div', { clase: 'capa-soltar-marco' }, [
        el('span', { clase: 'capa-soltar-mas' }, [icono('mas')]),
        el('strong', { texto: 'Suéltala para leerla' }),
        el('span', { texto: 'Leemos estaciones, tiempo y horas en tu navegador. Puedes soltar varias a la vez: cada una es un trayecto.' }),
      ]),
    ]);
    document.body.append(capa);
  }
});
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) { capa?.remove(); capa = null; } });
window.addEventListener('drop', (e) => {
  if (!capa) return;
  e.preventDefault();
  capa.remove(); capa = null;
  const imagenes = imagenesDe(e.dataTransfer);
  if (imagenes.length && !bloqueo()) elegirFicheros(imagenes);
});

function elegirFicheros(ficheros) {
  if (!perfil || bloqueo()) return;
  cola = [...ficheros];
  siguienteCaptura();
}

function siguienteCaptura() {
  const fichero = cola.shift();
  if (!fichero) { cancelar(); return; }
  preparar(fichero);
}

// --- Comprobaciones y avisos (3h) ------------------------------------------------------

/** Titulo corto de cada aviso de `precheck.js`, para 3h. */
const TITULO_AVISO = {
  foto_movida: 'Parece movida.',
  resolucion_baja: 'Es muy pequeña.',
  parece_apaisada: 'Está apaisada.',
  demasiado_antigua: 'Tiene más de 30 días.',
  tipo_no_admitido: 'No es una imagen que podamos leer.',
  demasiado_grande: 'No cabe.',
  recomprimida: 'Llega recomprimida.',
};
/** Estos si impiden seguir: no hay imagen que subir. */
const IMPIDEN = ['tipo_no_admitido', 'demasiado_grande', 'no_es_imagen'];

async function preparar(fichero) {
  anotar('subida_con_foto');
  if (preparada?.url) URL.revokeObjectURL(preparada.url);
  const url = URL.createObjectURL(fichero);
  preparada = { fichero, url, dataUrl: null, avisos: [], lectura: null, metadatos: {} };
  borrador = null;

  // Mientras se comprueba, ya en la pantalla de lectura: la persona ve su
  // captura desde el primer momento.
  pintarLeyendo(0, 'comprobando');
  mostrar('leyendo');

  let revision;
  try {
    revision = await revisar(fichero);
  } catch (error) {
    revision = { avisos: [{ codigo: 'no_es_imagen', gravedad: 'alta', texto: error.message }], comprimida: null };
  }
  if (preparada?.fichero !== fichero) return;
  preparada.dataUrl = revision.comprimida?.dataUrl || null;
  preparada.avisos = revision.avisos || [];

  // El EXIF, del fichero ORIGINAL: lo que se sube ya ha pasado por el lienzo y
  // ahi se pierde entero (#66). Solo `software` y `marca`, nunca la posicion.
  try {
    preparada.metadatos = leerExif(await fichero.slice(0, 65536).arrayBuffer());
  } catch {
    preparada.metadatos = {}; // sin EXIF el antifraude funciona igual
  }
  // El dia del fichero, para el antifraude de fechas: solo el dia, en Madrid.
  if (Number.isFinite(fichero.lastModified) && fichero.lastModified > 0) {
    preparada.metadatos.capturadaEn = diaMadrid(new Date(fichero.lastModified));
  }

  // 8g: en escritorio, los avisos que no impiden van encima de lo leido, sin
  // pantalla propia; en el movil, antes de leer (3h).
  const soloAvisan = !preparada.avisos.some((a) => IMPIDEN.includes(a.codigo)) && preparada.dataUrl;
  if (preparada.avisos.length && !(soloAvisan && enEscritorio())) {
    pintarAvisos(preparada.avisos);
    mostrar('avisos');
    return;
  }
  leer();
}

const enEscritorio = () => window.matchMedia('(min-width: 900px)').matches;

/** 8g: los avisos previos, encima de la lista o del billete, con "Elegir otra". */
function avisosEncima() {
  if (!enEscritorio() || !preparada?.avisos?.length) return null;
  return el('div', { clase: 'pila avisos-previos' }, preparada.avisos.map((a) => el('div', { clase: 'aviso atencion con-icono' }, [
    icono('aviso', 'icono'),
    el('p', {}, [
      el('strong', { texto: `${TITULO_AVISO[a.codigo] || 'Ojo.'} ` }),
      el('span', { texto: `${a.texto} ` }),
      el('button', { clase: 'enlace-boton', texto: 'Elegir otra', attrs: { type: 'button' }, on: { click: () => entradaFoto.click() } }),
    ]),
  ])));
}

function pintarAvisos(avisos) {
  const impide = avisos.some((a) => IMPIDEN.includes(a.codigo)) || !preparada.dataUrl;
  reemplazar(id('s-avisos'), [
    barra('Antes de leerla', { miniatura: false, atras: true }),
    el('div', { clase: 'subir-cuerpo' }, [
      el('div', { clase: 'captura-borrosa' }, [el('img', { attrs: { src: preparada.url, alt: '' } })]),
      el('div', { clase: 'pila avisos-previos' }, avisos.map((a) => el('div', { clase: 'aviso atencion con-icono' }, [
        icono('aviso', 'icono'),
        el('p', {}, [el('strong', { texto: `${TITULO_AVISO[a.codigo] || 'Ojo.'} ` }), el('span', { texto: a.texto })]),
      ]))),
      el('div', { clase: 'subir-hueco' }),
      el('div', { clase: 'subir-acciones' }, [
        el('button', {
          clase: 'btn grande', texto: 'Elegir otra captura', attrs: { type: 'button' },
          on: { click: () => entradaFoto.click() },
        }),
        impide ? null : el('button', {
          clase: 'btn grande secundario', texto: 'Seguir igualmente', attrs: { type: 'button' },
          on: { click: leer },
        }),
      ]),
    ]),
  ]);
}

// --- 3b · Leyendo ------------------------------------------------------------------------

function pintarLeyendo(avance, fase) {
  const pct = Math.round(avance * 100);
  const preparando = fase === 'preparando';
  if (window.matchMedia('(min-width: 900px)').matches) { pintarLeyendoEscritorio(pct, fase, preparando); return; }
  reemplazar(id('s-leyendo'), [
    el('div', { clase: 'subir-barra' }, [
      el('button', { clase: 'boton-icono', attrs: { type: 'button', 'aria-label': 'Cancelar' }, on: { click: cancelar } }, [icono('cerrar')]),
      el('span', { clase: 'subir-barra-titulo', texto: 'Leyendo…' }),
      el('span', { clase: 'subir-barra-hueco' }),
    ]),
    el('div', { clase: 'subir-cuerpo leyendo-cuerpo' }, [
      el('div', { clase: 'escaner' }, [
        el('img', { attrs: { src: preparada?.url || '', alt: '' } }),
        fase === 'leyendo' ? el('div', { clase: 'escaner-linea', estilo: { top: `${Math.min(96, pct)}%` } }) : null,
        fase === 'leyendo' ? el('div', { clase: 'escaner-sombra', estilo: { top: `${Math.min(96, pct)}%` } }) : null,
      ]),
      el('div', { clase: 'leyendo-lista' }, [
        fase === 'comprobando'
          ? el('div', {}, [el('span', { clase: 'girando' }), el('span', { texto: 'Mirando la captura…' })])
          : el('div', {}, [icono('comprobado', 'icono ok'), el('span', { texto: preparada?.avisos?.length ? 'Captura revisada' : 'Captura nítida y entera' })]),
        fase !== 'comprobando'
          ? el('div', {}, [el('span', { clase: 'girando' }), el('span', {
            texto: preparando ? `Preparando el lector (solo la primera vez) · ${pct} %` : `Estaciones, tiempo y horas · ${pct} %`,
          })])
          : null,
      ]),
      el('span', { clase: 'progreso leyendo-progreso' }, [el('span', { estilo: { width: `${fase === 'comprobando' ? 4 : pct}%` } })]),
      el('span', { clase: 'leyendo-nota', texto: 'Se lee en tu móvil. La imagen solo sale de aquí al pulsar Subir.' }),
    ]),
  ]);
}

/**
 * 8f · En escritorio se lee EN LA MISMA VISTA que se confirma: la captura a la
 * izquierda (con la linea que la recorre) y el billete a la derecha, vacio
 * hasta que llega la lectura. Sin pantalla intermedia con la imagen gigante.
 */
function pintarLeyendoEscritorio(pct, fase, preparando) {
  const hueco = (ancho) => el('span', { clase: 'esqueleto hueco-billete', estilo: { width: ancho } });
  const leyendo = fase === 'leyendo';
  reemplazar(id('s-leyendo'), [
    barra('Revisa y sube'),
    el('div', { clase: 'subir-cuerpo confirmar leyendo-8f' }, [
      el('div', { clase: 'confirmar-captura' }, [
        el('div', { clase: 'confirmar-imagen escaner' }, [
          el('img', { attrs: { src: preparada?.url || '', alt: 'Tu captura' } }),
          leyendo ? el('div', { clase: 'escaner-linea', estilo: { top: `${Math.min(96, pct)}%` } }) : null,
        ]),
        fase === 'comprobando'
          ? el('span', { clase: 'leido-ok' }, [el('span', { clase: 'girando' }), el('span', { texto: 'Mirando la captura…' })])
          : el('span', { clase: 'leido-ok' }, [icono('comprobado', 'icono peq'), el('span', { texto: 'Captura nítida y entera' })]),
        fase !== 'comprobando'
          ? el('span', { clase: 'leido-ok' }, [el('span', { clase: 'girando' }), el('span', {
            texto: preparando ? `Preparando el lector (solo la primera vez) · ${pct} %` : `Leyendo estaciones, tiempo y horas · ${pct} %`,
          })])
          : null,
        el('span', { clase: 'leyendo-nota', texto: 'Se lee en tu navegador. La imagen solo sale de aquí al pulsar Subir.' }),
      ]),
      el('div', { clase: 'confirmar-datos' }, [
        el('div', { clase: 'billete' }, [
          el('div', { clase: 'billete-arriba' }, [
            el('div', { clase: 'billete-estacion origen' }, [
              el('span', { clase: 'billete-punto origen' }),
              el('span', { clase: 'billete-nombre' }, [el('small', { texto: 'Salida' }), hueco('62%')]),
            ]),
            el('span', { clase: 'billete-guiones', attrs: { 'aria-hidden': 'true' } }),
            el('div', { clase: 'billete-estacion destino' }, [
              el('span', { clase: 'billete-punto destino' }, [icono('pin', 'icono')]),
              el('span', { clase: 'billete-nombre' }, [el('small', { texto: 'Meta' }), hueco('78%')]),
            ]),
          ]),
          el('div', { clase: 'billete-corte', attrs: { 'aria-hidden': 'true' } }),
          el('div', { clase: 'billete-abajo' }, [
            el('span', { clase: 'billete-tiempo' }, [el('small', { texto: 'Tiempo' }), el('strong', { clase: 'apagado', texto: '--:--' })]),
          ]),
        ]),
        el('span', { clase: 'progreso leyendo-progreso' }, [el('span', { estilo: { width: `${fase === 'comprobando' ? 4 : pct}%` } })]),
      ]),
    ]),
  ]);
}

async function leer() {
  const fichero = preparada?.fichero;
  if (!fichero) return;
  mostrar('leyendo');
  pintarLeyendo(0, 'leyendo');

  vista.src = preparada.url;
  await vista.decode().catch(() => { /* si no decodifica, extraer() lo dira */ });
  const lectura = await extraer(vista, (estadoOcr, avance) => {
    if (preparada?.fichero !== fichero) return;
    pintarLeyendo(avance, estadoOcr === 'recognizing text' ? 'leyendo' : 'preparando');
  });
  if (preparada?.fichero !== fichero) return;

  preparada.lectura = lectura.disponible ? lectura : null;

  // La app de BiciMAD pone la fecha bajo cada estacion ("21/09/25 02:51:12"):
  // si se ha leido, manda ella. Un trayecto de hace mas de un mes no se puede
  // subir (el worker lo rechazaria igual), asi que se dice ya.
  const fechaLeida = lectura.disponible ? lectura.fecha : '';
  if (fechaLeida && fechaLeida < diaMadridHace(30)) {
    cancelar();
    avisar(`Esta captura es del ${formatearFecha(fechaLeida)}. Solo cuentan los trayectos del último mes.`);
    return;
  }
  preparada.diaPropuesto = fechaLeida && fechaLeida <= diaMadrid()
    ? { dia: fechaLeida, motivo: 'la fecha de la captura' }
    : diaProbableDelViaje({
      ficheroModificado: fichero.lastModified,
      horaLlegada: lectura.disponible ? lectura.horaLlegada : null,
    });
  await decidirPaso(lectura);
}

/** Un trayecto leido, convertido a lo que se sube (o null si no vale). */
function aViaje(t) {
  const origen = normalizarEstacion(t.origen);
  const destino = normalizarEstacion(t.destino);
  if (!nombreEstacion(origen) || !nombreEstacion(destino) || origen === destino) return null;
  if (!t.segundosDuracion) return null;
  return {
    origen, destino, ruta: `${origen}-${destino}`, tiempoSegundos: t.segundosDuracion,
    horaSalida: t.horaSalida || '', horaLlegada: t.horaLlegada || '',
    // Para la encuesta de la bici (11a). No va al viaje: lo lee el worker.
    bici: t.numeroBici || '',
  };
}

async function decidirPaso(lectura) {
  const candidatos = (lectura.trayectos || []).map(aViaje).filter(Boolean);
  if (candidatos.length > 1) { await irAElegir(candidatos); return; }

  const leido = lectura.disponible && lectura.esBicimad ? aViaje(lectura) : null;
  const dia = diaInicial();
  if (leido) {
    borrador = { ...leido, fecha: dia };
    pintarConfirmar();
    mostrar('confirmar');
    return;
  }

  // 3i · Lo que si se leyo llega relleno; lo demas, a mano.
  const origen = lectura.disponible ? normalizarEstacion(lectura.origen) : '';
  const destino = lectura.disponible ? normalizarEstacion(lectura.destino) : '';
  borrador = {
    origen: nombreEstacion(origen) ? origen : '',
    destino: nombreEstacion(destino) ? destino : '',
    tiempoSegundos: lectura.disponible ? lectura.segundosDuracion || null : null,
    horaSalida: lectura.horaSalida || '', horaLlegada: lectura.horaLlegada || '',
    bici: lectura.disponible ? lectura.numeroBici || '' : '',
    fecha: dia,
  };
  pintarManual(lectura);
  mostrar('manual');
}

function diaInicial() {
  const p = preparada?.diaPropuesto;
  return p && p.dia >= diaMadridHace(30) && p.dia <= diaMadrid() ? p.dia : diaMadrid();
}

// --- 3c · Confirmar: lo leido, en un billete ------------------------------------------------


function segmentoDia(valor, alCambiar, { rotulo = 'Día del trayecto' } = {}) {
  const hoy = diaMadrid();
  const ayer = diaMadridHace(1);
  const otro = valor !== hoy && valor !== ayer;
  const opcion = (texto, activo, accion, conIcono = false) => el('button', {
    attrs: { type: 'button', 'aria-pressed': String(activo) }, on: { click: accion },
  }, [conIcono ? icono('calendario', 'icono peq') : null, el('span', {}, [].concat(texto))]);
  return el('div', { clase: 'subir-dia' }, [
    el('span', { clase: 'rotulo', texto: rotulo }),
    el('div', { clase: 'segmento' }, [
      opcion('Hoy', valor === hoy, () => alCambiar(hoy)),
      opcion('Ayer', valor === ayer, () => alCambiar(ayer)),
      // 8f: "Otro día…" en escritorio.
      opcion(otro ? formatearFecha(valor) : ['Otro', el('span', { clase: 'solo-escritorio-i', texto: ' día…' })], otro, () => abrirCalendario(valor, alCambiar), true),
    ]),
    preparada?.diaPropuesto?.motivo && valor === preparada.diaPropuesto.dia && valor !== hoy
      ? el('span', { clase: 'pista-dia', texto: `Hemos puesto este día porque ${preparada.diaPropuesto.motivo}.` })
      : null,
  ]);
}

/** Cual de los de hoy sera este: "1.º de 3 que puntúan hoy". */
function textoPuesto(cuantos = 1) {
  const n = llevaHoy() + cuantos;
  if (n > TOPE) return `Hoy ya has subido ${TOPE}: el máximo de un día`;
  if (n > CUPO) return `${ordinal(n)} del día · sin puntos`;
  return `${ordinal(n)} de ${CUPO} que puntúan hoy`;
}

function pintarConfirmar() {
  const b = borrador;
  const km = kmEstimados(b.origen, b.destino);
  const kmh = km && b.tiempoSegundos ? km / (b.tiempoSegundos / 3600) : null;
  const fueraDeCupo = llevaHoy() >= CUPO;
  const lleno = llevaHoy() >= TOPE;
  const esRutaDelDia = rutaDelDia && rutaDelDia === `${b.origen}-${b.destino}`;

  const estacion = (cual, etiqueta, codigo) => el('button', {
    clase: `billete-estacion ${cual}`, attrs: { type: 'button', 'aria-label': `Cambiar ${etiqueta.toLowerCase()}` },
    on: { click: () => abrirBuscador(cual) },
  }, [
    el('span', { clase: `billete-punto ${cual}` }, cual === 'destino' ? [icono('pin', 'icono')] : []),
    el('span', { clase: 'billete-nombre' }, [
      el('small', { texto: `${etiqueta} · ${codigo}` }),
      el('strong', { texto: nombreEstacion(codigo) || '—' }),
    ]),
    el('span', { clase: 'billete-editar' }, [icono('lapiz', 'icono peq'), el('span', { clase: 'solo-escritorio', texto: 'Cambiar' })]),
  ]);

  const boton = el('button', {
    clase: 'btn grande', attrs: { type: 'button', disabled: lleno ? '' : null },
    texto: fueraDeCupo ? 'Subir sin puntos' : 'Subir trayecto',
    on: { click: () => subir([{ ...borrador, ruta: `${borrador.origen}-${borrador.destino}` }], borrador.fecha) },
  });

  reemplazar(id('s-confirmar'), [
    barra('Revisa y sube'),
    el('div', { clase: 'subir-cuerpo confirmar' }, [
      el('div', { clase: 'confirmar-captura solo-escritorio' }, [
        el('div', { clase: 'confirmar-imagen' }, [el('span', { clase: 'captura-marcada' }, [
          el('img', { attrs: { src: preparada.url, alt: 'Tu captura' } }),
          // 8f: lo que se ha leido, recuadrado en azul sobre la propia captura.
          ...(preparada.lectura?.cajas || []).map((c) => el('span', {
            clase: 'caja-leida',
            estilo: { left: `${c.x}%`, top: `${c.y}%`, width: `${c.ancho}%`, height: `${c.alto}%` },
          })),
        ])]),
        el('span', { clase: 'leido-ok' }, [icono('comprobado', 'icono peq'), el('span', { texto: 'Captura nítida y entera' })]),
        el('span', { clase: 'leido-ok' }, [icono('comprobado', 'icono peq'), el('span', { texto: 'Estaciones, tiempo y horas leídos' })]),
        el('span', { clase: 'leyendo-nota', texto: 'Se lee en tu navegador. La imagen solo sale de aquí al pulsar Subir.' }),
      ]),
      el('div', { clase: 'confirmar-datos' }, [
        el('div', { clase: 'billete' }, [
          el('div', { clase: 'billete-arriba' }, [
            estacion('origen', 'Salida', b.origen),
            el('span', { clase: 'billete-guiones', attrs: { 'aria-hidden': 'true' } }),
            estacion('destino', 'Meta', b.destino),
          ]),
          el('div', { clase: 'billete-corte', attrs: { 'aria-hidden': 'true' } }),
          el('button', {
            clase: 'billete-abajo', attrs: { type: 'button', 'aria-label': 'Corregir el tiempo' },
            on: { click: abrirTiempo },
          }, [
            el('span', { clase: 'billete-tiempo' }, [el('small', { texto: 'Tiempo' }), el('strong', { texto: formatearTiempo(b.tiempoSegundos) })]),
            el('span', { clase: 'billete-extra' }, [
              km ? el('span', {}, [el('strong', { texto: `≈${coma(km)}` }), ' km']) : null,
              kmh ? el('span', {}, [el('strong', { texto: coma(kmh) }), ' km/h']) : null,
              b.horaSalida && b.horaLlegada ? el('span', { texto: `${b.horaSalida} → ${b.horaLlegada}` }) : null,
            ]),
          ]),
        ]),
        segmentoDia(b.fecha, (dia) => { borrador.fecha = dia; pintarConfirmar(); }),
        esRutaDelDia && !fueraDeCupo ? el('div', { clase: 'aviso-ruta-dia' }, [
          el('span', { clase: 'x2', texto: '×2' }), el('span', { texto: 'Es la ruta del día. Hoy puntúa doble.' }),
        ]) : null,
        fueraDeCupo ? tarjetaCupo(lleno) : null,
        el('div', { clase: 'subir-hueco' }),
        el('div', { clase: 'subir-enviar' }, [
          boton,
          // 3c: "1.º de 3 que puntúan hoy"; cada dato del billete ya se ve tocable.
          el('span', { clase: 'hoy-pista', texto: textoPuesto() }),
        ]),
      ]),
    ]),
  ]);
}

/** 3n · Cupo lleno: el 4.º se deja subir, pero se avisa antes. */
function tarjetaCupo(lleno) {
  return el('div', { clase: 'tarjeta-grande media cupo-lleno' }, [
    el('div', { clase: 'cupo-barras' }, [
      el('span', { clase: 'barras' }, Array.from({ length: CUPO }, () => el('span'))),
      el('strong', { texto: `${Math.min(llevaHoy(), CUPO)} de ${CUPO} hoy` }),
    ]),
    el('strong', { clase: 'cupo-titulo', texto: lleno ? 'Hoy ya no caben más' : 'Este ya no puntúa hoy' }),
    el('span', {
      clase: 'apagado',
      texto: lleno
        ? `Has subido ${TOPE} trayectos hoy, el máximo. Mañana vuelves a tener ${CUPO} que puntúan.`
        : `Se guarda en tus kilómetros y estadísticas. Mañana vuelves a tener ${CUPO}.`,
    }),
  ]);
}

// --- 3f · Corregir una estacion ------------------------------------------------------------

/** Tus estaciones habituales: las de las rutas en las que ya puntuas. */
function habituales() {
  const cuenta = new Map();
  for (const ruta of Object.keys(perfil?.puntosPorRuta || {})) {
    for (const e of ruta.split('-')) cuenta.set(e, (cuenta.get(e) || 0) + 1);
  }
  return [...cuenta.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e).filter((e) => ESTACIONES[e]).slice(0, 3);
}

const sinTildes = (t) => String(t).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

function buscarEstaciones(texto) {
  const q = sinTildes(texto.trim());
  if (!q) return [];
  const numero = /^\d+$/.test(q);
  return Object.entries(ESTACIONES)
    // Las retiradas y las previstas no pueden ser el origen de un trayecto de hoy.
    .filter(([, e]) => e.estado !== 'retirada' && e.estado !== 'prevista')
    .filter(([codigo, e]) => (numero ? codigo.startsWith(q) : sinTildes(e.nombre).includes(q)))
    .sort((a, b) => (numero ? Number(a[0]) - Number(b[0]) : a[1].nombre.localeCompare(b[1].nombre)))
    .slice(0, 6);
}

function abrirBuscador(cual) {
  const leida = normalizarEstacion(cual === 'origen' ? preparada?.lectura?.origen : preparada?.lectura?.destino);
  const campo = el('input', {
    attrs: { type: 'search', id: 'buscar-estacion', inputmode: 'search', autocomplete: 'off', placeholder: 'Número o nombre', 'aria-label': 'Buscar estación' },
  });
  const lista = el('div', { clase: 'lista-estaciones', attrs: { role: 'listbox' } });

  const elegir = (codigo) => {
    borrador[cual] = codigo;
    cerrar();
    pintarConfirmar();
  };
  const fila = (codigo, extra = '') => el('button', {
    clase: 'fila-estacion', attrs: { type: 'button', role: 'option' }, on: { click: () => elegir(codigo) },
  }, [
    el('span', { clase: 'codigo', texto: codigo }),
    el('span', { clase: 'nombre', texto: ESTACIONES[codigo]?.nombre || codigo }),
    el('span', { clase: 'extra', texto: extra }),
  ]);
  const pintar = () => {
    const q = campo.value.trim();
    const encontradas = buscarEstaciones(q);
    if (q && !encontradas.length) {
      reemplazar(lista, el('p', { clase: 'acceso-error', texto: /^\d+$/.test(q) ? 'Esa estación no existe' : 'No hay ninguna estación con ese nombre' }));
      return;
    }
    const iniciales = !q && leida && ESTACIONES[leida] ? [[leida]] : [];
    reemplazar(lista, [...iniciales, ...encontradas].map(([codigo]) => fila(codigo, codigo === leida ? 'la leída' : '')));
  };
  campo.addEventListener('input', pintar);

  const suyas = habituales();
  const { cerrar } = abrirHoja([
    el('div', { clase: 'hoja-cabeza' }, [
      el('h2', { texto: cual === 'origen' ? 'Estación de salida' : 'Estación de meta' }),
      el('button', { clase: 'btn plano', texto: 'Listo', attrs: { type: 'button' }, on: { click: () => cerrar() } }),
    ]),
    el('div', { clase: 'campo-buscar' }, [icono('buscar', 'icono'), campo]),
    lista,
    suyas.length ? el('span', { clase: 'rotulo', texto: 'Tus habituales' }) : null,
    suyas.length ? el('div', { clase: 'chips-habituales' }, suyas.map((c) => el('button', {
      attrs: { type: 'button' }, texto: `${c} ${ESTACIONES[c].nombre}`, on: { click: () => elegir(c) },
    }))) : null,
  ], { etiqueta: cual === 'origen' ? 'Estación de salida' : 'Estación de meta', clase: 'hoja-alta dialogo-escritorio' });
  pintar();
  campo.focus();
}

function abrirTiempo() {
  const min = el('input', { attrs: { type: 'number', min: '0', max: '120', inputmode: 'numeric', id: 't-min', 'aria-label': 'Minutos', value: String(Math.floor((borrador.tiempoSegundos || 0) / 60)) } });
  const seg = el('input', { attrs: { type: 'number', min: '0', max: '59', inputmode: 'numeric', id: 't-seg', 'aria-label': 'Segundos', value: String((borrador.tiempoSegundos || 0) % 60) } });
  const error = el('p', { clase: 'acceso-error', attrs: { 'aria-live': 'polite' } });
  const { cerrar } = abrirHoja([
    el('h2', { texto: 'Tiempo del trayecto' }),
    campoTiempo(min, seg),
    error,
    el('button', {
      clase: 'btn', texto: 'Listo', attrs: { type: 'button' },
      on: {
        click: () => {
          const total = (Number(min.value) || 0) * 60 + (Number(seg.value) || 0);
          if (total < 30 || total > 7200) { error.textContent = 'El tiempo debe estar entre 30 segundos y 2 horas.'; return; }
          borrador.tiempoSegundos = total;
          cerrar();
          pintarConfirmar();
        },
      },
    }),
  ], { etiqueta: 'Tiempo del trayecto', clase: 'dialogo-escritorio' });
  min.focus();
}

function campoTiempo(min, seg) {
  return el('div', { clase: 'campo-tiempo' }, [
    el('label', { clase: 'caja-numero', attrs: { for: min.id } }, [min, el('small', { texto: 'min' })]),
    el('span', { clase: 'dos-puntos', texto: ':' }),
    el('label', { clase: 'caja-numero', attrs: { for: seg.id } }, [seg, el('small', { texto: 'seg' })]),
  ]);
}

// --- 3j · Otro dia: calendario propio, ultimos 30 ------------------------------------------

async function diasConViaje() {
  // Una consulta acotada, SOLO al abrir el calendario: el punto de "ya subiste
  // algo ese dia" no justifica una lectura por viaje en cada subida.
  try {
    const snap = await getDocs(query(
      collection(db, 'tiempos_viaje'), where('uid', '==', perfil.uid), orderBy('creado', 'desc'), limit(60),
    ));
    return new Set(snap.docs.map((d) => d.data().fechaViaje));
  } catch {
    return new Set(); // sin puntos en el calendario se elige igual
  }
}

function abrirCalendario(valor, alElegir) {
  const hoy = diaMadrid();
  const minimo = diaMadridHace(30);
  let elegido = valor;
  let mes = (valor || hoy).slice(0, 7);
  let conViaje = new Set();

  const cuerpo = el('div', { clase: 'calendario' });
  const confirmar = el('button', { clase: 'btn', attrs: { type: 'button' } });
  const nombreMes = (m) => {
    const t = new Intl.DateTimeFormat('es-ES', { month: 'long', timeZone: 'UTC' }).format(new Date(`${m}-15T12:00:00Z`));
    return t.charAt(0).toUpperCase() + t.slice(1);
  };
  const mesDe = (m, n) => {
    const d = new Date(`${m}-15T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    return d.toISOString().slice(0, 7);
  };

  const pintar = () => {
    const primero = `${mes}-01`;
    const inicio = (new Date(`${primero}T12:00:00Z`).getUTCDay() + 6) % 7;
    const dias = [];
    for (let f = primero; f.slice(0, 7) === mes; f = sumarDias(f, 1)) dias.push(f);
    const puedeAtras = mesDe(mes, -1) >= minimo.slice(0, 7);
    const puedeAdelante = mesDe(mes, 1) <= hoy.slice(0, 7);

    reemplazar(cuerpo, [
      el('div', { clase: 'calendario-cabeza' }, [
        el('h2', { texto: nombreMes(mes) }),
        el('span', { clase: 'calendario-flechas' }, [
          el('button', { clase: 'boton-icono', attrs: { type: 'button', 'aria-label': 'Mes anterior', disabled: puedeAtras ? null : '' }, on: { click: () => { mes = mesDe(mes, -1); pintar(); } } }, [icono('atras')]),
          el('button', { clase: 'boton-icono', attrs: { type: 'button', 'aria-label': 'Mes siguiente', disabled: puedeAdelante ? null : '' }, on: { click: () => { mes = mesDe(mes, 1); pintar(); } } }, [icono('derecha')]),
        ]),
      ]),
      el('div', { clase: 'calendario-semana', attrs: { 'aria-hidden': 'true' } }, ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((d) => el('span', { texto: d }))),
      el('div', { clase: 'calendario-dias' }, [
        ...Array.from({ length: inicio }, () => el('span')),
        ...dias.map((f) => {
          const vale = f >= minimo && f <= hoy;
          return el('button', {
            clase: `${f === elegido ? 'elegido' : ''} ${f === hoy ? 'hoy' : ''} ${conViaje.has(f) ? 'con-viaje' : ''}`.trim(),
            attrs: { type: 'button', disabled: vale ? null : '', 'aria-pressed': String(f === elegido), 'aria-label': formatearFecha(f) },
            on: { click: () => { elegido = f; pintar(); } },
          }, [el('span', { texto: String(Number(f.slice(8))) }), el('i')]);
        }),
      ]),
    ]);
    const t = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${elegido}T12:00:00Z`));
    // 3j: "Jueves 24 de septiembre", sin la coma de Intl.
    confirmar.textContent = (t.charAt(0).toUpperCase() + t.slice(1)).replace(',', '');
  };

  const { cerrar } = abrirHoja([cuerpo, confirmar], { etiqueta: 'Elegir el día', clase: 'dialogo-escritorio' });
  confirmar.addEventListener('click', () => { cerrar(); alElegir(elegido); });
  pintar();
  diasConViaje().then((s) => { conViaje = s; pintar(); });
}

// --- 3i · No se ha podido leer: a mano ---------------------------------------------------

function pintarManual(lectura) {
  const b = borrador;
  const entrada = (cual, etiqueta) => {
    const campo = el('input', {
      attrs: { id: `m-${cual}`, type: 'text', inputmode: 'numeric', autocomplete: 'off', value: b[cual] || '', 'aria-describedby': `m-${cual}-nombre` },
    });
    const nombre = el('span', { clase: 'estacion-leida', attrs: { id: `m-${cual}-nombre`, 'aria-live': 'polite' } });
    const comprobar = () => {
      const codigo = normalizarEstacion(campo.value);
      const n = nombreEstacion(codigo);
      b[cual] = n ? codigo : '';
      campo.setAttribute('aria-invalid', String(Boolean(campo.value) && !n));
      reemplazar(nombre, !campo.value ? null : n
        ? el('span', { clase: 'ok' }, [icono('check', 'icono peq'), el('span', { texto: n })])
        : el('span', { clase: 'mal', texto: 'Esa estación no existe' }));
      revisar();
    };
    campo.addEventListener('input', comprobar);
    campo.addEventListener('blur', comprobar);
    return { nodo: el('div', { clase: 'campo-manual' }, [el('label', { attrs: { for: campo.id }, texto: etiqueta }), campo, nombre]), comprobar };
  };

  const salida = entrada('origen', 'Salida');
  const meta = entrada('destino', 'Meta');
  const min = el('input', { attrs: { type: 'number', min: '0', max: '120', inputmode: 'numeric', id: 'm-min', 'aria-label': 'Minutos', value: b.tiempoSegundos ? String(Math.floor(b.tiempoSegundos / 60)) : '' } });
  const seg = el('input', { attrs: { type: 'number', min: '0', max: '59', inputmode: 'numeric', id: 'm-seg', 'aria-label': 'Segundos', value: b.tiempoSegundos ? String(b.tiempoSegundos % 60) : '' } });
  const boton = el('button', { clase: 'btn grande', texto: 'Subir trayecto', attrs: { type: 'button', disabled: '' } });

  function revisar() {
    const total = (Number(min.value) || 0) * 60 + (Number(seg.value) || 0);
    b.tiempoSegundos = total || null;
    boton.disabled = !(b.origen && b.destino && b.origen !== b.destino && total >= 30 && total <= 7200) || llevaHoy() >= TOPE;
  }
  min.addEventListener('input', revisar);
  seg.addEventListener('input', revisar);

  const partes = [
    lectura?.disponible && b.origen && b.destino ? null : 'las estaciones',
    b.tiempoSegundos ? null : 'el tiempo',
  ].filter(Boolean);

  boton.addEventListener('click', () => subir([{ ...b, ruta: `${b.origen}-${b.destino}` }], b.fecha));

  reemplazar(id('s-manual'), [
    barra('Complétalo tú', { atras: true, miniatura: false }),
    el('div', { clase: 'subir-cuerpo' }, [
      el('div', { clase: 'captura-recorte' }, [el('img', { attrs: { src: preparada.url, alt: 'Tu captura' } })]),
      el('p', {
        clase: 'apagado',
        texto: partes.length === 2 || !lectura?.disponible
          ? 'No hemos podido leer la captura. Escribe los números de las estaciones y el tiempo que salen en ella.'
          : `No hemos podido leer ${partes.join(' ni ')}. Escríbelo tal como sale en la captura; lo demás sí lo hemos leído.`,
      }),
      el('div', { clase: 'rejilla-manual' }, [salida.nodo, meta.nodo]),
      el('div', { clase: 'campo-manual' }, [el('span', { clase: 'rotulo', texto: 'Tiempo' }), campoTiempo(min, seg)]),
      segmentoDia(b.fecha, (dia) => { b.fecha = dia; pintarManual(lectura); mostrar('manual'); }),
      llevaHoy() >= CUPO ? tarjetaCupo(llevaHoy() >= TOPE) : null,
      el('div', { clase: 'subir-hueco' }),
      el('div', { clase: 'subir-enviar' }, [boton]),
    ]),
  ]);
  if (b.origen) salida.comprobar();
  if (b.destino) meta.comprobar();
  revisar();
}

// --- 3g · Una captura, varios trayectos --------------------------------------------------------

const huellaLogica = (ruta, tiempoSegundos, fechaViaje) => `${ruta}|${tiempoSegundos}|${fechaViaje}`;

async function misViajesRecientes() {
  // UNA consulta acotada, solo cuando la captura trae mas de un trayecto: para
  // no ofrecer lo que ya esta subido.
  const ya = new Set();
  try {
    const snap = await getDocs(query(
      collection(db, 'tiempos_viaje'), where('uid', '==', perfil.uid), orderBy('creado', 'desc'), limit(60),
    ));
    for (const d of snap.docs) {
      const v = d.data();
      ya.add(huellaLogica(v.ruta, v.tiempoSegundos, v.fechaViaje));
    }
  } catch {
    // Sin esta consulta se ofrecen todos y ya dira el worker si alguno repite.
  }
  return ya;
}

async function irAElegir(candidatos) {
  const yaSubidos = await misViajesRecientes();
  let dia = diaInicial();
  const quedan = Math.max(0, CUPO - llevaHoy());
  const elegidos = new Set();

  const pintar = () => {
    const nuevos = candidatos.map((c, i) => ({ c, i, repetido: yaSubidos.has(huellaLogica(c.ruta, c.tiempoSegundos, dia)) }));
    // Se preseleccionan los que caben en el cupo; los que no, se ven pero no
    // se pueden marcar (3g).
    if (!elegidos.size) nuevos.filter((n) => !n.repetido).slice(0, quedan).forEach((n) => elegidos.add(n.i));
    const libres = nuevos.filter((n) => !n.repetido);
    const noCaben = libres.filter((n) => !elegidos.has(n.i) && elegidos.size >= quedan);
    const boton = el('button', {
      clase: 'btn grande', attrs: { type: 'button', disabled: elegidos.size ? null : '' },
      texto: elegidos.size === 1 ? 'Subir 1 trayecto' : `Subir ${elegidos.size} trayectos`,
      on: { click: () => subir([...elegidos].map((i) => candidatos[i]), dia) },
    });

    reemplazar(id('s-varios'), [
      barra(`${candidatos.length} trayectos encontrados`),
      el('div', { clase: 'subir-cuerpo varios' }, [
        el('div', { clase: 'confirmar-imagen solo-escritorio' }, [el('img', { attrs: { src: preparada.url, alt: 'Tu captura' } })]),
        el('div', { clase: 'varios-lista' }, [
          avisosEncima(),
          el('p', { clase: 'apagado' }, quedan
            ? ['Hoy te quedan ', el('strong', { texto: quedan === 1 ? '1 que puntúa' : `${quedan} que puntúan` }), '. Elige cuáles.']
            : ['Hoy ya no te quedan trayectos que puntúen. Puedes subirlos igual, sin puntos, de uno en uno.']),
          ...nuevos.map(({ c, i, repetido }) => {
            const marcado = elegidos.has(i);
            const bloqueado = repetido || (!marcado && elegidos.size >= quedan);
            return el('button', {
              clase: `trayecto-opcion ${marcado ? 'marcado' : ''} ${bloqueado ? 'apagado' : ''}`.trim(),
              attrs: { type: 'button', 'aria-pressed': String(marcado), disabled: bloqueado ? '' : null },
              on: { click: () => { if (marcado) elegidos.delete(i); else elegidos.add(i); pintar(); } },
            }, [
              el('span', { clase: 'casilla-visual' }, [icono('check', 'icono peq')]),
              // 3g: salida arriba y "→ meta" debajo; 8g: "Salida → Meta" en una
              // linea y debajo "hoy 18:51 → 19:08 · 2,1 km".
              el('span', { clase: 'trayecto-texto' }, [
                el('strong', {}, [nombreEstacion(c.origen), el('span', { clase: 'solo-escritorio-i', texto: ` → ${nombreEstacion(c.destino).split(' - ')[0]}` })]),
                el('span', { clase: 'solo-movil-i', texto: `→ ${nombreEstacion(c.destino)}` }),
                el('small', {}, repetido ? ['Ya lo tienes subido'] : [
                  el('span', { clase: 'solo-escritorio-i', texto: `${dia === diaMadrid() ? 'hoy' : dia === diaMadridHace(1) ? 'ayer' : formatearFecha(dia)} ` }),
                  [c.horaSalida, c.horaLlegada].filter(Boolean).join(' → '),
                  kmEstimados(c.origen, c.destino) ? el('span', { clase: 'solo-escritorio-i', texto: ` · ${String(kmEstimados(c.origen, c.destino).toFixed(1)).replace('.', ',')} km` }) : null,
                ]),
              ]),
              el('span', { clase: 'trayecto-tiempo', texto: formatearTiempo(c.tiempoSegundos) }),
            ]);
          }),
          noCaben.length ? el('p', {
            clase: 'menor apagado',
            texto: `${noCaben.length === 1 ? `El de las ${noCaben[0].c.horaSalida || 'otra hora'} no cabe` : 'Los demás no caben'} hoy: ya llevas ${llevaHoy()} y puntúan ${CUPO} al día.`,
          }) : null,
          el('div', { clase: 'varios-pie' }, [
            segmentoDia(dia, (d) => { dia = d; elegidos.clear(); pintar(); }, { rotulo: 'Día de los trayectos' }),
            el('div', { clase: 'subir-hueco' }),
            el('div', { clase: 'subir-enviar' }, [boton]),
          ]),
        ]),
      ]),
    ]);
  };
  pintar();
  mostrar('varios');
}

// --- Correcciones: para MEDIR el lector, no para juzgar a nadie -------------------------------

function correcciones(enviado) {
  const lectura = preparada?.lectura;
  if (!lectura) return null;
  const leido = {
    origen: normalizarEstacion(lectura.origen),
    destino: normalizarEstacion(lectura.destino),
    tiempoSegundos: lectura.segundosDuracion,
  };
  return {
    confianza: lectura.confianza,
    origen: leido.origen !== enviado.origen,
    destino: leido.destino !== enviado.destino,
    tiempoSegundos: leido.tiempoSegundos !== enviado.tiempoSegundos,
    desfaseSegundos: Number.isFinite(leido.tiempoSegundos) ? Math.abs(leido.tiempoSegundos - enviado.tiempoSegundos) : null,
  };
}

// --- Escritura ------------------------------------------------------------------------------

/**
 * Escribe los viajes elegidos y su captura.
 *
 * UN LOTE POR VIAJE: el freno de #62 solo deja un viaje por lote, porque el id
 * tiene que ser el numero que marca el contador de `cupos/{uid}`. La captura se
 * guarda UNA vez aunque haya varios viajes, y cada uno apunta a ella con
 * `capturaId` (#11).
 *
 * El navegador solo puede PROPONER: las reglas obligan a que el viaje nazca en
 * estado 'pendiente' y sin verificar. El veredicto lo pone el worker.
 */
async function escribirViajes(viajes, fechaViaje) {
  const actual = await leerCupo();
  const cupoRef = doc(db, 'cupos', perfil.uid);
  const capturaId = `${perfil.uid}_${actual.dia}_c${actual.capturas + 1}`;
  let escritas = actual.capturas;
  let contados = actual.viajes;
  const ids = [];

  for (const viaje of viajes) {
    contados += 1;
    const viajeId = `${perfil.uid}_${actual.dia}_${contados}`;
    const minutos = Math.floor(viaje.tiempoSegundos / 60);
    const segundos = viaje.tiempoSegundos % 60;
    const datos = {
      uid: perfil.uid,
      username: perfil.username,
      ruta: viaje.ruta,
      tiempoSegundos: viaje.tiempoSegundos,
      tiempoFormateado: `${String(minutos).padStart(2, '0')}m ${String(segundos).padStart(2, '0')}s`,
      fechaViaje,
      estado: 'pendiente',
      verificado: false,
      capturaId,
      creado: serverTimestamp(),
    };
    const corregido = correcciones(viaje);
    if (corregido) datos.correcciones = corregido;
    if (preparada?.metadatos && Object.keys(preparada.metadatos).length) datos.metadatos = preparada.metadatos;

    const lote = writeBatch(db);
    // La captura va con el primer viaje: si fuera aparte y fallara el viaje,
    // quedaria una captura de 700 KB sin dueño que nadie borra nunca.
    if (escritas === actual.capturas) {
      escritas += 1;
      lote.set(doc(db, 'capturas', capturaId), { uid: perfil.uid, datos: preparada.dataUrl, creado: serverTimestamp() });
    }
    lote.set(cupoRef, { dia: actual.dia, viajes: contados, capturas: escritas });
    lote.set(doc(db, 'tiempos_viaje', viajeId), datos);
    await lote.commit();
    ids.push(viajeId);
  }
  cupo = { dia: actual.dia, viajes: contados, capturas: escritas };
  return ids;
}

async function subir(viajes, fechaViaje) {
  if (!viajes.length || !preparada?.dataUrl) return;
  // Mientras se escribe: el boton dice "Subiendo…" y se avisa de no cerrar.
  const botones = document.querySelectorAll('.subir-paso:not(.oculto) .subir-enviar .btn');
  const pista = document.querySelector('.subir-paso:not(.oculto) .subir-enviar .hoy-pista');
  botones.forEach((b) => { b.disabled = true; b.textContent = 'Subiendo…'; });
  if (pista) pista.textContent = 'No cierres esta página';

  try {
    const ids = await escribirViajes(viajes, fechaViaje);
    anotar('subida_enviada');
    marcarPrimerViaje();
    pintarSubido(ids, viajes);
    mostrar('subido');
  } catch (error) {
    anotar('subida_fallida');
    botones.forEach((b) => { b.disabled = false; b.textContent = 'Subir trayecto'; });
    if (pista) {
      pista.textContent = traducirError(error);
      pista.classList.add('error');
    }
  }
}

// --- 3d · Subido, en cola ---------------------------------------------------------------------

function hora(d) {
  return new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }).format(d);
}

async function tarjetaAvisos() {
  if (!pushSoportado() || !pushConfigurado()) return null;
  if (await suscripcionActual()) return null;
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') return null;
  const interruptor = el('input', { clase: 'interruptor', attrs: { type: 'checkbox', role: 'switch', id: 'avisame' } });
  interruptor.addEventListener('change', async () => {
    if (!interruptor.checked) return;
    interruptor.disabled = true;
    try {
      const s = await suscribir();
      if (s) await guardarSuscripcionPush(s);
      else interruptor.checked = false;
    } catch {
      interruptor.checked = false; // sin permiso: se queda apagado y ya
    } finally {
      interruptor.disabled = false;
    }
  });
  return el('label', { clase: 'tarjeta-grande media avisame', attrs: { for: 'avisame' } }, [
    icono('campana', 'icono'),
    el('span', { clase: 'avisame-texto' }, [el('strong', { texto: 'Avísame cuando esté' }), el('span', { texto: 'Y si mi racha está en peligro.' })]),
    interruptor,
  ]);
}

function pintarSubido(ids, viajes = []) {
  const ahora = new Date();
  const lineaTiempo = el('div', { clase: 'linea-tiempo' });
  const pintarLinea = (estado) => {
    const resuelto = estado && estado !== 'pendiente' && estado !== 'extrayendo';
    reemplazar(lineaTiempo, [
      el('div', { clase: 'hecho' }, [el('i'), el('span', {}, [el('strong', { texto: 'Subido' }), ` · ${hora(ahora)}`])]),
      el('div', { clase: resuelto ? 'hecho' : 'ahora' }, [el('i'), el('span', {}, [el('strong', { texto: 'Analizando' }), ` · ~${hora(new Date(ahora.getTime() + 10 * 60000))}`])]),
      el('div', { clase: resuelto ? 'hecho' : '' }, [el('i'), el('span', {
        texto: estado === 'aprobado' ? 'Verificado y sumando' : estado === 'rechazado' ? 'No cuenta' : estado === 'revision' ? 'Lo mira una persona' : 'Verificado y sumando',
      })]),
    ]);
  };
  pintarLinea('pendiente');

  const hayMas = cola.length;
  const avisos = el('div');
  tarjetaAvisos().then((t) => { if (t) reemplazar(avisos, t); });

  reemplazar(id('s-subido'), el('div', { clase: 'subir-cuerpo subido' }, [
    el('span', { clase: 'subido-marca', attrs: { 'aria-hidden': 'true' } }, [icono('comprobado')]),
    el('div', { clase: 'subido-texto' }, [
      el('h2', { texto: ids.length > 1 ? `${ids.length} subidos.` : 'Subido.' }),
      el('p', { texto: 'Lo verificamos en unos diez minutos. Puedes cerrar la app: esto sigue solo.' }),
    ]),
    lineaTiempo,
    avisos,
    // 11a: la bici del primer trayecto. Opcional y con "Saltar".
    ids[0] && viajes[0] ? encuestaBici({ bici: viajes[0].bici, viajeId: ids[0], ruta: viajes[0].ruta }) : null,
    el('div', { clase: 'subir-hueco' }),
    hayMas
      ? el('button', { clase: 'btn grande', texto: `Leer la siguiente captura (${hayMas})`, attrs: { type: 'button' }, on: { click: siguienteCaptura } })
      : el('a', { clase: 'btn grande', texto: 'Volver a Hoy', attrs: { href: '/' } }),
    el('button', { clase: 'btn plano', texto: 'Subir otro trayecto', attrs: { type: 'button' }, on: { click: () => { cancelar(); entradaFoto.click(); } } }),
  ]));

  // Se sigue el primero (los demas van en la misma tanda) y se recuerda para
  // que Hoy lo siga si la persona se va (2d).
  recordarViaje(ids[0]);
  let respuestas = 0;
  seguirViaje(ids[0], (viaje) => {
    const primera = respuestas++ === 0;
    if (!viaje) return;
    pintarLinea(viaje.estado);
    if (viaje.estado === 'pendiente' || viaje.estado === 'extrayendo') return;
    olvidarViaje();
    if (primera) return;
    if (viaje.estado === 'aprobado') abrirVerificado(viaje, { racha: perfil.racha });
    else abrirResuelto(viaje);
  });
}

// El lector ocupa varios megas de memoria. Al irse de la pagina, fuera.
window.addEventListener('pagehide', () => { cerrarLector(); });

// Solo con `npm run maqueta` (Firebase de mentira): enseñar el billete sin
// depender de lo que lea el OCR de la imagen de ejemplo.
if (db.maqueta) {
  window.maquetaBillete = (datos = {}) => {
    preparada = { fichero: null, url: '/images/ejemplo.jpg', dataUrl: 'data:image/jpeg;base64,', avisos: [], lectura: { origen: '124', destino: '115', segundosDuracion: 1038, confianza: 90 }, metadatos: {} };
    borrador = { origen: '124', destino: '115', tiempoSegundos: 1038, horaSalida: '02:51', horaLlegada: '03:08', fecha: diaMadrid(), ...datos };
    pintarConfirmar();
    mostrar('confirmar');
  };
  window.maquetaVarios = () => {
    preparada = { fichero: null, url: '/images/ejemplo.jpg', dataUrl: 'data:image/jpeg;base64,', avisos: [], lectura: null, metadatos: {} };
    irAElegir([
      { origen: '124', destino: '115', ruta: '124-115', tiempoSegundos: 1038, horaSalida: '18:51', horaLlegada: '19:08' },
      { origen: '1', destino: '124', ruta: '1-124', tiempoSegundos: 707, horaSalida: '13:10', horaLlegada: '13:22' },
      { origen: '102', destino: '101', ruta: '102-101', tiempoSegundos: 542, horaSalida: '08:02', horaLlegada: '08:11' },
    ]);
  };
}
