'use strict';

/**
 * Misiones semanales y mensuales.
 *
 * Mismas reglas que las del dia (`misiones.js`): iguales para todo el mundo,
 * deterministas a partir del periodo (regenerarlas en cada pasada no cambia
 * nada) y con el progreso en el propio perfil, acumulado dentro de la
 * transaccion que verifica el viaje. Cero lecturas extra.
 *
 * LO QUE LAS HACE DISTINTAS: el fondo. Hay muchas familias (`FAMILIAS`), cada
 * una con varios objetivos posibles, y no se eligen al azar periodo a periodo
 * sino recorriendo una baraja: se baraja la lista de familias, cada periodo
 * coge las siguientes de la baraja y, cuando se acaba, se vuelve a barajar.
 * Asi una familia no se repite hasta que han salido todas las demas, y con los
 * objetivos que cambian, la misma familia tampoco vuelve igual.
 *
 * Solo cuentan los viajes que puntuan (como las del dia) y que son DEL
 * periodo: un trayecto de la semana pasada no completa la de esta.
 */

const { generador } = require('./misiones');

const elegir = (azar, lista) => lista[Math.floor(azar() * lista.length) % lista.length];
const coma = (n) => String(n).replace('.', ',');

/** Umbrales de las familias que cuentan trayectos "de algo". */
const KMH_RAPIDO = 15;
const METROS_LARGO = 3000;
const TEMPRANO_ANTES_DE = 9 * 60 + 30;
const TARDE_DESDE = 20 * 60;

/** Cuantas de cada periodo. */
const POR_PERIODO = { semana: 3, mes: 3 };

/**
 * Las familias. Cada una: de donde sale lo hecho (`medida`, una clave de los
 * totales), los objetivos posibles por periodo, el texto y los puntos.
 *
 * Los puntos son modestos (un trayecto normal da 40-70): empujan a salir, no
 * deciden la liga.
 */
const FAMILIAS = {
  kilometros: {
    medida: 'metros', escala: 1000,
    semana: [15, 20, 25, 30], mes: [60, 80, 100, 120],
    texto: (n, p) => `Recorre ${n} km ${p}`,
    ayuda: 'Suman todos tus trayectos.',
    puntos: { semana: 60, mes: 150 },
  },
  minutos: {
    medida: 'segundos', escala: 60,
    semana: [60, 90, 120], mes: [300, 400, 500],
    texto: (n, p) => (n % 60 === 0 ? `Pedalea ${n / 60} ${n === 60 ? 'hora' : 'horas'} ${p}` : `Pedalea ${n} minutos ${p}`),
    ayuda: 'Tiempo encima de la bici, sumando trayectos.',
    puntos: { semana: 55, mes: 140 },
  },
  trayectos: {
    medida: 'trayectos',
    semana: [5, 7, 10], mes: [20, 25, 30],
    texto: (n, p) => `Sube ${n} trayectos ${p}`,
    ayuda: 'Cuentan los que se verifican.',
    puntos: { semana: 50, mes: 130 },
  },
  dias: {
    medida: 'dias',
    semana: [3, 4, 5], mes: [10, 12, 15],
    texto: (n, p) => `Pedalea ${n} días distintos ${p}`,
    ayuda: 'Basta con un trayecto cada día.',
    puntos: { semana: 60, mes: 160 },
  },
  estaciones: {
    medida: 'estaciones',
    semana: [6, 8, 10], mes: [18, 22, 26],
    texto: (n, p) => `Pasa por ${n} estaciones distintas ${p}`,
    ayuda: 'Cuentan la de salida y la de llegada.',
    puntos: { semana: 55, mes: 140 },
  },
  rutas: {
    medida: 'rutas',
    semana: [4, 5, 6], mes: [12, 15, 18],
    texto: (n, p) => `Haz ${n} rutas distintas ${p}`,
    ayuda: 'Ida y vuelta son dos rutas.',
    puntos: { semana: 55, mes: 140 },
  },
  explorador: {
    medida: 'nuevas',
    semana: [2, 3], mes: [5, 7, 9],
    texto: (n, p) => `Termina en ${n} estaciones nuevas ${p}`,
    ayuda: 'Donde no hayas acabado nunca antes.',
    puntos: { semana: 70, mes: 170 },
  },
  madrugador: {
    medida: 'temprano',
    semana: [2, 3], mes: [6, 8, 10],
    texto: (n, p) => `${n} trayectos antes de las 9:30 ${p}`,
    ayuda: 'Cuenta la hora de salida de la captura.',
    puntos: { semana: 60, mes: 150 },
  },
  nocturno: {
    medida: 'tarde',
    semana: [2, 3], mes: [5, 7],
    texto: (n, p) => `${n} trayectos desde las 20:00 ${p}`,
    ayuda: 'Cuenta la hora de salida de la captura.',
    puntos: { semana: 55, mes: 140 },
  },
  finde: {
    medida: 'finde',
    semana: [2, 3], mes: [5, 7],
    texto: (n, p) => `${n} trayectos en fin de semana ${p}`,
    ayuda: 'Sábado o domingo.',
    puntos: { semana: 55, mes: 140 },
  },
  rutaSemana: {
    medida: 'rutaSemana',
    semana: [1, 2], mes: [3, 4],
    texto: (n, p) => (n === 1 ? `Haz la ruta de la semana ${p}` : `Haz la ruta de la semana ${n} veces ${p}`),
    ayuda: 'La que va por ×2 en Hoy.',
    puntos: { semana: 50, mes: 130 },
  },
  records: {
    medida: 'records',
    semana: [1, 2], mes: [3, 5],
    texto: (n, p) => (n === 1 ? `Mejora tu marca en una ruta ${p}` : `Mejora tu marca en ${n} rutas ${p}`),
    ayuda: 'Más rápido que tu mejor tiempo en esa ruta.',
    puntos: { semana: 65, mes: 160 },
  },
  rapidos: {
    medida: 'rapidos',
    semana: [2, 3, 4], mes: [8, 10, 12],
    texto: (n, p) => `${n} trayectos a más de ${KMH_RAPIDO} km/h ${p}`,
    ayuda: 'Velocidad media del trayecto.',
    puntos: { semana: 60, mes: 150 },
  },
  largos: {
    medida: 'largos',
    semana: [2, 3, 4], mes: [8, 10, 12],
    texto: (n, p) => `${n} trayectos de más de ${METROS_LARGO / 1000} km ${p}`,
    ayuda: 'Cada uno de una sola vez.',
    puntos: { semana: 60, mes: 150 },
  },
  granFondo: {
    medida: 'mejorDistancia', escala: 1000,
    semana: [4.5, 5, 5.5], mes: [6, 7, 8],
    texto: (n, p) => `Un trayecto de más de ${coma(n)} km ${p}`,
    ayuda: 'Tiene que ser de una sola vez.',
    puntos: { semana: 55, mes: 140 },
  },
  puntaVelocidad: {
    medida: 'mejorVelocidad',
    semana: [17, 18], mes: [19, 20],
    texto: (n, p) => `Supera los ${n} km/h de media en un trayecto ${p}`,
    ayuda: 'Basta con uno.',
    puntos: { semana: 60, mes: 150 },
  },
  diarias: {
    medida: 'diarias',
    semana: [5, 7, 9], mes: [20, 28, 35],
    texto: (n, p) => `Completa ${n} misiones diarias ${p}`,
    ayuda: 'Las tres de Hoy, cualquier día.',
    puntos: { semana: 55, mes: 150 },
  },
  racha: {
    medida: 'mejorRacha',
    semana: [4, 5, 6], mes: [10, 14, 18],
    texto: (n, p) => `Llega a una racha de ${n} días ${p}`,
    ayuda: 'La racha que tengas al verificar un trayecto del periodo.',
    puntos: { semana: 60, mes: 170 },
  },
};

const NOMBRES = Object.keys(FAMILIAS);

// --- Periodos -----------------------------------------------------------------
//
// Todo con dias 'YYYY-MM-DD' que ya son de Madrid (`util.diaMadrid`): aqui
// solo hay calendario, sin zonas ni horas. Se cuenta en numero de dia
// (dias desde 1970-01-01) con la cuenta civil de siempre.

const dos = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' → numero de dia. */
function aNumero(dia) {
  let [a, m, d] = String(dia).slice(0, 10).split('-').map(Number);
  a -= m <= 2 ? 1 : 0;
  const era = Math.floor(a / 400);
  const ae = a - era * 400;
  const dda = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const dde = ae * 365 + Math.floor(ae / 4) - Math.floor(ae / 100) + dda;
  return era * 146097 + dde - 719468;
}

/** Numero de dia → 'YYYY-MM-DD'. */
function aDia(n) {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const dde = z - era * 146097;
  const ae = Math.floor((dde - Math.floor(dde / 1460) + Math.floor(dde / 36524) - Math.floor(dde / 146096)) / 365);
  const dda = dde - (365 * ae + Math.floor(ae / 4) - Math.floor(ae / 100));
  const mp = Math.floor((5 * dda + 2) / 153);
  const d = dda - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return `${era * 400 + ae + (m <= 2 ? 1 : 0)}-${dos(m)}-${dos(d)}`;
}

/** 0 = domingo ... 6 = sabado. El 1970-01-01 fue jueves. */
const diaDeLaSemana = (dia) => (((aNumero(dia) + 4) % 7) + 7) % 7;

/** El lunes de un dia 'YYYY-MM-DD'. */
function lunesDeDia(dia) {
  return aDia(aNumero(dia) - ((diaDeLaSemana(dia) + 6) % 7));
}

/** La clave del periodo al que pertenece un dia. */
function periodoDe(tipo, dia) {
  return tipo === 'semana' ? lunesDeDia(dia) : String(dia).slice(0, 7);
}

/** Cuantos dias le quedan al periodo, contando el de hoy. */
function diasQuedan(tipo, dia) {
  if (tipo === 'semana') return aNumero(lunesDeDia(dia)) + 7 - aNumero(dia);
  const [a, m] = String(dia).split('-').map(Number);
  const primeroSiguiente = m === 12 ? `${a + 1}-01-01` : `${a}-${dos(m + 1)}-01`;
  return aNumero(primeroSiguiente) - aNumero(dia);
}

/** El numero de orden del periodo, para recorrer la baraja. */
function indiceDe(tipo, periodo) {
  if (tipo === 'semana') return Math.round((aNumero(periodo) - aNumero('2024-01-01')) / 7);
  const [a, m] = periodo.split('-').map(Number);
  return (a - 2024) * 12 + (m - 1);
}

/** Baraja de Fisher-Yates con semilla. */
function barajar(lista, azar) {
  const copia = [...lista];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(azar() * (i + 1)) % (i + 1);
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

/**
 * Las misiones de un periodo.
 * @param {'semana'|'mes'} tipo
 * @param {string} periodo  el lunes ('2026-10-26') o el mes ('2026-10')
 */
function generar(tipo, periodo) {
  const k = POR_PERIODO[tipo];
  const porCiclo = Math.floor(NOMBRES.length / k);
  const indice = indiceDe(tipo, periodo);
  const ciclo = Math.floor(indice / porCiclo);
  const pos = ((indice % porCiclo) + porCiclo) % porCiclo;
  // Semanas y meses barajan aparte: que no salgan las mismas en los dos.
  const baraja = barajar(NOMBRES, generador(`${tipo}-ciclo-${ciclo}`));
  const nombre = tipo === 'semana' ? 'esta semana' : 'este mes';

  return {
    periodo,
    misiones: baraja.slice(pos * k, pos * k + k).map((familia) => {
      const f = FAMILIAS[familia];
      const n = elegir(generador(`${tipo}-${periodo}-${familia}`), f[tipo]);
      return {
        tipo: familia,
        objetivo: n * (f.escala || 1),
        texto: f.texto(n, nombre),
        ayuda: f.ayuda,
        puntos: f.puntos[tipo],
      };
    }),
  };
}

// --- Progreso ---------------------------------------------------------------

function minutosDeHora(hora) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hora || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const VACIO = {
  metros: 0, segundos: 0, trayectos: 0, mejorVelocidad: 0, mejorDistancia: 0,
  rapidos: 0, largos: 0, nuevas: 0, temprano: 0, tarde: 0, finde: 0,
  rutaSemana: 0, records: 0, diarias: 0, mejorRacha: 0,
  estaciones: [], rutas: [], dias: [],
};

/** Una lista sin repetir y con tope: el perfil no tiene por que crecer. */
const conjunto = (lista, nuevos, tope) => [...new Set([...(Array.isArray(lista) ? lista : []), ...nuevos])].slice(0, tope);

/**
 * Suma un viaje a los totales del periodo. Si el periodo no es el del
 * acumulador, se empieza de cero.
 *
 * @param {object|null} totales  lo que habia en el perfil
 * @param {string} periodo
 * @param {object} viaje  { distanciaMetros, velocidadKmh, tiempoSegundos, ruta, horaSalida, dia }
 * @param {object} contexto  { esEstacionNueva, esRecord, esRutaSemana, racha, diarias }
 */
function acumular(totales, periodo, viaje, contexto = {}) {
  const base = totales && totales.periodo === periodo ? totales : { ...VACIO, periodo };
  const metros = viaje.distanciaMetros || 0;
  const kmh = viaje.velocidadKmh || 0;
  const minuto = minutosDeHora(viaje.horaSalida);
  const diaSemana = viaje.dia ? diaDeLaSemana(viaje.dia) : null;
  const estaciones = String(viaje.ruta || '').split('-').filter(Boolean).map((e) => e.replace(/^0+/, ''));
  const mas = (campo, si) => (base[campo] || 0) + (si ? 1 : 0);

  return {
    periodo,
    metros: (base.metros || 0) + metros,
    segundos: (base.segundos || 0) + (viaje.tiempoSegundos || 0),
    trayectos: mas('trayectos', true),
    mejorVelocidad: Math.max(base.mejorVelocidad || 0, kmh),
    mejorDistancia: Math.max(base.mejorDistancia || 0, metros),
    rapidos: mas('rapidos', kmh >= KMH_RAPIDO),
    largos: mas('largos', metros >= METROS_LARGO),
    nuevas: mas('nuevas', contexto.esEstacionNueva),
    temprano: mas('temprano', minuto !== null && minuto < TEMPRANO_ANTES_DE),
    tarde: mas('tarde', minuto !== null && minuto >= TARDE_DESDE),
    finde: mas('finde', diaSemana === 0 || diaSemana === 6),
    rutaSemana: mas('rutaSemana', contexto.esRutaSemana),
    records: mas('records', contexto.esRecord),
    diarias: (base.diarias || 0) + (contexto.diarias || 0),
    mejorRacha: Math.max(base.mejorRacha || 0, contexto.racha || 0),
    estaciones: conjunto(base.estaciones, estaciones, 40),
    rutas: conjunto(base.rutas, viaje.ruta ? [viaje.ruta] : [], 40),
    dias: conjunto(base.dias, viaje.dia ? [viaje.dia] : [], 31),
  };
}

/** Lo hecho en cada mision, a partir de los totales. */
function progresoDeTotales(lista, totales) {
  return lista.map((m) => {
    const medida = FAMILIAS[m.tipo]?.medida;
    const valor = totales?.[medida];
    const hecho = Array.isArray(valor) ? valor.length : Number(valor) || 0;
    return {
      tipo: m.tipo,
      hecho: Math.round(hecho * 100) / 100,
      objetivo: m.objetivo,
      completada: hecho >= m.objetivo,
    };
  });
}

/** Los puntos de las que ESTE viaje completa (de no hecha a hecha). */
function puntosCompletadas(lista, antes, despues) {
  return despues.reduce((t, p, i) => (p.completada && !(antes && antes[i] && antes[i].completada)
    ? t + ((lista[i] && lista[i].puntos) || 0) : t), 0);
}

/**
 * Todo lo que hace el worker con un viaje que puntua, para los dos periodos.
 *
 * @param {string} hoy  el dia de hoy en Madrid: solo cuenta el periodo en curso
 * @returns {{campos: object, extra: number, completadas: number}}
 *   `campos` va tal cual al update del perfil (`misionesSemana`, `misionesMes`).
 */
function aplicarViaje(previo, dia, viaje, contexto, hoy = dia) {
  const campos = {};
  let extra = 0;
  let completadas = 0;
  for (const [tipo, campo] of [['semana', 'misionesSemana'], ['mes', 'misionesMes']]) {
    const periodo = periodoDe(tipo, dia);
    // Un viaje de un periodo ya cerrado (se subio tarde) no cuenta: si no,
    // ademas, reiniciaria el acumulador del periodo en curso.
    if (periodo !== periodoDe(tipo, hoy)) continue;
    const lista = generar(tipo, periodo).misiones;
    const antes = previo?.[campo]?.periodo === periodo ? previo[campo].progreso : null;
    const totales = acumular(previo?.[campo], periodo, { ...viaje, dia }, contexto);
    const progreso = progresoDeTotales(lista, totales);
    campos[campo] = { ...totales, progreso };
    extra += puntosCompletadas(lista, antes, progreso);
    completadas += progreso.filter((p, i) => p.completada && !(antes && antes[i] && antes[i].completada)).length;
  }
  return { campos, extra, completadas };
}

module.exports = {
  FAMILIAS,
  POR_PERIODO,
  KMH_RAPIDO,
  METROS_LARGO,
  generar,
  acumular,
  progresoDeTotales,
  puntosCompletadas,
  aplicarViaje,
  periodoDe,
  lunesDeDia,
  diasQuedan,
  indiceDe,
};
