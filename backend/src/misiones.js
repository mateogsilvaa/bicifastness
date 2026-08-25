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
    };
  },

  velocidad: (azar) => {
    const kmh = elegir(azar, [13, 14, 15, 16]);
    return {
      tipo: 'velocidad',
      objetivo: kmh,
      texto: `Manten mas de ${kmh} km/h en un trayecto`,
      ayuda: 'Basta con que lo consigas en uno.',
    };
  },

  trayectos: (azar) => {
    const cuantos = elegir(azar, [1, 2]);
    return {
      tipo: 'trayectos',
      objetivo: cuantos,
      texto: cuantos === 1 ? 'Sube un trayecto hoy' : `Sube ${cuantos} trayectos hoy`,
      ayuda: 'Cuentan solo los que se verifiquen.',
    };
  },

  exploracion: () => ({
    tipo: 'exploracion',
    objetivo: 1,
    texto: 'Termina en una estacion que no hayas usado nunca',
    ayuda: 'Cualquiera en la que no hayas acabado antes.',
  }),
};

/** La tercera mision rota entre estas. */
const ROTATORIAS = ['trayectos', 'exploracion'];

/**
 * Genera las tres misiones de un dia.
 * @param {string} fecha  YYYY-MM-DD
 */
function generar(fecha) {
  const azar = generador(fecha);

  return {
    fecha,
    misiones: [
      FAMILIAS.distancia(azar),
      FAMILIAS.velocidad(azar),
      FAMILIAS[elegir(azar, ROTATORIAS)](azar),
    ],
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
  return {
    metros: viajesDelDia.reduce((t, v) => t + (v.distanciaMetros || 0), 0),
    mejorVelocidad: Math.max(0, ...viajesDelDia.map((v) => v.velocidadKmh || 0)),
    trayectos: viajesDelDia.length,
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
    : { fecha, metros: 0, mejorVelocidad: 0, trayectos: 0, nuevas: 0 };

  return {
    fecha,
    metros: (base.metros || 0) + (viaje.distanciaMetros || 0),
    mejorVelocidad: Math.max(base.mejorVelocidad || 0, viaje.velocidadKmh || 0),
    trayectos: (base.trayectos || 0) + 1,
    nuevas: (base.nuevas || 0) + (esEstacionNueva ? 1 : 0),
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
    }[m.tipo] || 0;

    return {
      tipo: m.tipo,
      hecho: Math.round(hecho * 100) / 100,
      objetivo: m.objetivo,
      completada: hecho >= m.objetivo,
    };
  });
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
  FAMILIAS,
  ROTATORIAS,
  generador,
  generar,
  progreso,
  totalesDelDia,
  acumular,
  progresoDeTotales,
  rutaDelDia,
};
