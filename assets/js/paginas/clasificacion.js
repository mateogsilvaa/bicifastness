// Modulo de la pagina /clasificacion/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// Fusiona /ranking/ y /bicirating/, que respondian a la misma pregunta con
// criterios distintos. La pestaña y la ruta elegidas viajan en la query string
// para que un enlace a una clasificacion concreta se pueda compartir y el boton
// de atras del navegador funcione.
//
// Lee de `agregados/`, NO de las colecciones. Dos motivos:
//
//   - recorrer `usuarios` costaba 175 lecturas por cada visita, y el plan
//     gratuito da 50.000 al dia: 285 visitas y se acabo
//   - esa coleccion esta cerrada porque lleva datos que no son de nadie mas
//     (#60). Un agregado solo trae lo que se pinta

import { db, doc, getDoc } from '/assets/js/firebase.js';
import { iniciarPagina, nombreRuta, formatearTiempo } from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';

iniciarPagina('clasificacion');

const PESTANAS = ['rutas', 'pilotos', 'clanes'];

/** Agregados ya pedidos, para no volver a pedirlos al cambiar de pestaña. */
const cache = new Map();

/** Motivo del ultimo fallo de lectura, si lo hubo. */
let fallo = null;

// --- Lectura -----------------------------------------------------------------

/**
 * Trae un agregado. Devuelve null si no existe todavia.
 *
 * Que no exista es normal y no es un error: el worker los crea la primera vez
 * que aprueba algo. Hasta entonces, la pantalla enseña su estado vacio.
 */
async function traer(nombre) {
  if (cache.has(nombre)) return cache.get(nombre);

  try {
    const snap = await getDoc(doc(db, 'agregados', nombre));
    const datos = snap.exists() ? snap.data() : null;
    cache.set(nombre, datos);
    return datos;
  } catch (error) {
    // Que falle UN agregado no puede tumbar la pantalla entera: cada panel se
    // pinta por su cuenta y el que no tenga datos enseña su estado vacio.
    //
    // Pero tampoco se traga en silencio. `permission-denied` aqui casi siempre
    // significa que las reglas desplegadas son anteriores al bloque
    // `agregados`, y sin este aviso se investiga la pantalla en vez del
    // despliegue.
    fallo = error.code === 'permission-denied'
      ? 'Las clasificaciones no estan disponibles. Si acabas de desplegar, revisa las reglas de Firestore.'
      : 'No hemos podido cargar las clasificaciones. Vuelve a intentarlo.';

    console.debug(`No se ha podido leer agregados/${nombre}`, error);
    cache.set(nombre, null);
    return null;
  }
}

/** Enseña el motivo del fallo, si lo hubo, en el panel que toque. */
function avisarSiFallo(panel) {
  if (fallo) estado(id(`msg-${panel}`), fallo, 'error');
}

// --- Pintado -----------------------------------------------------------------

function cabecera(columnas) {
  return el('thead', {}, [
    el('tr', {}, columnas.map((c) => el('th', {
      texto: c.texto,
      clase: c.clase || '',
      attrs: { scope: 'col' },
    }))),
  ]);
}

/**
 * Una fila de clasificacion.
 *
 * `esRecord` solo lo lleva el primero, y es el unico sitio de todo el sitio
 * donde aparece el lima.
 */
function fila({ pos, nombre, debajo, marca, extra, esRecord }) {
  return el('tr', { clase: esRecord ? 'record' : '' }, [
    el('td', { clase: 'col-puesto' }, [el('span', { clase: 'puesto', texto: String(pos) })]),
    el('td', {}, [
      el('div', { clase: 'nombre', texto: nombre }),
      debajo ? el('div', { clase: 'clan', texto: debajo }) : null,
    ]),
    el('td', { clase: 'col-marca' }, [el('span', { clase: 'marca', texto: marca })]),
    el('td', { clase: 'col-fecha menor apagado', texto: extra || '' }),
  ]);
}

function vacio(titulo, explicacion) {
  return el('div', { clase: 'vacio' }, [
    el('h3', { texto: titulo }),
    el('p', { texto: explicacion }),
  ]);
}

/** Esqueletos con el alto exacto de la fila real. Sin barrido. */
function esqueleto(filas = 6) {
  return el('div', {}, Array.from({ length: filas }, () => el('div', { clase: 'esqueleto fila' })));
}

/** "actualizado hace X": un agregado sin fecha no se distingue de uno congelado. */
function pieActualizado(agregado) {
  const marca = agregado?.actualizado?.toDate?.();
  if (!marca) return null;

  const minutos = Math.round((Date.now() - marca.getTime()) / 60000);
  const texto = minutos < 2 ? 'hace un momento'
    : minutos < 60 ? `hace ${minutos} min`
      : minutos < 1440 ? `hace ${Math.round(minutos / 60)} h`
        : `hace ${Math.round(minutos / 1440)} dias`;

  return el('p', { clase: 'menor apagado', texto: `Actualizado ${texto}` });
}

// --- Paneles -----------------------------------------------------------------

async function pintarRuta(ruta) {
  const destino = id('tabla-rutas');

  if (!ruta) {
    reemplazar(destino, vacio('Elige una ruta', 'Selecciona un tramo para ver quien manda en el.'));
    return;
  }

  reemplazar(destino, esqueleto());
  const agregado = await traer(`ruta-${ruta}`);

  if (!agregado || !agregado.filas?.length) {
    reemplazar(destino, vacio(
      'Todavia no hay tiempos en esta ruta',
      'El primero que la haga se queda con el record.'));
    avisarSiFallo('rutas');
    return;
  }

  reemplazar(destino,
    el('div', { clase: 'tabla-scroll' }, [
      el('table', { clase: 'tabla' }, [
        cabecera([
          { texto: 'Pos', clase: 'col-puesto' },
          { texto: 'Piloto' },
          { texto: 'Tiempo', clase: 'col-marca' },
          { texto: '', clase: 'col-fecha' },
        ]),
        el('tbody', {}, agregado.filas.map((f) => fila({
          pos: f.pos,
          nombre: f.nombre,
          debajo: f.clan,
          marca: formatearTiempo(f.marca),
          esRecord: f.pos === 1,
        }))),
      ]),
    ]),
    pieActualizado(agregado));
}

async function pintarPilotos() {
  const destino = id('tabla-pilotos');
  reemplazar(destino, esqueleto());

  const agregado = await traer('ranking-pilotos');

  if (!agregado || !agregado.filas?.length) {
    reemplazar(destino, vacio(
      'Todavia no hay pilotos con puntos',
      'Los puntos salen de los trayectos verificados.'));
    avisarSiFallo('pilotos');
    return;
  }

  reemplazar(destino,
    el('div', { clase: 'tabla-scroll' }, [
      el('table', { clase: 'tabla' }, [
        cabecera([
          { texto: 'Pos', clase: 'col-puesto' },
          { texto: 'Piloto' },
          { texto: 'BiciRating', clase: 'col-marca' },
          { texto: 'Viajes', clase: 'col-fecha' },
        ]),
        el('tbody', {}, agregado.filas.map((f) => fila({
          pos: f.pos,
          nombre: f.nombre,
          debajo: f.clan,
          marca: String(f.puntos),
          extra: String(f.viajes ?? ''),
          esRecord: f.pos === 1,
        }))),
      ]),
    ]),
    pieActualizado(agregado));
}

async function pintarClanes() {
  const destino = id('tabla-clanes');
  reemplazar(destino, esqueleto());

  const agregado = await traer('ranking-clanes');

  if (!agregado || !agregado.filas?.length) {
    reemplazar(destino, vacio('Todavia no hay clanes', 'Crea el primero desde tu perfil.'));
    avisarSiFallo('clanes');
    return;
  }

  reemplazar(destino,
    el('div', { clase: 'tabla-scroll' }, [
      el('table', { clase: 'tabla' }, [
        cabecera([
          { texto: 'Pos', clase: 'col-puesto' },
          { texto: 'Clan' },
          { texto: 'Estaciones', clase: 'col-marca' },
          { texto: 'Puntos', clase: 'col-fecha' },
        ]),
        el('tbody', {}, agregado.filas.map((f) => fila({
          pos: f.pos,
          nombre: f.nombre,
          debajo: `${f.viajes ?? 0} miembros`,
          marca: String(f.marca ?? 0),
          extra: String(f.puntos ?? 0),
          esRecord: f.pos === 1,
        }))),
      ]),
    ]),
    pieActualizado(agregado));
}

// --- Pestañas ----------------------------------------------------------------

function mostrar(pestana, { recordar = true } = {}) {
  const activa = PESTANAS.includes(pestana) ? pestana : 'rutas';

  for (const p of PESTANAS) {
    id(`tab-${p}`).setAttribute('aria-selected', String(p === activa));
    id(`panel-${p}`).classList.toggle('oculto', p !== activa);
  }

  if (recordar) {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', activa);
    // `replaceState` y no `pushState`: cambiar de pestaña no deberia meter una
    // entrada nueva en el historial, o el boton de atras recorre pestañas en
    // vez de volver a la pantalla anterior.
    window.history.replaceState({}, '', url);
  }

  if (activa === 'pilotos') pintarPilotos();
  if (activa === 'clanes') pintarClanes();
}

for (const p of PESTANAS) {
  id(`tab-${p}`).addEventListener('click', () => mostrar(p));
}

id('selector-ruta').addEventListener('change', (evento) => {
  const ruta = evento.target.value;
  const url = new URL(window.location.href);
  if (ruta) url.searchParams.set('ruta', ruta);
  else url.searchParams.delete('ruta');
  window.history.replaceState({}, '', url);
  pintarRuta(ruta);
});

// --- Carga -------------------------------------------------------------------

async function cargar() {
  for (const p of PESTANAS) reemplazar(id(`tabla-${p}`), esqueleto());

  // Sin try/catch: `traer` ya no lanza. Cada panel se pinta por su cuenta y el
  // que falle enseña su estado vacio con el motivo al lado, en vez de tumbar
  // toda la pantalla.
  const indice = await traer('rutas');
  const rutas = indice?.rutas || [];

  const parametros = new URLSearchParams(window.location.search);
  const pedida = parametros.get('ruta');
  const elegida = rutas.includes(pedida) ? pedida : rutas[0];

  reemplazar(id('selector-ruta'), rutas.map((r) => el('option', {
    texto: nombreRuta(r),
    attrs: { value: r, selected: r === elegida ? 'selected' : null },
  })));

  if (elegida) {
    await pintarRuta(elegida);
  } else {
    // Sin rutas no hay nada que elegir, pero si la lectura fallo hay que
    // decirlo: el desplegable vacio no distingue "todavia no hay datos" de
    // "no he podido leerlos".
    reemplazar(id('tabla-rutas'), vacio(
      'Todavia no hay clasificaciones',
      'Apareceran en cuanto se verifique el primer trayecto.'));
    avisarSiFallo('rutas');
  }

  mostrar(parametros.get('tab') || 'rutas', { recordar: false });
}

cargar();
