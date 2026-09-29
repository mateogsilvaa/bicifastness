/**
 * Las pantallas de Tu (/yo/), pintadas a partir de datos.
 *
 * Aqui no se lee ni se escribe nada: todo lo que se pinta llega por argumento,
 * y las acciones (impugnar, anclar, cambiar un aviso) llegan como funciones.
 * Asi la pagina (`paginas/yo.js`) decide QUE cuesta una lectura y cuando, y
 * esto solo decide COMO se ve. Y se puede probar sin Firebase.
 *
 * Diseño: 06 Perfil del rediseño 2026.
 */

import { el, icono, reemplazar } from './dom.js';
import { nombreRuta, formatearTiempo } from './ui.js';
import { INSIGNIAS, TEMPORADA } from '../data/insignias.js';
import { motivoDeViaje } from './motivos.js';
import { diaMadrid, diaMadridHace } from './dia.js';

// --- Formato -----------------------------------------------------------------

/**
 * Punto de millar siempre: "1.086". `toLocaleString('es-ES')` NO agrupa los
 * numeros de cuatro cifras (la norma española solo lo hace a partir de cinco),
 * y el diseño los quiere agrupados en todas partes.
 */
export function numero(n) {
  const entero = Math.round(Number(n) || 0);
  return String(entero).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** "184.º" */
export const ordinal = (n) => `${numero(n)}.º`;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DIAS_CORTOS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

const mayuscula = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

/** '2026-08' -> 'Agosto 2026'. Lo que no tenga esa forma se devuelve tal cual. */
export function nombreMes(clave) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(clave || ''));
  return m ? `${mayuscula(MESES[Number(m[2]) - 1])} ${m[1]}` : String(clave || '');
}

/**
 * El dia de un viaje, relativo: "Hoy", "Ayer", "Dom 27 sep".
 * Con el dia de Madrid, que es con el que cuenta el juego (`dia.js`).
 */
export function diaRelativo(fechaViaje, ahora = new Date()) {
  const dia = String(fechaViaje || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return '';
  if (dia === diaMadrid(ahora)) return 'Hoy';
  if (dia === diaMadridHace(1, ahora)) return 'Ayer';

  const [a, m, d] = dia.split('-').map(Number);
  const semana = DIAS_CORTOS[new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
  const año = a === Number(diaMadrid(ahora).slice(0, 4)) ? '' : ` ${a}`;
  return `${mayuscula(semana)} ${d} ${MESES_CORTOS[m - 1]}${año}`;
}

const DIVISIONES = {
  hierro: 'Hierro', bronce: 'Bronce', plata: 'Plata', oro: 'Oro', platino: 'Platino', leyenda: 'Leyenda',
};
export const nombreDivision = (d) => DIVISIONES[d] || null;

/** Un color de clan solo entra si es un hex de verdad: llega de la base de datos. */
const colorSeguro = (c) => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : null);

// --- Resumen (6a) ------------------------------------------------------------

/**
 * Lo fuerte que es cada modo, de 0 a 1, por el puesto en su clasificacion.
 *
 * Los tres modos se miden en cosas distintas (puntos, kilometros, dias), asi
 * que sumarlos o compararlos en crudo no dice nada. Lo que si se puede
 * comparar es DONDE estas en cada uno: el 10.º de 500 en Constancia es mas
 * fuerte ahi que el 300.º de 500 en Sprint. Sin puesto (no sale en el
 * agregado), cero.
 */
export function fuerzaModo(puesto) {
  if (!puesto?.pos || !puesto?.total) return 0;
  return Math.max(0, 1 - (puesto.pos - 1) / puesto.total);
}

export const MODOS = [
  { clave: 'sprint', nombre: 'Sprint' },
  { clave: 'fondo', nombre: 'Fondo' },
  { clave: 'constancia', nombre: 'Constancia' },
];

/** Los valores propios de cada modo, sacados del perfil (cero lecturas). */
export function valoresModos(perfil) {
  const sprint = Object.values(perfil.puntosPorRuta || {}).reduce((t, p) => t + (Number(p) || 0), 0);
  const km = (perfil.metrosTotales || 0) / 1000;
  const racha = perfil.mejorRacha || 0;
  return {
    sprint: `${numero(sprint)}`,
    fondo: `${km >= 10 ? numero(km) : km.toFixed(1).replace('.', ',')} km`,
    constancia: `${numero(racha)} ${racha === 1 ? 'día' : 'días'}`,
  };
}

/**
 * La tarjeta del BiciRating partida en sus tres modos, con "tu fuerte".
 *
 * @param {object} perfil
 * @param {object} puestos  { general, sprint, fondo, constancia }, cada uno
 *   { pos, total } o null si no sale en la clasificacion
 */
export function pintarRating(perfil, puestos = {}) {
  document.getElementById('rating').textContent = numero(perfil.biciRating || 0);

  const general = puestos.general;
  document.getElementById('puesto-global').textContent = general?.pos
    ? `${ordinal(general.pos)} de ${numero(general.total)}`
    : '';

  const fuerzas = Object.fromEntries(MODOS.map((m) => [m.clave, fuerzaModo(puestos[m.clave])]));
  const alguna = Object.values(fuerzas).some((f) => f > 0);
  const fuerte = alguna
    ? MODOS.reduce((a, b) => (fuerzas[b.clave] > fuerzas[a.clave] ? b : a)).clave
    : null;

  // Sin puesto en ninguno (quien acaba de empezar), tres tercios iguales: una
  // barra vacia parece un fallo, y tres iguales dice "todavia nada destaca".
  reemplazar(document.getElementById('barra-modos'), MODOS.map((m) => el('span', {
    clase: m.clave,
    estilo: { flex: String(alguna ? Math.max(fuerzas[m.clave], 0.04) * 100 : 1) },
  })));

  const valores = valoresModos(perfil);
  reemplazar(document.getElementById('leyenda-modos'), MODOS.map((m) => el('span', {}, [
    el('span', { clase: `nombre-modo ${m.clave}`, texto: m.nombre }),
    el('strong', { texto: valores[m.clave] }),
    m.clave === fuerte ? el('span', { clase: 'fuerte', texto: 'tu fuerte' }) : null,
  ])));
}

/** Cabecera: inicial sobre el color del clan, nombre, clan y etiquetas. */
export function pintarCabecera(perfil, clan) {
  const nombre = perfil.username || 'Piloto';
  document.getElementById('nombre').textContent = nombre;

  const avatar = document.getElementById('avatar');
  avatar.textContent = [...nombre.trim()][0]?.toUpperCase() || 'P';
  const color = colorSeguro(clan?.color);
  if (color) avatar.style.background = color;

  const creado = perfil.creado?.toDate?.();
  const desde = creado
    ? `desde ${MESES[creado.getMonth()]}${creado.getFullYear() === new Date().getFullYear() ? '' : ` de ${creado.getFullYear()}`}`
    : '';
  document.getElementById('clan').textContent = [clan?.nombre || 'Sin clan', desde].filter(Boolean).join(' · ');

  const division = nombreDivision(perfil.division);
  const escudos = perfil.escudos || 0;
  reemplazar(document.getElementById('etiquetas'), [
    division ? el('span', { clase: 'etiqueta-juego', texto: division }) : null,
    // Los escudos, a la vista: son lo que protege la racha.
    el('span', {
      clase: 'etiqueta-juego',
      attrs: { title: `${escudos} ${escudos === 1 ? 'escudo' : 'escudos'} de racha` },
    }, [icono('escudo'), el('span', { texto: String(escudos) }),
      el('span', { clase: 'solo-lectores', texto: escudos === 1 ? ' escudo' : ' escudos' })]),
  ]);
}

/** Las tres cifras sueltas. `total` es null mientras no llegue el conteo. */
export function pintarCifras(perfil, total) {
  const ok = perfil.viajesVerificados || 0;
  document.getElementById('total-viajes').textContent = total === null ? numero(ok) : numero(total);
  document.getElementById('verificados').textContent = total === null
    ? 'verificados'
    : `trayectos · ${numero(ok)} ok`;
  const km = (perfil.metrosTotales || 0) / 1000;
  document.getElementById('km-total').textContent = `${km >= 10 ? numero(km) : km.toFixed(1).replace('.', ',')} km`;
  const racha = perfil.mejorRacha || 0;
  document.getElementById('mejor-racha').textContent = `${numero(racha)} ${racha === 1 ? 'día' : 'días'}`;
}

/** Cuantas insignias del catalogo tiene. Las de temporada van aparte. */
export function insigniasConseguidas(perfil) {
  const tiene = new Set(perfil.logros || []);
  return Object.keys(INSIGNIAS).filter((k) => tiene.has(k)).length;
}

/**
 * Las entradas a las subpantallas.
 * @param {object} detalles  { enRevision }: lo que cuesta una lectura llega aparte
 */
export function pintarMenu(perfil, { enRevision = 0 } = {}) {
  const entradas = [
    { href: '#insignias', icono: 'medalla', texto: 'Insignias',
      detalle: `${insigniasConseguidas(perfil)} de ${Object.keys(INSIGNIAS).length}` },
    { href: '#historial', icono: 'reloj', texto: 'Historial',
      detalle: enRevision ? `${enRevision} en revisión` : '', atencion: enRevision > 0 },
    { href: '#temporadas', icono: 'clasificacion', texto: 'Temporadas',
      detalle: `${numero(perfil.puntosTemporada || 0)} pts este mes` },
    { href: '#rutas', icono: 'pin', texto: 'Rutas ancladas',
      detalle: `${(perfil.favoritas || []).length} de 3` },
  ];

  reemplazar(document.getElementById('menu'), entradas.map((e) => el('a', { attrs: { href: e.href } }, [
    icono(e.icono),
    el('span', { texto: e.texto }),
    el('span', { clase: `detalle${e.atencion ? ' atencion' : ''}`, texto: e.detalle }),
    icono('derecha', 'icono flecha'),
  ])));
}

// --- Insignias (6b) ------------------------------------------------------------

/** Los campos que no estan en el perfil y se sacan de el (igual que `logros.js`). */
function derivados(perfil) {
  const porRuta = perfil.puntosPorRuta || {};
  const estaciones = new Set();
  for (const ruta of Object.keys(porRuta)) {
    const [o, d] = String(ruta).split('-');
    if (o) estaciones.add(o);
    if (d) estaciones.add(d);
  }
  return { ...perfil, tramosConPuntos: Object.keys(porRuta).length, estacionesVisitadas: estaciones.size };
}

/** "214 de 250 km", "81 de 100". */
function progresoTexto(campo, valor, minimo) {
  if (campo === 'metrosTotales') return `${numero(valor / 1000)} de ${numero(minimo / 1000)} km`;
  return `${numero(valor)} de ${numero(minimo)}`;
}

/** Las de temporada ganadas, de la mas reciente a la mas antigua. */
export function insigniasDeTemporada(logros = []) {
  return logros
    .map((clave) => {
      const partes = String(clave).split('-');
      if (partes[0] !== 'temporada' || partes.length < 3) return null;
      const sufijo = partes[partes.length - 1];
      const plantilla = TEMPORADA[sufijo];
      if (!plantilla) return null;
      return { clave, temporada: partes.slice(1, -1).join('-'), ...plantilla };
    })
    .filter(Boolean)
    .sort((a, b) => b.temporada.localeCompare(a.temporada));
}

export function pintarInsignias(perfil) {
  const tiene = new Set(perfil.logros || []);
  const datos = derivados(perfil);
  const total = Object.keys(INSIGNIAS).length;

  document.getElementById('titulo-insignias').textContent =
    `Insignias · ${insigniasConseguidas(perfil)} de ${total}`;

  const [ultima] = insigniasDeTemporada(perfil.logros);
  reemplazar(document.getElementById('insignia-destacada'), ultima
    ? el('div', { clase: 'destacada' }, [
      el('span', { clase: 'disco' }, [icono('medalla')]),
      el('span', { clase: 'texto' }, [
        el('strong', { texto: `${ultima.titulo} · ${nombreMes(ultima.temporada).split(' ')[0].toLowerCase()}` }),
        el('span', { clase: 'sub', texto: ultima.descripcion }),
      ]),
    ])
    : null);

  // Todas, conseguidas o no: cada pendiente, con su progreso real, es una meta.
  reemplazar(document.getElementById('insignias'), Object.entries(INSIGNIAS).map(([clave, ins]) => {
    const conseguida = tiene.has(clave);
    const regla = ins.regla;
    const valor = regla ? Number(datos[regla.campo]) || 0 : 0;
    const pct = conseguida ? 100 : regla ? Math.min(100, (valor / regla.minimo) * 100) : 0;

    return el('div', {
      clase: `insignia ${conseguida ? 'conseguida' : 'pendiente'}`,
      titulo: ins.descripcion,
    }, [
      el('span', { clase: 'disco' }, [icono(ins.icono)]),
      el('span', { clase: 'titulo', texto: ins.titulo }),
      el('span', {
        clase: 'progreso',
        attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
          'aria-valuenow': String(Math.round(pct)), 'aria-label': ins.titulo },
      }, [el('span', { estilo: { width: `${pct}%` } })]),
      el('span', {
        clase: 'estado-insignia',
        texto: conseguida ? 'conseguida' : regla ? progresoTexto(regla.campo, valor, regla.minimo) : ins.descripcion,
      }),
    ]);
  }));
}

// --- Historial (6c) ------------------------------------------------------------

export const ESTADOS = {
  aprobado: { clase: 'verificado', texto: 'Verificado' },
  pendiente: { clase: 'pendiente', texto: 'En cola' },
  revision: { clase: 'revision', texto: 'Lo mira una persona' },
  rechazado: { clase: 'rechazado', texto: 'No cuenta' },
};

export const FILTROS = [
  { clave: 'todos', texto: 'Todos', vale: () => true },
  { clave: 'verificados', texto: 'Verificados', vale: (v) => v.estado === 'aprobado' },
  { clave: 'pendientes', texto: 'Pendientes', vale: (v) => v.estado === 'pendiente' || v.estado === 'revision' },
  { clave: 'no', texto: 'No cuentan', vale: (v) => v.estado === 'rechazado' },
];

/** Se puede pedir que una persona revise un rechazo automatico (art. 22.3 RGPD). */
export const impugnable = (v) => v.estado === 'rechazado' && v.revisadoPor === 'automatico' && !v.impugnado;

function textoExtra(v) {
  if (v.estado === 'aprobado') return v.puntos ? `+${numero(v.puntos)}` : '';
  if (impugnable(v)) return 'Pide revisión →';
  if (v.impugnado) return 'Revisión pedida';
  return '';
}

/**
 * La lista del historial, agrupada por el dia del VIAJE (no el de subida).
 *
 * @param {Array<{id, datos}>} viajes  lo cargado hasta ahora, en orden
 * @param {string} filtro
 * @param {{ alImpugnar: Function }} acciones
 */
export function nodosHistorial(viajes, filtro, { alImpugnar }) {
  const vale = (FILTROS.find((f) => f.clave === filtro) || FILTROS[0]).vale;
  const visibles = viajes.filter((v) => vale(v.datos));

  if (!visibles.length) {
    return [el('div', { clase: 'vacio' }, [
      el('h3', { texto: viajes.length ? 'Nada con este filtro' : 'Aún no has subido ningún trayecto' }),
      viajes.length
        ? el('p', { texto: 'Prueba con otro, o carga más trayectos abajo.' })
        : el('p', {}, [el('a', { texto: 'Subir mi primer trayecto', attrs: { href: '/subir/' } })]),
    ])];
  }

  const nodos = [];
  let diaAnterior = null;

  for (const { id, datos: v } of visibles) {
    const dia = diaRelativo(v.fechaViaje);
    if (dia !== diaAnterior) {
      nodos.push(el('p', { clase: 'dia-historial', texto: dia }));
      diaAnterior = dia;
    }

    // Verificado pero pasado el cupo del dia (08 · 8n): cuenta en km, no en puntos.
    const estado = v.estado === 'aprobado' && v.fueraDeCupo
      ? { clase: 'pendiente', texto: 'Sin puntos · pasado el cupo' }
      : ESTADOS[v.estado] || ESTADOS.pendiente;
    const detalle = el('div', { clase: 'detalle-viaje oculto' }, nodosDetalle(id, v, alImpugnar));
    const fila = el('button', {
      clase: 'fila-viaje',
      attrs: { type: 'button', 'aria-expanded': 'false' },
    }, [
      el('span', { clase: 'ruta-viaje', texto: nombreRuta(v.ruta) }),
      el('span', { clase: 'tiempo', texto: formatearTiempo(v.tiempoSegundos) }),
      el('span', { clase: `estado-viaje ${estado.clase}`, texto: estado.texto }),
      el('span', { clase: 'extra', texto: textoExtra(v) }),
    ]);

    fila.addEventListener('click', () => {
      const abierto = fila.getAttribute('aria-expanded') === 'true';
      fila.setAttribute('aria-expanded', String(!abierto));
      detalle.classList.toggle('oculto', abierto);
    });

    nodos.push(el('div', {}, [fila, detalle]));
  }

  return nodos;
}

/** Lo que se ve al abrir una fila: el motivo si no cuenta, y que se puede hacer. */
function nodosDetalle(id, v, alImpugnar) {
  const nodos = [];

  if (v.estado === 'rechazado') {
    // El texto sale de `motivos.js`: el resumen de la auditoria esta escrito
    // para quien revisa y lleva dentro los numeros del antifraude.
    const motivo = motivoDeViaje(v);
    nodos.push(el('div', { clase: 'aviso error' }, [
      el('p', { clase: 'etiqueta', texto: motivo.dePersona ? 'Lo que dice quien lo ha revisado' : 'Por qué no cuenta' }),
      el('p', { texto: motivo.texto }),
      motivo.queHacer ? el('p', { texto: motivo.queHacer }) : null,
    ]));
  }

  if (impugnable(v)) {
    const boton = el('button', { clase: 'btn plano', texto: 'Pedir revisión humana', attrs: { type: 'button' } });
    boton.addEventListener('click', () => alImpugnar(id, boton));
    nodos.push(boton);
  } else if (v.impugnado) {
    nodos.push(el('p', { clase: 'menor apagado', estilo: { margin: '0' },
      texto: 'Has pedido revisión humana. La va a mirar una persona.' }));
  }

  if (v.estado === 'aprobado' && v.distanciaMetros) {
    const km = (v.distanciaMetros / 1000).toFixed(1).replace('.', ',');
    nodos.push(el('p', { clase: 'menor apagado', estilo: { margin: '0' },
      texto: `${km} km${v.velocidadKmh ? ` · ${String(v.velocidadKmh.toFixed(1)).replace('.', ',')} km/h` : ''}` }));
  }
  if (v.estado === 'pendiente') {
    nodos.push(el('p', { clase: 'menor apagado', estilo: { margin: '0' },
      texto: 'En cola: el análisis automático tarda de 5 a 15 minutos.' }));
  }
  if (v.estado === 'revision' && !v.impugnado) {
    nodos.push(el('p', { clase: 'menor apagado', estilo: { margin: '0' },
      texto: 'Una persona lo va a revisar. No hace falta que hagas nada.' }));
  }

  return nodos;
}

// --- Temporadas (6d) -----------------------------------------------------------

/** Dias que le quedan al mes de Madrid, contando hoy. */
export function diasQueQuedan(ahora = new Date()) {
  const [a, m, d] = diaMadrid(ahora).split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return ultimo - d;
}

/**
 * @param {object} perfil
 * @param {Array<{temporada, nombre, puntos, posicion, division}>} cerradas
 *   ya ordenadas y con nombre (lo decide la pagina)
 */
export function pintarTemporadas(perfil, cerradas) {
  const actual = perfil.puntosTemporada || 0;
  const mejor = Math.max(actual, ...cerradas.map((t) => t.puntos || 0), 1);
  const quedan = diasQueQuedan();
  const division = nombreDivision(perfil.division);

  reemplazar(document.getElementById('temporada-actual'), el('div', { clase: 'temporada-actual' }, [
    el('div', { clase: 'cabeza' }, [
      el('strong', { texto: nombreMes(diaMadrid().slice(0, 7)) }),
      el('span', { texto: quedan === 0 ? 'acaba esta noche' : quedan === 1 ? 'acaba mañana' : `quedan ${quedan} días` }),
    ]),
    el('div', { clase: 'cifra-grande' }, [
      el('strong', { texto: numero(actual) }),
      el('span', { texto: ['pts', division].filter(Boolean).join(' · ') }),
    ]),
    el('div', { clase: 'pista', attrs: { 'aria-hidden': 'true' } }, [
      el('span', { estilo: { width: `${Math.round((actual / mejor) * 100)}%` } }),
    ]),
  ]));

  const premios = insigniasDeTemporada(perfil.logros);

  reemplazar(document.getElementById('temporadas'), cerradas.length
    ? cerradas.map((t) => {
      const suyos = premios.filter((p) => p.temporada === t.temporada).map((p) => p.titulo);
      const sub = [t.posicion ? ordinal(t.posicion) : null, nombreDivision(t.division)].filter(Boolean).join(' · ');
      return el('div', { clase: 'temporada-fila' }, [
        el('span', { clase: 'mes', texto: t.nombre }),
        el('span', { clase: 'puntos', texto: numero(t.puntos || 0) }),
        el('span', { clase: 'progreso gruesa', attrs: { 'aria-hidden': 'true' } }, [
          el('span', { estilo: { width: `${Math.round(((t.puntos || 0) / mejor) * 100)}%` } }),
        ]),
        el('span', { clase: 'sub', texto: sub || 'sin puntos' }),
        el('span', { clase: 'premio', texto: suyos.join(' · ') }),
      ]);
    })
    : [el('div', { clase: 'vacio' }, [
      el('h3', { texto: 'Esta es tu primera temporada' }),
      el('p', { texto: 'Cada mes se cierra la clasificación y aquí se queda lo que hiciste.' }),
    ])]);
}
