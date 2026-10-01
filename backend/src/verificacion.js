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
const {
  buscarEstacion, distanciaMetros, horaASegundos, diaMadrid, minutosDelDiaEnZona,
} = require('./util');
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
    // Las horas se guardan en minutos ("22:46") y la captura las da con
    // segundos ("22:46:37"): entre minutos enteros cabe hasta un minuto de
    // diferencia sin que haya nada raro. 22:46 -> 23:03 son 17 min, y el viaje
    // de 22:46:37 a 23:03:20 dura 16:43. Sin este margen, capturas buenas del
    // historial salian "desviadas" y, sumadas a otra señal, rechazadas.
    const sinSegundos = !/:d{2}:d{2}/.test(`${lectura.horaSalida}${lectura.horaLlegada}`);
    const margen = sinSegundos ? 59 : 0;
    const desviacion = Math.max(0, Math.abs(diferencia - lectura.segundosDuracion) - margen);

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
function comprobarDuplicado({ hashSha, hashPerceptual, shaPrevios, hashesPrevios, capturaId }) {
  const señales = [];

  // Una misma captura puede sostener VARIOS viajes: el historial de la app es
  // una lista y ahi caben tres trayectos del mismo dia (#11). Los viajes que
  // comparten captura comparten huella, asi que si no se descartasen aqui, el
  // segundo y el tercero se rechazarian por "captura reutilizada" — que es
  // exactamente lo contrario de lo que esa comprobacion quiere detectar.
  //
  // Lo que sigue detectando: la misma imagen subida en OTRO lote, sea de quien
  // sea. Eso es lo que hace un duplicado de verdad.
  const deOtraCaptura = (previo) => !capturaId || !previo.capturaId || previo.capturaId !== capturaId;

  const duplicadoExacto = shaPrevios.filter(deOtraCaptura).find((p) => p.sha === hashSha);
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
    if (!deOtraCaptura(previo)) continue;
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

  // 15 y no 45, y el cambio tiene motivo (#66).
  //
  // Valia 45 cuando se creia que el dato salia del EXIF del fichero, o sea del
  // servidor. Resulta que no podia: el navegador recodifica toda captura en un
  // `<canvas>` y eso borra el EXIF antes de que salga del movil, asi que esta
  // señal no habia saltado NUNCA en produccion. Estaba llamada, probada y
  // muerta.
  //
  // Ahora el dato lo lee el navegador del fichero original y lo declara. Eso
  // pilla a quien edita una captura sin pensar —que es el caso corriente— pero
  // no a quien va en serio: le basta con no mandarlo. Una pista que se puede
  // omitir no puede pesar como una prueba.
  if (edicionSospechosa) {
    señales.push(señal('metadatos_edicion', 15,
      `La captura declara haber pasado por ${software}. Una captura de pantalla autentica no pasa por un editor.`));
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
 *
 * Recibe la distribucion ya calculada, no la lista de tiempos, y eso arregla un
 * fallo que no se veia: el worker le pasaba los 200 tiempos MAS RAPIDOS de la
 * ruta, porque la consulta iba ordenada. En cuanto una ruta pasaba de 200
 * marcas, "la media de la ruta" era la media de su cola rapida, no la de la
 * ruta, y la comprobacion se iba deformando segun crecia el tramo — sin fallar
 * nunca, que es lo peor que puede hacer un detector.
 *
 * Ahora sale de `agregados/ruta-{X}`, que el worker calcula sobre TODOS los
 * tiempos verificados del tramo. De paso cuesta una lectura en vez de 200.
 */
function distribucion(tiempos) {
  const muestras = (tiempos || []).filter((t) => Number.isFinite(t));
  if (!muestras.length) return { muestras: 0, media: 0, desviacion: 0 };

  const media = muestras.reduce((a, b) => a + b, 0) / muestras.length;
  const varianza = muestras.reduce((a, t) => a + (t - media) ** 2, 0) / muestras.length;

  return { muestras: muestras.length, media, desviacion: Math.sqrt(varianza) };
}

function comprobarEstadistica({ tiempoSegundos, distribucionRuta }) {
  const { muestras, media, desviacion } = distribucionRuta || {};
  if (!muestras || muestras < FISICA.MINIMO_MUESTRAS_ESTADISTICA) return [];

  // Sin dispersion no hay nada que medir (todos han hecho el mismo tiempo).
  if (!desviacion || desviacion < 1) return [];

  const z = (media - tiempoSegundos) / desviacion;
  if (z < FISICA.DESVIACIONES_SOSPECHOSA) return [];

  return [señal('atipico_estadistico', 30,
    `El tiempo esta ${z.toFixed(1)} desviaciones por debajo de la media de la ruta ` +
    `(${Math.round(media)}s de media en ${muestras} marcas).`,
    { z: Number(z.toFixed(2)), mediaRuta: Math.round(media), muestras })];
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

// --- Comprobacion 8: la fecha del viaje -----------------------------------------
/**
 * La fecha la ESCRIBE la persona, y es lo que decide si el viaje salva la racha
 * de hoy y cuenta para las misiones de hoy. Hasta esto nada la cruzaba con
 * nada: una captura vieja que nunca se subio, declarada como de hoy, mantenia
 * viva una racha sin pedalear. La huella impide reutilizar una captura, pero no
 * usar una que no se habia usado.
 *
 * La app de BiciMAD no pone la fecha en la captura, asi que no se puede leer.
 * Lo que si se puede son dos imposibilidades, sin opinar:
 *
 *   1. Un viaje de HOY no puede haber terminado DESPUES de subirse. Si la
 *      captura marca la llegada a las 22:10 y se subio a las 08:00, ese viaje
 *      es de otro dia. Sale del OCR del servidor y de la hora de subida que
 *      pone Firestore, asi que no depende de nada que mande el navegador.
 *   2. Una captura no puede ser ANTERIOR al viaje que dice mostrar. La fecha del
 *      fichero la declara el navegador (`capturadaEn`) y quien vaya en serio no
 *      la manda — igual que con el editor de #66 —, pero el caso corriente, que
 *      es elegir una captura vieja de la galeria, la manda sin enterarse.
 *
 * Las dos pesan 50 y NO son decisivas: mandan a revision, no rechazan. La
 * primera depende de que el OCR lea bien una hora, y la segunda de un reloj de
 * movil. Una persona que se equivoca de fecha merece que alguien lo mire, no un
 * rechazo automatico; y el viaje no puntua mientras tanto, que es lo que
 * importa. Ademas el navegador avisa antes de subir (subir.js), asi que a quien
 * no hace trampa esto casi nunca le llega.
 */
function comprobarFecha({ fechaViaje, capturadaEn, lectura, subidoEn }) {
  const señales = [];
  const dia = String(fechaViaje || '').slice(0, 10);

  if (capturadaEn && /^\d{4}-\d{2}-\d{2}$/.test(capturadaEn) && capturadaEn < dia) {
    señales.push(señal('captura_anterior_al_viaje', 50,
      `El fichero de la captura es del ${capturadaEn}, anterior al dia declarado del viaje (${dia}).`,
      { capturadaEn, fechaViaje: dia }));
  }

  // 3. La app actual pinta la fecha bajo cada estacion ("21/09/25 02:51:12").
  //    Si se ha leido y no es el dia declarado, lo mira una persona: el dia
  //    declarado ya no puede tener mas de un mes (worker.js), asi que una
  //    captura vieja nunca se aprueba sola. No es fatal porque depende de que el
  //    OCR no confunda un 5 con un 6.
  const fechaLeida = lectura?.disponible ? String(lectura.fecha || '') : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(fechaLeida) && dia && fechaLeida !== dia) {
    señales.push(señal('fecha_captura_distinta', 50,
      `La captura marca el ${fechaLeida} y el viaje se ha declarado del ${dia}.`,
      { fechaCaptura: fechaLeida, fechaViaje: dia }));
  }

  const subida = subidoEn instanceof Date && !Number.isNaN(subidoEn.getTime()) ? subidoEn : null;
  const llegada = lectura?.disponible ? horaASegundos(lectura.horaLlegada) : null;
  const salida = lectura?.disponible ? horaASegundos(lectura.horaSalida) : null;

  // Si cruza la medianoche, la llegada es del dia siguiente al declarado y la
  // comparacion no aplica.
  const cruzaMedianoche = salida !== null && llegada !== null && llegada < salida;

  if (subida && llegada !== null && !cruzaMedianoche && dia === diaMadrid(subida)) {
    const minutosSubida = minutosDelDiaEnZona(subida, 'Europe/Madrid');
    // Diez minutos de margen: el reloj del movil y el de Firestore no tienen
    // por que ir clavados, y la captura se hace justo al terminar.
    if (llegada / 60 > minutosSubida + 10) {
      señales.push(señal('llegada_posterior_a_subida', 50,
        `La captura marca la llegada a las ${lectura.horaLlegada}, pero se subio antes, ` +
        `hoy a las ${String(Math.floor(minutosSubida / 60)).padStart(2, '0')}:${String(minutosSubida % 60).padStart(2, '0')}. ` +
        'El viaje no puede ser de hoy.',
        { horaLlegada: lectura.horaLlegada }));
    }
  }

  return señales;
}

// --- Comprobacion 9: el reloj del propio movil ---------------------------------
/**
 * La barra de estado de la captura lleva la hora del movil en el momento de
 * hacerla. Es la unica hora de la imagen que la app de BiciMAD no pinta, y por
 * eso quien edita el trayecto casi nunca la toca. Dos imposibilidades:
 *
 *   1. La captura no puede estar hecha ANTES de que acabe el trayecto que
 *      enseña: si el reloj marca 17:05 y la llegada es a las 17:40, o el
 *      trayecto esta retocado o la captura es de otro dia.
 *   2. Si el viaje es de hoy, la captura no puede estar hecha DESPUES de
 *      subirla.
 *
 * Pesan 50 y no son decisivas: la hora de la barra es pequeña y el OCR la
 * puede leer mal. Van a una persona, que la ve de un vistazo.
 */
function comprobarReloj({ lectura, subidoEn, fechaViaje }) {
  if (!lectura?.disponible || !lectura.relojBarra) return [];
  const reloj = horaASegundos(lectura.relojBarra);
  const llegada = horaASegundos(lectura.horaLlegada);
  const salida = horaASegundos(lectura.horaSalida);
  if (reloj === null) return [];
  const señales = [];

  if (llegada !== null) {
    const falta = llegada - reloj;
    // Tres minutos de margen por redondeos; doce horas como tope para no
    // confundir "antes" con "al dia siguiente" (captura hecha pasada la
    // medianoche de un viaje de la noche anterior).
    const cruza = salida !== null && llegada < salida;
    if (!cruza && falta > 180 && falta < 12 * 3600) {
      señales.push(señal('reloj_anterior_a_llegada', 50,
        `El reloj del movil en la captura marca ${lectura.relojBarra}, antes de la llegada del trayecto (${lectura.horaLlegada}).`,
        { relojBarra: lectura.relojBarra }));
    }
  }

  const subida = subidoEn instanceof Date && !Number.isNaN(subidoEn.getTime()) ? subidoEn : null;
  const dia = String(fechaViaje || '').slice(0, 10);
  if (subida && dia === diaMadrid(subida)) {
    const minutosSubida = minutosDelDiaEnZona(subida, 'Europe/Madrid');
    if (reloj / 60 > minutosSubida + 10 && reloj / 60 - minutosSubida < 12 * 60) {
      señales.push(señal('reloj_posterior_a_subida', 50,
        `El reloj de la captura marca ${lectura.relojBarra}, despues de haberla subido.`,
        { relojBarra: lectura.relojBarra }));
    }
  }
  return señales;
}

// --- Comprobacion 10: dos lecturas que tienen que coincidir --------------------
/**
 * La captura se lee DOS veces, con dos preparaciones de imagen distintas
 * (ocr.releerCaptura). Si las dos no dicen lo mismo en lo que decide —
 * estaciones y duracion— la lectura no es de fiar, y dar un viaje por bueno
 * sobre una lectura dudosa es justo lo que no puede pasar. Un campo que la
 * segunda lectura no alcanza a leer no cuenta como desacuerdo: solo lo que las
 * dos leen y no coincide.
 */
function comprobarConsenso({ lectura, segundaLectura }) {
  if (!lectura?.disponible || !segundaLectura?.disponible) return [];
  const sinCeros = (v) => String(v || '').replace(/^0+/, '');
  const discrepan = [];
  for (const campo of ['origen', 'destino']) {
    const a = sinCeros(lectura[campo]);
    const b = sinCeros(segundaLectura[campo]);
    if (a && b && a !== b) discrepan.push(`${campo} ${a}/${b}`);
  }
  const d1 = lectura.segundosDuracion;
  const d2 = segundaLectura.segundosDuracion;
  if (Number.isFinite(d1) && Number.isFinite(d2) && Math.abs(d1 - d2) > 5) discrepan.push(`duracion ${d1}s/${d2}s`);
  if (!discrepan.length) return [];
  return [señal('lectura_sin_consenso', 40,
    `Las dos lecturas de la captura no coinciden (${discrepan.join(', ')}).`,
    { discrepan })];
}

// --- Comprobacion 11: el formato de la imagen ---------------------------------
/**
 * Una captura de la app es una pantalla de movil en vertical. Un recorte que
 * deja solo el recuadro del trayecto se lee igual de bien, pero es tambien lo
 * que hace quien ha montado el recuadro en otra imagen. Pesa poco: sola no
 * manda a nadie a revision, pero suma con cualquier otra cosa.
 */
function comprobarFormato({ ancho, alto }) {
  if (!ancho || !alto) return [];
  const proporcion = alto / ancho;
  if (proporcion >= 1.3) return [];
  return [señal('formato_no_movil', 15,
    `La imagen mide ${ancho}x${alto}: no tiene el formato de una pantalla de movil. Parece recortada.`)];
}

// --- Comprobacion 12: una bici no esta en dos sitios a la vez ------------------
/**
 * Con el numero de la bici leido en la captura, dos personas distintas no
 * pueden haberla llevado a la misma hora. Si pasa, o una de las dos capturas
 * es de otra persona (la del amigo, la que circula por un grupo), o esta
 * retocada. Un minuto de margen por redondeos en los bordes.
 */
function comprobarBici({ lectura, uid, usosBici }) {
  const salida = horaASegundos(lectura?.horaSalida);
  const llegada = horaASegundos(lectura?.horaLlegada);
  if (!lectura?.numeroBici || salida === null || llegada === null || llegada < salida) return [];
  const choque = (usosBici || []).find((u) => {
    if (!u || u.uid === uid) return false;
    const s = horaASegundos(u.salida);
    const l = horaASegundos(u.llegada);
    if (s === null || l === null) return false;
    return Math.min(llegada, l) - Math.max(salida, s) > 60;
  });
  if (!choque) return [];
  return [señal('bici_en_dos_sitios', 60,
    `La bici ${lectura.numeroBici} figura a la misma hora en un trayecto de otra persona (${choque.tripId || 'otro viaje'}).`,
    { viajeOriginal: choque.tripId || null })];
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
    ...comprobarFecha(contexto),
    ...comprobarReloj(contexto),
    ...comprobarConsenso(contexto),
    ...comprobarFormato(contexto),
    ...comprobarBici(contexto),
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

module.exports = { evaluar, distribucion, distanciaCalleMetros, velocidadKmh };
