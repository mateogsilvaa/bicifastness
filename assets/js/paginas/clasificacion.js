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
import { leerCache, guardarCache } from '/assets/js/cache.js';
import { auth, onAuthStateChanged } from '/assets/js/firebase.js';
import { pedirTexto, avisar } from '/assets/js/dom.js';
import { reportarViaje } from '/assets/js/acciones.js';

iniciarPagina('clasificacion');

const PESTANAS = ['rutas', 'pilotos', 'clanes'];

/**
 * Que mide cada modo y con que unidad.
 *
 * La unidad importa: "120" no dice nada, "120 km" si. Y la explicacion evita
 * que alguien mire Sprint pensando que es el ranking general y se crea ultimo.
 */
const MODOS = {
  general: { unidad: '', columna: 'BiciRating', extra: 'Viajes',
    explica: 'Todo lo que has sumado: distancia, velocidad, constancia y puestos en tramos.' },
  sprint: { unidad: '', columna: 'Puntos', extra: 'Tramos',
    explica: 'Solo los puntos por posicion en los tramos. Premia ir rapido.' },
  fondo: { unidad: ' km', columna: 'Kilometros', extra: 'Viajes',
    explica: 'Kilometros recorridos. Premia usar la bici, no correr.' },
  constancia: { unidad: ' dias', columna: 'Mejor racha', extra: 'Racha actual',
    explica: 'La racha mas larga que has mantenido. Premia aparecer.' },
};

/**
 * Agregados ya pedidos, para no volver a pedirlos al cambiar de pestaña.
 *
 * Este Map dura lo que dure la pagina. Detras hay una cache de sesion
 * (`cache.js`) que ademas sobrevive a irse a otra pantalla y volver, que es el
 * caso que de verdad gastaba lecturas repetidas (#37).
 */
const cache = new Map();

/** Motivo del ultimo fallo de lectura, si lo hubo. */
let fallo = null;

/**
 * Si hay sesion, para saber si se puede ofrecer denunciar.
 *
 * La clasificacion se ve sin cuenta —es lo que engancha a quien llega de
 * fuera— pero denunciar exige firmar: la regla comprueba que quien denuncia sea
 * quien dice ser. Ofrecer un boton que va a fallar es peor que no ofrecerlo.
 *
 * Se repinta al saberlo: `onAuthStateChanged` llega despues de la primera
 * pintada, y sin esto quien entra con sesion no veria el boton hasta recargar.
 */
let haySesion = false;

onAuthStateChanged(auth, (u) => {
  const antes = haySesion;
  haySesion = Boolean(u);
  if (antes !== haySesion) pintarActiva();
});

// --- Lectura -----------------------------------------------------------------

/**
 * Trae un agregado. Devuelve null si no existe todavia.
 *
 * Que no exista es normal y no es un error: el worker los crea la primera vez
 * que aprueba algo. Hasta entonces, la pantalla enseña su estado vacio.
 */
async function traer(nombre) {
  if (cache.has(nombre)) return cache.get(nombre);

  // Lo guardado en esta pestana, si sigue siendo reciente. `undefined` es "no
  // hay nada"; `null` es "ya se pregunto y todavia no existe", que tambien se
  // cachea para no volver a preguntar.
  const guardado = leerCache(nombre);
  if (guardado !== undefined) {
    cache.set(nombre, guardado);
    return guardado;
  }

  try {
    const snap = await getDoc(doc(db, 'agregados', nombre));
    const datos = snap.exists() ? snap.data() : null;
    cache.set(nombre, datos);
    guardarCache(nombre, datos);
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
function fila({ pos, nombre, debajo, marca, extra, esRecord, denunciable }) {
  return el('tr', { clase: esRecord ? 'record' : '' }, [
    el('td', { clase: 'col-puesto' }, [el('span', { clase: 'puesto', texto: String(pos) })]),
    el('td', {}, [
      el('div', { clase: 'nombre', texto: nombre }),
      debajo ? el('div', { clase: 'clan', texto: debajo }) : null,
    ]),
    el('td', { clase: 'col-marca' }, [el('span', { clase: 'marca', texto: marca })]),
    el('td', { clase: 'col-fecha menor apagado' }, [
      extra ? el('span', { texto: extra }) : null,
      denunciable ? botonDenunciar(denunciable, nombre) : null,
    ]),
  ]);
}

/**
 * Denunciar un tiempo (#61).
 *
 * Solo con sesion: la regla exige que quien denuncia sea quien firma, y ofrecer
 * un boton que va a fallar es peor que no ofrecerlo.
 *
 * Se manda el id del VIAJE y nada mas. De quien es lo resuelve el worker, que
 * es quien puede leerlo, y es tambien quien descarta las autodenuncias: aqui no
 * hay forma de saber de quien es el tiempo, y por eso el boton sale tambien en
 * la propia fila. Decirlo antes exigiria publicar los uid de todo el que
 * aparece en una clasificacion, que es justo lo que no se hace desde #60.
 */
function botonDenunciar(viajeId, deQuien) {
  return el('button', {
    clase: 'btn plano menor',
    texto: 'Denunciar',
    attrs: { type: 'button', 'aria-label': `Denunciar el tiempo de ${deQuien}` },
    on: {
      click: async (ev) => {
        const boton = ev.currentTarget;

        const motivo = await pedirTexto(
          `¿Que le ves de raro al tiempo de ${deQuien}?`,
          {
            textoAceptar: 'Denunciar',
            etiqueta: 'Lo lee una persona. Cuenta que te ha hecho sospechar.',
            // El mismo minimo que exige la regla. Que lo diga el dialogo evita
            // escribir tres palabras y llevarse un error despues de enviar.
            minimo: 10,
          },
        );
        if (!motivo) return;

        boton.disabled = true;
        try {
          await reportarViaje(viajeId, motivo);
          avisar('Gracias. Lo mirara una persona.', 'exito');
          boton.textContent = 'Denunciado';
        } catch (error) {
          avisar(error.message || 'No se ha podido enviar la denuncia.');
          boton.disabled = false;
        }
      },
    },
  });
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
          denunciable: haySesion ? f.viajeId : null,
        }))),
      ]),
    ]),
    pieActualizado(agregado));
}

async function pintarPilotos() {
  const destino = id('tabla-pilotos');
  const modo = id('selector-modo').value || 'general';
  const config = MODOS[modo];

  id('explica-modo').textContent = config.explica;
  reemplazar(destino, esqueleto());

  const agregado = await traer(`ranking-${modo}`);

  if (!agregado || !agregado.filas?.length) {
    reemplazar(destino, vacio(
      'Todavia no hay nadie en esta tabla',
      modo === 'constancia'
        ? 'Las rachas empiezan con el primer trayecto verificado.'
        : 'Los puntos salen de los trayectos verificados.'));
    avisarSiFallo('pilotos');
    return;
  }

  reemplazar(destino,
    el('div', { clase: 'tabla-scroll' }, [
      el('table', { clase: 'tabla' }, [
        cabecera([
          { texto: 'Pos', clase: 'col-puesto' },
          { texto: 'Piloto' },
          { texto: config.columna, clase: 'col-marca' },
          { texto: config.extra, clase: 'col-fecha' },
        ]),
        el('tbody', {}, agregado.filas.map((f) => fila({
          pos: f.pos,
          nombre: f.nombre,
          debajo: f.clan,
          marca: `${f.puntos}${config.unidad}`,
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

id('selector-modo').addEventListener('change', (evento) => {
  const url = new URL(window.location.href);
  url.searchParams.set('modo', evento.target.value);
  window.history.replaceState({}, '', url);
  pintarPilotos();
});

id('selector-ruta').addEventListener('change', (evento) => {
  const ruta = evento.target.value;
  const url = new URL(window.location.href);
  if (ruta) url.searchParams.set('ruta', ruta);
  else url.searchParams.delete('ruta');
  window.history.replaceState({}, '', url);
  pintarRuta(ruta);
});

/**
 * Repinta lo que este a la vista.
 *
 * Solo hace falta para el ranking de un tramo, que es donde vive el boton de
 * denunciar: la sesion llega despues de la primera pintada y sin esto quien
 * entra con cuenta no veria el boton hasta recargar.
 */
function pintarActiva() {
  const ruta = id('selector-ruta')?.value;
  if (ruta) pintarRuta(ruta);
}

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

  const modo = parametros.get('modo');
  if (modo && MODOS[modo]) id('selector-modo').value = modo;

  mostrar(parametros.get('tab') || 'rutas', { recordar: false });
}

cargar();
