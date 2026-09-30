#!/usr/bin/env node
/**
 * Planifica la ruta del dia para un año y la deja en data/rutas-destacadas.csv.
 *
 * El worker la lee cada mañana (backend/src/rutas-destacadas.js): si el dia
 * esta en el fichero, esa es la ruta del dia; si no, vuelve a elegir entre los
 * tramos con actividad, como antes.
 *
 * Que tramos valen:
 *   - entre 0,5 y 6,7 km por calle (distancias.estimar: linea recta por el
 *     factor callejero, lo mismo que usa el juego para puntuar);
 *   - que se hagan en 5 a 20 minutos a 13 km/h, el ritmo tipico de una BiciMAD
 *     por ciudad. Ni un paseo de dos minutos ni una travesia de media hora.
 *   - un mismo tramo no se repite en 120 dias, y una estacion no sale como
 *     salida o llegada dos veces en la misma semana.
 *
 * Es determinista (semilla fija): volver a lanzarlo da el mismo fichero.
 *
 * Uso:
 *   node scripts/generar-rutas-destacadas.js [--desde 2026-10-01] [--dias 365]
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const distancias = require(path.join(RAIZ, 'backend', 'src', 'distancias'));
const estaciones = require(path.join(RAIZ, 'backend', 'lib', 'estaciones.json'));

const KM_MIN = 0.5;
const KM_MAX = 6.7;
const MIN_MIN = 5;
const MIN_MAX = 20;
const KMH = 13;
const SIN_REPETIR_TRAMO = 120;
const SIN_REPETIR_ESTACION = 7;

const arg = (nombre, defecto) => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i > 0 ? process.argv[i + 1] : defecto;
};
const desde = arg('desde', '2026-10-01');
const dias = Number(arg('dias', '365'));

// Generador pseudoaleatorio con semilla (mulberry32): el mismo fichero siempre.
function generador(semilla) {
  let a = 0;
  for (const c of String(semilla)) a = (Math.imul(a ^ c.charCodeAt(0), 2654435761) >>> 0);
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ids = Object.keys(estaciones).sort();
const candidatos = [];
for (const a of ids) {
  for (const b of ids) {
    if (a === b) continue;
    const metros = distancias.estimar(a, b);
    if (!metros) continue;
    const km = metros / 1000;
    const minutos = (km / KMH) * 60;
    if (km < KM_MIN || km > KM_MAX || minutos < MIN_MIN || minutos > MIN_MAX) continue;
    candidatos.push({ origen: a, destino: b, km, minutos });
  }
}
if (!candidatos.length) throw new Error('Ningun tramo cumple las condiciones.');

const azar = generador(`rutas-destacadas-${desde}`);
const usadoTramo = new Map();
const usadaEstacion = new Map();
const filas = [];
const inicio = new Date(`${desde}T12:00:00Z`);

for (let d = 0; d < dias; d++) {
  const fecha = new Date(inicio.getTime() + d * 864e5).toISOString().slice(0, 10);
  const libre = (c) => (d - (usadoTramo.get(`${c.origen}-${c.destino}`) ?? -1e9)) > SIN_REPETIR_TRAMO
    && (d - (usadaEstacion.get(c.origen) ?? -1e9)) > SIN_REPETIR_ESTACION
    && (d - (usadaEstacion.get(c.destino) ?? -1e9)) > SIN_REPETIR_ESTACION;
  // Se prueba al azar hasta dar con uno libre; con miles de candidatos, enseguida.
  let elegido = null;
  for (let intento = 0; intento < 5000 && !elegido; intento++) {
    const c = candidatos[Math.floor(azar() * candidatos.length)];
    if (libre(c)) elegido = c;
  }
  if (!elegido) elegido = candidatos[Math.floor(azar() * candidatos.length)];
  usadoTramo.set(`${elegido.origen}-${elegido.destino}`, d);
  usadaEstacion.set(elegido.origen, d);
  usadaEstacion.set(elegido.destino, d);
  filas.push({ fecha, ...elegido });
}

const csv = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const lineas = [
  'fecha,ruta,origen,nombre_origen,destino,nombre_destino,km,minutos_estimados',
  ...filas.map((f) => [
    f.fecha, `${f.origen}-${f.destino}`,
    f.origen, estaciones[f.origen].nombre, f.destino, estaciones[f.destino].nombre,
    f.km.toFixed(2), Math.round(f.minutos),
  ].map(csv).join(',')),
];
const destino = path.join(RAIZ, 'data', 'rutas-destacadas.csv');
fs.writeFileSync(destino, `${lineas.join('\n')}\n`);
console.log(`OK: ${filas.length} dias (${filas[0].fecha} a ${filas[filas.length - 1].fecha}) de ${candidatos.length} tramos posibles -> ${path.relative(RAIZ, destino)}`);
