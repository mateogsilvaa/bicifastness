// Las ligas (divisiones) en el navegador: nombres, el calendario de dos
// semanas y el emblema de cada una.
//
// GEMELO de `backend/src/divisiones.js` en lo que importa: `ANCLA_LIGA` y
// `DIAS_POR_LIGA`. Un test los compara. Si solo se movieran alli, la web diria
// "cambia el lunes 12" y el cambio caeria el 19.

import { diaMadrid, sumarDias } from './dia.js';

/** De peor a mejor (diseño 12). El identificador es el nombre sin tilde. */
export const NIVELES = ['cobre', 'plata', 'oro', 'platino', 'esmeralda', 'rubi', 'diamante'];

/** Antes de la primera liga con trayectos, y tras dos ligas sin pedalear. */
export const SIN_CLASIFICAR = 'sin-clasificar';

export const NOMBRES = {
  'sin-clasificar': 'Sin clasificar',
  cobre: 'Cobre', plata: 'Plata', oro: 'Oro', platino: 'Platino',
  esmeralda: 'Esmeralda', rubi: 'Rubí', diamante: 'Diamante',
};

/** La division de una clave de grupo ('plata-4' -> 'plata'). */
export function divisionDeClave(clave) {
  const c = String(clave || '');
  if (c === SIN_CLASIFICAR) return SIN_CLASIFICAR;
  const i = c.lastIndexOf('-');
  return i > 0 ? c.slice(0, i) : c;
}

/** El numero del grupo ('plata-4' -> '4'), o '' para sin clasificar. */
export function numeroDeGrupo(clave) {
  const c = String(clave || '');
  return c === SIN_CLASIFICAR ? '' : c.slice(c.lastIndexOf('-') + 1);
}

/** Cuantos dias dura una liga. */
export const DIAS_POR_LIGA = 14;

/** El dia que abre la web: la primera liga va de ahi al domingo 15. */
export const LANZAMIENTO = '2026-11-01';

/** El lunes desde el que se cuentan las ligas de dos semanas. */
export const ANCLA_LIGA = '2026-11-02';

const diasEntre = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);

function lunesDeLiga(dia) {
  const vueltas = Math.floor(diasEntre(ANCLA_LIGA, dia) / DIAS_POR_LIGA);
  return sumarDias(ANCLA_LIGA, vueltas * DIAS_POR_LIGA);
}

/** ¿Cae el dia en la primera liga (o antes del lanzamiento)? */
const enPrimeraLiga = (dia) => diasEntre(ANCLA_LIGA, dia) < DIAS_POR_LIGA;

/** El dia en que empezo la liga en juego el dia dado. */
export function inicioLiga(dia = diaMadrid()) {
  return enPrimeraLiga(dia) ? LANZAMIENTO : lunesDeLiga(dia);
}

/** El lunes en que se cierra la liga en juego (y empieza la siguiente). */
export function proximoCambio(dia = diaMadrid()) {
  return sumarDias(enPrimeraLiga(dia) ? ANCLA_LIGA : lunesDeLiga(dia), DIAS_POR_LIGA);
}

/** Dias que quedan hasta el cambio de liga. */
export function diasHastaCambio(dia = diaMadrid()) {
  return diasEntre(dia, proximoCambio(dia));
}

/** "lunes 19 oct" */
export function fechaCorta(dia) {
  return new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(`${dia}T12:00:00Z`)).replace(',', '').replace('.', '');
}

/** "el lunes 19 oct", "mañana", "el lunes que viene". Para frases del tipo "suben …". */
export function cuandoCambia(dia = diaMadrid()) {
  const quedan = diasHastaCambio(dia);
  if (quedan <= 1) return 'mañana';
  return `el ${fechaCorta(proximoCambio(dia))}`;
}

/** "Plata · grupo 4", o "Sin clasificar". */
export function nombreGrupo(clave) {
  const division = divisionDeClave(clave);
  const n = numeroDeGrupo(clave);
  return n ? `${NOMBRES[division] || division} · grupo ${n}` : (NOMBRES[division] || division);
}

/** Donde viven las insignias del diseño 12: `{id}.svg` y `{id}-oscuro.svg`. */
const RUTA = '/assets/img/divisiones';

/**
 * La insignia de una division (diseño 12 · Insignias de division).
 *
 * Son los SVG del diseño, tal cual, en `assets/img/divisiones/`: la version
 * clara y la `-oscuro` (borde blanco de pegatina en vez de sombra), y el CSS
 * enseña la del tema. Las `-compacto` son copias identicas, asi que no se
 * piden aparte.
 *
 * @param {string} division  'cobre' ... 'diamante' o 'sin-clasificar'
 * @param {{tamano?: number, apagado?: boolean}} opciones  `tamano` es el ALTO
 */
export function emblemaLiga(division, { tamano = 32, apagado = false } = {}) {
  const id = NOMBRES[division] ? division : SIN_CLASIFICAR;
  const caja = document.createElement('span');
  caja.className = `insignia-division division-${id}${apagado ? ' apagado' : ''}`;
  caja.setAttribute('aria-hidden', 'true');
  caja.style.height = `${tamano}px`;
  for (const [variante, fichero] of [['claro', `${id}.svg`], ['oscuro', `${id}-oscuro.svg`]]) {
    const img = document.createElement('img');
    img.className = `insignia-${variante}`;
    img.src = `${RUTA}/${fichero}`;
    img.alt = '';
    img.decoding = 'async';
    img.style.height = `${tamano}px`;
    caja.append(img);
  }
  return caja;
}

/**
 * 12 · Chip junto al nombre (Hoy, Tu, perfil publico): la insignia a 22 px y
 * "Plata · grupo 4" en negrita, sobre blanco.
 *
 * @param {string} division
 * @param {string} texto  lo que va al lado; por defecto, el nombre de la division
 */
export function chipDivision(division, texto = null) {
  const id = NOMBRES[division] ? division : SIN_CLASIFICAR;
  const chip = document.createElement('span');
  chip.className = 'chip-insignia';
  const rotulo = document.createElement('span');
  rotulo.textContent = texto || NOMBRES[id];
  chip.append(emblemaLiga(id, { tamano: 22 }), rotulo);
  return chip;
}
