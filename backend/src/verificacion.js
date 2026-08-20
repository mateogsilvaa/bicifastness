'use strict';

/**
 * Motor de verificacion de viajes.
 *
 * Recibe un viaje ya validado en formato y devuelve un veredicto:
 *   { decision: 'aprobado' | 'rechazado' | 'revision', riesgo, señales[] }
 *
 * Cada comprobacion devuelve una "señal" con codigo, gravedad y explicacion.
 * Una señal puede ser `decisiva`, y entonces zanja el resultado por si sola
 * (por ejemplo: fisicamente imposible, o captura ya usada en otro viaje).
 * El resto suman puntos de riesgo y deciden por umbral.
 */

const { FISICA, RIESGO, IMAGEN, HORARIO } = require('./config');
const { buscarEstacion, distanciaMetros, horaASegundos } = require('./util');
const { distanciaHamming } = require('./imagen');

// --- Constructores de señal ---------------------------------------------------
const señal = (codigo, gravedad, mensaje, extra = {}) => ({
  codigo, gravedad, mensaje, ...extra,
});
const fatal = (codigo, mensaje, extra) =>
  señal(codigo, 100, mensaje, { ...extra, decisiva: 'rechazado' });

/**
 * Distancia estimada por calle entre dos estaciones, en metros.
 * La linea recta infravalora el recorrido real, asi que la corregimos con un
 * factor de trama urbana. Es una estimacion conservadora a proposito: preferimos
 * dejar pasar un caso dudoso a revision que rechazar un tiempo legitimo.
 */
function distanciaCalleMetros(idOrigen, idDestino) {
  const a = buscarEstacion(idOrigen);
  const b = buscarEstacion(idDestino);
  if (!a || !b) return null;
  return distanciaMetros(a, b) * FISICA.FACTOR_CALLEJERO;
}

/** Velocidad media implicita en km/h. */
function velocidadKmh(metros, segundos) {
  if (!metros || !segundos) return null;
  return (metros / segundos) * 3.6;
}

// --- Comprobacion 1: plausibilidad fisica ------------------------------------
/**
 * La comprobacion mas potente y la unica que no se puede falsificar con una
 * captura mejor hecha: la geografia no negocia. Las BiciMAD son de pedaleo
 * asistido con corte legal a 25 km/h, asi que hay un suelo duro de tiempo para
 * cada par de estaciones.
 */
function comprobarFisica({ ruta, tiempoSegundos }) {
  const [origen, destino] = ruta.split('-');
  const metros = distanciaCalleMetros(origen, destino);
  const señales = [];

  if (metros === null) {
    return { señales: [señal('geo_desconocida', 15, 'No hay coordenadas para alguna estacion de la ruta.')], metros: null, kmh: null };
  }

  if (metros < FISICA.METROS_MINIMOS) {
    señales.push(señal('ruta_trivial', 25,
      `Las dos estaciones estan a solo ${Math.round(metros)} m: el trayecto es demasiado corto para competir.`));
  }

  const kmh = velocidadKmh(metros, tiempoSegundos);

  if (kmh > FISICA.VELOCIDAD_IMPOSIBLE_KMH) {
    señales.push(fatal('velocidad_imposible',
      `Velocidad media de ${kmh.toFixed(1)} km/h sobre ${Math.round(metros)} m estimados. ` +
      `Una BiciMAD corta la asistencia a ${FISICA.VELOCIDAD_IMPOSIBLE_KMH} km/h: el tiempo declarado es fisicamente imposible.`,
      { kmh: Number(kmh.toFixed(1)), metros: Math.round(metros) }));
  } else if (kmh > FISICA.VELOCIDAD_SOSPECHOSA_KMH) {
    señales.push(señal('velocidad_sospechosa', 40,
      `Velocidad media de ${kmh.toFixed(1)} km/h: posible, pero muy alta para trafico urbano.`,
      { kmh: Number(kmh.toFixed(1)) }));
  } else if (kmh < FISICA.VELOCIDAD_MINIMA_KMH) {
    señales.push(señal('velocidad_muy_baja', 10,
      `Velocidad media de ${kmh.toFixed(1)} km/h, mas lento que andar.`,
      { kmh: Number(kmh.toFixed(1)) }));
  }

  return { señales, metros: Math.round(metros), kmh: kmh ? Number(kmh.toFixed(1)) : null };
}

// --- Comprobacion 2: coherencia de la captura con lo declarado ---------------
/**
 * Cruza lo que se ha LEIDO en la imagen con lo que el usuario ha escrito, y
 * ademas comprueba que la propia captura sea coherente consigo misma:
 * llegada - salida tiene que dar la duracion del recuadro.
 *
 * Esa resta es la comprobacion mas valiosa de todo el bloque, y desde que se
 * quito la IA es ademas la principal defensa contra el retoque: quien manipula
 * una captura cambia el numero grande y se deja las horas. Es determinista, o
 * sea que no opina ni falla distinto cada vez.
 */
function comprobarCaptura({ ruta, tiempoSegundos, lectura }) {
  const señales = [];

  if (!lectura.disponible) {
    señales.push(señal('lectura_no_disponible', 30,
      `No se ha podido leer la captura automaticamente (${lectura.error}). Requiere revision humana.`));
    return señales;
  }

  if (!lectura.esBicimad) {
    señales.push(fatal('no_es_bicimad', 'La imagen no parece una captura de la app BiciMAD.'));
    return señales;
  }

  // La confianza la da el propio OCR, no un juicio. Por debajo de esto lo que
  // haya leido no es de fiar y decide una persona.
  if (lectura.confianza < 55) {
    señales.push(señal('lectura_poco_segura', 25,
      `La lectura de la captura solo alcanza un ${lectura.confianza}% de confianza.`));
  }

  // Coherencia interna de la propia captura.
  const salida = horaASegundos(lectura.horaSalida);
  const llegada = horaASegundos(lectura.horaLlegada);
  if (salida !== null && llegada !== null && lectura.segundosDuracion !== null) {
    let diferencia = llegada - salida;
    if (diferencia < 0) diferencia += 24 * 3600; // el viaje cruza la medianoche
    const desviacion = Math.abs(diferencia - lectura.segundosDuracion);

    if (desviacion > 90) {
      señales.push(fatal('captura_incoherente',
        `Entre las horas de la captura hay ${diferencia}s, pero el recuadro de duracion marca ${lectura.segundosDuracion}s. ` +
        'La imagen ha sido retocada.',
        { diferenciaHoras: diferencia, duracionMostrada: lectura.segundosDuracion }));
    } else if (desviacion > 5) {
      señales.push(señal('captura_desviada', 30,
        `Descuadre de ${desviacion}s entre las horas y la duracion mostrada.`));
    }
  } else {
    señales.push(señal('horas_ilegibles', 15, 'No se han podido leer con claridad las horas de la captura.'));
  }

  // Coherencia con lo que ha escrito el usuario.
  const [origenDeclarado, destinoDeclarado] = ruta.split('-').map((v) => v.replace(/^0+/, ''));
  const origenLeido = lectura.origen.replace(/^0+/, '');
  const destinoLeido = lectura.destino.replace(/^0+/, '');

  if (origenLeido && destinoLeido) {
    if (origenLeido !== origenDeclarado || destinoLeido !== destinoDeclarado) {
      señales.push(señal('ruta_no_coincide', 60,
        `En la captura se lee la ruta ${origenLeido}-${destinoLeido}, pero se ha declarado ${origenDeclarado}-${destinoDeclarado}.`));
    }
  } else {
    señales.push(señal('estaciones_ilegibles', 20, 'No se han podido leer las estaciones en la captura.'));
  }

  if (lectura.segundosDuracion !== null) {
    const desfase = Math.abs(lectura.segundosDuracion - tiempoSegundos);
    if (desfase > 60) {
      señales.push(señal('tiempo_no_coincide', 60,
        `La captura marca ${lectura.segundosDuracion}s pero se han declarado ${tiempoSegundos}s.`));
    } else if (desfase > 5) {
      señales.push(señal('tiempo_desviado', 25,
        `Diferencia de ${desfase}s entre la captura y el tiempo declarado.`));
    }
  }

  return señales;
}

// --- Comprobacion 3: reutilizacion de la captura -----------------------------
/**
 * `hashesPrevios` son los dHash de las capturas recientes de CUALQUIER usuario,
 * no solo del que sube. Asi se detecta tambien que dos cuentas suban la misma
 * imagen, que es el patron tipico de las cuentas multiples.
 */
function comprobarDuplicado({ hashSha, hashPerceptual, shaPrevios, hashesPrevios }) {
  const señales = [];

  const duplicadoExacto = shaPrevios.find((p) => p.sha === hashSha);
  if (duplicadoExacto) {
    señales.push(fatal('captura_reutilizada',
      duplicadoExacto.uid
        ? 'Esta captura ya se habia subido antes, byte a byte.'
        : 'Esta captura ya se habia subido antes.',
      { viajeOriginal: duplicadoExacto.tripId }));
    return señales;
  }

  if (!hashPerceptual) return señales;

  let masParecido = null;
  for (const previo of hashesPrevios) {
    if (!previo.dhash) continue;
    const distancia = distanciaHamming(hashPerceptual, previo.dhash);
    if (!masParecido || distancia < masParecido.distancia) {
      masParecido = { ...previo, distancia };
    }
  }

  if (masParecido && masParecido.distancia <= IMAGEN.MAX_DISTANCIA_PERCEPTUAL) {
    señales.push(fatal('captura_casi_identica',
      `La captura es practicamente identica a la de otro viaje ya registrado ` +
      `(distancia perceptual ${masParecido.distancia}). Recomprimir o recortar una imagen no la convierte en nueva.`,
      { viajeOriginal: masParecido.tripId, distancia: masParecido.distancia }));
  } else if (masParecido && masParecido.distancia <= IMAGEN.MAX_DISTANCIA_PERCEPTUAL + 4) {
    señales.push(señal('captura_parecida', 35,
      `La captura se parece mucho a la de otro viaje (distancia ${masParecido.distancia}).`,
      { viajeOriginal: masParecido.tripId }));
  }

  return señales;
}

// --- Comprobacion 4: contexto del piloto y del record ------------------------
/**
 * Aunque todo lo anterior este limpio, hay dos situaciones que merecen ojos
 * humanos: pulverizar el record de una ruta, y mejorarse a uno mismo de forma
 * abrupta. No son trampa por si mismas, pero es donde mas duele equivocarse.
 */
function comprobarContexto({ tiempoSegundos, mejorTiempoRuta, mejorTiempoPropio, edicionSospechosa, software }) {
  const señales = [];

  if (edicionSospechosa) {
    señales.push(señal('metadatos_edicion', 45,
      `La imagen conserva metadatos de ${software}. Una captura de pantalla autentica no pasa por un editor.`));
  }

  if (mejorTiempoRuta && tiempoSegundos < mejorTiempoRuta) {
    const mejora = (mejorTiempoRuta - tiempoSegundos) / mejorTiempoRuta;
    if (mejora > FISICA.MARGEN_RECORD_REVISION) {
      señales.push(señal('record_pulverizado', 35,
        `Bate el record de la ruta en un ${(mejora * 100).toFixed(0)}%. Todo record roto por mucho margen se revisa a mano.`,
        { mejoraPct: Number((mejora * 100).toFixed(1)) }));
    }
  }

  if (mejorTiempoPropio && tiempoSegundos < mejorTiempoPropio) {
    const mejora = (mejorTiempoPropio - tiempoSegundos) / mejorTiempoPropio;
    if (mejora > FISICA.MARGEN_MEJORA_PERSONAL) {
      señales.push(señal('salto_personal', 20,
        `Mejora su propia marca en esta ruta en un ${(mejora * 100).toFixed(0)}%.`,
        { mejoraPct: Number((mejora * 100).toFixed(1)) }));
    }
  }

  return señales;
}

// --- Comprobacion 5: la ruta contra su propia distribucion -------------------
/**
 * Un umbral fijo de velocidad es tosco: hay rutas cuesta abajo y rutas con seis
 * semaforos. En cuanto una ruta acumula unas cuantas marcas, su propia
 * distribucion es un detector mucho mejor: si un tiempo se sale varias
 * desviaciones tipicas por debajo de lo que consigue todo el mundo, algo pasa
 * aunque la velocidad media este dentro de lo teoricamente posible.
 */
function comprobarEstadistica({ tiempoSegundos, tiemposRuta }) {
  const muestras = (tiemposRuta || []).filter((t) => Number.isFinite(t));
  if (muestras.length < FISICA.MINIMO_MUESTRAS_ESTADISTICA) return [];

  const media = muestras.reduce((a, b) => a + b, 0) / muestras.length;
  const varianza = muestras.reduce((a, t) => a + (t - media) ** 2, 0) / muestras.length;
  const desviacion = Math.sqrt(varianza);

  // Sin dispersion no hay nada que medir (todos han hecho el mismo tiempo).
  if (desviacion < 1) return [];

  const z = (media - tiempoSegundos) / desviacion;
  if (z < FISICA.DESVIACIONES_SOSPECHOSA) return [];

  return [señal('atipico_estadistico', 30,
    `El tiempo esta ${z.toFixed(1)} desviaciones por debajo de la media de la ruta ` +
    `(${Math.round(media)}s de media en ${muestras.length} marcas).`,
    { z: Number(z.toFixed(2)), mediaRuta: Math.round(media), muestras: muestras.length })];
}

// --- Comprobacion 6: perfil del propio piloto --------------------------------
/**
 * Compara la velocidad de este trayecto con la que el piloto viene sosteniendo
 * en sus viajes ya verificados. Un salto brusco no prueba nada por si solo
 * — se puede mejorar de verdad — pero combinado con otras señales pesa.
 */
function comprobarPerfilPiloto({ kmh, velocidadesPrevias }) {
  const previas = (velocidadesPrevias || []).filter((v) => Number.isFinite(v) && v > 0);
  if (!kmh || previas.length < 4) return [];

  const media = previas.reduce((a, b) => a + b, 0) / previas.length;
  if (media <= 0) return [];

  const salto = (kmh - media) / media;
  if (salto <= 0.5) return [];

  return [señal('salto_de_ritmo', 25,
    `Va a ${kmh} km/h cuando su media verificada es de ${media.toFixed(1)} km/h ` +
    `(un ${(salto * 100).toFixed(0)}% mas rapido de lo habitual en el).`,
    { mediaPiloto: Number(media.toFixed(1)), saltoPct: Number((salto * 100).toFixed(0)) })];
}

// --- Comprobacion 7: hora del trayecto ---------------------------------------
/**
 * La madrugada profunda es cuando menos gente hay en la calle y cuando mas
 * facil resulta justificar un tiempo imposible. No se penaliza mucho: es solo
 * un dato de contexto para la persona que revisa.
 */
function comprobarHorario({ lectura }) {
  if (!lectura?.disponible) return [];

  const salida = horaASegundos(lectura.horaSalida);
  if (salida === null) return [];

  const hora = Math.floor(salida / 3600);
  if (hora < HORARIO.HORA_INICIO_MADRUGADA || hora >= HORARIO.HORA_FIN_MADRUGADA) return [];

  return [señal('horario_inusual', 10,
    `El trayecto figura a las ${lectura.horaSalida}, en plena madrugada.`)];
}

// --- Orquestador --------------------------------------------------------------
/**
 * Ejecuta todas las comprobaciones y decide.
 * Devuelve siempre un objeto serializable, listo para guardar en el viaje: el
 * admin ve exactamente por que se ha tomado la decision.
 */
function evaluar(contexto) {
  const fisica = comprobarFisica(contexto);
  const señales = [
    ...fisica.señales,
    ...comprobarCaptura(contexto),
    ...comprobarDuplicado(contexto),
    ...comprobarContexto(contexto),
    ...comprobarEstadistica(contexto),
    ...comprobarPerfilPiloto({ ...contexto, kmh: fisica.kmh }),
    ...comprobarHorario(contexto),
  ];

  const decisiva = señales.find((s) => s.decisiva);
  const riesgo = señales.reduce((total, s) => total + s.gravedad, 0);

  let decision;
  let resumen;

  if (decisiva) {
    decision = decisiva.decisiva;
    resumen = decisiva.mensaje;
  } else if (riesgo >= RIESGO.UMBRAL_RECHAZO) {
    decision = 'rechazado';
    resumen = 'Se han acumulado demasiadas señales de fraude.';
  } else if (riesgo < RIESGO.UMBRAL_APROBACION) {
    decision = 'aprobado';
    resumen = 'Auditoria automatica superada.';
  } else {
    decision = 'revision';
    resumen = 'Hay indicios que requieren revision humana.';
  }

  return {
    decision,
    resumen,
    riesgo,
    señales: señales.map(({ decisiva: _omitida, ...resto }) => resto),
    metros: fisica.metros,
    kmh: fisica.kmh,
    evaluadoEn: new Date().toISOString(),
    varianteCaptura: contexto.lectura?.variante || null,
  };
}

module.exports = { evaluar, distanciaCalleMetros, velocidadKmh };
