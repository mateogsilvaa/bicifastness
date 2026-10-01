/**
 * Leer la captura EN EL NAVEGADOR, para poder preguntar "esto es lo que veo,
 * confirmas?" en el momento (issue #8).
 *
 * Antes habia que transcribir a mano las dos estaciones y el tiempo que ya
 * estaban en la imagen, y cada errata acababa en la cola de revision manual.
 * Ahora se escribe solo lo que haya que corregir.
 *
 * POR QUE AQUI Y NO EN EL WORKER. El worker tambien lee la captura, y va a
 * seguir haciendolo: es el unico que decide. Pero tarda minutos, y una pantalla
 * de confirmacion que llega minutos despues no es una confirmacion, es otra
 * espera. Lo de aqui es para la persona; lo del worker es para el veredicto.
 *
 * LO QUE CUESTA. El motor y el modelo de idioma son unos cinco megas que el
 * navegador se baja UNA vez, y solo cuando alguien va a subir un viaje de
 * verdad (esto se carga al elegir la foto, no al abrir la pagina). Si algo
 * falla — navegador antiguo, red mala, sin espacio — la pagina de subida cae al
 * formulario manual de siempre. Nunca se queda nadie sin poder subir.
 *
 * NADA DE ESTO ES SEGURIDAD. Lo que se lea aqui es una PROPUESTA que el usuario
 * confirma o corrige, y el worker vuelve a leer la captura por su cuenta y
 * compara. Quien manipule lo que sale de aqui se encuentra con esa comparacion.
 *
 * Este fichero no importa nada del proyecto a proposito: asi los tests pueden
 * cargarlo sin navegador (ver `backend/test/cliente.test.js`).
 */

const RUTA_OCR = '/assets/ocr';

/**
 * Los cuatro ajustes que TIENEN que ser los mismos que los del worker.
 *
 * Estan aqui juntos y exportados por un motivo concreto: cada uno estaba suelto
 * con un comentario que decia "el mismo que el worker", y nada lo comprobaba.
 * Si alguno se moviera de un lado y no del otro, el navegador leeria la captura
 * distinto de como la va a leer el worker — y toda la gracia de leerla aqui es
 * proponer LO QUE EL WORKER VA A VER. Cuando no coinciden, la persona confirma
 * una cosa, el worker lee otra, salta `ruta_no_coincide` o `tiempo_no_coincide`
 * y el viaje acaba en revision manual: justo lo que esta pantalla existe para
 * evitar.
 *
 * Y es una divergencia que no da la cara. Nada falla, nada avisa: simplemente
 * empiezan a caer mas viajes en la cola, y eso no se parece a un fallo de
 * programacion sino a que "el OCR es malo".
 *
 * Ahora las cuatro se comparan contra el worker en `test/cliente.test.js`, y
 * las constantes de abajo salen de aqui para que lo que se prueba sea lo mismo
 * que se usa.
 */
export const AJUSTES_WORKER = {
  /** `backend/src/normalizar.js` -> ANCHO */
  ANCHO: 1400,
  /** `backend/src/normalizar.js` -> UMBRAL_OSCURO */
  UMBRAL_OSCURO: 110,
  /** `backend/src/ocr.js` -> SEGMENTACION */
  SEGMENTACION: '3',
  /** `backend/src/ocr.js` -> RESOLUCION */
  RESOLUCION: '600',
  /** `backend/src/normalizar.js` -> NIVELES (el gris claro de la bici y las fechas, a oscuro) */
  NIVELES: { DESDE: 140, HASTA: 240 },
};

/** Ancho al que se lee, el mismo que usa el worker (`backend/src/normalizar.js`). */
const ANCHO_OCR = AJUSTES_WORKER.ANCHO;

/** Por debajo de esta luminancia media la captura es de modo oscuro. */
const UMBRAL_OSCURO = AJUSTES_WORKER.UMBRAL_OSCURO;

/**
 * Modo de segmentacion de pagina. El mismo que el worker, y por el mismo
 * motivo: sin fijarlo, tesseract se come la linea de la duracion cuando va
 * grande y aislada.
 */
const SEGMENTACION = AJUSTES_WORKER.SEGMENTACION;

/**
 * Resolucion que se le declara a tesseract.
 *
 * Si no se le dice, la estima y ESCRIBE UN AVISO en cada lectura ("Estimating
 * resolution as 608"). Emscripten manda ese aviso por `printErr`, que en el
 * navegador es `console.error`: una linea roja por captura, en la pantalla
 * donde la gente sube sus viajes. Parece que la web esta rota.
 *
 * El valor no es un 300 copiado de un tutorial: la captura se normaliza a 1400
 * px de ancho y una pantalla de movil mide unos 7 cm, o sea unos 600 puntos por
 * pulgada de verdad, que es ademas lo que estimaba tesseract solo. Sobre el
 * banco de capturas da los mismos aciertos que sin declararlo (55/55, medido
 * con 300, con 600 y sin nada), asi que esto solo calla el aviso.
 */
const RESOLUCION = AJUSTES_WORKER.RESOLUCION;

/**
 * Tope para una lectura. Si se pasa de aqui, se le da el formulario manual.
 *
 * Sin esto, un motor que se queda a medias (wasm que no instancia, memoria que
 * no llega) deja la pantalla esperando para siempre y sin decir nada, que es la
 * peor forma de fallar que existe.
 */
const TIMEOUT_MS = 45000;

// --- Parseo del texto ---------------------------------------------------------
/**
 * OJO: estas tres funciones son GEMELAS de las de `backend/src/ocr.js`.
 *
 * Estan duplicadas porque el backend es CommonJS y esto es un modulo ES que
 * ademas tiene que poder cargarse suelto; compartir el fichero exigiria un
 * empaquetador que este proyecto no tiene. Lo que impide que se separen es un
 * test que ejecuta LAS DOS sobre el mismo corpus de textos y exige que
 * devuelvan lo mismo. Si tocas una, toca la otra.
 */

const HORA = '\\b([01]?\\d|2[0-3]):([0-5]\\d)\\b';

export function horasEtiquetadas(texto) {
  const conEtiqueta = (etiquetas) => {
    const m = texto.match(new RegExp(`(?:${etiquetas})\\W{0,12}${HORA}`, 'i'));
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
  };

  return {
    salida: conEtiqueta('salida|inicio|comienzo|desde'),
    llegada: conEtiqueta('llegada|fin|final|hasta'),
  };
}

export function extraerHoras(texto) {
  const { salida, llegada } = horasEtiquetadas(texto);
  if (salida && llegada) return [salida, llegada];

  // Formato actual de la app: cada estacion con su "21/09/25 02:51:12".
  const conFecha = extraerFechas(texto);
  if (conFecha.length >= 2) return [conFecha[0].hora, conFecha[1].hora];

  const encontradas = [...texto.matchAll(new RegExp(HORA, 'g'))]
    .map((m) => `${m[1].padStart(2, '0')}:${m[2]}`);
  return [...new Set(encontradas)];
}

export function extraerEstaciones(texto) {
  // Solo el "(124)" que cierra "124 - Nombre (124)": un parentesis suelto (el
  // icono del reloj leido como "(5)") no es una estacion.
  const conParentesis = [...texto.matchAll(/-[^\n()]*?\S\s*\(?(\d{1,3}[a-zA-Z]?)\)/g)].map((m) => m[1]);
  if (conParentesis.length >= 2) return conParentesis;

  const alPrincipio = [...texto.matchAll(/^\s*(\d{1,3})\s*[-–]\s*\S/gm)].map((m) => m[1]);
  // Una linea sola con su "(124)": la lectura por lineas de extraerTrayectos.
  if (alPrincipio.length) return alPrincipio;
  if (conParentesis.length) return conParentesis;
  // Nombre cortado por la app ("176 - Plaza de la Beata María Ana de Jesús (17..."):
  // numero, guion y nombre, en una linea sin mas numeros de estacion.
  const cortada = String(texto).match(/(?:^|\s)(\d{1,3})\s*[-–]\s*[A-Za-zÁÉÍÓÚÑáéíóúñ][^\n]*\(\d{0,3}\.{2,}/);
  return cortada ? [cortada[1]] : [];
}

export function extraerDuracion(texto) {
  const conUnidades = texto.match(/(\d{1,3})\s*min(?:utos?)?(?:\s*(?:y\s*)?(\d{1,2})\s*s)?/i);
  if (conUnidades) return Number(conUnidades[1]) * 60 + Number(conUnidades[2] || 0);

  // "17m. 18s.", el de la app actual.
  const abreviado = texto.match(/(\d{1,3})\s*m\.?\s*(\d{1,2})\s*s\b/i);
  if (abreviado) return Number(abreviado[1]) * 60 + Number(abreviado[2]);

  const junto = texto.match(/(?:duraci[oó]n|tiempo)\D{0,20}(\d{1,3}):([0-5]\d)/i);
  if (junto) return Number(junto[1]) * 60 + Number(junto[2]);

  return null;
}

/**
 * El numero de la bici ("Bicicleta 2471", "Bici nº 10310").
 *
 * Solo con la palabra delante: un numero suelto de 4 cifras en la captura
 * puede ser cualquier cosa (la hora sin dos puntos, un importe, un codigo). Y
 * "BiciMAD" no cuenta como "bici": el limite de palabra lo impide.
 */
export function extraerBici(texto) {
  const m = String(texto || '').match(/\bbici(?:cleta)?\b\W{0,4}(?:n(?:[º°o.]|[uú]m(?:ero)?\.?)\s*)?[:#]?\s*(\d{3,5})\b/i);
  return m ? m[1] : biciSuelta(texto);
}

/**
 * Formato actual de la app: el numero de la bici va solo, junto al icono y
 * ANTES de la primera estacion, sin la palabra "bici". Se busca solo ahi, y se
 * corrige lo que el OCR confunde en ese gris claro (l, I, | por 1; o, O por 0:
 * "lo310" es la 10310).
 */
/** El numero de bici de una linea suelta ("7 18853 O", "— 75 lo310"), o ''. */
export function biciDeLinea(linea) {
  if (/[:/€]/.test(linea)) return '';
  for (const trozo of String(linea || '').split(/\s+/)) {
    if (!/^[0-9lIioO|]{4,6}$/.test(trozo) || (trozo.match(/\d/g) || []).length < 3) continue;
    const numero = trozo.replace(/[lIi|]/g, '1').replace(/[oO]/g, '0');
    if (/^\d{4,5}$/.test(numero)) return numero;
  }
  return '';
}

export function biciSuelta(texto) {
  const lineas = String(texto || '').split(/\r?\n/);
  const primera = lineas.findIndex((l) => /\(\d{1,3}[a-zA-Z]?\)/.test(l));
  if (primera <= 0) return '';
  for (const linea of lineas.slice(0, primera)) {
    for (const trozo of linea.split(/\s+/)) {
      if (!/^[0-9lIioO|]{4,6}$/.test(trozo) || (trozo.match(/\d/g) || []).length < 3) continue;
      const numero = trozo.replace(/[lIi|]/g, '1').replace(/[oO]/g, '0');
      if (/^\d{4,5}$/.test(numero)) return numero;
    }
  }
  return '';
}

/**
 * Fecha y hora de cada estacion, formato actual de la app ("21/09/25 02:51:12":
 * la primera es la salida y la segunda la llegada). La fecha es la del
 * trayecto, y con ella se comprueba que no tenga mas de un mes.
 */

/**
 * Tiempo de una barra leida aparte ("llm. 44s." es 11m. 44s.): la letra de
 * BiciMAD hace que el 1 salga l, I o |, y el 0, o u O.
 */
export function tiempoDeBarra(texto) {
  const t = String(texto || '').replace(/[lI|]/g, '1').replace(/[oO]/g, '0');
  const m = t.match(/(\d{1,3})\s*m\.?\s*(\d{1,2})\s*s/);
  if (!m || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Numero de bici de la pasada de solo numeros: "7518853" es el icono leido
 * como "75" seguido de la bici. Fechas, horas y tiempos no valen.
 */
export function biciDeNumero(texto) {
  const t = String(texto || '');
  if (!/^\d{4,7}$/.test(t)) return '';
  if (t.length <= 5) return t;
  // "235 - Sodio (235)" sin letras es "235235": eso es una estacion, no una bici.
  if (t.length === 6 && t.slice(0, 3) === t.slice(3)) return '';
  return t.slice(-5);
}

/**
 * Pone a cada trayecto el tiempo y la bici que le tocan por ALTURA en la
 * captura, cuando el historial trae varias tarjetas. La barra del tiempo va
 * debajo de su salida; la bici, encima.
 *
 * @param {Array} trayectos  los de extraerTrayectos
 * @param {Array<{texto: string, y: number}>} lineas  las de la pasada principal
 * @param {Array<{segundos: number, y: number}>} tiempos
 * @param {Array<{bici: string, y: number}>} bicis
 */
/**
 * Los campos sueltos de la lectura (origen, tiempo, bici…) son los del primer
 * trayecto, que es el que mejor se ha leido: con su tiempo sacado de las horas
 * y su bici por altura. Sin trayectos, se quedan como estaban.
 */
export function conPrimerTrayecto(lectura) {
  const [t] = lectura.trayectos || [];
  if (!t) return lectura;
  const sale = { ...lectura };
  for (const campo of ['origen', 'destino', 'horaSalida', 'horaLlegada', 'segundosDuracion', 'numeroBici', 'fecha']) {
    if (t[campo] !== '' && t[campo] !== null && t[campo] !== undefined) sale[campo] = t[campo];
  }
  return sale;
}

export function asignarPorAltura(trayectos, lineas, tiempos, bicis) {
  // La altura de la salida de cada trayecto: cada dos estaciones, uno nuevo.
  const salidas = [];
  let estaciones = 0;
  for (const { texto, y } of lineas) {
    for (let i = 0; i < extraerEstaciones(texto).length; i++) {
      if (estaciones % 2 === 0) salidas.push(y);
      estaciones++;
    }
  }
  if (salidas.length !== trayectos.length) return trayectos;
  const porHoras = trayectos.map((t) => Boolean(t.tiempoPorHoras));
  const conDatos = trayectos.map((t) => ({ ...t }));
  for (const { segundos, y } of tiempos) {
    let k = -1;
    salidas.forEach((ys, i) => { if (ys < y) k = i; });
    if (k >= 0 && segundos && !porHoras[k]) conDatos[k].segundosDuracion = segundos;
  }
  for (const { bici, y } of bicis) {
    const k = salidas.findIndex((ys) => ys > y);
    if (k >= 0 && (k === 0 || salidas[k - 1] < y) && bici) conDatos[k].numeroBici = bici;
  }
  return conDatos;
}

export function extraerFechas(texto) {
  const re = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\s+([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?/g;
  return [...String(texto || '').matchAll(re)].flatMap((m) => {
    const dia = Number(m[1]);
    const mes = Number(m[2]);
    if (dia < 1 || dia > 31 || mes < 1 || mes > 12) return [];
    const anio = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return [{
      fecha: `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`,
      hora: `${m[4].padStart(2, '0')}:${m[5]}`,
      // Segundos desde medianoche, si la captura trae los segundos.
      segundosDia: m[6] !== undefined ? Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6]) : null,
    }];
  });
}

/**
 * Trocea el texto de la captura en TRAYECTOS (issue #11).
 *
 * El historial de BiciMAD es una lista, asi que es de lo mas normal que una
 * captura recoja dos o tres viajes. Hasta ahora se leia como si siempre hubiera
 * uno: se cogian las dos primeras estaciones y la primera duracion, y el resto
 * de la imagen se ignoraba. Quien subia una captura de su dia acababa en la
 * cola de revision manual sin entender por que.
 *
 * COMO SE TROCEA. Por lineas, y con una regla simple: cada vez que aparece una
 * estacion cuando el trayecto que se esta montando ya tiene las dos suyas,
 * empieza uno nuevo. Las horas solo cuentan si van ETIQUETADAS (salida,
 * llegada), que es lo que evita que el reloj de la barra de estado se cuele
 * como hora de salida del primero.
 *
 * No se usa la geometria de la imagen (posiciones de cada linea) a proposito:
 * seria mas exacto, pero ata el parseo a lo que devuelva la version de turno
 * del OCR, y esto tiene que funcionar igual en el navegador y en el worker.
 */
export function extraerTrayectos(texto) {
  const trayectos = [];
  let actual = null;

  const guardar = () => {
    if (actual && actual.origen && actual.destino) trayectos.push(actual);
    actual = null;
  };

  const nuevo = () => ({
    origen: '', destino: '', horaSalida: '', horaLlegada: '', segundosDuracion: null, numeroBici: '', fecha: '',
  });

  let biciPendiente = '';
  const segundosSalida = new WeakMap();
  const porHoras = new WeakMap();
  for (const linea of String(texto || '').split(/\r?\n/)) {
    const estaciones = extraerEstaciones(linea);

    // En el historial cada tarjeta empieza con su bici ("18853"), antes de sus
    // estaciones: se guarda y se da al trayecto que empieza despues.
    if (!estaciones.length && !extraerBici(linea)) {
      const suelta = biciDeLinea(linea);
      if (suelta && (!actual || (actual.origen && actual.destino))) biciPendiente = suelta;
    }

    for (const estacion of estaciones) {
      if (!actual) actual = nuevo();
      // Ya tenia las dos: esta estacion abre el siguiente trayecto.
      if (actual.origen && actual.destino) { guardar(); actual = nuevo(); }
      if (biciPendiente && !actual.origen && !actual.numeroBici) { actual.numeroBici = biciPendiente; biciPendiente = ''; }

      if (!actual.origen) actual.origen = estacion;
      else actual.destino = estacion;
    }

    if (!actual) continue;

    const horas = horasEtiquetadas(linea);
    if (horas.salida && !actual.horaSalida) actual.horaSalida = horas.salida;
    if (horas.llegada && !actual.horaLlegada) actual.horaLlegada = horas.llegada;

    for (const { fecha, hora, segundosDia } of extraerFechas(linea)) {
      if (!actual.fecha) actual.fecha = fecha;
      if (!actual.horaSalida) {
        actual.horaSalida = hora;
        segundosSalida.set(actual, segundosDia);
      } else if (!actual.horaLlegada && hora !== actual.horaSalida) {
        actual.horaLlegada = hora;
        // De la salida a la llegada, con segundos: es el tiempo del trayecto.
        const desde = segundosSalida.get(actual);
        if (desde !== null && desde !== undefined && segundosDia !== null) {
          const duracion = (segundosDia - desde + 86400) % 86400;
          if (duracion > 0 && duracion <= 3 * 3600) porHoras.set(actual, duracion);
        }
      }
    }

    const duracion = extraerDuracion(linea);
    if (duracion !== null && actual.segundosDuracion === null) actual.segundosDuracion = duracion;

    const bici = extraerBici(linea);
    if (bici && !actual.numeroBici) actual.numeroBici = bici;
  }

  guardar();
  // El tiempo sacado de las horas manda sobre el leido en la barra. Se marca
  // (sin enumerar, para no cambiar la forma del trayecto) para que la pasada
  // de la barra no lo pise.
  for (const t of trayectos) {
    if (porHoras.has(t)) {
      t.segundosDuracion = porHoras.get(t);
      Object.defineProperty(t, 'tiempoPorHoras', { value: true, enumerable: false });
    }
  }
  // La bici suelta va antes de la primera estacion, fuera de cualquier trayecto.
  const suelta = biciSuelta(texto);
  if (suelta && trayectos[0] && !trayectos[0].numeroBici) trayectos[0].numeroBici = suelta;
  return trayectos;
}

/**
 * De todos los trayectos de la captura, el que dice ser este viaje.
 *
 * Sin esto, subir los tres viajes de una misma captura acabaria con dos
 * rechazados por `ruta_no_coincide`: el motor compararia los tres contra el
 * primer trayecto que se lea. Si ninguno encaja se devuelve el primero, y
 * entonces la señal salta con razon.
 */
export function elegirTrayecto(lectura, ruta) {
  const trayectos = (lectura && lectura.trayectos) || [];
  if (trayectos.length <= 1) return lectura;

  const sinCeros = (v) => String(v || '').replace(/^0+/, '');
  const [origen, destino] = String(ruta || '').split('-').map(sinCeros);

  const encaja = trayectos.find((t) => sinCeros(t.origen) === origen && sinCeros(t.destino) === destino);
  return { ...lectura, ...(encaja || trayectos[0]) };
}

export const MARCADORES = [
  'bicimad', 'emt', 'trayecto', 'recorrido', 'duracion', 'duración',
  'estacion', 'estación', 'salida', 'llegada', 'bicicleta', 'viajes realizados',
];

/**
 * ¿Es una captura de la app de BiciMAD? Una palabra suya, o dos estaciones con
 * su forma ("124 - Nombre (124)") y ademas el tiempo o la fecha y hora de cada
 * una. Antes pedia el tiempo del texto principal, y en el historial la barra
 * azul se lee mal en esa pasada ("Tim. 00s."): capturas buenas acababan
 * rechazadas como "no es BiciMAD", que ademas es un rechazo directo.
 */
export function esCapturaBicimad(texto, plano, estaciones) {
  if (MARCADORES.some((m) => plano.includes(m))) return true;
  if (estaciones.length < 2) return false;
  return extraerDuracion(texto) !== null || extraerFechas(texto).length >= 2 || extraerTrayectos(texto).length > 0;
}

/** Lo que se puede sacar de un texto ya leido. Sin navegador: se puede probar. */
export function interpretar(texto) {
  const plano = String(texto || '').toLowerCase();
  const horas = extraerHoras(texto);
  const estaciones = extraerEstaciones(texto);

  return conPrimerTrayecto({
    esBicimad: esCapturaBicimad(texto, plano, estaciones),
    // Todos los trayectos de la captura (#11). Los campos sueltos siguen siendo
    // los del primero, para quien solo espera uno.
    trayectos: extraerTrayectos(texto),
    origen: estaciones[0] || '',
    destino: estaciones[1] || '',
    horaSalida: horas[0] || '',
    horaLlegada: horas[1] || '',
    segundosDuracion: extraerDuracion(texto),
    numeroBici: extraerBici(texto),
    fecha: extraerFechas(texto)[0]?.fecha || '',
  });
}

// --- Motor --------------------------------------------------------------------

let worker = null;
let cargando = null;

/**
 * Aviso del `errorHandler` de la lectura en curso.
 *
 * `errorHandler` NO es opcional aunque lo parezca, y aqui menos que en el
 * worker: sin el, tesseract hace `throw Error(data)` desde el manejador de
 * mensajes de su Worker, o sea FUERA de cualquier promesa. Eso no lo recoge
 * ningun try/catch, sale en la consola como error no capturado y ademas lo
 * recoge `errores.js`, que lo manda a `errores_cliente`. Una captura rara de
 * una persona se convertia en un fallo global de la web.
 */
let fallo = null;

/**
 * Arranca el worker de tesseract. Una sola vez por pestaña.
 *
 * `cargando` evita que dos fotos elegidas seguidas arranquen dos motores de
 * cinco megas cada uno.
 */
function arrancar(alProgresar) {
  if (worker) return Promise.resolve(worker);
  if (cargando) return cargando;

  cargando = (async () => {
    // La compilacion ESM de tesseract.js exporta TODO colgando de `default`, no
    // como exportaciones sueltas. Un `import { createWorker }` compila sin
    // quejarse y explota en ejecucion con "createWorker is not a function".
    const modulo = await import(`${RUTA_OCR}/tesseract.esm.min.js`);
    const { createWorker } = modulo.default || modulo;

    worker = await createWorker('spa', 1, {
      workerPath: `${RUTA_OCR}/worker.min.js`,
      // Un fichero concreto y no un directorio: asi tesseract no busca la
      // variante que toque y no hay que llevar las seis en el repositorio. Y
      // tiene que ser la que lleva el wasm incrustado, porque el worker corre
      // desde un `blob:` y desde ahi no se resuelve una ruta relativa.
      corePath: `${RUTA_OCR}/tesseract-core-simd-lstm.wasm.js`,
      langPath: RUTA_OCR,
      logger: (m) => {
        if (alProgresar && typeof m.progress === 'number') alProgresar(m.status, m.progress);
      },
      errorHandler: (datos) => { fallo = datos; },
    });

    await worker.setParameters({
      tessedit_pageseg_mode: SEGMENTACION,
      user_defined_dpi: RESOLUCION,
    });
    return worker;
  })();

  // Si falla, que el siguiente intento pueda volver a probar.
  cargando.catch(() => { cargando = null; worker = null; });
  return cargando;
}

/** Suelta el motor y sus cinco megas de memoria. */
export async function cerrar() {
  const suyo = worker;
  worker = null;
  cargando = null;
  fallo = null;
  // Con `catch` y sin ruido: esto suelta el motor cuando ya no queda nada que
  // leer. Un worker que no se deja cerrar limpiamente se va con la pestaña, y
  // avisar de ello solo serviria para preocupar por algo que no ha afectado a
  // ninguna captura.
  if (suyo) await suyo.terminate().catch(() => {});
}

/**
 * Deja la captura como la deja el worker antes de leerla: a un ancho fijo, en
 * gris y, si viene en modo oscuro, invertida.
 *
 * La inversion no es un capricho: tesseract acierta bastante mas con texto
 * oscuro sobre fondo claro, y sin ella una captura en modo oscuro se lee mucho
 * peor. Es la version de canvas de `backend/src/normalizar.js`; lo que no se
 * hace aqui es recortar margenes, que alli sirve para quitar la barra de estado
 * y aqui no compensa el codigo.
 */
export function prepararParaOcr(imagen, { niveles = true } = {}) {
  const escala = Math.min(ANCHO_OCR / imagen.naturalWidth, 4);
  const lienzo = document.createElement('canvas');
  lienzo.width = Math.round(imagen.naturalWidth * escala);
  lienzo.height = Math.round(imagen.naturalHeight * escala);

  const ctx = lienzo.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, lienzo.width, lienzo.height);
  ctx.drawImage(imagen, 0, 0, lienzo.width, lienzo.height);

  const pixeles = ctx.getImageData(0, 0, lienzo.width, lienzo.height);
  const datos = pixeles.data;

  let suma = 0;
  for (let i = 0; i < datos.length; i += 4) {
    datos[i] = 0.299 * datos[i] + 0.587 * datos[i + 1] + 0.114 * datos[i + 2];
    suma += datos[i];
  }

  const media = suma / (datos.length / 4);
  const invertir = media < UMBRAL_OSCURO;

  // Franjas oscuras (la barra azul del tiempo): blanco sobre oscuro se lee muy
  // mal. Cada fila oscura en mas de la mitad de su ancho se invierte y se
  // estira. Gemela de invertirFranjas (backend/src/normalizar.js).
  const franjas = [];
  let desde = -1;
  for (let y = 0; y < lienzo.height; y++) {
    const fila = y * lienzo.width * 4;
    let oscuros = 0;
    for (let x = 0; x < lienzo.width; x++) {
      const g = invertir ? 255 - datos[fila + x * 4] : datos[fila + x * 4];
      if (g < 130) oscuros++;
    }
    if (oscuros / lienzo.width <= 0.55) {
      if (desde >= 0 && y - desde >= 25) franjas.push([desde, y]);
      desde = -1;
      continue;
    }
    if (desde < 0) desde = y;
    for (let x = 0; x < lienzo.width; x++) {
      const i = fila + x * 4;
      const g = invertir ? 255 - datos[i] : datos[i];
      // Se guarda ya "invertido de vuelta" para que el bucle de abajo, que
      // invierte en modo oscuro, lo deje como debe quedar.
      const claro = Math.min(255, Math.round(((255 - g) * 255) / 170));
      datos[i] = invertir ? 255 - claro : claro;
    }
  }

  // El numero de la bici y la fecha y hora de cada estacion van en gris muy
  // claro: lo que este entre DESDE y HASTA se estira a 0..255 (el gris pasa a
  // casi negro, el blanco sigue blanco); lo mas oscuro no se toca, y asi el
  // texto blanco de la barra azul del tiempo sigue legible.
  const { DESDE, HASTA } = AJUSTES_WORKER.NIVELES;
  for (let i = 0; i < datos.length; i += 4) {
    let gris = invertir ? 255 - datos[i] : datos[i];
    if (niveles && gris >= DESDE) gris = Math.min(255, Math.round(((gris - DESDE) * 255) / (HASTA - DESDE)));
    datos[i] = gris;
    datos[i + 1] = gris;
    datos[i + 2] = gris;
    // El alfa se deja en paz. Invertirlo es lo que dejaba las capturas oscuras
    // completamente transparentes en el worker, y el OCR leia una hoja blanca.
  }

  if (desde >= 0 && lienzo.height - desde >= 25) franjas.push([desde, lienzo.height]);
  ctx.putImageData(pixeles, 0, 0);
  return { lienzo, oscura: invertir, franjas };
}

/**
 * Lee una captura y devuelve lo que ha entendido.
 *
 * Nunca lanza por culpa del OCR: si no se puede leer devuelve
 * `{ disponible: false }` y quien llama enseña el formulario manual.
 *
 * @param {HTMLImageElement} imagen  la captura ya decodificada
 * @param {(estado: string, progreso: number) => void} [alProgresar]
 */
export async function extraer(imagen, alProgresar) {
  let temporizador = null;

  try {
    const { lienzo, oscura, franjas } = prepararParaOcr(imagen);

    // El reloj cuenta desde el principio: la descarga del motor tambien puede
    // quedarse colgada, y para quien espera es el mismo problema.
    const conReloj = (promesa) => Promise.race([
      promesa,
      new Promise((_, mal) => {
        temporizador = setTimeout(() => mal(new Error('La lectura ha tardado demasiado.')), TIMEOUT_MS);
      }),
    ]);

    const motor = await conReloj(arrancar(alProgresar));

    // El aviso es de ESTA lectura: se limpia antes de pedirla, porque el
    // manejador se instala una vez y el motor se reutiliza.
    fallo = null;

    // `blocks`: la posicion de cada linea, para marcar en la captura lo que se
    // ha leido (8f: los recuadros azules sobre las dos estaciones).
    const { data } = await conReloj(motor.recognize(lienzo, {}, { text: true, blocks: true }));

    // Tesseract puede avisar de un problema sin llegar a rechazar la promesa.
    // Lo leido entonces no es de fiar: mejor el formulario a mano.
    if (fallo) throw new Error(String(fallo).slice(0, 200));

    const texto = String(data.text || '');

    const lineas = (data.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((pa) => pa.lines || []));
    const cajas = lineas
      .filter((l) => /-[^()]*\S\s*\(\d{1,3}[a-zA-Z]?\)\s*$/.test(String(l.text || '').trim()))
      .map(({ bbox: c }) => ({
        x: (c.x0 / lienzo.width) * 100, y: (c.y0 / lienzo.height) * 100,
        ancho: ((c.x1 - c.x0) / lienzo.width) * 100, alto: ((c.y1 - c.y0) / lienzo.height) * 100,
      }));

    let leido = interpretar(texto);

    // Pasadas de solo numeros con el mismo motor (como el worker): el tiempo de
    // cada barra azul, leida como una linea, y las bicis. Cada uno va al
    // trayecto que le toca por altura.
    try {
      const tiempos = [];
      const bicis = [];
      await motor.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789msIl|oO. ' });
      for (const [desde, hasta] of franjas) {
        const corte = document.createElement('canvas');
        const x = Math.round(lienzo.width * 0.12);
        const ancho = Math.round(lienzo.width * 0.42);
        corte.width = ancho * 2;
        corte.height = (hasta - desde) * 2;
        corte.getContext('2d').drawImage(lienzo, x, desde, ancho, hasta - desde, 0, 0, corte.width, corte.height);
        const { data: d } = await conReloj(motor.recognize(corte));
        const segundos = tiempoDeBarra(d.text);
        if (segundos) tiempos.push({ segundos, y: desde });
      }
      await motor.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '0123456789' });
      const { data: n } = await conReloj(motor.recognize(lienzo, {}, { text: true, blocks: true }));
      for (const palabra of (n.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((pa) => (pa.lines || []).flatMap((l) => l.words || [])))) {
        const bici = biciDeNumero(palabra.text);
        if (bici) bicis.push({ bici, y: palabra.bbox.y0 });
      }
      leido = conPrimerTrayecto({
        ...leido,
        trayectos: asignarPorAltura(leido.trayectos, lineas.map((l) => ({ texto: String(l.text || ''), y: l.bbox.y0 })), tiempos, bicis),
      });
    } finally {
      await motor.setParameters({ tessedit_pageseg_mode: SEGMENTACION, tessedit_char_whitelist: '' });
    }

    // Segunda oportunidad. El retoque de grises es lo que deja leer la bici y
    // las fechas, pero en alguna captura (fondos grises, modo oscuro raro) se
    // come otra cosa. Si falta algo de lo imprescindible, se lee otra vez SIN
    // retoque y se rellena solo lo que faltaba: la primera lectura manda.
    const falta = (l) => !l.origen || !l.destino || !l.segundosDuracion;
    if (falta(leido)) {
      fallo = null;
      const { data: otra } = await conReloj(motor.recognize(prepararParaOcr(imagen, { niveles: false }).lienzo));
      if (!fallo) {
        const segunda = interpretar(String(otra.text || ''));
        const rellenado = { ...leido };
        for (const [clave, valor] of Object.entries(segunda)) {
          const vacio = rellenado[clave] === '' || rellenado[clave] === null || rellenado[clave] === undefined
            || (Array.isArray(rellenado[clave]) && !rellenado[clave].length);
          if (vacio) rellenado[clave] = valor;
        }
        leido = rellenado;
      }
    }

    return {
      disponible: true,
      cajas,
      oscura,
      confianza: Math.max(0, Math.min(100, Math.round(data.confidence ?? 0))),
      texto,
      ...leido,
    };
  } catch (error) {
    // Un navegador sin SIMD, sin espacio o sin red se queda aqui. No es un
    // error del usuario y no se le cuenta como tal: se le da el formulario.
    // `console.debug` y no `console.error` a proposito: esto NO es un fallo de
    // la web, es una captura que no se ha podido leer, y para eso esta el
    // formulario a mano. Sacarlo como error llenaria la consola de rojo y el
    // recogedor de errores de ruido.
    console.debug('No se ha podido leer la captura en el navegador', error);
    return { disponible: false, error: error?.message || 'No se ha podido leer la captura.' };
  } finally {
    // Cancelarlo importa: un temporizador de 45 s que sobrevive a cada lectura
    // mantiene la pestaña despierta sin motivo. Es el mismo fallo que tenia el
    // worker y que se encontro midiendo el banco.
    clearTimeout(temporizador);
  }
}
