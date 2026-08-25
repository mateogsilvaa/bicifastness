// El dia, en hora de Madrid.
//
// POR QUE UN MODULO PARA ESTO. Habia tres copias de "hoy en YYYY-MM-DD" en el
// navegador y todas usaban la hora del dispositivo, mientras el worker contaba
// en UTC o en Madrid segun el sitio. Cuando las dos puntas no coinciden salen
// fallos que solo aparecen un par de horas al dia y no se reproducen de dia:
//
//   - las misiones se publicaban con el dia UTC y la portada las pedia con el
//     local: entre las 22:00 y las 00:00 la seccion desaparecia
//   - `subir/` ponia el tope del selector de fecha en el dia UTC, asi que entre
//     medianoche y las 02:00 no dejaba elegir HOY
//   - las sesiones se guardaban con el dia del dispositivo y el panel las
//     agrupaba por dia UTC
//
// Y no es la hora del dispositivo, que es lo que habia: quien abra la web desde
// otro pais, o con el reloj mal puesto, veria el dia de otro sitio. El juego
// ocurre en Madrid, asi que el dia lo decide Madrid — igual que `util.diaMadrid`
// en el backend, que es su pareja.

const ZONA = 'Europe/Madrid';

// 'sv-SE' da exactamente YYYY-MM-DD, que es lo unico que se le pide.
const FORMATO = new Intl.DateTimeFormat('sv-SE', { timeZone: ZONA });

/** Hoy en Madrid, como 'YYYY-MM-DD'. */
export function diaMadrid(fecha = new Date()) {
  return FORMATO.format(fecha);
}

/**
 * El dia de Madrid de hace `n` dias.
 *
 * Restar milisegundos y volver a formatear, en vez de restarle al numero del
 * dia: asi los cambios de hora no descuadran el resultado. En el paso a horario
 * de invierno un dia dura 25 horas, y "hace 30 dias" calculado a mano se iria un
 * dia — justo el limite que aplica el servidor.
 */
export function diaMadridHace(n, fecha = new Date()) {
  return diaMadrid(new Date(fecha.getTime() - n * 86400000));
}
