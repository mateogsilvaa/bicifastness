'use strict';

/**
 * Divisiones semanales.
 *
 * POR QUE. En una tabla unica de 400 personas, el puesto 180 no se mueve nunca
 * y no motiva a nadie. En un grupo de 30, subir de division esta a dos buenos
 * trayectos. Es lo que hace que competir tenga sentido para alguien normal.
 *
 * Cada liga dura DOS SEMANAS. El lunes que la cierra suben los 5 primeros de
 * cada grupo y bajan los 5 ultimos, y los puntos de liga vuelven a cero.
 *
 * Por que dos semanas y no una: con una, quien se pierde dos dias por trabajo
 * o lluvia ya no tiene margen de remontar, y el ascenso premiaba haber tenido
 * una buena semana mas que pedalear de verdad. Con dos, da tiempo a remontar y
 * el cambio sigue estando lo bastante cerca como para motivar.
 *
 * Todo el calculo son funciones puras sobre listas: se puede probar entero sin
 * Firestore, que es donde se esconden los errores de este tipo de reglas.
 */

const { diaMadrid } = require('./util');

const NIVELES = ['hierro', 'bronce', 'plata', 'oro', 'platino', 'leyenda'];

/** Cuantos dias dura una liga. */
const DIAS_POR_LIGA = 14;

/**
 * El lunes en que empezo la primera liga de dos semanas. Desde ahi, una cada
 * `DIAS_POR_LIGA`. Tiene un gemelo en `assets/js/ligas.js` (un test los
 * compara): si solo se moviera aqui, la web diria "cambia el lunes 12" y el
 * cambio caeria el 19.
 */
const ANCLA_LIGA = '2026-10-05';

/** Dias entre dos fechas 'YYYY-MM-DD'. */
const diasEntre = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);

/** Suma dias a una fecha 'YYYY-MM-DD'. */
function sumarDias(fecha, n) {
  // A mediodia UTC, que en Madrid es el mismo dia con cualquier horario.
  return diaMadrid(new Date(Date.parse(`${fecha}T12:00:00Z`) + n * 864e5));
}

/** El lunes en que empezo la liga que esta en juego el dia dado. */
function inicioLiga(dia) {
  const vueltas = Math.floor(diasEntre(ANCLA_LIGA, dia) / DIAS_POR_LIGA);
  return sumarDias(ANCLA_LIGA, vueltas * DIAS_POR_LIGA);
}

/** El ultimo dia (domingo) de la liga en juego el dia dado. */
const finLiga = (dia) => sumarDias(inicioLiga(dia), DIAS_POR_LIGA - 1);

/** ¿Empieza liga nueva este dia? Es cuando toca cerrar la anterior. */
const esCambioDeLiga = (dia) => inicioLiga(dia) === dia;

/** Cuanta gente por grupo. Con mas, deja de sentirse como una liga. */
const POR_GRUPO = 30;

/** Cuantos suben y cuantos bajan cada semana. */
const MUEVEN = 5;

/**
 * Reparte a los pilotos en grupos dentro de su nivel.
 *
 * Se ordena por puntos antes de repartir para que los grupos queden parejos: si
 * se repartiera al azar, a alguien le tocaria un grupo con los tres mejores y a
 * otro uno vacio.
 */
function repartirEnGrupos(pilotos) {
  const grupos = new Map();

  for (const nivel of NIVELES) {
    const delNivel = pilotos
      .filter((p) => (p.division || 'hierro') === nivel)
      .sort((a, b) => (b.puntos || 0) - (a.puntos || 0));

    for (let i = 0; i < delNivel.length; i += POR_GRUPO) {
      const numero = Math.floor(i / POR_GRUPO) + 1;
      grupos.set(`${nivel}-${numero}`, delNivel.slice(i, i + POR_GRUPO));
    }
  }

  return grupos;
}

const subeA = (nivel) => NIVELES[Math.min(NIVELES.indexOf(nivel) + 1, NIVELES.length - 1)];
const bajaA = (nivel) => NIVELES[Math.max(NIVELES.indexOf(nivel) - 1, 0)];

/**
 * Decide los movimientos de un grupo.
 *
 * Dos reglas que no son obvias y que importan:
 *
 * 1. Quien no ha competido en toda la liga NO baja. Castigar la ausencia con
 *    un descenso empuja a abandonar del todo, que es justo lo contrario de lo
 *    que busca una liga. Tampoco sube: no ha hecho nada.
 *
 * 2. Un grupo incompleto no puede subir a 5 y bajar a 5 a la vez. Con 7
 *    personas, eso moveria a todas menos dos y el grupo dejaria de significar
 *    nada. Se mueve como mucho un tercio por lado.
 */
function movimientos(clave, miembros) {
  const nivel = clave.split('-')[0];
  const activos = miembros.filter((p) => (p.puntos || 0) > 0);

  // Ni ascensos ni descensos si casi nadie ha jugado: el resultado seria ruido.
  if (activos.length < 3) return { suben: [], bajan: [], sinCambios: miembros };

  const cuantos = Math.min(MUEVEN, Math.floor(miembros.length / 3));
  if (cuantos === 0) return { suben: [], bajan: [], sinCambios: miembros };

  const orden = [...miembros].sort((a, b) => (b.puntos || 0) - (a.puntos || 0));

  // De donde viene y en que puesto acabo: es lo que cuenta la hoja del lunes
  // (02 Hoy · 2g, "Acabaste 3.ª de 30 en tu grupo").
  const conPuesto = (p, division) => ({
    ...p, division, desde: nivel, puesto: orden.indexOf(p) + 1, total: miembros.length,
  });

  const suben = orden
    .filter((p) => (p.puntos || 0) > 0)
    .slice(0, cuantos)
    .filter(() => nivel !== 'leyenda')
    .map((p) => conPuesto(p, subeA(nivel)));

  const idsQueSuben = new Set(suben.map((p) => p.uid));

  // Los ultimos, pero solo entre quienes han competido.
  const bajan = orden
    .filter((p) => (p.puntos || 0) > 0 && !idsQueSuben.has(p.uid))
    .slice(-cuantos)
    .filter(() => nivel !== 'hierro')
    .map((p) => conPuesto(p, bajaA(nivel)));

  const movidos = new Set([...suben, ...bajan].map((p) => p.uid));

  return {
    suben,
    bajan,
    sinCambios: miembros.filter((p) => !movidos.has(p.uid)),
  };
}

/**
 * Calcula el cierre de una liga entera. Devuelve solo los pilotos que CAMBIAN de division,
 * para no escribir 400 documentos cuando se mueven 40.
 */
function calcularSemana(pilotos) {
  const grupos = repartirEnGrupos(pilotos);
  const cambios = [];

  for (const [clave, miembros] of grupos) {
    const { suben, bajan } = movimientos(clave, miembros);
    cambios.push(...suben, ...bajan);
  }

  return cambios;
}

/** El grupo al que pertenece un piloto, para ensenarselo. */
function grupoDe(pilotos, uid) {
  for (const [clave, miembros] of repartirEnGrupos(pilotos)) {
    if (miembros.some((p) => p.uid === uid)) return clave;
  }
  return null;
}

module.exports = {
  NIVELES,
  DIAS_POR_LIGA,
  ANCLA_LIGA,
  inicioLiga,
  finLiga,
  esCambioDeLiga,
  sumarDias,
  POR_GRUPO,
  MUEVEN,
  repartirEnGrupos,
  movimientos,
  calcularSemana,
  grupoDe,
  subeA,
  bajaA,
};
