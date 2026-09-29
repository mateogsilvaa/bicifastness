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

/** Suma dias a una fecha 'YYYY-MM-DD' (a mediodia UTC, sin lios de horario). */
export function sumarDias(fecha, n) {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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

const HORA = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONA, hour12: false, hour: '2-digit', minute: '2-digit',
});

/**
 * Minutos que lleva el dia de Madrid, de 0 a 1439. La pareja de
 * `util.minutosDelDiaEnZona` en el backend.
 */
export function minutosMadrid(fecha = new Date()) {
  const p = {};
  for (const { type, value } of HORA.formatToParts(fecha)) p[type] = value;
  return (p.hour === '24' ? 0 : Number(p.hour)) * 60 + Number(p.minute);
}

/**
 * El dia mas probable de un viaje, a partir de su captura.
 *
 * El calendario se abria siempre en HOY, y es el dato que decide la racha: quien
 * sube por la mañana el trayecto de anoche lo declaraba de hoy sin darse
 * cuenta, y el antifraude (`comprobarFecha` en el worker) lo manda a revision
 * con razon. Mejor acertar aqui que explicarlo despues.
 *
 * Dos pistas, por orden:
 *   1. el dia del fichero: una captura se hace al terminar el viaje o despues,
 *      asi que si el fichero es de ayer, el viaje tambien. En iOS el navegador
 *      da la hora de ahora, y entonces esta pista no dice nada (dice hoy)
 *   2. la hora de llegada leida: si es de hoy, no puede ser posterior a ahora
 *
 * @returns {{ dia: string, motivo: string|null }} motivo es null si es hoy
 */
export function diaProbableDelViaje({ ficheroModificado, horaLlegada, ahora = new Date() }) {
  const hoy = diaMadrid(ahora);

  if (Number.isFinite(ficheroModificado) && ficheroModificado > 0) {
    const delFichero = diaMadrid(new Date(ficheroModificado));
    if (delFichero < hoy) return { dia: delFichero, motivo: 'la captura es de ese dia' };
  }

  const m = /^(\d{1,2}):(\d{2})/.exec(String(horaLlegada || ''));
  if (m && Number(m[1]) * 60 + Number(m[2]) > minutosMadrid(ahora) + 10) {
    return { dia: diaMadridHace(1, ahora), motivo: `la captura marca la llegada a las ${m[1]}:${m[2]}, mas tarde que ahora` };
  }

  return { dia: hoy, motivo: null };
}
