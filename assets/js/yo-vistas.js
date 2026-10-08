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
import { fotoPropiaLocal, ponerFoto } from './foto-local.js';
import { leerFoto } from './foto-perfil.js';
import { nombreRuta, formatearTiempo } from './ui.js';
import { INSIGNIAS, TEMPORADA } from '../data/insignias.js';
import { NIVELES, NOMBRES as LIGAS, emblemaLiga, chipDivision, numeroDeGrupo, LANZAMIENTO } from './ligas.js';
import { diaMadrid, diaMadridHace } from './dia.js';
import { impugnable } from './motivos.js';

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

export const nombreDivision = (d) => LIGAS[d] || null;

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
  // 8m: en escritorio, "184.º de 1.207 en Madrid".
  reemplazar(document.getElementById('puesto-global'), general?.pos
    ? [`${ordinal(general.pos)} de ${numero(general.total)}`, el('span', { clase: 'solo-escritorio-i', texto: ' en Madrid' })]
    : []);

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
    // 6a: "527 · tu fuerte", en la cifra; 8m: "Constancia · tu fuerte", en el nombre.
    el('span', { clase: `nombre-modo ${m.clave}` }, [m.nombre, m.clave === fuerte ? el('span', { clase: 'solo-escritorio-i', texto: ' · tu fuerte' }) : null]),
    el('strong', {}, [valores[m.clave], m.clave === fuerte ? el('span', { clase: 'solo-movil-i', texto: ' · tu fuerte' }) : null]),
  ])));
}

/** Cabecera: inicial sobre el color del clan, nombre, clan y etiquetas. */
export function pintarCabecera(perfil, clan, grupo = null) {
  const nombre = perfil.username || 'Piloto';
  document.getElementById('nombre').textContent = nombre;

  const avatar = document.getElementById('avatar');
  avatar.textContent = [...nombre.trim()][0]?.toUpperCase() || 'P';
  const color = colorSeguro(clan?.color);
  if (color) avatar.style.background = color;
  // La copia local primero (sin red) y luego la de verdad: una lectura por
  // visita, que `leerFoto` no repite aunque la cabecera se pinte tres veces.
  ponerFoto(avatar, fotoPropiaLocal());
  leerFoto(nombre, { propia: true }).then((img) => ponerFoto(avatar, img));

  const creado = perfil.creado?.toDate?.();
  const desde = creado
    ? `desde ${MESES[creado.getMonth()]}${creado.getFullYear() === new Date().getFullYear() ? '' : ` de ${creado.getFullYear()}`}`
    : '';
  // Sin division guardada es que aun no ha cerrado ninguna liga: sin clasificar.
  const division = nombreDivision(perfil.division) || nombreDivision('sin-clasificar');
  const liga = numeroDeGrupo(grupo) ? `${division} · grupo ${numeroDeGrupo(grupo)}` : division;
  // 8m: en escritorio la liga va en esta linea, sin etiquetas debajo.
  reemplazar(document.getElementById('clan'), [
    clan?.nombre || 'Sin clan',
    liga ? el('span', { clase: 'solo-escritorio-i', texto: ` · ${liga}` }) : null,
    desde ? ` · ${desde}` : null,
  ]);

  const escudos = perfil.escudos || 0;
  reemplazar(document.getElementById('etiquetas'), [
    // 6a: "Plata · grupo 4" en cuanto se sabe el grupo de la liga.
    // 12 · Chip junto al nombre, con la insignia de su division.
    chipDivision(LIGAS[perfil.division] ? perfil.division : 'sin-clasificar', liga),
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
  document.getElementById('estaciones-distintas').textContent = numero(derivados(perfil).estacionesVisitadas);
}

/** Cuantas insignias del catalogo tiene. Las de temporada van aparte. */
export function insigniasConseguidas(perfil) {
  const tiene = new Set(perfil.logros || []);
  const datos = derivados(perfil);
  return Object.entries(INSIGNIAS).filter(([k, ins]) => tiene.has(k) || alcanzada(ins, datos)).length;
}

/** La meta de una insignia con regla, ya cumplida en los datos del perfil. */
function alcanzada(ins, datos) {
  return Boolean(ins.regla) && (Number(datos[ins.regla.campo]) || 0) >= ins.regla.minimo;
}

/** Si quien mira es administrador (sale de su token, no del perfil). */
let esAdministrador = false;
export function marcarAdministrador(valor) { esAdministrador = Boolean(valor); }

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
    // Solo para administradores, y solo es un enlace: la puerta de verdad
    // esta en cada pagina de /admin/ y en las reglas de Firestore.
    ...(esAdministrador ? [{ href: '/admin/panel/', icono: 'ajustes', texto: 'Administración', detalle: 'Panel' }] : []),
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
  return {
    ...perfil,
    tramosConPuntos: Object.keys(porRuta).length,
    estacionesVisitadas: estaciones.size,
    // Igual que `logros.js`: la mejor division alcanzada (cobre 1 ... diamante 7).
    nivelLiga: Math.max(0, NIVELES.indexOf(perfil.division) + 1,
      Number.isInteger(perfil.divisionMaxima) ? perfil.divisionMaxima + 1 : 0),
  };
}

/** "214 de 250 km", "81 de 100". */
function progresoTexto(campo, valor, minimo) {
  // 6b: "214 de 250"; la unidad ya va en el nombre ("250 km").
  if (campo === 'metrosTotales') return `${numero(Math.floor(valor / 1000))} de ${numero(minimo / 1000)}`;
  if (campo === 'segundosTotales') return `${numero(Math.floor(valor / 3600))} de ${numero(minimo / 3600)} h`;
  // La liga no es un contador: se dice donde estas.
  if (campo === 'nivelLiga') return valor ? `tu mejor: ${LIGAS[NIVELES[valor - 1]]}` : 'sin clasificar';
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

  // 6b: "Insignias · 7 de 16"; 8m: "Insignias" y la cuenta a la derecha.
  const cuenta = `${insigniasConseguidas(perfil)} de ${total}`;
  reemplazar(document.getElementById('titulo-insignias'), ['Insignias', el('span', { clase: 'solo-movil-i', texto: ` · ${cuenta}` })]);
  document.getElementById('cuenta-insignias').textContent = cuenta;
  document.getElementById('ver-insignias').textContent = `Ver las ${total} insignias`;

  const [ultima] = insigniasDeTemporada(perfil.logros);
  reemplazar(document.getElementById('insignia-destacada'), ultima
    ? el('div', { clase: 'destacada' }, [
      el('span', { clase: 'disco' }, [icono('medalla')]),
      el('span', { clase: 'texto' }, [
        el('strong', { texto: `${ultima.titulo} · ${nombreMes(ultima.temporada).split(' ')[0].toLowerCase()}` }),
        el('span', { clase: 'sub' }, [
          el('span', { clase: 'solo-movil-i', texto: ultima.descripcion }),
          el('span', { clase: 'solo-escritorio-i', texto: 'De temporada' }),
        ]),
      ]),
    ])
    : null);

  // Todas, conseguidas o no: cada pendiente, con su progreso real, es una meta.
  reemplazar(document.getElementById('insignias'), Object.entries(INSIGNIAS).map(([clave, ins]) => {
    const regla = ins.regla;
    const valor = regla ? Number(datos[regla.campo]) || 0 : 0;
    // Alcanzada la meta, conseguida: el logro lo apunta el servidor en el
    // siguiente recalculo, y "41 de 1" no es un progreso.
    const conseguida = tiene.has(clave) || alcanzada(ins, datos);
    const pct = conseguida ? 100 : regla ? Math.min(100, (valor / regla.minimo) * 100) : 0;

    return el('div', {
      clase: `insignia ${conseguida ? 'conseguida' : 'bloqueada'}`,
      titulo: ins.descripcion,
    }, [
      // Las de liga llevan el emblema de su liga, el mismo que el ranking.
      el('span', { clase: `disco${ins.modo === 'liga' ? ' con-emblema' : ''}` }, [
        ins.modo === 'liga' ? emblemaLiga(NIVELES[(regla?.minimo || 1) - 1], { tamano: 30, apagado: !conseguida }) : icono(ins.icono),
      ]),
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
export { impugnable };

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
 * @param {{ alAbrir: Function }} acciones  alAbrir(viaje con id, fila)
 */
export function nodosHistorial(viajes, filtro, { alAbrir }) {
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

  // Primera tanda: lo de antes del lanzamiento sigue aqui, pero aparte y
  // dicho claro: no cuenta para nada (backend/src/lanzamiento.js).
  const hoy = diaMadrid();
  const esBeta = (v) => v.fase === 'beta' || (hoy >= LANZAMIENTO && String(v.fechaViaje || '') < LANZAMIENTO);
  const actuales = visibles.filter((x) => !esBeta(x.datos));
  const beta = visibles.filter((x) => esBeta(x.datos));

  const filas = (lista, { primeraTanda = false } = {}) => {
    const nodos = [];
    let diaAnterior = null;
    for (const { id, datos: v } of lista) {
      const dia = diaRelativo(v.fechaViaje);
      if (dia !== diaAnterior) {
        nodos.push(el('p', { clase: 'dia-historial', texto: dia }));
        diaAnterior = dia;
      }

      // Verificado pero pasado el cupo del dia (08 · 8n): cuenta en km, no en puntos.
      const estado = primeraTanda
        ? { clase: 'pendiente', texto: 'Primera tanda · no cuenta' }
        : v.estado === 'aprobado' && v.fueraDeCupo
          ? { clase: 'pendiente', texto: 'Sin puntos · pasado el cupo' }
          : ESTADOS[v.estado] || ESTADOS.pendiente;
      const fila = el('button', {
        clase: `fila-viaje${primeraTanda ? ' de-tanda' : ''}`,
        attrs: { type: 'button', 'data-viaje': id },
      }, [
        el('span', { clase: 'ruta-viaje', texto: nombreRuta(v.ruta) }),
        el('span', { clase: 'tiempo', texto: formatearTiempo(v.tiempoSegundos) }),
        el('span', { clase: `estado-viaje ${estado.clase}`, texto: estado.texto }),
        el('span', { clase: 'extra', texto: textoExtra(v) }),
      ]);

      // 6c: cada fila abre el detalle de 3k / 3l (en escritorio, al lado).
      fila.addEventListener('click', () => alAbrir({ id, ...v }, fila));

      nodos.push(fila);
    }
    return nodos;
  };

  const nodos = filas(actuales);
  if (beta.length) {
    nodos.push(el('div', { clase: 'tanda-beta' }, [
      el('h3', { texto: 'Primera tanda' }),
      el('p', { texto: `La fase de pruebas, antes del lanzamiento. Tus ${beta.length === 1 ? 'trayecto se queda' : `${beta.length} trayectos se quedan`} aquí, pero no cuentan para nada: ni puntos, ni rachas, ni rankings.` }),
    ]));
    nodos.push(...filas(beta, { primeraTanda: true }));
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
 * 8m: las ultimas cinco temporadas como barras (80 px la mejor), la actual en
 * azul, y la mejor posicion a la derecha del titulo.
 */
function pintarBarrasTemporadas(actual, cerradas) {
  const destino = document.getElementById('barras-temporadas');
  if (!destino) return;
  const meses = [
    ...cerradas.filter((t) => /^\d{4}-\d{2}$/.test(t.temporada)).slice(0, 4).reverse()
      .map((t) => ({ mes: t.temporada, puntos: t.puntos || 0 })),
    { mes: diaMadrid().slice(0, 7), puntos: actual, actual: true },
  ];
  const tope = Math.max(...meses.map((m) => m.puntos), 1);
  reemplazar(destino, meses.map((m) => el('div', { clase: `barra-mes${m.actual ? ' actual' : ''}` }, [
    el('span', { clase: 'valor', texto: String(m.puntos) }),
    el('span', { clase: 'columna', estilo: { height: `${Math.max(4, Math.round((m.puntos / tope) * 80))}px` } }),
    el('span', { clase: 'mes', texto: MESES_CORTOS[Number(m.mes.slice(5, 7)) - 1] }),
  ])));
  const mejor = cerradas.filter((t) => t.posicion).sort((a, b) => a.posicion - b.posicion)[0];
  document.getElementById('mejor-temporada').textContent = mejor
    ? `mejor: ${ordinal(mejor.posicion)} en ${nombreMes(mejor.temporada).split(' ')[0].toLowerCase()}`
    : '';
}

/**
 * @param {object} perfil
 * @param {Array<{temporada, nombre, puntos, posicion, division}>} cerradas
 *   ya ordenadas y con nombre (lo decide la pagina)
 */
export function pintarTemporadas(perfil, cerradas, puesto = null) {
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
      // 6d: "pts · 184.º · Plata".
      el('span', { texto: ['pts', puesto?.pos ? ordinal(puesto.pos) : null, division].filter(Boolean).join(' · ') }),
    ]),
    el('div', { clase: 'pista', attrs: { 'aria-hidden': 'true' } }, [
      el('span', { estilo: { width: `${Math.round((actual / mejor) * 100)}%` } }),
    ]),
  ]));

  pintarBarrasTemporadas(actual, cerradas);

  const premios = insigniasDeTemporada(perfil.logros);

  reemplazar(document.getElementById('temporadas'), cerradas.length
    ? cerradas.map((t) => {
      const suyos = premios.filter((p) => p.temporada === t.temporada);
      const sub = [t.posicion ? ordinal(t.posicion) : null, nombreDivision(t.division)].filter(Boolean).join(' · ');
      return el('div', { clase: 'temporada-fila' }, [
        el('span', { clase: 'mes', texto: t.nombre }),
        el('span', { clase: 'puntos', texto: numero(t.puntos || 0) }),
        el('span', { clase: 'progreso gruesa', attrs: { 'aria-hidden': 'true' } }, [
          el('span', { estilo: { width: `${Math.round(((t.puntos || 0) / mejor) * 100)}%` } }),
        ]),
        el('span', { clase: 'sub', texto: sub || 'sin puntos' }),
        // 6d: el bronce, en su color; el resto, en ambar.
        el('span', { clase: `premio ${suyos.some((p) => p.clave.endsWith('-bronce')) ? 'bronce' : ''}`, texto: suyos.map((p) => p.titulo).join(' · ') }),
      ]);
    })
    : [el('div', { clase: 'vacio' }, [
      el('h3', { texto: 'Esta es tu primera temporada' }),
      el('p', { texto: 'Cada mes se cierra la clasificación y aquí se queda lo que hiciste.' }),
    ])]);
}
