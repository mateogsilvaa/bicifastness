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

const { FISICA, RIESGO, IMAGEN, HORARIO, LIMITES } = require('./config');
const {
  buscarEstacion, construirRuta, distanciaMetros, horaASegundos, diaMadrid, minutosDelDiaEnZona,
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
  // La distancia ciclable real, si esta en la tabla (scripts/build-distancias.js):
  // la estimacion se pasa en los tramos directos y daba velocidades
  // "sospechosas" a viajes normales.
  const real = require('./distancias').resolver(idOrigen, idDestino);
  if (real && !real.estimada) return real.metros;
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
function comprobarFisica({ ruta, tiempoSegundos }, { impecable = false } = {}) {
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

  // La velocidad que se ENSEÑA (y la que usa el perfil del piloto) es la de la
  // distancia estimada por calle.
  const kmh = velocidadKmh(metros, tiempoSegundos);

  // Con la captura IMPECABLE el tiempo lo ha medido BiciMAD y las estaciones y
  // las horas cuadran: si sale rapido, lo que esta mal es NUESTRA distancia
  // (atajos por parques, carriles bici, Madrid Rio...), no el viaje. Ahi la
  // velocidad no opina. (Noviembre de 2026: uno de 68 km/h "por calle" era
  // legal y acabo en revision.)
  // Lo unico que se mira entonces es lo que ni con atajos cabe: mas de 32 km/h
  // de media en LINEA RECTA (una BiciMAD corta la asistencia a 25). Eso ya no
  // es la distancia, es una captura retocada con cuidado: a revision, nunca
  // rechazo.
  const recta = distanciaMetros(buscarEstacion(origen), buscarEstacion(destino));
  const kmhMinimo = velocidadKmh(Math.max(0, recta - FISICA.MARGEN_POSICION_METROS), tiempoSegundos);
  if (impecable) {
    if (kmhMinimo !== null && kmhMinimo > FISICA.VELOCIDAD_IMPOSIBLE_IMPECABLE_KMH) {
      señales.push(señal('velocidad_imposible', 60,
        `Al menos ${kmhMinimo.toFixed(1)} km/h en linea recta, con una captura que cuadra: ni con atajos. Requiere revision humana.`,
        { kmh: Number(kmhMinimo.toFixed(1)), metros: Math.round(recta) }));
    }
    return { señales, metros: Math.round(metros), kmh: kmh ? Number(kmh.toFixed(1)) : null };
  }

  // Sin captura impecable, la velocidad se mide con la distancia MAS CORTA que
  // puede haber —la linea recta, menos lo que baila la posicion de las
  // estaciones— y no con la estimacion por calle, que no conoce los atajos. Y
  // nunca rechaza: como mucho, a revision (las dos van en DE_LECTURA).
  const kmhCorto = velocidadKmh(recta * 1.1, tiempoSegundos);

  if (kmhMinimo !== null && kmhMinimo > FISICA.VELOCIDAD_IMPOSIBLE_KMH) {
    señales.push(señal('velocidad_imposible', 60,
      `Al menos ${kmhMinimo.toFixed(1)} km/h en linea recta: con el tiempo declarado no da. ` +
      'Puede ser un tiempo mal escrito o una estacion mal leida. Requiere revision humana.',
      { kmh: Number(kmhMinimo.toFixed(1)), metros: Math.round(recta) }));
  } else if (kmhCorto !== null && kmhCorto > FISICA.VELOCIDAD_SOSPECHOSA_KMH) {
    señales.push(señal('velocidad_sospechosa', 40,
      `${kmhCorto.toFixed(1)} km/h contando casi en linea recta: posible, pero muy alta para trafico urbano.`,
      { kmh: Number(kmhCorto.toFixed(1)) }));
  } else if (kmh !== null && kmh < FISICA.VELOCIDAD_MINIMA_KMH) {
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
/**
 * ¿Hay ALGO de BiciMAD en lo leido? Una estacion, un tiempo, una fecha o una
 * franja del azul de la app. La hora suelta no cuenta: la barra de estado de
 * cualquier captura lleva una.
 */
function indiciosDeBicimad(lectura) {
  const leidos = [lectura.origen, lectura.destino, lectura.fecha]
    .filter((v) => v !== null && v !== undefined && v !== '').length;
  return leidos
    + (Number.isFinite(lectura.segundosDuracion) ? 1 : 0)
    + ((lectura.franjasAzules || 0) > 0 ? 1 : 0);
}

/**
 * ¿La segunda lectura (`ocr.releerCaptura`) confirma las horas y la duracion de
 * la primera? Es lo que separa "la captura esta retocada" de "el OCR ha leido
 * mal un numero": un numero mal leido rara vez se lee mal igual dos veces con
 * pixeles distintos, y uno retocado se lee igual las dos.
 */
function lecturaConfirmada(lectura, segunda) {
  if (!segunda?.disponible) return false;
  const d1 = lectura.segundosDuracion;
  const d2 = segunda.segundosDuracion;
  return Number.isFinite(d1) && Number.isFinite(d2) && Math.abs(d1 - d2) <= 5
    && Boolean(segunda.horaSalida) && segunda.horaSalida === lectura.horaSalida
    && Boolean(segunda.horaLlegada) && segunda.horaLlegada === lectura.horaLlegada;
}

function comprobarCaptura({ ruta, tiempoSegundos, lectura, segundaLectura }) {
  const señales = [];

  if (!lectura.disponible) {
    señales.push(señal('lectura_no_disponible', 30,
      `No se ha podido leer la captura automaticamente (${lectura.error}). Requiere revision humana.`));
    return señales;
  }

  if (!lectura.esBicimad) {
    // Rechazo directo SOLO si no hay nada de BiciMAD y la lectura es nitida: la
    // foto del gato, una nota, otra app. Si hay una estacion, un tiempo o el
    // azul de la app, lo mas probable es una captura buena mal leida (borrosa,
    // recortada, en modo oscuro), y eso lo mira una persona. Rechazar ahi era
    // decirle a alguien con su viaje delante que no es de BiciMAD.
    if (indiciosDeBicimad(lectura) === 0 && (lectura.confianza ?? 0) >= 60) {
      señales.push(fatal('no_es_bicimad', 'La imagen no parece una captura de la app BiciMAD.'));
    } else {
      señales.push(señal('bicimad_dudosa', 50,
        'La captura no se ha podido reconocer como de la app BiciMAD con seguridad. Requiere revision humana.'));
    }
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
    const sinSegundos = !/:\d{2}:\d{2}/.test(`${lectura.horaSalida}${lectura.horaLlegada}`);
    const margen = sinSegundos ? 59 : 0;
    const desviacion = Math.max(0, Math.abs(diferencia - lectura.segundosDuracion) - margen);

    if (desviacion > 90 && lecturaConfirmada(lectura, segundaLectura)) {
      señales.push(fatal('captura_incoherente',
        `Entre las horas de la captura hay ${diferencia}s, pero el recuadro de duracion marca ${lectura.segundosDuracion}s. ` +
        'La imagen ha sido retocada.',
        { diferenciaHoras: diferencia, duracionMostrada: lectura.segundosDuracion }));
    } else if (desviacion > 90) {
      // El mismo descuadre, pero sin que una segunda lectura lo confirme: puede
      // ser un 1 leido como 7. No se rechaza a nadie por un numero mal leido.
      señales.push(señal('captura_descuadrada', 50,
        `Entre las horas de la captura hay ${diferencia}s y el recuadro marca ${lectura.segundosDuracion}s, ` +
        'pero la segunda lectura no lo confirma. Requiere revision humana.',
        { diferenciaHoras: diferencia, duracionMostrada: lectura.segundosDuracion }));
    } else if (desviacion > 5) {
      // Un descuadre de segundos casi siempre es un digito de los segundos
      // mal leido (la app de BiciMAD los cuadra al segundo). Solo pesa lo
      // bastante para mandar a revision si la segunda lectura lee las mismas
      // horas; si no, se anota pero no frena por si sola un viaje bueno.
      const confirmada = lecturaConfirmada(lectura, segundaLectura);
      señales.push(señal('captura_desviada', confirmada ? 30 : 10,
        `Descuadre de ${desviacion}s entre las horas y la duracion mostrada`
        + (confirmada ? '.' : ', sin confirmar por la segunda lectura.')));
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
    if (desfase > 60 && tiempoInventado({ lectura, ruta, tiempoSegundos })) {
      // La captura muestra ESTE trayecto, con su tiempo confirmado por sus
      // propias horas, y lo declarado es bastante mas rapido y no por una
      // cifra mal leida: el tiempo se lo ha puesto el piloto, no BiciMAD.
      señales.push(fatal('tiempo_inventado',
        `La captura de este trayecto marca ${lectura.segundosDuracion}s (y sus horas lo confirman), `
        + `pero se han declarado ${tiempoSegundos}s.`,
        { leido: lectura.segundosDuracion, declarado: tiempoSegundos }));
    } else if (desfase > 60) {
      señales.push(señal('tiempo_no_coincide', 60,
        `La captura marca ${lectura.segundosDuracion}s pero se han declarado ${tiempoSegundos}s.`));
    } else if (desfase > 5) {
      señales.push(señal('tiempo_desviado', 25,
        `Diferencia de ${desfase}s entre la captura y el tiempo declarado.`));
    }
  }

  return señales;
}

/**
 * ¿El tiempo declarado esta inventado? Solo si no hay duda de lectura:
 *   - la captura muestra la MISMA ruta declarada (es este trayecto);
 *   - su duracion cuadra con sus propias horas de salida y llegada (se ha
 *     leido bien: las tres cifras dicen lo mismo);
 *   - lo declarado es MAS RAPIDO, por mas de 60 s y mas de un 10 %;
 *   - y no es una sola cifra cambiada (un 3 leido como 8 no es trampa).
 * Pura.
 */
function tiempoInventado({ lectura, ruta, tiempoSegundos }) {
  const leido = lectura?.segundosDuracion;
  if (!Number.isFinite(leido) || !Number.isFinite(tiempoSegundos)) return false;
  const sinCeros = (v) => String(v || '').replace(/^0+/, '');
  const [o, d] = String(ruta || '').split('-').map(sinCeros);
  if (sinCeros(lectura.origen) !== o || sinCeros(lectura.destino) !== d) return false;
  const salida = horaASegundos(lectura.horaSalida);
  const llegada = horaASegundos(lectura.horaLlegada);
  if (salida === null || llegada === null) return false;
  let entre = llegada - salida;
  if (entre < 0) entre += 24 * 3600;
  const margen = /:\d{2}:\d{2}/.test(`${lectura.horaSalida}${lectura.horaLlegada}`) ? 5 : 65;
  if (Math.abs(entre - leido) > margen) return false;
  if (leido - tiempoSegundos <= Math.max(60, leido * 0.1)) return false;
  // Una sola cifra distinta en mm:ss (con los mismos digitos de largo).
  const mmss = (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  const a = mmss(leido);
  const b = mmss(tiempoSegundos);
  const unaCifra = a.length === b.length && [...a].filter((c, i) => c !== b[i]).length <= 1;
  return !unaCifra;
}

// --- Comprobacion 3: reutilizacion de la captura -----------------------------
/**
 * Lo que identifica a UN trayecto dentro de una captura: su dia, sus horas, su
 * duracion y su bici. Es lo que distingue "la misma captura otra vez" de "otra
 * captura de la misma pantalla de la app".
 *
 * El dia solo cuenta si se ha LEIDO en la imagen: el declarado lo escribe la
 * persona, y quien resube una captura vieja con otra fecha es justo a quien
 * hay que pillar.
 */
function firmaDeLectura(lectura) {
  if (!lectura?.disponible) return null;
  const firma = {
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(lectura.fecha || '')) ? lectura.fecha : null,
    salida: lectura.horaSalida || null,
    llegada: lectura.horaLlegada || null,
    duracion: Number.isFinite(lectura.segundosDuracion) ? lectura.segundosDuracion : null,
    bici: lectura.numeroBici ? String(lectura.numeroBici).replace(/^0+/, '') : null,
  };
  return Object.values(firma).some((v) => v !== null) ? firma : null;
}

/**
 * ¿Dos firmas son el mismo trayecto?
 *
 *   'distinto'    las horas, o el dia leido, no coinciden: otro viaje.
 *   'igual'       coinciden las horas y algo mas que las ate (segundos, dia o
 *                 bici), sin nada en contra: la misma captura, por mucho que
 *                 se haya recortado.
 *   'desconocido' no hay con que compararlas; o solo coinciden las horas al
 *                 minuto, que quien hace siempre el mismo trayecto puede
 *                 repetir otro dia; o coinciden las horas y discrepa otra cosa.
 *
 * Lo que separa dos viajes son las horas y el dia. La bici y la duracion NO:
 * medido sobre el banco, la misma captura algo borrosa da la bici 1903, 1042 o
 * 19053, y con eso una captura repetida pasaria por otro viaje. Que discrepen
 * con las horas iguales solo quita certeza (y una duracion distinta con las
 * mismas horas es justo una captura retocada): lo mira una persona.
 */
function compararFirmas(a, b) {
  if (!a || !b) return 'desconocido';
  const conSegundos = (h) => /^\d{1,2}:\d{2}:\d{2}$/.test(String(h || ''));

  let horas = 0;
  let fuerte = false;
  for (const campo of ['salida', 'llegada']) {
    const x = horaASegundos(a[campo]);
    const y = horaASegundos(b[campo]);
    if (x === null || y === null) continue;
    const exacto = conSegundos(a[campo]) && conSegundos(b[campo]);
    // Al minuto, si alguna viene sin segundos: "11:13" y "11:13:40" son lo mismo.
    const iguales = exacto ? Math.abs(x - y) <= 2 : Math.floor(x / 60) === Math.floor(y / 60);
    if (!iguales) return 'distinto';
    horas += 1;
    if (exacto) fuerte = true;
  }
  if (a.fecha && b.fecha && a.fecha !== b.fecha) return 'distinto';
  if (horas < 2) return 'desconocido';

  const duracionDistinta = Number.isFinite(a.duracion) && Number.isFinite(b.duracion)
    && Math.abs(a.duracion - b.duracion) > 5;
  const biciDistinta = Boolean(a.bici && b.bici && a.bici !== b.bici);
  if (duracionDistinta || biciDistinta) return 'desconocido';

  if (a.fecha && b.fecha) fuerte = true;
  if (a.bici && b.bici) fuerte = true;
  return fuerte ? 'igual' : 'desconocido';
}

/**
 * Un duplicado cuyo viaje original esta RECHAZADO y es de la misma persona no
 * es un duplicado: es "Corregir y volver a subir". El original no cuenta para
 * nada, asi que subir otra vez su captura no puede contar un trayecto dos
 * veces. Antes eso se rechazaba por "captura ya subida", y la pantalla de
 * rechazo invitaba justo a hacerlo.
 */
const esReintento = (previo, uid) => previo.estado === 'rechazado' && Boolean(uid) && previo.uid === uid;

/**
 * `hashesPrevios` son los dHash de las capturas recientes de CUALQUIER usuario,
 * no solo del que sube. Asi se detecta tambien que dos cuentas suban la misma
 * imagen, que es el patron tipico de las cuentas multiples.
 *
 * El dHash es de 9x8 pixeles, y a esa resolucion TODAS las capturas de la app
 * de BiciMAD se parecen: la misma maqueta, el mismo azul, el mismo blanco.
 * Medido en el banco de pruebas, dos viajes distintos salen a distancia 5,
 * dentro del umbral de "la misma imagen". Rechazar por eso era rechazar a quien
 * repite trayecto, que es quien mas usa la app. Asi que el parecido solo SEÑALA
 * candidatos, y lo que decide es lo leido: si las horas, el dia o la bici no
 * coinciden, es otro viaje, por mucho que se parezca la pantalla.
 */
function comprobarDuplicado({ hashSha, hashPerceptual, shaPrevios, hashesPrevios, capturaId, lectura, uid }) {
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

  // Y la MISMA persona subiendo otra vez su captura para OTRO trayecto de los
  // que salen en ella (el historial trae dos y la web solo vio uno, o los sube
  // de uno en uno). Si es el mismo trayecto, eso ya lo para `viaje_repetido`.
  const firmaActual = firmaDeLectura(lectura);
  const otroTrayectoMio = (previo) => Boolean(uid) && previo.uid === uid && previo.firma && firmaActual
    && horaASegundos(firmaActual.salida) !== null && horaASegundos(previo.firma.salida) !== null
    && Math.abs(horaASegundos(firmaActual.salida) - horaASegundos(previo.firma.salida)) > 90;

  const duplicadoExacto = (shaPrevios || []).filter(deOtraCaptura)
    .filter((p) => !otroTrayectoMio(p))
    .find((p) => p.sha === hashSha);
  if (duplicadoExacto && !esReintento(duplicadoExacto, uid)) {
    if (duplicadoExacto.estado === 'rechazado') {
      // De otra persona y rechazado: no cuenta dos veces, pero que una cuenta
      // suba la captura de otra es el patron de las cuentas multiples.
      señales.push(señal('captura_reutilizada', 50,
        'Esta captura ya la habia subido otra cuenta (aquel viaje se rechazo). Requiere revision humana.',
        { viajeOriginal: duplicadoExacto.tripId }));
    } else {
      señales.push(fatal('captura_reutilizada',
        duplicadoExacto.uid
          ? 'Esta captura ya se habia subido antes, byte a byte.'
          : 'Esta captura ya se habia subido antes.',
        { viajeOriginal: duplicadoExacto.tripId }));
    }
    return señales;
  }
  if (duplicadoExacto) return señales;

  if (!hashPerceptual) return señales;

  const firma = firmaActual;
  const candidatos = (hashesPrevios || [])
    .filter((previo) => previo.dhash && deOtraCaptura(previo) && !otroTrayectoMio(previo))
    .map((previo) => ({ ...previo, distancia: distanciaHamming(hashPerceptual, previo.dhash) }))
    .filter((previo) => previo.distancia <= IMAGEN.MAX_DISTANCIA_PERCEPTUAL)
    .sort((a, b) => a.distancia - b.distancia);

  let dudoso = null;
  for (const previo of candidatos) {
    if (esReintento(previo, uid)) continue;
    const comparacion = compararFirmas(firma, previo.firma);
    if (comparacion === 'distinto') continue;
    if (comparacion === 'igual' && previo.estado !== 'rechazado') {
      señales.push(fatal('captura_casi_identica',
        `La captura es la de otro viaje ya registrado (distancia perceptual ${previo.distancia}, ` +
        'y las horas leidas coinciden). Recomprimir o recortar una imagen no la convierte en nueva.',
        { viajeOriginal: previo.tripId, distancia: previo.distancia }));
      return señales;
    }
    dudoso = dudoso || previo;
  }

  if (dudoso) {
    señales.push(señal('captura_parecida', 35,
      `La captura se parece mucho a la de otro viaje (distancia ${dudoso.distancia}) ` +
      'y no se ha podido comprobar por lo leido si es el mismo trayecto.',
      { viajeOriginal: dudoso.tripId }));
  }

  return señales;
}

/**
 * El mismo trayecto subido otra vez, con OTRA captura: la de la misma pantalla
 * hecha dos veces, o recortada de forma que ni el dHash la reconoce.
 *
 * `viajesMismoDia` son los de la misma ruta y el mismo dia declarado (una
 * consulta del worker), con la franja leida en su captura. Una persona no
 * puede hacer la misma ruta dos veces a la misma hora. Dos personas si: dos
 * amigos que salen juntos. Por eso entre cuentas distintas solo pesa si no se
 * sabe la bici; con bicis distintas son dos viajes, y con la misma ya lo dice
 * `bici_en_dos_sitios`.
 */
function comprobarViajeRepetido({ lectura, uid, capturaId, viajesMismoDia }) {
  const firma = firmaDeLectura(lectura);
  if (!firma || horaASegundos(firma.salida) === null || horaASegundos(firma.llegada) === null) return [];

  for (const otro of viajesMismoDia || []) {
    if (!otro || otro.estado === 'rechazado') continue;
    if (capturaId && otro.capturaId === capturaId) continue;
    const s = horaASegundos(otro.salida);
    const l = horaASegundos(otro.llegada);
    if (s === null || l === null) continue;
    const a = horaASegundos(firma.salida);
    const b = horaASegundos(firma.llegada);
    if (Math.abs(a - s) > 90 || Math.abs(b - l) > 90) continue;

    if (otro.uid === uid) {
      return [fatal('viaje_repetido',
        `Este trayecto (${firma.salida} → ${firma.llegada}) ya esta subido en otro viaje tuyo.`,
        { viajeOriginal: otro.tripId || null })];
    }
    // Con las dos bicis leidas: distintas son dos viajes, y la misma ya la
    // señala `bici_en_dos_sitios`.
    if (!(otro.bici && firma.bici)) {
      return [señal('viaje_coincidente', 40,
        `Otra cuenta tiene subido el mismo trayecto a la misma hora (${firma.salida} → ${firma.llegada}) y no se sabe la bici de los dos.`,
        { viajeOriginal: otro.tripId || null })];
    }
  }
  return [];
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
function comprobarConsenso({ lectura, segundaLectura, ruta, tiempoSegundos }) {
  if (!lectura?.disponible || !segundaLectura?.disponible) return [];
  const sinCeros = (v) => String(v || '').replace(/^0+/, '');
  const [declOrigen, declDestino] = String(ruta || '').split('-').map(sinCeros);
  const declarado = { origen: declOrigen, destino: declDestino };
  const discrepan = [];
  // Lo que la segunda lectura no alcanza a leer bien NO es desacuerdo si la
  // primera dice exactamente lo que declaro el piloto: la segunda preparacion
  // de la imagen lee peor los recortes, y castigar eso mandaba a revision
  // capturas buenas (noviembre de 2026: la mitad de las revisiones). Si la
  // primera NO coincide con lo declarado, eso ya lo pilla `comprobarCaptura`;
  // aqui queda lo que de verdad no se sabe leer.
  for (const campo of ['origen', 'destino']) {
    const a = sinCeros(lectura[campo]);
    const b = sinCeros(segundaLectura[campo]);
    if (a && b && a !== b && a !== declarado[campo]) discrepan.push(campo);
  }
  const d1 = lectura.segundosDuracion;
  const d2 = segundaLectura.segundosDuracion;
  const d1Cuadra = Number.isFinite(tiempoSegundos) && Math.abs(d1 - tiempoSegundos) <= 5;
  if (Number.isFinite(d1) && Number.isFinite(d2) && Math.abs(d1 - d2) > 5 && !d1Cuadra) discrepan.push('duracion');
  if (!discrepan.length) return [];
  return [señal('lectura_sin_consenso', 40,
    `Las dos lecturas de la captura no coinciden en: ${discrepan.join(', ')}.`,
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
 * Señales que dependen de que el OCR haya leido bien un numero o una palabra.
 *
 * Sumadas pueden mandar un viaje a revision, pero NO rechazarlo: "en la captura
 * se lee otra ruta" + "no se leen las horas" sumaban 75 y rechazaban solas una
 * captura buena y borrosa. Un rechazo automatico tiene que salir de algo que no
 * sea una lectura dudosa: la fisica, un duplicado, una señal decisiva o
 * indicios de fraude que no dependen del OCR.
 */
const DE_LECTURA = new Set([
  'lectura_no_disponible', 'lectura_poco_segura', 'bicimad_dudosa', 'captura_descuadrada',
  'captura_desviada', 'horas_ilegibles', 'ruta_no_coincide', 'estaciones_ilegibles',
  'tiempo_no_coincide', 'tiempo_desviado', 'fecha_captura_distinta', 'llegada_posterior_a_subida',
  'reloj_anterior_a_llegada', 'reloj_posterior_a_subida', 'lectura_sin_consenso', 'horario_inusual',
  'formato_no_movil',
  // La velocidad tampoco rechaza nunca sola: depende de una distancia
  // estimada que no conoce los atajos (comprobarFisica).
  'velocidad_imposible', 'velocidad_sospechosa',
]);

/**
 * Señales que solo dicen "no estoy seguro de haber leido bien" o "esto es un
 * poco raro", sin indicio de trampa. Con una captura IMPECABLE (ver abajo) no
 * aportan nada: lo que importa ya se ha leido y cuadra. Siguen apareciendo en
 * la auditoria, con gravedad 0, para quien revise.
 */
const RUIDO = new Set([
  // El tiempo de una captura impecable lo ha puesto BiciMAD, no el piloto: si
  // sale rapido es porque fue rapido (o porque la distancia estimada, recta x
  // 1,35, se pasa en un tramo directo). Lo IMPOSIBLE sigue rechazandose solo.
  'velocidad_sospechosa',
  'formato_no_movil', 'lectura_poco_segura', 'horario_inusual', 'velocidad_muy_baja',
  'geo_desconocida', 'captura_desviada', 'lectura_sin_consenso', 'horas_ilegibles',
]);

/**
 * ¿La captura dice exactamente lo declarado? Es de BiciMAD, se leen las dos
 * estaciones y son las declaradas, la duracion leida es la declarada (±5 s) y
 * las horas de salida y llegada cuadran con esa duracion. Quien retoca una
 * captura para que diga otra cosa no pasa esto: la resta de horas lo delata
 * (`captura_incoherente`).
 */
function capturaImpecable({ lectura, ruta, tiempoSegundos }) {
  if (!lectura?.disponible || !lectura.esBicimad) return false;
  const sinCeros = (v) => String(v || '').replace(/^0+/, '');
  const [o, d] = String(ruta || '').split('-').map(sinCeros);
  if (!o || sinCeros(lectura.origen) !== o || sinCeros(lectura.destino) !== d) return false;
  const dur = lectura.segundosDuracion;
  if (!Number.isFinite(dur) || !Number.isFinite(tiempoSegundos) || Math.abs(dur - tiempoSegundos) > 5) return false;
  const salida = horaASegundos(lectura.horaSalida);
  const llegada = horaASegundos(lectura.horaLlegada);
  if (salida === null || llegada === null) return false;
  let entre = llegada - salida;
  if (entre < 0) entre += 24 * 3600;
  const margen = /:\d{2}:\d{2}/.test(`${lectura.horaSalida}${lectura.horaLlegada}`) ? 5 : 65;
  return Math.abs(entre - dur) <= margen;
}

/** ¿El dia que marca la captura es uno en el que se podia subir el viaje? */
function fechaDentroDePlazo(fechaCaptura, fechaViaje) {
  const leida = String(fechaCaptura || '');
  const declarada = String(fechaViaje || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(leida) || !/^\d{4}-\d{2}-\d{2}$/.test(declarada)) return false;
  if (leida < LIMITES.PRIMER_DIA_VIAJES) return false;
  // A lo sumo una semana de diferencia con lo declarado, y nunca posterior.
  const dias = (Date.parse(declarada) - Date.parse(leida)) / 864e5;
  return Math.abs(dias) <= 7 && leida <= declarada;
}

/**
 * La lectura que mejor dice lo declarado, de varias de la MISMA captura.
 *
 * Cada preparacion de la imagen falla en sitios distintos (un 8 por un 3, una
 * fila de Android cortada). Si una de ellas lee exactamente las estaciones y
 * la duracion declaradas, la captura dice eso: que una lectura equivocada
 * acierte por casualidad las dos estaciones Y la duracion al segundo no pasa.
 * Lo que sigue protegiendo de un retoque es lo de siempre: las horas tienen
 * que cuadrar con la duracion en la lectura elegida (`captura_incoherente`).
 *
 * Pura. Devuelve la primera si ninguna mejora.
 */
function mejorLectura(lecturas, ruta, tiempoSegundos) {
  const validas = (lecturas || []).filter((l) => l?.disponible);
  if (!validas.length) return lecturas?.[0] || null;
  const sinCeros = (v) => String(v || '').replace(/^0+/, '');
  const [o, d] = String(ruta || '').split('-').map(sinCeros);
  // Una lectura cuyas horas no cuadran con su duracion (la llegada antes que
  // la salida: ha leido las estaciones en otro orden) no puede ganar por
  // coincidir con lo declarado. Pasó: una preparacion troceo la captura al
  // reves, dijo justo la ruta declarada (que era la inversa) y se eligio.
  const coherente = (l) => {
    const sa = horaASegundos(l.horaSalida);
    const ll = horaASegundos(l.horaLlegada);
    if (sa === null || ll === null || !Number.isFinite(l.segundosDuracion)) return true;
    const margen = /:\d{2}:\d{2}/.test(`${l.horaSalida}${l.horaLlegada}`) ? 5 : 65;
    return ll >= sa && Math.abs(ll - sa - l.segundosDuracion) <= margen;
  };
  const nota = (l) => (coherente(l) ? 0 : -10)
    + (sinCeros(l.origen) === o ? 1 : 0)
    + (sinCeros(l.destino) === d ? 1 : 0)
    + (Number.isFinite(l.segundosDuracion) && Math.abs(l.segundosDuracion - tiempoSegundos) <= 5 ? 1 : 0)
    + (l.horaSalida && l.horaLlegada ? 0.5 : 0)
    + (l.esBicimad ? 0.25 : 0)
    + (capturaImpecable({ lectura: l, ruta, tiempoSegundos }) ? 2 : 0);
  return validas.reduce((mejor, l) => (nota(l) > nota(mejor) ? l : mejor), validas[0]);
}

/**
 * La ruta que dice la captura, cuando NO es la declarada pero la captura es
 * clara: para corregir las estaciones sin mandar el viaje a revision.
 *
 * Solo devuelve algo si:
 *   - un trayecto de la captura tiene dos estaciones que existen y distintas,
 *     la MISMA duracion declarada (±5 s) y horas que cuadran con ella;
 *   - al menos DOS lecturas distintas (Tesseract, PaddleOCR, relecturas)
 *     coinciden en esa ruta;
 *   - y no hay otra ruta que tambien lo cumpla (sin ambigüedad).
 *
 * La duracion es lo que decide los puntos y sale de la captura; equivocarse de
 * estaciones al declarar (la ruta al reves que rellenaba la web, un numero mal
 * tecleado) no es trampa. Pura.
 *
 * @returns {{ ruta: string, lectura: object }|null}
 */
function rutaDeLaCaptura(lecturas, tiempoSegundos) {
  const apoyos = new Map();
  for (const [i, l] of (lecturas || []).entries()) {
    if (!l?.disponible) continue;
    const candidatos = Array.isArray(l.trayectos) && l.trayectos.length ? l.trayectos : [l];
    for (const t of candidatos) {
      let ruta;
      try { ruta = construirRuta(t.origen, t.destino).ruta; } catch { continue; }
      if (!Number.isFinite(t.segundosDuracion) || Math.abs(t.segundosDuracion - tiempoSegundos) > 5) continue;
      const sa = horaASegundos(t.horaSalida);
      const ll = horaASegundos(t.horaLlegada);
      if (sa === null || ll === null) continue;
      let entre = ll - sa;
      if (entre < 0) entre += 24 * 3600;
      const margen = /:\d{2}:\d{2}/.test(`${t.horaSalida}${t.horaLlegada}`) ? 5 : 65;
      if (Math.abs(entre - t.segundosDuracion) > margen) continue;
      if (!apoyos.has(ruta)) apoyos.set(ruta, { lecturas: new Set(), lectura: { ...l, ...t } });
      apoyos.get(ruta).lecturas.add(i);
    }
  }
  const firmes = [...apoyos].filter(([, a]) => a.lecturas.size >= 2);
  if (firmes.length !== 1) return null;
  const [ruta, { lectura }] = firmes[0];
  return { ruta, lectura: { ...lectura, trayectos: [] } };
}

/**
 * Ejecuta todas las comprobaciones y decide.
 * Devuelve siempre un objeto serializable, listo para guardar en el viaje: el
 * admin ve exactamente por que se ha tomado la decision.
 */
function evaluar(contexto) {
  const impecable = capturaImpecable(contexto);
  // `impecable` lo calcula el propio motor, no viene del worker.
  const fisica = comprobarFisica(contexto, { impecable });
  const todas = [
    ...fisica.señales,
    ...comprobarCaptura(contexto),
    ...comprobarDuplicado(contexto),
    ...comprobarViajeRepetido(contexto),
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
  // Con la captura impecable, el ruido se anota pero no pesa.
  const señales = impecable
    ? todas.map((s) => (RUIDO.has(s.codigo) && !s.decisiva
      // Con el OCR casi a ciegas no: que todo coincida podria ser suerte.
      && !(s.codigo === 'lectura_poco_segura' && (contexto.lectura?.confianza ?? 0) < 35)
      ? { ...s, gravedad: 0, anotada: true } : s))
      // La captura dice otro dia, pero todo lo demas es exactamente lo
      // declarado: es alguien que sube hoy un viaje de ayer y se equivoco de
      // dia (los 7 casos del estreno que fueron a revision por esto, buenos).
      // Si ese dia es valido —desde el estreno, sin pasar de hoy— se anota
      // con poco peso. Una captura vieja de verdad (fuera de plazo) sigue
      // yendo a revision.
      .map((s) => (s.codigo === 'fecha_captura_distinta' && fechaDentroDePlazo(s.fechaCaptura, contexto.fechaViaje)
        ? { ...s, gravedad: 10, anotada: true } : s))
    : todas;

  const decisiva = señales.find((s) => s.decisiva);
  const riesgo = señales.reduce((total, s) => total + s.gravedad, 0);
  const riesgoSinLectura = señales
    .filter((s) => !DE_LECTURA.has(s.codigo))
    .reduce((total, s) => total + s.gravedad, 0);

  let decision;
  let resumen;

  if (decisiva) {
    decision = decisiva.decisiva;
    resumen = decisiva.mensaje;
  } else if (riesgoSinLectura >= RIESGO.UMBRAL_RECHAZO && contexto.primerViaje) {
    // El primer trayecto de alguien no se rechaza solo por señales sumadas:
    // lo mira una persona. Un primer rechazo es donde mas gente se va (lo dice
    // scripts/simular-semana.js), y en quien empieza las señales blandas — un
    // recorte raro, un ritmo sin historial con el que compararse — pesan mas
    // de lo que deberian. Lo decisivo (velocidad imposible, captura repetida o
    // manipulada) se sigue rechazando igual.
    decision = 'revision';
    resumen = 'Primer trayecto: lo revisa una persona en vez de rechazarlo solo.';
  } else if (riesgoSinLectura >= RIESGO.UMBRAL_RECHAZO) {
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
    impecable,
    metros: fisica.metros,
    kmh: fisica.kmh,
    evaluadoEn: new Date().toISOString(),
    varianteCaptura: contexto.lectura?.variante || null,
  };
}

module.exports = {
  capturaImpecable, RUIDO, mejorLectura, fechaDentroDePlazo, rutaDeLaCaptura, tiempoInventado,
  evaluar, distribucion, distanciaCalleMetros, velocidadKmh, DE_LECTURA, firmaDeLectura, compararFirmas,
};
