'use strict';

/**
 * Parametros de negocio y de antifraude, en un solo sitio.
 *
 * Todos estos limites se aplican EN EL SERVIDOR. Antes vivian en el navegador
 * (subir/index.html comprobaba "3 viajes al dia" en JS), lo que significaba que
 * cualquiera podia saltarselos abriendo la consola.
 */

// --- Limites de subida -------------------------------------------------------
const LIMITES = {
  VIAJES_POR_DIA: 3,
  VIAJES_POR_SEMANA: 12,
  SEGUNDOS_ENTRE_SUBIDAS: 60,
  // Antiguedad maxima de un viaje que se puede reclamar.
  DIAS_MAX_ANTIGUEDAD: 30,
  // Tamano maximo de la captura ya comprimida por el cliente.
  MAX_BYTES_IMAGEN: 3 * 1024 * 1024,
  MIMES_IMAGEN: ['image/jpeg', 'image/png', 'image/webp'],
};

// --- Plausibilidad fisica ----------------------------------------------------
const FISICA = {
  // Las BiciMAD son pedaleo asistido con corte legal a 25 km/h (Reglamento UE
  // 168/2013). Por encima de esto en media, sobre distancia de calle estimada,
  // el trayecto es imposible: se rechaza solo.
  VELOCIDAD_IMPOSIBLE_KMH: 25,
  // Franja de sospecha: posible pero muy improbable sostenido en ciudad.
  VELOCIDAD_SOSPECHOSA_KMH: 21,
  // Por debajo de esto es mas lento que andar: no es trampa, pero se revisa.
  VELOCIDAD_MINIMA_KMH: 3.5,
  // La distancia en linea recta infravalora el recorrido real por calle. Este
  // factor la corrige; es el valor habitual para trama urbana densa.
  FACTOR_CALLEJERO: 1.35,
  // Distancia minima entre estaciones para que la ruta cuente como trayecto.
  METROS_MINIMOS: 250,
  // Un tiempo que mejora el record vigente por mas de este margen siempre pasa
  // por revision humana, aunque todo lo demas este limpio.
  MARGEN_RECORD_REVISION: 0.20,
  // Mejora sobre la propia marca historica del piloto que enciende una alerta.
  MARGEN_MEJORA_PERSONAL: 0.35,
  // Cuando una ruta ya tiene bastantes tiempos, su propia distribucion dice
  // mucho mas que un umbral fijo. Por debajo de este numero de marcas no hay
  // estadistica suficiente y no se aplica la comprobacion.
  MINIMO_MUESTRAS_ESTADISTICA: 6,
  // Cuantas desviaciones tipicas por debajo de la media empieza a ser raro.
  DESVIACIONES_SOSPECHOSA: 2.5,
};

// --- Horario del servicio ----------------------------------------------------
/**
 * BiciMAD opera 24 h, pero la actividad real de madrugada es residual y es la
 * franja donde se concentran los intentos de colar tiempos inventados. No se
 * rechaza por esto: solo se marca para que lo mire una persona.
 */
const HORARIO = {
  HORA_INICIO_MADRUGADA: 2,
  HORA_FIN_MADRUGADA: 5,
};

// --- Duracion valida de un trayecto -----------------------------------------
const TIEMPO = {
  MIN_SEGUNDOS: 30,
  MAX_SEGUNDOS: 2 * 60 * 60,
};

// --- Umbrales de decision automatica ----------------------------------------
/**
 * El pipeline acumula puntos de riesgo. La decision final:
 *   riesgo <  UMBRAL_APROBACION  -> aprobado automaticamente
 *   riesgo >= UMBRAL_RECHAZO     -> rechazado automaticamente
 *   en medio                     -> cola de revision manual
 * Cualquier veredicto marcado como concluyente (`decisivo`) corta el proceso y
 * decide por si solo, sin pasar por la suma de puntos.
 */
const RIESGO = {
  UMBRAL_APROBACION: 20,
  UMBRAL_RECHAZO: 70,
};

// --- Deteccion de imagen duplicada ------------------------------------------
const IMAGEN = {
  // Distancia de Hamming sobre el dHash de 64 bits. 0 = identica.
  // <= 6 sobre capturas de movil distintas es practicamente la misma imagen.
  MAX_DISTANCIA_PERCEPTUAL: 6,
  /**
   * Cuantos hashes recientes comparamos (los mas nuevos primero).
   *
   * Esto solo acota la comparacion PERCEPTUAL, la que pilla una captura
   * recomprimida o recortada. La byte a byte no depende de esta ventana: el id
   * del documento de `huellas_captura` ES el sha, asi que se busca directa y
   * pilla el duplicado por viejo que sea.
   *
   * 150 y no 400 porque era la lectura mas cara del worker — 400 documentos por
   * cada viaje procesado, 153.600 al dia con 240 subidas (docs/COSTE.md) — y lo
   * que se pierde es poco: recomprimir una captura para colarla otra vez se hace
   * a los pocos dias del original, no meses despues. Y aunque se pierda, es la
   * comprobacion blanda: el duplicado exacto sigue siendo infalible.
   */
  VENTANA_COMPARACION: 150,
};

// --- Puntuacion de la competicion -------------------------------------------
const PUNTOS = {
  // Puntos por posicion en el ranking de una ruta.
  POR_POSICION: [80, 65, 55, 35, 35, 20, 20],
  POR_VIAJE_VERIFICADO: 5,
  MULTIPLICADOR_RUTA_DESTACADA: 2,
  MULTIPLICADOR_RUTA_HISTORICA: 1.5,
  // Puntos que aporta cada piloto a su clan por dominar una estacion.
  ESTACION_POR_POSICION: [7, 5, 3, 1, 1, 1, 1, 1, 1, 1],
};

// --- Puntos de cada viaje ----------------------------------------------------
/**
 * La v1 solo media el tiempo entre dos estaciones, asi que solo puntuaba ir
 * rapido: quien hacia 40 km tranquilos a la semana no aparecia en ningun sitio
 * y se iba. Estos numeros reparten los puntos entre distancia y velocidad para
 * que quepan los dos perfiles. Ver docs/JUEGO.md.
 *
 * Comprobacion de que ninguno domina al otro:
 *   velocista  1,5 km a 20 km/h -> 10 + 9  + 30 = 49
 *   fondista   6,0 km a 12 km/h -> 10 + 36 + 10 = 56
 *   diario     2,5 km a 13 km/h -> 10 + 15 + 13 = 38
 */
const VIAJE = {
  BASE: 10,
  PUNTOS_POR_KM: 6,
  // Por debajo de esta velocidad no se puntua por ir rapido, pero TAMPOCO se
  // resta: un trayecto lento sigue sumando por base y por distancia.
  VELOCIDAD_UMBRAL_KMH: 8,
  PUNTOS_POR_KMH: 2.5,
  // Bonus por pedalear en una estacion que controla tu clan. Solo un 10%: mas
  // alto convertiria el juego en una bola de nieve, porque el clan que domina
  // puntuaria mas y con ello dominaria mas.
  MULTIPLICADOR_TERRITORIO: 1.1,
};

// --- Racha diaria ------------------------------------------------------------
/**
 * El escudo no es un regalo: perder una racha de 40 dias por un dia de gripe
 * hace que la gente ABANDONE, no que se esfuerce mas. Y se gasta solo, porque
 * si hubiera que entrar en la web a usarlo seria el mismo problema que intenta
 * evitar.
 */
const RACHA = {
  INCREMENTO_POR_DIA: 0.05,
  DIAS_TOPE: 10,          // el multiplicador deja de crecer aqui: x1,5
  DIAS_POR_ESCUDO: 7,
  MAX_ESCUDOS: 2,
};

// --- Version vigente de los textos legales ----------------------------------
/**
 * Al subir la version se fuerza a todos los usuarios a volver a aceptar los
 * terminos. El consentimiento queda registrado con esta version, la fecha y el
 * hash del documento, que es lo que exige el RGPD para poder demostrarlo.
 */
const LEGAL = {
  VERSION_TERMINOS: '1.3.0',
  VERSION_PRIVACIDAD: '1.3.0',
};

module.exports = { LIMITES, FISICA, TIEMPO, RIESGO, IMAGEN, PUNTOS, VIAJE, RACHA, LEGAL, HORARIO };
