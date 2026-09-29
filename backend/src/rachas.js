'use strict';

/**
 * Racha diaria: el modo Constancia del juego (ver docs/JUEGO.md).
 *
 * Es la mecanica de retencion mas barata que existe, y la unica que premia
 * aparecer aunque sea con un trayecto corto y lento.
 *
 * Todo aqui es funcion pura sobre el estado del usuario. No toca Firestore ni
 * lee el reloj por su cuenta: la fecha entra siempre por parametro. Asi se
 * puede probar el cambio de mes y el cambio de hora sin trucar el sistema, que
 * es donde este tipo de codigo falla.
 */

const { RACHA } = require('./config');
const { inicioDelDiaMadrid } = require('./util');

/**
 * Identificador del dia al que pertenece un instante, en hora de Madrid.
 *
 * La zona horaria no es un detalle: con UTC, un trayecto a las 23:30 de un dia
 * de verano en Madrid cae en el dia siguiente, y al usuario le romperia la
 * racha un viaje que hizo a tiempo.
 */
function diaDe(fecha = new Date()) {
  return inicioDelDiaMadrid(fecha);
}

/** Dias naturales entre dos dias (ya normalizados con `diaDe`). */
function diasEntre(anterior, actual) {
  return Math.round((actual - anterior) / 86400000);
}

/**
 * Multiplicador de puntos por racha: crece un 5% por dia hasta x1,5 a los 10.
 * El tope existe para que una racha de un ano no valga tres veces mas que una
 * de dos semanas; pasado ese punto, la racha se sostiene sola.
 */
function multiplicador(racha) {
  const dias = Math.max(0, Math.min(Number(racha) || 0, RACHA.DIAS_TOPE));
  return 1 + dias * RACHA.INCREMENTO_POR_DIA;
}

/**
 * Estado por defecto de quien no tiene racha todavia.
 * @typedef {{racha: number, mejorRacha: number, escudos: number,
 *            diasHastaEscudo: number, ultimoDiaActivo: number|null}} EstadoRacha
 */
function estadoInicial() {
  return {
    racha: 0,
    mejorRacha: 0,
    escudos: 0,
    diasHastaEscudo: RACHA.DIAS_POR_ESCUDO,
    ultimoDiaActivo: null,
  };
}

/**
 * Registra un dia activo (el usuario ha tenido al menos un viaje verificado).
 *
 * Es idempotente dentro del mismo dia: verificar tres viajes de hoy no suma
 * tres a la racha. Importa, porque el worker procesa la cola por lotes y puede
 * resolver varios viajes del mismo piloto en la misma pasada.
 *
 * @param {EstadoRacha} estado
 * @param {Date} fecha instante del viaje
 * @returns {EstadoRacha & {gano: boolean, escudoGanado: boolean}}
 */
function registrarDiaActivo(estado, fecha = new Date()) {
  const previo = { ...estadoInicial(), ...estado };
  const hoy = diaDe(fecha);

  if (previo.ultimoDiaActivo === hoy) {
    return { ...previo, gano: false, escudoGanado: false };
  }

  // Un viaje ATRASADO no toca la racha.
  //
  // Se pueden subir viajes de hasta `LIMITES.DIAS_MAX_ANTIGUEDAD` dias atras, y
  // sin esto pasaba lo siguiente: quien llevaba doce dias de racha y subia un
  // trayecto legitimo de hace cinco veia su racha puesta a 1 —el dia no era
  // consecutivo con el ultimo activo— y ademas `ultimoDiaActivo` RETROCEDIA,
  // asi que la pasada diaria contaba cuatro dias perdidos, se comia los dos
  // escudos y remataba la racha en 0. Doce dias y dos escudos por subir un
  // viaje que el propio sistema admite.
  //
  // Que no sume tampoco es a proposito. Para saber si ese dia rellena un hueco
  // haria falta la lista de dias activos, y aqui solo se guarda el ultimo. Y
  // contarlo para el escudo abriria la puerta a fabricarlos subiendo viajes de
  // dias sueltos del mes pasado. Se queda como estaba: ni gana ni pierde.
  if (previo.ultimoDiaActivo !== null && hoy < previo.ultimoDiaActivo) {
    return { ...previo, gano: false, escudoGanado: false };
  }

  // Primer viaje, o vuelta tras haber perdido la racha.
  const seguido = previo.ultimoDiaActivo !== null && diasEntre(previo.ultimoDiaActivo, hoy) === 1;
  const racha = seguido ? previo.racha + 1 : 1;

  // El escudo se gana cada 7 dias ACTIVOS, no cada 7 dias de calendario.
  let diasHastaEscudo = previo.diasHastaEscudo - 1;
  let escudos = previo.escudos;
  let escudoGanado = false;

  if (diasHastaEscudo <= 0) {
    diasHastaEscudo = RACHA.DIAS_POR_ESCUDO;
    if (escudos < RACHA.MAX_ESCUDOS) {
      escudos++;
      escudoGanado = true;
    }
  }

  return {
    racha,
    mejorRacha: Math.max(previo.mejorRacha, racha),
    escudos,
    diasHastaEscudo,
    ultimoDiaActivo: hoy,
    gano: true,
    escudoGanado,
  };
}

/**
 * Cierra los dias que han pasado sin actividad. Lo llama la pasada diaria del
 * worker.
 *
 * Gasta un escudo por cada dia perdido mientras queden, y solo entonces rompe
 * la racha. Se gasta SOLO: si hubiera que entrar en la web a usarlo, seria el
 * mismo problema que el escudo intenta evitar.
 *
 * @param {EstadoRacha} estado
 * @param {Date} ahora
 * @returns {EstadoRacha & {escudosGastados: number, rota: boolean}}
 */
function cerrarDiasPerdidos(estado, ahora = new Date()) {
  const previo = { ...estadoInicial(), ...estado };
  const sinCambios = { ...previo, escudosGastados: 0, rota: false };

  if (previo.ultimoDiaActivo === null || previo.racha === 0) return sinCambios;

  const hoy = diaDe(ahora);
  const transcurridos = diasEntre(previo.ultimoDiaActivo, hoy);

  // El dia de hoy todavia se puede salvar: no cuenta como perdido hasta que
  // termine. Solo se juzgan los dias YA cerrados.
  const perdidos = transcurridos - 1;
  if (perdidos <= 0) return sinCambios;

  const gastados = Math.min(perdidos, previo.escudos);
  const sinCubrir = perdidos - gastados;

  if (sinCubrir > 0) {
    return {
      ...previo,
      racha: 0,
      escudos: previo.escudos - gastados,
      // Los escudos cubrieron lo que pudieron, pero la racha se ha roto igual.
      ultimoDiaActivo: previo.ultimoDiaActivo,
      escudosGastados: gastados,
      rota: true,
    };
  }

  // Todos los dias perdidos quedan cubiertos: la racha sobrevive. Se mueve el
  // ultimo dia activo para no volver a cobrar por los mismos dias en la
  // siguiente pasada.
  return {
    ...previo,
    escudos: previo.escudos - gastados,
    ultimoDiaActivo: hoy - 86400000,
    escudosGastados: gastados,
    rota: false,
  };
}

module.exports = {
  diaDe,
  diasEntre,
  multiplicador,
  estadoInicial,
  registrarDiaActivo,
  cerrarDiasPerdidos,
};
