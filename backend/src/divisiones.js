'use strict';

/**
 * Divisiones semanales.
 *
 * POR QUE. En una tabla unica de 400 personas, el puesto 180 no se mueve nunca
 * y no motiva a nadie. En un grupo de 30, subir de division esta a dos buenos
 * trayectos. Es lo que hace que competir tenga sentido para alguien normal.
 *
 * Los lunes suben los 5 primeros de cada grupo y bajan los 5 ultimos.
 *
 * Todo el calculo son funciones puras sobre listas: se puede probar entero sin
 * Firestore, que es donde se esconden los errores de este tipo de reglas.
 */

const NIVELES = ['hierro', 'bronce', 'plata', 'oro', 'platino', 'leyenda'];

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
 * 1. Quien no ha competido en toda la semana NO baja. Castigar la ausencia con
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

  const suben = orden
    .filter((p) => (p.puntos || 0) > 0)
    .slice(0, cuantos)
    .filter(() => nivel !== 'leyenda')
    .map((p) => ({ ...p, division: subeA(nivel) }));

  const idsQueSuben = new Set(suben.map((p) => p.uid));

  // Los ultimos, pero solo entre quienes han competido.
  const bajan = orden
    .filter((p) => (p.puntos || 0) > 0 && !idsQueSuben.has(p.uid))
    .slice(-cuantos)
    .filter(() => nivel !== 'hierro')
    .map((p) => ({ ...p, division: bajaA(nivel) }));

  const movidos = new Set([...suben, ...bajan].map((p) => p.uid));

  return {
    suben,
    bajan,
    sinCambios: miembros.filter((p) => !movidos.has(p.uid)),
  };
}

/**
 * Calcula la semana entera. Devuelve solo los pilotos que CAMBIAN de division,
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
  POR_GRUPO,
  MUEVEN,
  repartirEnGrupos,
  movimientos,
  calcularSemana,
  grupoDe,
  subeA,
  bajaA,
};
