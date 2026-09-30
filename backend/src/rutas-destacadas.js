'use strict';

/**
 * La ruta del dia planificada (data/rutas-destacadas.csv).
 *
 * El fichero lo genera `scripts/generar-rutas-destacadas.js` para un año:
 * tramos de 0,5 a 6,7 km que se hacen en 5 a 20 minutos, sin repetir tramo en
 * 120 dias ni estacion en una semana. Si el dia no esta (el plan se acabo o el
 * fichero falta), el worker vuelve a elegir entre los tramos con actividad.
 */

const fs = require('fs');
const path = require('path');

const FICHERO = path.join(__dirname, '..', '..', 'data', 'rutas-destacadas.csv');

let plan = null;

/** fecha (YYYY-MM-DD) -> ruta ("005-002"). Se lee una vez. */
function leerPlan(fichero = FICHERO) {
  const mapa = new Map();
  let texto = '';
  try {
    texto = fs.readFileSync(fichero, 'utf8');
  } catch {
    return mapa; // sin fichero: sin plan, y el worker elige como antes
  }
  for (const linea of texto.split(/\r?\n/).slice(1)) {
    // Tres cifras casi siempre ("005"), cuatro en alguna estacion nueva ("8000").
    const m = linea.match(/^(\d{4}-\d{2}-\d{2}),(\d{3,4}[A-Z]?-\d{3,4}[A-Z]?),/);
    if (m) mapa.set(m[1], m[2]);
  }
  return mapa;
}

/** La ruta planificada para ese dia, o null. */
function rutaPlanificada(fecha) {
  if (!plan) plan = leerPlan();
  return plan.get(fecha) || null;
}

module.exports = { leerPlan, rutaPlanificada, FICHERO };
