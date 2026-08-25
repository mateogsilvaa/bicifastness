'use strict';

const { ErrorApp } = require('./errores');
const ESTACIONES = require('../lib/estaciones.json');

/**
 * Normaliza un id de estacion al formato canonico: 3 digitos + sufijo opcional.
 * Acepta "2", "02", "002", "25a" y devuelve "002" / "025A".
 */
function normalizarEstacion(raw) {
  const val = String(raw ?? '').trim().toUpperCase();
  const match = val.match(/^(\d+)([A-Z]?)$/);
  if (!match) return val;
  return match[1].padStart(3, '0') + (match[2] || '');
}

/** Devuelve la estacion o null. Nunca lanza. */
function buscarEstacion(raw) {
  return ESTACIONES[normalizarEstacion(raw)] || null;
}

/**
 * Construye el id de ruta canonico "ORIGEN-DESTINO" validando ambos extremos.
 * Lanza si alguna estacion no existe o si origen y destino coinciden.
 */
function construirRuta(origenRaw, destinoRaw) {
  const origen = normalizarEstacion(origenRaw);
  const destino = normalizarEstacion(destinoRaw);

  if (!ESTACIONES[origen]) {
    throw new ErrorApp('invalid-argument', `La estacion de salida "${origenRaw}" no existe.`);
  }
  if (!ESTACIONES[destino]) {
    throw new ErrorApp('invalid-argument', `La estacion de meta "${destinoRaw}" no existe.`);
  }
  if (origen === destino) {
    throw new ErrorApp('invalid-argument', 'La salida y la meta no pueden ser la misma estacion.');
  }
  return { origen, destino, ruta: `${origen}-${destino}` };
}

/** Distancia en metros entre dos puntos (haversine). */
function distanciaMetros(a, b) {
  const R = 6371000;
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Saneado de texto libre que va a acabar mostrandose a otros usuarios.
 * Quita caracteres de control e invisibles (incluido el bidi override, que se
 * usa para disfrazar texto) y recorta a una longitud maxima.
 */
/**
 * Rangos de codepoints que nunca deben sobrevivir en texto de usuario:
 * controles C0/C1, espacios de ancho cero, marcas bidi (sirven para colar
 * nombres que se renderizan al reves) y el BOM.
 */
const INVISIBLES = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x200b, 0x200f],
  [0x2060, 0x2064], [0x2066, 0x2069], [0x202a, 0x202e], [0xfeff, 0xfeff],
];

function limpiarTexto(raw, maxLongitud = 200) {
  let salida = '';
  for (const ch of String(raw ?? '')) {
    const cp = ch.codePointAt(0);
    if (INVISIBLES.some(([lo, hi]) => cp >= lo && cp <= hi)) continue;
    salida += ch;
  }
  return salida.trim().slice(0, maxLongitud);
}

/** Entero dentro de un rango o ErrorApp. */
function enteroEnRango(valor, min, max, campo) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ErrorApp('invalid-argument', `${campo} debe ser un entero entre ${min} y ${max}.`);
  }
  return n;
}

/** Exige sesion iniciada y email verificado; devuelve el uid. */
function exigirAuth(request) {
  if (!request.auth || !request.auth.uid) {
    throw new ErrorApp('unauthenticated', 'Debes iniciar sesion.');
  }
  return request.auth.uid;
}

/** Exige que el llamante tenga el custom claim de administrador. */
function exigirAdmin(request) {
  const uid = exigirAuth(request);
  if (request.auth.token.admin !== true) {
    throw new ErrorApp('permission-denied', 'Necesitas permisos de administrador.');
  }
  return uid;
}

const TZ = 'Europe/Madrid';

/**
 * Desfase de la zona horaria en ese instante concreto, en ms.
 * Formatea la fecha en Madrid y reinterpreta el resultado como si fuera UTC:
 * la diferencia con el instante original es justo el offset (+1h o +2h segun
 * si rige el horario de verano).
 */
function desfaseZona(fecha) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(fecha);

  const p = {};
  for (const { type, value } of partes) p[type] = value;
  const hora = p.hour === '24' ? 0 : Number(p.hour);

  const comoUTC = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    hora, Number(p.minute), Number(p.second)
  );
  return comoUTC - fecha.getTime();
}

/**
 * Instante (epoch ms) de la medianoche de Madrid del dia al que pertenece
 * `fecha`. Es lo que define "hoy" para el limite diario de subidas: si usaramos
 * UTC, entre medianoche y las 02:00 de Madrid el contador se reiniciaria antes
 * de tiempo y se podrian colar subidas de mas.
 */
function inicioDelDiaMadrid(fecha = new Date()) {
  const desfase = desfaseZona(fecha);
  const local = new Date(fecha.getTime() + desfase);
  const medianocheIngenua = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()
  );
  // El desfase en la medianoche puede no ser el mismo que ahora (los dias del
  // cambio de hora), asi que lo recalculamos sobre el instante aproximado.
  return medianocheIngenua - desfaseZona(new Date(medianocheIngenua - desfase));
}

/** "HH:MM:SS" -> segundos desde medianoche. Devuelve null si no parsea. */
function horaASegundos(texto) {
  const m = String(texto ?? '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3] || 0);
  if (h > 23 || min > 59 || s > 59) return null;
  return h * 3600 + min * 60 + s;
}

/**
 * El dia natural en Madrid, como 'YYYY-MM-DD'.
 *
 * Existe para que worker y navegador estén de acuerdo en que dia es. No es
 * `toISOString().slice(0, 10)`: eso es el dia en UTC, y en horario de verano
 * Madrid va dos horas por delante, asi que entre las 22:00 y las 00:00 el UTC
 * todavia dice ayer. Las misiones se publicaban con esa clave y el navegador
 * las pedia con la suya, de modo que cada noche desaparecian un par de horas.
 *
 * Tampoco es la fecha local del dispositivo: quien abra la web desde otro pais
 * veria las misiones de otro dia. El juego ocurre en Madrid.
 */
function diaMadrid(fecha = new Date()) {
  return diaEnZona(fecha, TZ);
}

/**
 * El dia natural en la zona que se le diga, como 'YYYY-MM-DD'.
 *
 * Existe porque no todo lo del proyecto ocurre en Madrid: la cuota diaria de
 * Firestore se reinicia a medianoche del PACIFICO, y contarla por dias de
 * Madrid o de UTC la parte por la mitad.
 */
function diaEnZona(fecha, zona) {
  // 'sv-SE' da exactamente YYYY-MM-DD, que es lo unico que se le pide.
  return new Intl.DateTimeFormat('sv-SE', { timeZone: zona }).format(fecha);
}

/**
 * El lunes de la semana de una fecha, como 'YYYY-MM-DD' de Madrid.
 *
 * Vive AQUI, con el resto de la aritmetica de dias, y no donde se usa. Estaba
 * en `metricas.js` y hacia esto:
 *
 *     const lunes = new Date(fecha);
 *     lunes.setUTCDate(lunes.getUTCDate() - ((lunes.getUTCDay() + 6) % 7));
 *     return diaMadrid(lunes);
 *
 * Que es la mezcla de siempre: el dia de la semana lo preguntaba al calendario
 * UTC y la respuesta la daba en el de Madrid. Entre las 00:00 y las 02:00 de
 * Madrid el dia UTC va uno por detras, asi que preguntaba por AYER y restaba
 * una semana de mas. Un alta de las 00:30 del lunes 2026-07-06 salia en la
 * semana '2026-06-30' — que ademas es un martes.
 *
 * En las cohortes de retencion eso abria una semana fantasma con una persona
 * dentro, y como solo se guardan doce, cada fantasma echaba fuera una semana
 * real. Peor: el corte entre cohortes vivas y congeladas sale de esta misma
 * funcion, asi que durante esas dos horas retrocedia una semana y las cohortes
 * ya cerradas se recalculaban desde datos parciales.
 *
 * El arreglo es no mezclar. Primero se reduce a un DIA de Madrid; a partir de
 * ahi ya no hay zonas, solo calendario, y la medianoche UTC se usa de percha
 * para contar dias porque en UTC todos los dias duran lo mismo.
 */
function lunesDe(fecha) {
  const [año, mes, dia] = diaMadrid(fecha).split('-').map(Number);

  // Date.UTC + getUTCDay: el calendario UTC no tiene cambios de horario, asi
  // que restar dias aqui es restar dias de verdad.
  const percha = new Date(Date.UTC(año, mes - 1, dia));
  percha.setUTCDate(percha.getUTCDate() - ((percha.getUTCDay() + 6) % 7));

  const dosDigitos = (n) => String(n).padStart(2, '0');
  return [
    percha.getUTCFullYear(),
    dosDigitos(percha.getUTCMonth() + 1),
    dosDigitos(percha.getUTCDate()),
  ].join('-');
}

/**
 * Minutos transcurridos del dia en la zona dada.
 *
 * Lo usa la proyeccion de consumo para saber que parte del dia lleva gastada.
 * Con `getUTCHours()` la respuesta era la del dia UTC, que no es el dia del que
 * se esta proyectando.
 */
function minutosDelDiaEnZona(fecha, zona) {
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone: zona, hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(fecha);

  const p = {};
  for (const { type, value } of partes) p[type] = value;
  const hora = p.hour === '24' ? 0 : Number(p.hour);

  return hora * 60 + Number(p.minute);
}

module.exports = {
  ESTACIONES,
  normalizarEstacion,
  buscarEstacion,
  construirRuta,
  distanciaMetros,
  limpiarTexto,
  enteroEnRango,
  exigirAuth,
  exigirAdmin,
  inicioDelDiaMadrid,
  diaMadrid,
  diaEnZona,
  lunesDe,
  minutosDelDiaEnZona,
  horaASegundos,
};
