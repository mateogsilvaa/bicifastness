'use strict';

/**
 * Influencia de los clanes sobre las estaciones.
 *
 * POR QUE NO SOLO TIEMPOS. La version anterior repartia territorio unicamente
 * por posicion en el ranking de tiempos, asi que el mapa era un juego exclusivo
 * de velocistas: un clan de gente que hace muchos kilometros no podia disputar
 * una estacion por bien que pedaleara.
 *
 * Ahora la influencia tiene tres componentes (docs/JUEGO.md):
 *
 *     0,40 * presencia   viajes del clan que tocan la estacion
 *     0,35 * velocidad   puntos por posicion en los tramos de la estacion
 *     0,25 * volumen     kilometros del clan en esos tramos
 *
 * Cada componente se normaliza ANTES de pesarla. Sin eso, el volumen en metros
 * (decenas de miles) aplastaria a la presencia (unidades) y los pesos no
 * significarian nada.
 *
 * EL DECAIMIENTO ES LA REGLA QUE MANTIENE EL MAPA VIVO. Sin el, el primer clan
 * que llega pinta la ciudad de su color y ahi se queda: no hay nada que hacer
 * ni para el que domina ni para el que llega despues. Con el, mantener el
 * territorio exige pedalear ESTA semana.
 */

const { diaMadrid } = require('./util');

/** Pesos de cada componente. Suman 1. */
const PESOS = { presencia: 0.40, velocidad: 0.35, volumen: 0.25 };

/** Puntos por posicion en un tramo, para la componente de velocidad. */
const POR_POSICION = [10, 7, 5, 4, 3, 2, 2, 1, 1, 1];

/**
 * Cuanto se conserva de un dia para otro.
 *
 * A 0,97 diario, un clan que se para pierde la mitad de su influencia en 23
 * dias: lento como para no castigar una semana mala, rapido como para que
 * abandonar se note.
 */
const CONSERVA_DIARIA = 0.97;

/** Cuota a partir de la cual un clan CONTROLA la estacion. */
const UMBRAL_CONTROL = 50;

/**
 * YYYY-MM-DD, en hora de Madrid.
 *
 * Solo marca CUANDO pasa de un dia al siguiente el decaimiento: se aplica por
 * diferencia entre la fecha guardada y la de hoy, asi que mientras las dos usen
 * el mismo calendario el resultado es el mismo. Aun asi va en Madrid, porque
 * ahora todo el juego cuenta los dias asi y dejar aqui la unica excepcion es
 * dejar una trampa para quien venga despues.
 *
 * El unico dia que NO es de Madrid en todo el proyecto es el de la cuota
 * (`src/cuota.js`), y es porque ese no lo decidimos nosotros.
 */
function dia(fecha = new Date()) {
  return diaMadrid(fecha);
}

/** Normaliza un mapa de valores a 0-1 sobre su maximo. */
function normalizar(porClan) {
  const maximo = Math.max(0, ...Object.values(porClan));
  if (!maximo) return {};

  const salida = {};
  for (const [clan, valor] of Object.entries(porClan)) salida[clan] = valor / maximo;
  return salida;
}

/**
 * Calcula la influencia BRUTA del periodo sobre una estacion.
 *
 * Solo cuenta el mejor tiempo de cada piloto en cada tramo: si no, quien sube
 * diez veces la misma ruta se lleva medio reparto.
 *
 * @param {string} estacionId
 * @param {Array} viajes      verificados, con uid, ruta, tiempoSegundos, distanciaMetros
 * @param {Map} clanPorUid    uid -> clanId
 * @returns {Object} clanId -> influencia 0-100
 */
function influenciaDelPeriodo(estacionId, viajes, clanPorUid) {
  const objetivo = String(estacionId);

  const presencia = {};
  const velocidad = {};
  const volumen = {};

  // Agrupar por tramo los viajes que tocan la estacion.
  const porRuta = new Map();
  for (const v of viajes) {
    if (!v.ruta) continue;
    const [origen, destino] = String(v.ruta).split('-');
    if (origen !== objetivo && destino !== objetivo) continue;

    if (!porRuta.has(v.ruta)) porRuta.set(v.ruta, []);
    porRuta.get(v.ruta).push(v);
  }

  for (const lista of porRuta.values()) {
    // Mejor marca de cada piloto en este tramo.
    const mejorPorPiloto = new Map();
    for (const v of lista) {
      const previo = mejorPorPiloto.get(v.uid);
      if (!previo || v.tiempoSegundos < previo.tiempoSegundos) mejorPorPiloto.set(v.uid, v);
    }

    const orden = [...mejorPorPiloto.values()].sort((a, b) => a.tiempoSegundos - b.tiempoSegundos);

    orden.forEach((viaje, indice) => {
      const clan = clanPorUid.get(viaje.uid);
      if (!clan) return;

      presencia[clan] = (presencia[clan] || 0) + 1;
      velocidad[clan] = (velocidad[clan] || 0) + (POR_POSICION[indice] || 0);
      volumen[clan] = (volumen[clan] || 0) + (viaje.distanciaMetros || 0);
    });
  }

  // Normalizar ANTES de pesar: en crudo, el volumen en metros aplastaria a la
  // presencia y los pesos no significarian nada.
  const nP = normalizar(presencia);
  const nV = normalizar(velocidad);
  const nK = normalizar(volumen);

  const bruta = {};
  for (const clan of new Set([...Object.keys(nP), ...Object.keys(nV), ...Object.keys(nK)])) {
    bruta[clan] = 100 * (
      PESOS.presencia * (nP[clan] || 0)
      + PESOS.velocidad * (nV[clan] || 0)
      + PESOS.volumen * (nK[clan] || 0)
    );
  }

  return bruta;
}

/**
 * Aplica el decaimiento a lo acumulado.
 *
 * Se hace por DIFERENCIA DE FECHAS, no ejecutando una vez al dia. Es
 * deliberado: un cron que tiene que correr exactamente cada dia acaba saltandose
 * alguno (GitHub retrasa los programados con carga), y entonces el territorio se
 * queda congelado sin que nadie lo note. Asi, se ejecute cuando se ejecute, el
 * resultado es el mismo, y ejecutarlo dos veces el mismo dia no descuenta dos
 * veces.
 *
 * @param {Object} acumulado    clanId -> influencia
 * @param {string} desde        YYYY-MM-DD del ultimo decaimiento
 * @param {string} hasta        YYYY-MM-DD de hoy
 */
function decaer(acumulado, desde, hasta) {
  if (!desde || desde >= hasta) return { ...acumulado };

  const dias = Math.round((Date.parse(hasta) - Date.parse(desde)) / 86400000);
  const factor = CONSERVA_DIARIA ** dias;

  const salida = {};
  for (const [clan, valor] of Object.entries(acumulado)) {
    const decaido = valor * factor;
    // Por debajo de esto ya no pinta nada y solo ocupa sitio en el documento.
    if (decaido >= 0.5) salida[clan] = Number(decaido.toFixed(2));
  }
  return salida;
}

/**
 * Combina lo acumulado (ya decaido) con lo nuevo del periodo, y devuelve el
 * reparto en porcentaje mas quien controla la estacion.
 */
function repartir(acumulado, nuevo) {
  const total = {};
  for (const [clan, valor] of Object.entries(acumulado)) total[clan] = valor;
  for (const [clan, valor] of Object.entries(nuevo)) total[clan] = (total[clan] || 0) + valor;

  const suma = Object.values(total).reduce((t, v) => t + v, 0);
  if (!suma) return { acumulado: {}, cuota: {}, dominante: null };

  const cuota = {};
  let dominante = null;
  let mayor = 0;

  for (const [clan, valor] of Object.entries(total)) {
    cuota[clan] = Number(((valor / suma) * 100).toFixed(1));
    if (valor > mayor) { mayor = valor; dominante = clan; }
  }

  // Dominar no es ir primero: hace falta pasar del 50%. Con tres clanes al 34,
  // 33 y 33 la estacion esta EN DISPUTA, que es informacion distinta y mas util
  // que declarar un dueño por un punto.
  const controla = dominante && cuota[dominante] > UMBRAL_CONTROL ? dominante : null;

  return {
    acumulado: Object.fromEntries(
      Object.entries(total).map(([c, v]) => [c, Number(v.toFixed(2))])),
    cuota,
    dominante: controla,
    lider: dominante,
    enDisputa: !controla,
  };
}

module.exports = {
  PESOS,
  POR_POSICION,
  CONSERVA_DIARIA,
  UMBRAL_CONTROL,
  dia,
  normalizar,
  influenciaDelPeriodo,
  decaer,
  repartir,
};
