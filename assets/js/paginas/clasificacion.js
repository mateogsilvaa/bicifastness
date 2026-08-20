// Modulo de la pagina /clasificacion/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// Fusiona /ranking/ y /bicirating/, que respondian a la misma pregunta con
// criterios distintos. La pestaña y la ruta elegidas viajan en la query string
// para que un enlace a una clasificacion concreta se pueda compartir y el boton
// de atras del navegador funcione.

import { auth, db, collection, getDocs, query, where, onAuthStateChanged } from '/assets/js/firebase.js';
import { iniciarPagina, nombreRuta, formatearTiempo, formatearFecha } from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';

iniciarPagina('clasificacion');

const PESTANAS = ['rutas', 'pilotos', 'clanes'];

let usuarios = [];
let viajes = [];
let clanes = [];
let uidActual = null;
let cargado = false;

// --- Pintado -----------------------------------------------------------------

/** Cabecera de la tabla. Las columnas son <th scope="col"> de verdad. */
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
 * donde aparece el lima. `esTuya` marca tu posicion con el azul, igual que la
 * navegacion marca donde estas.
 */
function fila({ puesto, nombre, debajo, marca, fecha, esRecord, esTuya }) {
  const clases = [esRecord ? 'record' : '', esTuya ? 'tuya' : ''].filter(Boolean).join(' ');

  return el('tr', { clase: clases }, [
    el('td', { clase: 'col-puesto' }, [el('span', { clase: 'puesto', texto: String(puesto) })]),
    el('td', {}, [
      el('div', { clase: 'nombre', texto: nombre }),
      debajo ? el('div', { clase: 'clan', texto: debajo }) : null,
    ]),
    el('td', { clase: 'col-marca' }, [el('span', { clase: 'marca', texto: marca })]),
    el('td', { clase: 'col-fecha menor apagado', texto: fecha || '' }),
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

// --- Rutas -------------------------------------------------------------------

function rutasConTiempos() {
  const cuenta = new Map();
  for (const v of viajes) cuenta.set(v.ruta, (cuenta.get(v.ruta) || 0) + 1);
  return [...cuenta.keys()].sort();
}

function pintarRuta(ruta) {
  const destino = id('tabla-rutas');

  if (!ruta) {
    reemplazar(destino, vacio('Elige una ruta', 'Selecciona un tramo para ver quien manda en el.'));
    return;
  }

  // Solo el mejor tiempo de cada piloto compite: si no, quien sube diez veces
  // la misma ruta ocupa medio podio.
  const mejorPorPiloto = new Map();
  for (const v of viajes) {
    if (v.ruta !== ruta) continue;
    const previo = mejorPorPiloto.get(v.uid);
    if (!previo || v.tiempoSegundos < previo.tiempoSegundos) mejorPorPiloto.set(v.uid, v);
  }

  const orden = [...mejorPorPiloto.values()].sort((a, b) => a.tiempoSegundos - b.tiempoSegundos);

  if (!orden.length) {
    reemplazar(destino, vacio(
      'Todavia no hay tiempos en esta ruta',
      'El primero que la haga se queda con el record.'));
    return;
  }

  const porUid = new Map(usuarios.map((u) => [u.uid, u]));

  reemplazar(destino, el('table', { clase: 'tabla' }, [
    cabecera([
      { texto: 'Pos', clase: 'col-puesto' },
      { texto: 'Piloto' },
      { texto: 'Tiempo', clase: 'col-marca' },
      { texto: 'Fecha', clase: 'col-fecha' },
    ]),
    el('tbody', {}, orden.map((v, i) => {
      const piloto = porUid.get(v.uid);
      return fila({
        puesto: i + 1,
        nombre: piloto?.username || 'Piloto',
        debajo: piloto?.clanId || null,
        marca: formatearTiempo(v.tiempoSegundos),
        fecha: v.fechaViaje ? formatearFecha(v.fechaViaje) : '',
        esRecord: i === 0,
        esTuya: v.uid === uidActual,
      });
    })),
  ]));
}

// --- Pilotos y clanes --------------------------------------------------------

function pintarPilotos() {
  const orden = [...usuarios]
    .filter((u) => (u.biciRating || 0) > 0)
    .sort((a, b) => (b.biciRating || 0) - (a.biciRating || 0));

  const destino = id('tabla-pilotos');

  if (!orden.length) {
    reemplazar(destino, vacio(
      'Todavia no hay pilotos con puntos',
      'Los puntos salen de los trayectos verificados.'));
    return;
  }

  reemplazar(destino, el('table', { clase: 'tabla' }, [
    cabecera([
      { texto: 'Pos', clase: 'col-puesto' },
      { texto: 'Piloto' },
      { texto: 'BiciRating', clase: 'col-marca' },
      { texto: 'Viajes', clase: 'col-fecha' },
    ]),
    el('tbody', {}, orden.map((u, i) => fila({
      puesto: i + 1,
      nombre: u.username || 'Piloto',
      debajo: u.clanId || null,
      marca: String(u.biciRating || 0),
      fecha: `${u.viajesVerificados || 0}`,
      esRecord: i === 0,
      esTuya: u.uid === uidActual,
    }))),
  ]));
}

function pintarClanes() {
  const orden = [...clanes].sort((a, b) => (b.biciRating || 0) - (a.biciRating || 0));
  const destino = id('tabla-clanes');

  if (!orden.length) {
    reemplazar(destino, vacio('Todavia no hay clanes', 'Crea el primero desde tu perfil.'));
    return;
  }

  const miClan = usuarios.find((u) => u.uid === uidActual)?.clanId || null;

  reemplazar(destino, el('table', { clase: 'tabla' }, [
    cabecera([
      { texto: 'Pos', clase: 'col-puesto' },
      { texto: 'Clan' },
      { texto: 'BiciRating', clase: 'col-marca' },
      { texto: 'Miembros', clase: 'col-fecha' },
    ]),
    el('tbody', {}, orden.map((c, i) => fila({
      puesto: i + 1,
      nombre: c.nombre || c.id,
      debajo: null,
      marca: String(c.biciRating || 0),
      fecha: `${c.numMiembros || 0}`,
      esRecord: i === 0,
      esTuya: c.id === miClan,
    }))),
  ]));
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

onAuthStateChanged(auth, (usuario) => {
  uidActual = usuario ? usuario.uid : null;
  // Si ya estaba pintado, se repinta para marcar tu fila.
  if (cargado) mostrar(new URLSearchParams(window.location.search).get('tab') || 'rutas', { recordar: false });
});

async function cargar() {
  for (const p of PESTANAS) reemplazar(id(`tabla-${p}`), esqueleto());

  try {
    const [usuariosSnap, viajesSnap, clanesSnap] = await Promise.all([
      getDocs(collection(db, 'usuarios')),
      getDocs(query(collection(db, 'tiempos_viaje'), where('verificado', '==', true))),
      getDocs(collection(db, 'clanes')),
    ]);

    usuarios = usuariosSnap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    viajes = viajesSnap.docs.map((d) => d.data());
    clanes = clanesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    cargado = true;

    const parametros = new URLSearchParams(window.location.search);
    const rutas = rutasConTiempos();
    const pedida = parametros.get('ruta');
    const elegida = rutas.includes(pedida) ? pedida : rutas[0];

    reemplazar(id('selector-ruta'), rutas.map((r) => el('option', {
      texto: nombreRuta(r),
      attrs: { value: r, selected: r === elegida ? 'selected' : null },
    })));

    pintarRuta(elegida);
    mostrar(parametros.get('tab') || 'rutas', { recordar: false });
  } catch (error) {
    console.debug('No se ha podido cargar la clasificacion', error);
    for (const p of PESTANAS) {
      reemplazar(id(`tabla-${p}`), el('div', {}));
      estado(id(`msg-${p}`), 'No hemos podido cargar la clasificacion. Vuelve a intentarlo.', 'error');
    }
  }
}

cargar();
