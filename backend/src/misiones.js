'use strict';

/**
 * Misiones diarias y ruta del dia.
 *
 * TRES MISIONES AL DIA, IGUALES PARA TODO EL MUNDO.
 *
 * Que sean iguales no es pereza: es lo que permite que las lea todo el mundo con
 * UNA lectura cacheable de `config/misiones/{fecha}` en vez de una por usuario.
 * El progreso individual va en el propio documento del usuario, que ya se lee de
 * todas formas.
 *
 * SE GENERAN DE FORMA DETERMINISTA A PARTIR DE LA FECHA.
 *
 * Esto importa mas de lo que parece. El worker corre cada pocos minutos: si las
 * misiones salieran de `Math.random()`, cada pasada generaria otras distintas y
 * alguien que llevara media mision hecha a las 11:00 se encontraria otra a las
 * 11:05. Con la fecha como semilla, el dia entero produce siempre lo mismo, y
 * regenerarlas es inofensivo.
 *
 * SIEMPRE hay una de distancia y una de velocidad, para que ningun perfil de
 * piloto se quede sin poder completarlas. La tercera rota.
 */

/** Generador con semilla. No necesita ser bueno, necesita ser reproducible. */
function generador(semilla) {
  let estado = 0;
  for (let i = 0; i < semilla.length; i++) {
    estado = (estado * 31 + semilla.charCodeAt(i)) | 0;
  }

  return () => {
    // xorshift de 32 bits: corto, sin dependencias y suficiente para elegir
    // entre cuatro opciones.
    estado ^= estado << 13;
    estado ^= estado >>> 17;
    estado ^= estado << 5;
    return Math.abs(estado) / 2147483647;
  };
}

/** Elige un elemento de una lista con el generador dado. */
const elegir = (azar, lista) => lista[Math.floor(azar() * lista.length) % lista.length];

/**
 * Lo que da cada mision al completarla, UNA vez por dia (02 Hoy: "+20").
 *
 * Una mision sin premio es una lista de tareas. Se suman a los puntos del viaje
 * que la completa, dentro de la misma transaccion, asi que no cuestan ninguna
 * escritura aparte; y como van en `puntos` del viaje, anular ese viaje los
 * devuelve con el resto (`revertirPremio`).
 *
 * Modestos a proposito: un trayecto normal da 40-70. La mision empuja a salir,
 * no decide la clasificacion.
 */
const PUNTOS_MISION = {
  distancia: 20,
  velocidad: 15,
  trayectos: 15,
  exploracion: 25,
  largo: 20,
  minutos: 15,
  estaciones: 20,
  temprano: 20,
  tarde: 15,
};

/** Hora de salida 'HH:MM' en minutos del dia, o null si no se leyo. */
function minutosDeHora(hora) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hora || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Antes de las 9:30 cuenta como trayecto madrugador. */
const TEMPRANO_ANTES_DE = 9 * 60 + 30;
/** Desde las 20:00, de tarde-noche. */
const TARDE_DESDE = 20 * 60;

/**
 * Las familias de mision.
 *
 * Los objetivos son deliberadamente modestos. Una mision que no se puede
 * completar en un trayecto normal no invita a salir: invita a ignorarla.
 */
const FAMILIAS = {
  distancia: (azar) => {
    const km = elegir(azar, [3, 4, 5, 6]);
    return {
      tipo: 'distancia',
      objetivo: km * 1000,
      texto: `Recorre ${km} km hoy`,
      ayuda: 'Suman todos tus trayectos del dia.',
      puntos: PUNTOS_MISION.distancia,
    };
  },

  velocidad: (azar) => {
    const kmh = elegir(azar, [13, 14, 15, 16]);
    return {
      tipo: 'velocidad',
      objetivo: kmh,
      texto: `Mas de ${kmh} km/h en un trayecto`,
      ayuda: 'Basta con que lo consigas en uno.',
      puntos: PUNTOS_MISION.velocidad,
    };
  },

  trayectos: (azar) => {
    const cuantos = elegir(azar, [1, 2]);
    return {
      tipo: 'trayectos',
      objetivo: cuantos,
      texto: cuantos === 1 ? 'Sube un trayecto hoy' : `Sube ${cuantos} trayectos hoy`,
      ayuda: 'Cuentan solo los que se verifiquen.',
      puntos: PUNTOS_MISION.trayectos,
    };
  },

  // Un trayecto largo de una sola vez (no suman varios).
  largo: (azar) => {
    const km = elegir(azar, [2.5, 3, 3.5, 4]);
    return {
      tipo: 'largo',
      objetivo: km * 1000,
      texto: `Un trayecto de mas de ${String(km).replace('.', ',')} km`,
      ayuda: 'Tiene que ser en un solo trayecto.',
      puntos: PUNTOS_MISION.largo,
    };
  },

  // Tiempo encima de la bici, sumando los trayectos del dia.
  minutos: (azar) => {
    const min = elegir(azar, [20, 25, 30, 40]);
    return {
      tipo: 'minutos',
      objetivo: min * 60,
      texto: `Pedalea ${min} minutos hoy`,
      ayuda: 'Suman todos tus trayectos del dia.',
      puntos: PUNTOS_MISION.minutos,
    };
  },

  exploracion: () => ({
    tipo: 'exploracion',
    objetivo: 1,
    texto: 'Termina en una estacion nueva',
    ayuda: 'Cualquiera en la que no hayas acabado antes.',
    puntos: PUNTOS_MISION.exploracion,
  }),

  // Moverse por la ciudad, no repetir el mismo tramo: cuentan origen y destino.
  estaciones: (azar) => {
    const cuantas = elegir(azar, [3, 4]);
    return {
      tipo: 'estaciones',
      objetivo: cuantas,
      texto: `Pasa por ${cuantas} estaciones distintas hoy`,
      ayuda: 'Cuentan la de salida y la de llegada de cada trayecto.',
      puntos: PUNTOS_MISION.estaciones,
    };
  },

  // La hora sale de la captura (la de salida que lee el OCR). Sin hora leida,
  // ese trayecto no cuenta para esta mision: no hay forma de saberlo.
  temprano: () => ({
    tipo: 'temprano',
    objetivo: 1,
    texto: 'Un trayecto antes de las 9:30',
    ayuda: 'Cuenta la hora de salida de la captura.',
    puntos: PUNTOS_MISION.temprano,
  }),

  tarde: () => ({
    tipo: 'tarde',
    objetivo: 1,
    texto: 'Un trayecto a partir de las 20:00',
    ayuda: 'Cuenta la hora de salida de la captura.',
    puntos: PUNTOS_MISION.tarde,
  }),
};

/**
 * Cada hueco rota entre varias familias, para que no sean siempre las mismas
 * tres: uno de volumen (distancia, tiempo o estaciones), uno de esfuerzo
 * (velocidad o trayecto largo), y uno de habito (trayectos, explorar, o la
 * hora del dia).
 *
 * El de esfuerzo sigue teniendo solo dos a proposito: es el que mas pesa en
 * quien va rapido, y la velocidad tiene que salir a menudo.
 */
const HUECOS = [
  ['distancia', 'minutos', 'estaciones'],
  ['velocidad', 'largo'],
  ['trayectos', 'exploracion', 'temprano', 'tarde'],
];

/**
 * Genera las tres misiones de un dia.
 * @param {string} fecha  YYYY-MM-DD
 */
function generar(fecha) {
  const azar = generador(fecha);

  return {
    fecha,
    // Cada hueco elige familia con su propia semilla: el primer numero del
    // generador de una fecha sale sesgado y un hueco se quedaba siempre igual.
    misiones: HUECOS.map((opciones, i) => FAMILIAS[elegir(generador(`${fecha}#${i}`), opciones)](azar)),
  };
}

/**
 * Progreso de un piloto sobre las misiones del dia.
 *
 * Es una funcion pura sobre los viajes del dia: se puede probar entera, y el
 * worker la usa tras verificar cada viaje.
 *
 * @param {Array} misiones
 * @param {Array} viajesDelDia  verificados hoy, con distanciaMetros y velocidadKmh
 * @param {Set} estacionesPrevias  estaciones donde el piloto ya habia terminado
 */
function progreso(misiones, viajesDelDia, estacionesPrevias = new Set()) {
  return progresoDeTotales(misiones, totalesDelDia(viajesDelDia, estacionesPrevias));
}

/**
 * Los cuatro numeros de los que depende cualquier mision, sacados de una lista
 * de viajes.
 *
 * @returns {{metros: number, mejorVelocidad: number, trayectos: number, nuevas: number}}
 */
function totalesDelDia(viajesDelDia, estacionesPrevias = new Set()) {
  const estaciones = new Set();
  for (const v of viajesDelDia) {
    for (const e of String(v.ruta || '').split('-')) if (e) estaciones.add(e.replace(/^0+/, ''));
  }
  const horas = viajesDelDia.map((v) => minutosDeHora(v.horaSalida)).filter((m) => m !== null);
  return {
    estaciones: [...estaciones],
    temprano: horas.filter((m) => m < TEMPRANO_ANTES_DE).length,
    tarde: horas.filter((m) => m >= TARDE_DESDE).length,
    metros: viajesDelDia.reduce((t, v) => t + (v.distanciaMetros || 0), 0),
    mejorVelocidad: Math.max(0, ...viajesDelDia.map((v) => v.velocidadKmh || 0)),
    trayectos: viajesDelDia.length,
    mejorDistancia: Math.max(0, ...viajesDelDia.map((v) => v.distanciaMetros || 0)),
    segundos: viajesDelDia.reduce((t, v) => t + (v.tiempoSegundos || 0), 0),
    nuevas: viajesDelDia.filter((v) => {
      const destino = String(v.ruta || '').split('-')[1];
      return destino && !estacionesPrevias.has(destino);
    }).length,
  };
}

/**
 * Suma un viaje a los totales del dia, sin releer los anteriores.
 *
 * Es el camino que usa el worker. La alternativa —consultar los viajes
 * verificados de hoy cada vez que se aprueba uno— seria una consulta por viaje
 * aprobado para recalcular algo que ya sabiamos. El acumulador vive en el propio
 * documento del usuario, que la transaccion ya tiene leido.
 *
 * `fecha` es el dia al que pertenecen los totales. Si no coincide con la del
 * acumulador, se empieza de cero: es el cambio de dia.
 */
function acumular(totales, fecha, viaje, esEstacionNueva = false) {
  const base = (totales && totales.fecha === fecha)
    ? totales
    : { fecha, metros: 0, mejorVelocidad: 0, trayectos: 0, nuevas: 0, mejorDistancia: 0, segundos: 0 };

  // Las estaciones del dia, sin repetir y con tope: el documento del usuario no
  // tiene por que crecer con un dia raro de muchos trayectos.
  const estaciones = new Set(Array.isArray(base.estaciones) ? base.estaciones : []);
  for (const e of String(viaje.ruta || '').split('-')) if (e) estaciones.add(e.replace(/^0+/, ''));
  const minuto = minutosDeHora(viaje.horaSalida);

  return {
    fecha,
    metros: (base.metros || 0) + (viaje.distanciaMetros || 0),
    mejorVelocidad: Math.max(base.mejorVelocidad || 0, viaje.velocidadKmh || 0),
    trayectos: (base.trayectos || 0) + 1,
    nuevas: (base.nuevas || 0) + (esEstacionNueva ? 1 : 0),
    mejorDistancia: Math.max(base.mejorDistancia || 0, viaje.distanciaMetros || 0),
    segundos: (base.segundos || 0) + (viaje.tiempoSegundos || 0),
    estaciones: [...estaciones].slice(0, 20),
    temprano: (base.temprano || 0) + (minuto !== null && minuto < TEMPRANO_ANTES_DE ? 1 : 0),
    tarde: (base.tarde || 0) + (minuto !== null && minuto >= TARDE_DESDE ? 1 : 0),
  };
}

/** Progreso a partir de totales ya calculados. */
function progresoDeTotales(misiones, totales) {
  return misiones.map((m) => {
    const hecho = {
      distancia: totales.metros || 0,
      velocidad: totales.mejorVelocidad || 0,
      trayectos: totales.trayectos || 0,
      exploracion: totales.nuevas || 0,
      largo: totales.mejorDistancia || 0,
      minutos: totales.segundos || 0,
      estaciones: Array.isArray(totales.estaciones) ? totales.estaciones.length : 0,
      temprano: totales.temprano || 0,
      tarde: totales.tarde || 0,
    }[m.tipo] || 0;

    return {
      tipo: m.tipo,
      hecho: Math.round(hecho * 100) / 100,
      objetivo: m.objetivo,
      completada: hecho >= m.objetivo,
    };
  });
}

/** Cuantas misiones pasa ESTE viaje de no hechas a hechas (para las insignias). */
function cuantasCompletadas(antes, despues) {
  return despues.filter((p, i) => p.completada && !(antes && antes[i] && antes[i].completada)).length;
}

/**
 * Los puntos de las misiones que ESTE viaje acaba de completar.
 *
 * Compara el progreso de antes con el de despues: solo cuenta la que pasa de
 * no hecha a hecha. Asi el segundo viaje del dia no vuelve a cobrar la mision
 * que ya completo el primero, sin guardar nada mas que lo que ya se guardaba.
 *
 * @param {Array} misionesDelDia  las de `generar(fecha).misiones`
 * @param {Array|null} antes  progreso previo del mismo dia (o null)
 * @param {Array} despues  progreso tras este viaje
 */
function puntosCompletadas(misionesDelDia, antes, despues) {
  return despues.reduce((total, p, i) => {
    const yaEstaba = Boolean(antes && antes[i] && antes[i].completada);
    if (!p.completada || yaEstaba) return total;
    return total + ((misionesDelDia[i] && misionesDelDia[i].puntos) || 0);
  }, 0);
}

/**
 * Elige la ruta del dia.
 *
 * Un ranking que empieza vacio cada manana es un ranking que PUEDE GANAR
 * cualquiera, incluido quien se registro ayer. Es la razon mas directa para
 * abrir la web hoy, y los records historicos del tramo no se tocan.
 *
 * Se descartan los tramos con poca actividad: una ruta del dia desierta no
 * invita a nada, y ademas el multiplicador x2 sobre un tramo que nadie hace es
 * regalar puntos al primero que pase.
 *
 * @param {Map<string, number>} viajesPorRuta  ruta -> cuantos viajes tiene
 * @param {Array} recientes  rutas destacadas ultimamente, para no repetir
 * @param {string} fecha
 */
function rutaDelDia(viajesPorRuta, recientes = [], fecha = '') {
  const MINIMO = 3;

  const candidatas = [...viajesPorRuta.entries()]
    .filter(([ruta, cuantos]) => cuantos >= MINIMO && !recientes.includes(ruta))
    .map(([ruta]) => ruta)
    .sort();

  // Si todas las que valen se han usado hace poco, se permite repetir: mejor
  // repetir que quedarse sin ruta del dia.
  const finales = candidatas.length
    ? candidatas
    : [...viajesPorRuta.entries()].filter(([, c]) => c >= MINIMO).map(([r]) => r).sort();

  if (!finales.length) return null;

  return elegir(generador(`ruta-${fecha}`), finales);
}

module.exports = {
  PUNTOS_MISION,
  puntosCompletadas,
  cuantasCompletadas,
  FAMILIAS,
  HUECOS,
  generador,
  generar,
  progreso,
  totalesDelDia,
  acumular,
  progresoDeTotales,
  rutaDelDia,
};
