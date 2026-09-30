// Modulo de la pagina /clasificacion/ (04 Ranking; en escritorio 8c, 8i y 8j).
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// TODO SALE DE `agregados/*`: documentos publicos que el worker deja ya
// ordenados. Nunca se recorre una coleccion (#37, #60). Cada agregado se pide
// una vez y se guarda en la pestaña (`cache.js`).

import { db, doc, getDoc, auth, onAuthStateChanged } from '/assets/js/firebase.js';
import { iniciarPagina, nombreEstacion, formatearTiempo, normalizarEstacion, miles } from '/assets/js/ui.js';
import { id, el, icono, estado, reemplazar, pedirTexto, avisar, abrirHoja } from '/assets/js/dom.js';
import { leerCache, guardarCache } from '/assets/js/cache.js';
import { reportarViaje, guardarFavoritas } from '/assets/js/acciones.js';
import { diaMadrid } from '/assets/js/dia.js';
import { diaRelativo } from '/assets/js/yo-vistas.js';
import { ESTACIONES } from '/assets/data/estaciones.js';

iniciarPagina('clasificacion');

const PESTANAS = ['pilotos', 'rutas', 'clanes'];
const DIVISIONES = { hierro: 'Hierro', bronce: 'Bronce', plata: 'Plata', oro: 'Oro', platino: 'Platino', leyenda: 'Leyenda' };

/**
 * Que mide cada modo, con su frase y su unidad (4b). "120" no dice nada; "120
 * km" si.
 */
const MODOS = {
  general: { unidad: 'pts', formato: (v) => numero(v), explica: 'Todo lo que has sumado esta temporada: distancia, ritmo, constancia y puestos en tramos.' },
  sprint: { unidad: 'pts', formato: (v) => numero(v), explica: 'Puntos por tu puesto en cada tramo. Premia ir rápido.' },
  fondo: { unidad: 'km', formato: (v) => `${numero(v)} km`, explica: 'Kilómetros de la temporada. Premia usar la bici, no correr.' },
  constancia: { unidad: 'días', formato: (v) => `${v} ${v === 1 ? 'día' : 'días'}`, explica: 'Tu racha más larga. Premia aparecer cada día.' },
};

const numero = (n) => miles(n);
const ordinal = (n) => `${n}.º`;
const $ = id;

let perfil = null;
let haySesion = false;
let fallo = null;
const cache = new Map();

// --- Lectura -----------------------------------------------------------------

/**
 * Trae un agregado. Devuelve null si no existe todavia: el worker los crea la
 * primera vez que aprueba algo, y hasta entonces la pantalla enseña su vacio.
 */
async function traer(nombre) {
  if (cache.has(nombre)) return cache.get(nombre);
  const guardado = leerCache(nombre);
  if (guardado !== undefined) { cache.set(nombre, guardado); return guardado; }
  try {
    const snap = await getDoc(doc(db, 'agregados', nombre));
    const datos = snap.exists() ? snap.data() : null;
    cache.set(nombre, datos);
    guardarCache(nombre, datos);
    return datos;
  } catch (error) {
    // `permission-denied` aqui casi siempre son reglas desplegadas anteriores
    // al bloque `agregados`: se dice, para investigar el despliegue y no la
    // pantalla.
    fallo = error.code === 'permission-denied'
      ? 'Las clasificaciones no están disponibles. Si acabas de desplegar, revisa las reglas de Firestore.'
      : 'No hemos podido cargar la clasificación.';
    console.debug(`No se ha podido leer agregados/${nombre}`, error);
    cache.set(nombre, null);
    return null;
  }
}

async function clanesDelMapa() {
  const mapa = await traer('mapa');
  return mapa?.clanes || {};
}

// --- Piezas ---------------------------------------------------------------------

function esqueleto(filas = 8) {
  return el('div', { clase: 'esqueleto-lista' }, Array.from({ length: filas }, (_, i) => el('div', { clase: 'esqueleto-fila' }, [
    el('span'), el('span', { estilo: { width: `${[70, 55, 62, 48, 66, 58, 72, 50][i % 8]}%` } }), el('span'),
  ])));
}

function vacio(titulo, texto) {
  return el('div', { clase: 'vacio-rayas' }, [el('strong', { texto: titulo }), el('span', { texto })]);
}

function errorRed(reintentar) {
  return el('div', { clase: 'aviso error con-icono' }, [
    icono('sinred', 'icono'),
    el('p', {}, [
      el('span', { texto: `${fallo || 'No hemos podido cargar la clasificación.'} ` }),
      el('button', { clase: 'enlace-boton', texto: 'Reintentar', attrs: { type: 'button' }, on: { click: () => { fallo = null; cache.clear(); reintentar(); } } }),
    ]),
  ]);
}

function pieActualizado(agregado) {
  const marca = agregado?.actualizado?.toDate?.();
  if (!marca) return null;
  const min = Math.round((Date.now() - marca.getTime()) / 60000);
  const texto = min < 2 ? 'hace un momento' : min < 60 ? `hace ${min} min` : min < 1440 ? `hace ${Math.round(min / 60)} h` : `hace ${Math.round(min / 1440)} días`;
  return el('p', { clase: 'pie-actualizado', texto: `Actualizado ${texto}` });
}

function cuandoAcaba() {
  const hoy = diaMadrid();
  const [a, m] = hoy.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  const quedan = ultimo - Number(hoy.slice(8));
  const mes = new Intl.DateTimeFormat('es-ES', { month: 'long', timeZone: 'UTC' }).format(new Date(`${hoy}T12:00:00Z`));
  const Mes = mes.charAt(0).toUpperCase() + mes.slice(1);
  return `${Mes} · ${quedan === 0 ? 'acaba hoy' : quedan === 1 ? 'acaba mañana' : `acaba en ${quedan} días`}`;
}

// --- Pilotos (4a, 4b, 8c) ------------------------------------------------------------

function parametros() { return new URLSearchParams(window.location.search); }
function cambiarParametro(clave, valor) {
  const url = new URL(window.location.href);
  if (valor) url.searchParams.set(clave, valor); else url.searchParams.delete(clave);
  window.history.replaceState({}, '', url);
}

let ambito = 'grupo';
let modo = 'general';

async function claveDeMiGrupo() {
  if (!perfil?.username) return null;
  const indice = await traer('grupos');
  return indice?.porPiloto?.[perfil.username] || null;
}

function filaPiloto(f, { yo, zona, valor, clanes, columnas = null, flecha = false }) {
  const clan = clanes[f.clan];
  // 4a: puestos ganados o perdidos desde ayer en el grupo (el worker los calcula).
  const cambio = Number(f.cambio) || 0;
  return el('button', {
    clase: `fila-ranking ${yo ? 'tuya' : ''} ${flecha ? 'con-flecha' : ''}`,
    attrs: { type: 'button', 'aria-label': `${f.pos}.º ${f.nombre}, ${valor}` },
    on: { click: () => abrirPiloto(f.nombre) },
  }, [
    el('span', { clase: `zona ${zona || ''}`, attrs: { 'aria-hidden': 'true' } }),
    el('span', { clase: 'pos', texto: String(f.pos) }),
    el('span', { clase: 'quien' }, [
      el('span', { clase: 'nombre', texto: yo ? `Tú · ${f.nombre}` : f.nombre }),
      el('span', { clase: 'clan' }, [
        el('span', { clase: 'punto-clan', estilo: { background: clan?.color || 'transparent' } }),
        el('span', { texto: clan?.nombre || 'Sin clan' }),
      ]),
    ]),
    el('span', { clase: 'clan-escritorio' }, [
      el('span', { clase: 'punto-clan', estilo: { background: clan?.color || 'transparent' } }),
      el('span', { texto: clan?.nombre || 'Sin clan' }),
    ]),
    ...(columnas || []).map((c) => el('span', { clase: 'col-modo', texto: c })),
    el('strong', { clase: 'valor', texto: valor }),
    flecha ? el('span', {
      clase: `flecha-cambio ${cambio > 0 ? 'sube' : cambio < 0 ? 'baja' : ''}`,
      attrs: { title: cambio ? `${cambio > 0 ? 'Sube' : 'Baja'} ${Math.abs(cambio)} desde ayer` : 'Igual que ayer' },
    }, [icono(cambio > 0 ? 'sube' : cambio < 0 ? 'baja' : 'mas-h')]) : null,
  ]);
}

async function pintarPilotos() {
  const destino = $('tabla-pilotos');
  const params = parametros();
  const clave = haySesion ? await claveDeMiGrupo() : null;
  ambito = params.get('ambito') === 'madrid' || !clave ? 'madrid' : 'grupo';
  modo = MODOS[params.get('modo')] ? params.get('modo') : 'general';

  // El grupo compite por puntos de temporada: los modos son de Madrid.
  $('ambito-grupo').classList.toggle('oculto', !clave);
  $('ambito-grupo').textContent = clave ? nombreGrupo(clave) : 'Tu grupo';
  $('ambito-grupo').setAttribute('aria-pressed', String(ambito === 'grupo'));
  document.querySelector('.ranking')?.classList.toggle('en-grupo', ambito === 'grupo');
  $('ambito-madrid').setAttribute('aria-pressed', String(ambito === 'madrid'));
  for (const b of document.querySelectorAll('.chip-modo')) {
    // 4a: el grupo se ordena por el total, asi que "General" va marcado.
    b.setAttribute('aria-pressed', String(ambito === 'madrid' ? b.value === modo : b.value === 'general'));
    b.disabled = false;
  }
  // 4b: la frase de cada modo solo en Madrid; en tu grupo (4a) no hay frase.
  $('explica-modo').textContent = ambito === 'grupo' ? '' : MODOS[modo].explica;

  reemplazar(destino, esqueleto());
  const clanes = await clanesDelMapa();
  const escritorio = window.matchMedia('(min-width: 900px)').matches;

  if (ambito === 'grupo') {
    const grupo = await traer(`grupo-${clave}`);
    if (!grupo?.filas?.length) { reemplazar(destino, fallo ? errorRed(pintarPilotos) : vacio('Tu grupo aún no tiene tabla', 'Se forma en cuanto se verifique el primer trayecto de la semana.')); return; }
    const mueven = grupo.mueven ?? 5;
    // En escritorio, la tabla de verdad con una columna por modo (8c).
    const extras = escritorio ? await Promise.all(['sprint', 'fondo', 'constancia'].map((m) => traer(`ranking-${m}`))) : null;
    const valorDe = (m, nombre) => {
      const f = extras?.[['sprint', 'fondo', 'constancia'].indexOf(m)]?.filas?.find((x) => x.nombre === nombre);
      return f ? MODOS[m].formato(f.puntos) : '—';
    };
    reemplazar(destino, [
      el('div', { clase: 'lista-ranking con-columnas' }, [
        // 8c: en escritorio, la cabecera de una tabla de verdad; 4a: en movil,
        // quien sube el lunes y la unidad.
        el('div', { clase: 'cabecera-ranking' }, escritorio
          ? [
            el('span', { clase: 'col-cab col-pos', texto: '#' }),
            el('span', { clase: 'col-cab', texto: 'Piloto' }),
            el('span', { clase: 'col-cab', texto: 'Clan' }),
            ...['Sprint', 'Fondo', 'Constancia'].map((t) => el('span', { clase: 'col-cab num', texto: t })),
            el('span', { clase: 'col-cab num', texto: 'Total ↓' }),
          ]
          : [
            el('span', { clase: 'sube', texto: 'Suben el lunes' }),
            el('span', { clase: 'col-cab num', texto: 'pts' }),
          ]),
        ...grupo.filas.map((f, i) => filaPiloto(f, {
          yo: f.nombre === perfil?.username,
          zona: mueven && i < mueven ? 'sube' : mueven && i >= grupo.filas.length - mueven ? 'baja' : '',
          valor: numero(f.puntos),
          clanes,
          columnas: escritorio ? [valorDe('sprint', f.nombre), valorDe('fondo', f.nombre), valorDe('constancia', f.nombre)] : null,
          flecha: !escritorio,
        })),
      ]),
      pieActualizado(grupo),
    ]);
    filaFija(grupo.filas, (f) => numero(f.puntos), 'pts');
    return;
  }

  const agregado = await traer(`ranking-${modo}`);
  if (!agregado?.filas?.length) {
    reemplazar(destino, fallo ? errorRed(pintarPilotos) : vacio('Todavía no hay nadie en esta tabla', modo === 'constancia' ? 'Las rachas empiezan con el primer trayecto verificado.' : 'Los puntos salen de los trayectos verificados.'));
    return;
  }
  const formato = MODOS[modo].formato;
  const [p1, p2, p3] = agregado.filas;
  const podio = modo === 'fondo' && p1 && p2 && p3
    ? el('div', { clase: 'podio' }, [
      el('div', { clase: 'podio-2' }, [el('span', { texto: '2.º' }), el('strong', { texto: p2.nombre }), el('span', { clase: 'cifra', texto: formato(p2.puntos) })]),
      el('div', { clase: 'podio-1' }, [el('span', { texto: '1.º' }), el('strong', { texto: p1.nombre }), el('span', { clase: 'cifra', texto: formato(p1.puntos) })]),
      el('div', { clase: 'podio-3' }, [el('span', { texto: '3.º' }), el('strong', { texto: p3.nombre }), el('span', { clase: 'cifra', texto: formato(p3.puntos) })]),
    ])
    : null;
  const resto = podio ? agregado.filas.slice(3) : agregado.filas;
  reemplazar(destino, [
    podio,
    el('div', { clase: 'lista-ranking' }, resto.map((f) => filaPiloto(f, {
      yo: f.nombre === perfil?.username, valor: formato(f.puntos), clanes,
    }))),
    agregado.paginas > 1 ? el('p', { clase: 'pie-actualizado', texto: `Se ven los ${resto.length + (podio ? 3 : 0)} primeros de ${numero(agregado.total)}.` }) : null,
    pieActualizado(agregado),
  ]);
  filaFija(agregado.filas, (f) => formato(f.puntos), MODOS[modo].unidad);
}

function nombreGrupo(clave) {
  const [nivel, n] = String(clave).split('-');
  return `${DIVISIONES[nivel] || nivel} · grupo ${n}`;
}

/**
 * Tu fila fijada sobre la barra cuando queda fuera de la vista (4b), con el
 * hueco al de delante. Sin sesion, la invitacion (4g).
 */
let observador = null;
function filaFija(filas, valor, unidad) {
  const fija = $('fila-fija');
  observador?.disconnect();
  if (!haySesion) {
    reemplazar(fija, el('div', { clase: 'invitacion-ranking' }, [
      el('span', {}, [el('strong', { texto: '¿Dónde quedarías tú?' }), el('br'), el('span', { texto: 'Sube un trayecto y aparece tu puesto.' })]),
      el('a', { clase: 'btn', texto: 'Empezar', attrs: { href: '/' } }),
    ]));
    fija.classList.remove('oculto');
    return;
  }
  const i = filas.findIndex((f) => f.nombre === perfil?.username);
  if (i < 0) { fija.classList.add('oculto'); return; }
  const yo = filas[i];
  const delante = filas[i - 1];
  const hueco = delante ? diferencia(delante.puntos, yo.puntos, unidad) : null;
  reemplazar(fija, el('div', { clase: 'tu-fila' }, [
    el('span', { clase: 'pos', texto: String(yo.pos) }),
    el('span', { clase: 'quien' }, [
      el('strong', { texto: 'Tú' }),
      el('small', { texto: hueco ? `a ${hueco} del ${ordinal(delante.pos)}` : 'vas primero' }),
    ]),
    el('strong', { clase: 'valor', texto: valor(yo) }),
  ]));
  const nodo = document.querySelector('.fila-ranking.tuya');
  if (!nodo || !('IntersectionObserver' in window)) { fija.classList.toggle('oculto', Boolean(nodo)); return; }
  observador = new IntersectionObserver(([e]) => fija.classList.toggle('oculto', e.isIntersecting));
  observador.observe(nodo);
}

function diferencia(a, b, unidad) {
  const d = Math.max(0, (a || 0) - (b || 0));
  if (unidad === 'km') return `${String(Math.max(0.1, d).toFixed(1)).replace('.', ',')} km`;
  if (unidad === 'días') return `${d || 1} ${d === 1 ? 'día' : 'días'}`;
  return `${numero(d || 1)} pts`;
}

for (const b of document.querySelectorAll('.chip-filtro')) {
  b.addEventListener('click', () => { cambiarParametro('ambito', b.dataset.ambito === 'madrid' ? 'madrid' : null); pintarPilotos(); });
}
for (const b of document.querySelectorAll('.chip-modo')) {
  b.addEventListener('click', () => {
    cambiarParametro('modo', b.value === 'general' ? null : b.value);
    cambiarParametro('ambito', 'madrid');
    pintarPilotos();
  });
}

// --- Rutas (4c, 4d, 8i) ------------------------------------------------------------

const [ORIGEN, DESTINO] = [0, 1];
const nombreDe = (ruta, cual) => {
  const cod = String(ruta).split('-')[cual];
  return nombreEstacion(cod) || cod;
};
const tramo = (ruta) => `${nombreDe(ruta, ORIGEN)} → ${nombreDe(ruta, DESTINO)}`;
const corto = (n) => String(n).split(' - ')[0];
const mmss = (s) => formatearTiempo(s);
const menosDe = (seg) => `−${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, '0')}`;
const masDe = (seg) => `+${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, '0')}`;

function kmRuta(ruta) {
  const [a, b] = String(ruta).split('-').map((c) => ESTACIONES[c] || ESTACIONES[String(Number(c))]);
  if (!a || !b) return null;
  const rad = (g) => (g * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h)) * 1.35;
}

async function configGeneral() {
  const guardado = leerCache('config-general');
  if (guardado !== undefined) return guardado;
  try {
    const snap = await getDoc(doc(db, 'config', 'general'));
    const datos = snap.exists() ? snap.data() : null;
    guardarCache('config-general', datos);
    return datos;
  } catch {
    return null; // sin ruta del dia la lista se ve igual
  }
}

/** Tu fila en una ruta y lo que te falta para el de delante. */
function miPuesto(agregado) {
  const filas = agregado?.filas || [];
  const i = filas.findIndex((f) => f.nombre === perfil?.username);
  if (i < 0) return null;
  const yo = filas[i];
  const delante = filas[i - 1];
  return { yo, delante, total: agregado.total ?? filas.length };
}

async function filaRuta(ruta, { rutaDelDia, ancladas, indice, seleccionada }) {
  const agregado = await traer(`ruta-${ruta}`);
  const mio = miPuesto(agregado);
  const pilotos = agregado?.total ?? agregado?.filas?.length ?? indice?.viajesPorRuta?.[ruta] ?? 0;
  const esDelDia = ruta === rutaDelDia;
  const hoyN = esDelDia && agregado?.hoyDia === diaMadrid() ? agregado.hoyPilotos || 0 : null;
  const info = [
    ancladas.has(ruta) ? 'Anclada' : null,
    esDelDia ? `Ruta del día${hoyN !== null ? ` · ${hoyN} hoy` : ''}` : null,
    !esDelDia ? `${pilotos} ${pilotos === 1 ? 'piloto' : 'pilotos'}` : null,
  ].filter(Boolean).join(' · ');
  let puesto = '';
  let clase = '';
  if (mio) {
    if (mio.yo.pos === 1) { puesto = 'Récord'; clase = 'record'; } else {
      puesto = `${ordinal(mio.yo.pos)}${mio.delante && mio.yo.pos <= 4 ? ` · ${menosDe(mio.yo.marca - mio.delante.marca)} para ${ordinal(mio.delante.pos)}` : ''}`;
      clase = mio.yo.pos <= 3 || ancladas.has(ruta) ? 'azul' : '';
    }
  }
  return el('button', {
    clase: `fila-ruta ${seleccionada ? 'elegida' : ''}`,
    attrs: { type: 'button', 'aria-current': seleccionada ? 'true' : null },
    on: { click: () => abrirRuta(ruta) },
  }, [
    el('span', { clase: 'ruta-nombre' }, [
      el('span', { texto: corto(nombreDe(ruta, ORIGEN)) }), icono('flecha', 'icono peq'), el('span', { texto: corto(nombreDe(ruta, DESTINO)) }),
    ]),
    el('span', { clase: 'ruta-tiempo', texto: mio ? mmss(mio.yo.marca) : '' }),
    el('span', { clase: 'ruta-info', texto: info }),
    el('span', { clase: `ruta-puesto ${clase}`, texto: puesto }),
  ]);
}

async function pintarListaRutas(filtro = '') {
  const destino = $('rutas-lista');
  const indice = await traer('rutas');
  const todas = Array.isArray(indice?.rutas) ? indice.rutas : Object.keys(indice?.rutas || {});
  const rutaDelDia = (await configGeneral())?.rutaDestacada || null;
  const ancladas = new Set(perfil?.favoritas || []);
  const mias = [...new Set([...(perfil?.favoritas || []), ...Object.keys(perfil?.puntosPorRuta || {})])].filter((r) => r !== rutaDelDia);
  const seleccionada = parametros().get('ruta');

  const buscador = el('input', {
    attrs: { type: 'search', id: 'buscar-ruta', placeholder: 'Estación de salida o de meta', 'aria-label': 'Buscar ruta por estación', autocomplete: 'off', value: filtro },
  });
  const resultados = el('div', { clase: 'rutas-resultados' });

  const pintarResultados = async () => {
    const q = buscador.value.trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    if (!q) { reemplazar(resultados); return; }
    const casan = todas.filter((r) => {
      const [a, b] = r.split('-');
      const texto = `${a} ${b} ${nombreDe(r, ORIGEN)} ${nombreDe(r, DESTINO)}`.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
      return texto.includes(q);
    }).slice(0, 20);
    reemplazar(resultados, casan.length
      ? [el('span', { clase: 'rotulo', texto: `${casan.length} ${casan.length === 1 ? 'ruta' : 'rutas'}` }),
        ...casan.map((r) => el('button', { clase: `fila-ruta ${r === seleccionada ? 'elegida' : ''}`, attrs: { type: 'button' }, on: { click: () => abrirRuta(r) } }, [
          el('span', { clase: 'ruta-nombre' }, [el('span', { texto: corto(nombreDe(r, ORIGEN)) }), icono('flecha', 'icono peq'), el('span', { texto: corto(nombreDe(r, DESTINO)) })]),
          el('span', { clase: 'ruta-tiempo' }),
          el('span', { clase: 'ruta-info', texto: `${indice?.viajesPorRuta?.[r] ?? 0} viajes` }),
          el('span', { clase: 'ruta-puesto' }),
        ]))]
      : vacio('Ninguna ruta con esa estación', 'Prueba con el número o con otra parte del nombre.'));
  };
  buscador.addEventListener('input', pintarResultados);

  let tarjetaDia = null;
  if (rutaDelDia) {
    const ag = await traer(`ruta-${rutaDelDia}`);
    const deHoy = ag?.hoyDia === diaMadrid() ? ag.hoy || [] : [];
    tarjetaDia = el('button', { clase: 'tarjeta-ruta-dia compacta', attrs: { type: 'button' }, on: { click: () => abrirRuta(rutaDelDia) } }, [
      el('span', { clase: 'x2', texto: 'Ruta del día · ×2' }),
      el('span', { clase: 'cierra', texto: deHoy.length ? `${ag.hoyPilotos || deHoy.length} hoy` : 'aún sin tiempos hoy' }),
      el('strong', { texto: `${corto(nombreDe(rutaDelDia, ORIGEN))} → ${corto(nombreDe(rutaDelDia, DESTINO))}` }),
      el('span', { clase: 'cifra', texto: deHoy[0] ? mmss(deHoy[0].marca) : '' }),
    ]);
  }

  const filas = await Promise.all(mias.slice(0, 12).map((r) => filaRuta(r, { rutaDelDia, ancladas, indice, seleccionada: r === seleccionada })));
  reemplazar(destino, [
    el('div', { clase: 'campo-buscar' }, [icono('buscar', 'icono'), buscador, el('kbd', { clase: 'solo-escritorio-inline', texto: '/' })]),
    resultados,
    tarjetaDia,
    filas.length ? el('span', { clase: 'rotulo', texto: 'Tus rutas' }) : null,
    filas.length ? el('div', { clase: 'lista-rutas' }, filas) : null,
    !filas.length && !todas.length ? vacio('Todavía no hay rutas', 'Aparecen en cuanto se verifica el primer trayecto.') : null,
    !filas.length && todas.length && haySesion ? el('p', { clase: 'menor apagado', texto: 'Cuando subas un trayecto, sus rutas aparecen aquí. Busca cualquiera por estación.' }) : null,
  ]);
  if (filtro) pintarResultados();
}

// "/" busca (8 · reglas de teclado).
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || /^(input|textarea)$/i.test(e.target?.tagName || '')) return;
  const campo = $('buscar-ruta');
  if (campo && !$('panel-rutas').classList.contains('oculto')) { e.preventDefault(); campo.focus(); }
});

function abrirRuta(ruta) {
  cambiarParametro('ruta', ruta);
  document.querySelector('.rutas-rejilla')?.classList.add('con-detalle');
  pintarDetalleRuta(ruta);
  for (const b of document.querySelectorAll('.fila-ruta')) b.classList.remove('elegida');
  window.scrollTo(0, 0);
}

function cerrarRuta() {
  cambiarParametro('ruta', null);
  document.querySelector('.rutas-rejilla')?.classList.remove('con-detalle');
  reemplazar($('ruta-detalle'));
}

async function pintarDetalleRuta(ruta, vista = null) {
  const destino = $('ruta-detalle');
  reemplazar(destino, esqueleto(7));
  const agregado = await traer(`ruta-${ruta}`);
  const rutaDelDia = (await configGeneral())?.rutaDestacada || null;
  const esDelDia = ruta === rutaDelDia;
  // "Hoy": en la ruta del dia, su tabla de hoy; en las demas, las marcas que
  // se han hecho hoy (el agregado guarda el dia de cada una).
  const deHoy = esDelDia
    ? (agregado?.hoyDia === diaMadrid() ? agregado.hoy || [] : [])
    : (agregado?.filas || []).filter((f) => f.fecha === diaMadrid()).map((f, i) => ({ ...f, pos: i + 1 }));
  const modoVista = vista || (esDelDia ? 'hoy' : 'siempre');
  const filas = modoVista === 'hoy' ? deHoy : agregado?.filas || [];
  const km = kmRuta(ruta);
  const [a, b] = ruta.split('-');
  const ancladas = new Set(perfil?.favoritas || []);
  const anclada = ancladas.has(ruta);

  const pin = haySesion ? el('button', {
    clase: `boton-anclar ${anclada ? 'activo' : ''}`,
    attrs: { type: 'button', 'aria-pressed': String(anclada), 'aria-label': anclada ? 'Quitar de tus rutas ancladas' : 'Anclar esta ruta' },
    on: {
      click: async () => {
        const nuevas = new Set(perfil.favoritas || []);
        if (anclada) nuevas.delete(ruta); else nuevas.add(ruta);
        try {
          await guardarFavoritas([...nuevas]);
          perfil.favoritas = [...nuevas];
          pintarDetalleRuta(ruta, modoVista);
          pintarListaRutas($('buscar-ruta')?.value || '');
        } catch (e) { avisar(e.message || 'No se ha podido guardar.'); }
      },
    },
  }, [icono('pin', 'icono'), el('span', { clase: 'solo-escritorio-inline', texto: anclada ? 'Anclada' : 'Anclar' })]) : null;

  const mio = miPuesto(modoVista === 'hoy' ? { filas: deHoy, total: deHoy.length } : agregado);
  const record = filas[0];
  const objetivo = mio?.delante;

  reemplazar(destino, [
    el('div', { clase: 'detalle-barra' }, [
      el('button', { clase: 'boton-icono solo-movil-inline', attrs: { type: 'button', 'aria-label': 'Volver a las rutas' }, on: { click: cerrarRuta } }, [icono('atras')]),
      pin,
    ]),
    el('div', { clase: 'detalle-titulo' }, [
      // 4d: "001 → 102 · 1,9 km".
      el('span', { clase: 'rotulo' }, [
        [`${normalizarEstacion(a)} → ${normalizarEstacion(b)}`, km ? `${String(km.toFixed(1)).replace('.', ',')} km` : null].filter(Boolean).join(' · '),
        // 8i: en escritorio, tambien cuantos pilotos la han hecho.
        agregado?.total ? el('span', { clase: 'solo-escritorio-i', texto: ` · ${agregado.total} pilotos` }) : null,
      ]),
      el('h2', {}, [el('span', { texto: nombreDe(ruta, ORIGEN) }), el('br', { clase: 'solo-movil-inline' }), el('span', { texto: ` → ${nombreDe(ruta, DESTINO)}` })]),
    ]),
    el('div', { clase: 'segmento dos' }, [
      el('button', { attrs: { type: 'button', 'aria-pressed': String(modoVista === 'hoy') }, texto: 'Hoy', on: { click: () => pintarDetalleRuta(ruta, 'hoy') } }),
      el('button', { attrs: { type: 'button', 'aria-pressed': String(modoVista === 'siempre') }, texto: 'Siempre', on: { click: () => pintarDetalleRuta(ruta, 'siempre') } }),
    ]),
    record ? el('div', { clase: 'tarjetas-ruta' }, [
      // 8i: en escritorio, cada tarjeta dice ademas cuando o con que marca.
      el('div', { clase: 'tarjeta-record' }, [el('span', { texto: modoVista === 'hoy' ? 'Récord de hoy' : 'Récord' }), el('strong', { texto: mmss(record.marca) }), el('small', {}, [record.nombre, record.fecha ? el('span', { clase: 'solo-escritorio-i', texto: ` · ${fechaCorta(record.fecha)}` }) : null])]),
      mio ? el('div', { clase: 'tarjeta-tuya' }, [el('span', { texto: 'Tu mejor' }), el('strong', { texto: mmss(mio.yo.marca) }), el('small', {}, [`${ordinal(mio.yo.pos)} de ${mio.total}`, mio.yo.fecha ? el('span', { clase: 'solo-escritorio-i', texto: ` · ${diaRelativo(mio.yo.fecha)}` }) : null])]) : null,
      objetivo ? el('div', { clase: 'tarjeta-objetivo' }, [el('span', { texto: `Para el ${ordinal(objetivo.pos)}` }), el('strong', { texto: menosDe(mio.yo.marca - objetivo.marca) }), el('small', {}, [objetivo.nombre, el('span', { clase: 'solo-escritorio-i', texto: ` · ${mmss(objetivo.marca)}` })])]) : null,
    ]) : null,
    filas.length
      ? el('div', { clase: 'lista-ranking tabla-ruta' }, filas.map((f) => {
        const yo = f.nombre === perfil?.username;
        return el('button', {
          clase: `fila-ranking corta ${yo ? 'tuya' : ''}`, attrs: { type: 'button' },
          on: { click: () => abrirPiloto(f.nombre, { ruta, viajeId: f.viajeId, marca: f.marca }) },
        }, [
          el('span', { clase: 'pos', texto: String(f.pos) }),
          el('span', { clase: 'nombre', texto: yo ? 'Tú' : f.nombre }),
          el('span', { clase: 'fecha-ruta', texto: f.fecha ? fechaCorta(f.fecha) : '' }),
          el('span', { clase: 'dif', texto: f.pos > 1 && record ? masDe(f.marca - record.marca) : '' }),
          el('strong', { clase: 'valor', texto: mmss(f.marca) }),
        ]);
      }))
      : vacio(modoVista === 'hoy' ? 'Hoy aún no hay tiempos' : 'Esta ruta aún no tiene tiempos', 'El primero que la haga se lleva el récord.'),
    // 4d: fijo abajo, sobre la barra, con el fondo de la pagina alrededor.
    el('div', { clase: 'barra-subir-aqui' }, [
      el('a', { clase: 'btn grande subir-aqui', attrs: { href: '/subir/', 'data-subir': '' } }, [icono('mas', 'icono'), el('span', { texto: 'Subir un tiempo aquí' })]),
    ]),
    pieActualizado(agregado),
  ]);
}

function fechaCorta(f) {
  return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${f}T12:00:00Z`));
}

// --- Clanes (4e, 8j) -----------------------------------------------------------------

async function pintarClanes() {
  const destino = $('tabla-clanes');
  reemplazar(destino, esqueleto(7));
  const [agregado, mapa] = await Promise.all([traer('ranking-clanes'), traer('mapa')]);
  if (!agregado?.filas?.length) {
    reemplazar(destino, fallo ? errorRed(pintarClanes) : vacio('Todavía no hay clanes', 'Crea el primero desde Mapa.'));
    return;
  }
  const clanes = mapa?.clanes || {};
  const idPorNombre = Object.fromEntries(Object.entries(clanes).map(([cid, c]) => [c.nombre, cid]));
  const cuenta = {};
  for (const e of Object.values(mapa?.estaciones || {})) if (e.clan) cuenta[e.clan] = (cuenta[e.clan] || 0) + 1;
  const total = Object.keys(ESTACIONES).length;
  const controladas = Object.values(cuenta).reduce((t, n) => t + n, 0);
  const miClan = perfil?.clanId ? clanes[perfil.clanId]?.nombre : null;
  const iniciales = (n) => String(n).split(/\s+/).map((p) => p[0]).join('').slice(0, 3).toUpperCase();

  reemplazar(destino, [
    el('div', { clase: 'reparto-clanes' }, [
      el('span', { clase: 'rotulo', texto: `Estaciones controladas · ${controladas} de ${total}` }),
      el('div', { clase: 'barra-reparto', attrs: { role: 'img', 'aria-label': `${controladas} de ${total} estaciones controladas por algún clan` } }, [
        ...Object.entries(cuenta).sort((x, y) => y[1] - x[1]).map(([cid, n]) => el('span', { estilo: { flex: String(n), background: clanes[cid]?.color || 'var(--tinta-3)' } })),
        el('span', { clase: 'libre', estilo: { flex: String(Math.max(0, total - controladas)) } }),
      ]),
    ]),
    el('div', { clase: 'lista-ranking clanes' }, agregado.filas.map((f) => {
      const cid = idPorNombre[f.nombre];
      const color = clanes[cid]?.color || 'var(--tinta-3)';
      return el('a', {
        clase: `fila-clan ${f.nombre === miClan ? 'tuya' : ''}`,
        attrs: { href: cid ? `/territorio/?clan=${encodeURIComponent(cid)}` : '/territorio/' },
      }, [
        el('span', { clase: 'pos', texto: String(f.pos) }),
        el('span', { clase: 'escudo-clan', estilo: { background: color }, texto: iniciales(f.nombre) }),
        el('span', { clase: 'quien' }, [
          el('span', { clase: 'nombre', texto: f.nombre }),
          el('span', { clase: 'clan', texto: `${f.viajes ?? 0} miembros · ${f.marca ?? 0} estaciones` }),
        ]),
        el('span', { clase: 'col-modo', texto: `${f.marca ?? 0} est.` }),
        el('strong', { clase: 'valor', texto: numero(f.puntos) }),
      ]);
    })),
    pieActualizado(agregado),
  ]);
  $('fila-fija').classList.add('oculto');
}

// --- Otro piloto (4f, 8j) ------------------------------------------------------------

async function abrirPiloto(nombre, desde = null) {
  const [general, sprint, fondo, constancia, clanes, indice] = await Promise.all([
    traer('ranking-general'), traer('ranking-sprint'), traer('ranking-fondo'), traer('ranking-constancia'), clanesDelMapa(), traer('grupos'),
  ]);
  const de = (ag) => ag?.filas?.find((f) => f.nombre === nombre) || null;
  const g = de(general);
  const clan = clanes[g?.clan];
  const clave = indice?.porPiloto?.[nombre];
  const grupo = clave ? await traer(`grupo-${clave}`) : null;
  const enGrupo = grupo?.filas?.find((f) => f.nombre === nombre);
  const esYo = nombre === perfil?.username;

  // Cara a cara: las rutas en las que salis los dos (de las tuyas).
  const mias = [...new Set([...(perfil?.favoritas || []), ...Object.keys(perfil?.puntosPorRuta || {})])].slice(0, 10);
  const cara = [];
  let unViaje = desde?.viajeId || null;
  if (!esYo && perfil?.username) {
    for (const r of mias) {
      const ag = await traer(`ruta-${r}`);
      const yo = ag?.filas?.find((f) => f.nombre === perfil.username);
      const el2 = ag?.filas?.find((f) => f.nombre === nombre);
      if (el2 && !unViaje) unViaje = el2.viajeId;
      if (yo && el2) cara.push({ ruta: r, yo: yo.marca, otro: el2.marca });
    }
  }
  const ganoYo = cara.filter((c) => c.yo < c.otro).length;
  const ganaOtro = cara.filter((c) => c.otro < c.yo).length;

  const menu = unViaje && haySesion && !esYo ? el('button', {
    clase: 'boton-icono', attrs: { type: 'button', 'aria-label': 'Más opciones' },
    on: { click: () => menuDenuncia(nombre, desde, unViaje) },
  }, [icono('mas-h')]) : null;

  const volver = el('button', { clase: 'boton-icono solo-movil-inline', attrs: { type: 'button', 'aria-label': 'Volver' } }, [icono('atras')]);
  const cerrarX = el('button', { clase: 'boton-icono solo-escritorio-inline', attrs: { type: 'button', 'aria-label': 'Cerrar' } }, [icono('cerrar')]);
  const { cerrar } = abrirHoja([
    el('div', { clase: 'panel-cabeza' }, [
      volver,
      el('span', { clase: 'rotulo solo-escritorio-inline', texto: 'Piloto' }),
      el('span', { clase: 'acciones-panel' }, [menu, cerrarX]),
    ]),
    el('div', { clase: 'piloto-cabeza' }, [
      el('span', { clase: 'avatar-inicial', estilo: { background: clan?.color || 'var(--tinta)' }, texto: [...nombre][0]?.toUpperCase() || 'P' }),
      el('div', {}, [
        el('h2', { texto: nombre }),
        el('span', { clase: 'apagado', texto: [clan?.nombre || 'Sin clan', clave ? nombreGrupo(clave) : null, enGrupo ? ordinal(enGrupo.pos) : null].filter(Boolean).join(' · ') }),
      ]),
    ]),
    el('div', { clase: 'cifras-piloto' }, [
      ['Sprint', de(sprint) ? MODOS.sprint.formato(de(sprint).puntos) : '—'],
      ['Fondo', de(fondo) ? MODOS.fondo.formato(de(fondo).puntos) : '—'],
      ['Racha', de(constancia) ? MODOS.constancia.formato(de(constancia).puntos) : '—'],
    ].map(([t, v]) => el('div', {}, [el('span', { texto: t }), el('strong', { texto: v })]))),
    cara.length ? el('div', { clase: 'hoy-seccion' }, [el('h3', { texto: 'Cara a cara' }), el('span', { texto: `tú ${ganoYo} · ${nombre.split(/[._]/)[0]} ${ganaOtro}` })]) : null,
    cara.length ? el('div', { clase: 'cara-a-cara' }, [
      ...cara.map((c) => el('div', { clase: 'fila-cara' }, [
        el('span', { texto: `${corto(nombreDe(c.ruta, ORIGEN))} → ${corto(nombreDe(c.ruta, DESTINO))}` }),
        el('span', { clase: c.yo < c.otro ? 'gana tuya' : '', texto: mmss(c.yo) }),
        el('span', { clase: c.otro < c.yo ? 'gana' : '', texto: mmss(c.otro) }),
      ])),
      el('div', { clase: 'fila-cara pie' }, [el('span'), el('span', { texto: 'tú' }), el('span', { texto: nombre.split(/[._]/)[0] })]),
    ]) : null,
    !esYo && !cara.length && perfil?.username ? el('p', { clase: 'menor apagado', texto: 'Todavía no coincidís en ninguna de tus rutas.' }) : null,
    unViaje && haySesion && !esYo ? el('button', { clase: 'btn plano denunciar', texto: 'Denunciar nombre de piloto', attrs: { type: 'button' }, on: { click: () => denunciarNombre(nombre, unViaje) } }) : null,
  ], { etiqueta: `Piloto ${nombre}`, clase: 'panel-lateral' });
  volver.addEventListener('click', cerrar);
  cerrarX.addEventListener('click', cerrar);
}

function menuDenuncia(nombre, desde, unViaje) {
  const { cerrar } = abrirHoja([
    el('h2', { texto: nombre }),
    desde?.viajeId ? el('button', { clase: 'btn secundario', texto: `Denunciar su tiempo en ${tramo(desde.ruta)}`, attrs: { type: 'button' }, on: { click: () => { cerrar(); denunciarTiempo(nombre, desde.viajeId); } } }) : null,
    el('button', { clase: 'btn secundario', texto: 'Denunciar nombre de piloto', attrs: { type: 'button' }, on: { click: () => { cerrar(); denunciarNombre(nombre, unViaje); } } }),
  ], { etiqueta: 'Opciones', clase: 'dialogo-escritorio' });
}

/**
 * Se denuncia UN VIAJE (#61): lo unico que sale de aqui es su id. De quien es
 * lo resuelve el worker, que es quien puede leerlo.
 */
async function denunciarTiempo(nombre, viajeId) {
  const motivo = await pedirTexto(`¿Qué le ves de raro al tiempo de ${nombre}?`, {
    textoAceptar: 'Denunciar', etiqueta: 'Lo lee una persona. Cuenta qué te ha hecho sospechar.', minimo: 10,
  });
  if (!motivo) return;
  try {
    await reportarViaje(viajeId, motivo);
    avisar('Gracias. Lo mirará una persona.', 'exito');
  } catch (error) {
    avisar(error.message || 'No se ha podido enviar la denuncia.');
  }
}

/** El nombre, por el mismo circuito: la cola de denuncias lleva al piloto. */
async function denunciarNombre(nombre, viajeId) {
  const motivo = await pedirTexto(`¿Qué tiene de malo el nombre «${nombre}»?`, {
    textoAceptar: 'Denunciar', etiqueta: 'Lo revisa una persona.', minimo: 0,
  });
  if (motivo === null) return;
  try {
    await reportarViaje(viajeId, `Nombre de piloto: ${nombre}. ${motivo || 'Nombre ofensivo.'}`.slice(0, 300));
    avisar('Gracias. Lo revisará una persona.', 'exito');
  } catch (error) {
    avisar(error.message || 'No se ha podido enviar la denuncia.');
  }
}

// --- Pestañas y carga --------------------------------------------------------------

function mostrar(pestana, { recordar = true } = {}) {
  const activa = PESTANAS.includes(pestana) ? pestana : 'pilotos';
  for (const p of PESTANAS) {
    $(`tab-${p}`).setAttribute('aria-selected', String(p === activa));
    $(`tab-${p}`).setAttribute('aria-pressed', String(p === activa));
    $(`panel-${p}`).classList.toggle('oculto', p !== activa);
  }
  if (recordar) cambiarParametro('tab', activa === 'pilotos' ? null : activa);
  // "Septiembre · acaba mañana" solo va en Pilotos (4a, 4b); Rutas y Clanes
  // (4c, 4e) llevan el titulo solo.
  document.querySelector('.ranking')?.setAttribute('data-pestana', activa);
  $('fila-fija').classList.add('oculto');
  observador?.disconnect();
  if (activa === 'pilotos') pintarPilotos();
  if (activa === 'rutas') {
    pintarListaRutas();
    const ruta = parametros().get('ruta');
    if (ruta) abrirRuta(ruta);
  }
  if (activa === 'clanes') pintarClanes();
}

for (const p of PESTANAS) $(`tab-${p}`).addEventListener('click', () => mostrar(p));

onAuthStateChanged(auth, async (u) => {
  haySesion = Boolean(u);
  $('cabeza-invitado').classList.toggle('oculto', haySesion);
  document.body.classList.toggle('sin-sesion', !haySesion);
  if (u) {
    try {
      const snap = await getDoc(doc(db, 'usuarios', u.uid));
      perfil = snap.exists() ? snap.data() : null;
    } catch {
      perfil = null; // sin perfil se ve igual, sin "tu fila"
    }
  }
  $('fin-temporada').textContent = cuandoAcaba();
  const params = parametros();
  const tab = params.get('tab') || (params.get('ruta') ? 'rutas' : 'pilotos');
  mostrar(tab, { recordar: false });
});

// Sin sesion no hay a quien enseñar su fila: si el aviso de error estaba, se va.
estado($('msg-pilotos'), '');
