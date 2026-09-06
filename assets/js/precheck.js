/**
 * Comprobaciones de la captura ANTES de subirla, y compresion.
 *
 * Que es esto y que no es. Todo lo que hay aqui se vuelve a comprobar en el
 * worker, que es el unico que decide. Esto no es seguridad y no sirve de nada
 * contra quien quiera saltarselo: cualquiera puede abrir la consola y llamar al
 * envio directamente. Es CORTESIA. El worker tarda unos diez minutos, asi que
 * subir una foto movida cuesta diez minutos de espera para nada, y eso es justo
 * lo que hace que la gente no vuelva a subir un segundo viaje.
 *
 * Por eso ningun aviso BLOQUEA: se dice lo que se ve y, si la persona insiste,
 * se sube igual. Quien sabe que su foto es rara y aun asi quiere intentarlo
 * tiene derecho a hacerlo; a veces tendra razon.
 *
 * Los umbrales de aqui no son antifraude y no hay problema en enseñarlos: son
 * "esta borrosa" y "esta es muy pequeña". Los del antifraude viven en el
 * servidor y no salen de ahi.
 *
 * Este fichero no importa nada a proposito, para que los tests puedan cargarlo
 * sin navegador: las funciones que miden estan separadas de las que tocan el
 * DOM y son las que se prueban.
 */

export const LIMITES_CLIENTE = {
  // Los mismos que `LIMITES.MIMES_IMAGEN` del backend. Un test los ata.
  MIMES: ['image/jpeg', 'image/png', 'image/webp'],

  // Presupuesto REAL de la captura: no es `MAX_BYTES_IMAGEN` (3 MB), es el
  // tope que imponen las reglas de Firestore al campo `datos` de `capturas`,
  // que se mide en caracteres del data URL, no en bytes de imagen. Un
  // documento de Firestore no puede pasar de 1 MiB y ahi dentro tiene que
  // caber tambien el resto de campos. Si esto se pasa, la escritura la rechaza
  // la regla y el usuario ve un "permission-denied" que no explica nada.
  MAX_CARACTERES_DATA_URL: 700000,

  // A donde se lleva la captura antes de subirla. Es el ancho al que el worker
  // normaliza para leerla (`backend/src/normalizar.js`), y mandarsela ya a esa
  // medida le ahorra AMPLIAR, que es justo el caso en el que el OCR falla.
  // Nunca se amplia aqui: si la foto viene mas pequeña, se sube tal cual y ya
  // decidira el servidor.
  ANCHO_SUBIDA: 1400,

  // Calidades JPEG que se prueban, de mejor a peor, hasta que la imagen cabe.
  // Se empieza alto a proposito: lo que se juega aqui es que se lea el texto.
  CALIDADES: [0.9, 0.82, 0.74, 0.66],
  // Si ni con la peor calidad cabe, se va reduciendo el ancho.
  ANCHOS_DE_RESERVA: [1100, 900, 700],

  // Por debajo de esto no hay pixeles suficientes para que se lean los nombres
  // de las estaciones, ni ampliando.
  MIN_ANCHO: 600,

  // Una captura de movil es mas alta que ancha. Si llega apaisada casi siempre
  // es una foto de otra pantalla, o un recorte que se ha comido media captura.
  PROPORCION_MINIMA: 1,

  // Varianza del laplaciano por debajo de la cual la imagen se considera
  // movida. Se mide siempre sobre la misma medida (ANCHO_ANALISIS), porque la
  // varianza depende del tamaño y con imagenes de distinto ancho el numero no
  // seria comparable.
  //
  // El valor es conservador: una captura de pantalla autentica da valores muy
  // por encima (el texto tiene bordes duros) y una foto movida se queda muy por
  // debajo, asi que la franja de duda es ancha y solo avisamos cuando esta
  // claro. Queda pendiente afinarlo contra el banco de capturas reales (#16);
  // hasta entonces, mejor pasarse de callado que de pesado.
  UMBRAL_NITIDEZ: 80,
  ANCHO_ANALISIS: 640,

  // El mismo de `LIMITES.DIAS_MAX_ANTIGUEDAD`. Un test los ata.
  DIAS_MAX_ANTIGUEDAD: 30,

  // El mismo de `LIMITES.VIAJES_POR_DIA`, y con el mismo test detras. Aqui solo
  // sirve para no dejar elegir mas trayectos de los que el servidor va a
  // aceptar (#11): quien elige tres y ve rechazado el tercero no entiende nada.
  VIAJES_POR_DIA: 3,
};

// --- Medida de nitidez --------------------------------------------------------

/**
 * Varianza del laplaciano: la forma clasica de medir si una imagen esta
 * enfocada. El laplaciano responde a los cambios bruscos de luminosidad; en una
 * imagen nitida hay muchos y muy fuertes (los bordes del texto), y en una movida
 * todo son transiciones suaves, asi que su varianza se hunde.
 *
 * Se usa el nucleo de cuatro vecinos, que es el barato y aqui sobra:
 *
 *     L(x,y) = 4·c − arriba − abajo − izquierda − derecha
 *
 * @param {Uint8ClampedArray|number[]} gris  un valor de luminosidad por pixel
 * @param {number} ancho
 * @param {number} alto
 * @returns {number} varianza, o 0 si no hay interior que medir
 */
export function varianzaLaplaciano(gris, ancho, alto) {
  if (ancho < 3 || alto < 3) return 0;

  let suma = 0;
  let sumaCuadrados = 0;
  let cuenta = 0;

  // Solo el interior: en el borde faltan vecinos y tratarlos como negros
  // inventaria un salto de contraste en todo el perimetro.
  for (let y = 1; y < alto - 1; y++) {
    for (let x = 1; x < ancho - 1; x++) {
      const i = y * ancho + x;
      const l = 4 * gris[i] - gris[i - 1] - gris[i + 1] - gris[i - ancho] - gris[i + ancho];
      suma += l;
      sumaCuadrados += l * l;
      cuenta++;
    }
  }

  const media = suma / cuenta;
  return sumaCuadrados / cuenta - media * media;
}

/** Luminosidad percibida, de un RGBA plano a un valor por pixel. */
export function aGrises(rgba) {
  const gris = new Float32Array(rgba.length / 4);
  for (let i = 0; i < gris.length; i++) {
    const p = i * 4;
    gris[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return gris;
}

// --- Juicio sobre las medidas -------------------------------------------------

/**
 * Convierte medidas en avisos. Sin DOM, sin promesas: entra un objeto de
 * numeros y sale una lista de cosas que decirle a la persona.
 *
 * `gravedad` no es un porcentaje ni suma nada: solo distingue lo que conviene
 * mirar antes de subir ('alta') de lo que se dice de pasada ('baja').
 *
 * @param {object} medidas
 * @param {string} [medidas.tipo]              MIME del fichero
 * @param {number} [medidas.ancho]
 * @param {number} [medidas.alto]
 * @param {number} [medidas.nitidez]           varianza del laplaciano
 * @param {number} [medidas.diasAntiguedad]    del fichero, no del viaje
 * @param {number} [medidas.caracteresDataUrl] tamaño ya comprimido
 * @returns {Array<{codigo: string, texto: string, gravedad: 'alta'|'baja'}>}
 */
export function evaluarMedidas(medidas = {}) {
  const { tipo, ancho, alto, nitidez, diasAntiguedad, caracteresDataUrl } = medidas;
  const avisos = [];
  const aviso = (codigo, gravedad, texto) => avisos.push({ codigo, gravedad, texto });

  if (tipo !== undefined && !LIMITES_CLIENTE.MIMES.includes(tipo)) {
    aviso('tipo_no_admitido', 'alta',
      'Ese fichero no es una imagen de las que admitimos. Tiene que ser JPG, PNG o WEBP.');
  }

  if (ancho && ancho < LIMITES_CLIENTE.MIN_ANCHO) {
    aviso('resolucion_baja', 'alta',
      'La imagen es muy pequeña y puede que no se lean los nombres de las estaciones. '
      + 'Si la has sacado de una conversacion, busca la original en la galeria.');
  }

  if (ancho && alto && alto / ancho < LIMITES_CLIENTE.PROPORCION_MINIMA) {
    aviso('parece_apaisada', 'baja',
      'La imagen es mas ancha que alta, y una captura de movil suele ser al reves. '
      + 'Comprueba que no es una foto de otra pantalla ni un recorte a medias.');
  }

  if (Number.isFinite(nitidez) && nitidez < LIMITES_CLIENTE.UMBRAL_NITIDEZ) {
    aviso('foto_movida', 'alta',
      'La foto se ve movida o desenfocada. Si es una foto hecha a otra pantalla, '
      + 'sale mejor la captura de pantalla del propio movil.');
  }

  if (Number.isFinite(diasAntiguedad) && diasAntiguedad > LIMITES_CLIENTE.DIAS_MAX_ANTIGUEDAD) {
    aviso('demasiado_antigua', 'baja',
      `El fichero parece de hace mas de ${LIMITES_CLIENTE.DIAS_MAX_ANTIGUEDAD} dias, `
      + 'y solo se pueden reclamar trayectos de ese ultimo mes. '
      + 'La fecha del fichero no siempre es la del viaje, asi que puede ser una falsa alarma.');
  }

  if (caracteresDataUrl > LIMITES_CLIENTE.MAX_CARACTERES_DATA_URL) {
    aviso('demasiado_grande', 'alta',
      'No hemos conseguido dejar la captura en un tamaño que podamos guardar. '
      + 'Prueba con otra imagen.');
  }

  return avisos;
}

// --- Lo que necesita navegador -----------------------------------------------

/** Carga un fichero como imagen decodificada. */
function cargarImagen(fichero) {
  return new Promise((resolver, rechazar) => {
    const url = URL.createObjectURL(fichero);
    const img = new Image();
    // La URL se suelta pase lo que pase: si no, cada foto elegida se queda en
    // memoria hasta que se cierre la pestaña.
    img.onload = () => { URL.revokeObjectURL(url); resolver(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rechazar(new Error('El fichero no es una imagen que podamos abrir.')); };
    img.src = url;
  });
}

/** Dibuja la imagen a un ancho dado y devuelve el lienzo. */
function dibujar(img, ancho) {
  const escala = ancho / img.naturalWidth;
  const lienzo = document.createElement('canvas');
  lienzo.width = Math.max(1, Math.round(img.naturalWidth * escala));
  lienzo.height = Math.max(1, Math.round(img.naturalHeight * escala));

  const ctx = lienzo.getContext('2d', { willReadFrequently: true });
  // Fondo blanco: un PNG con transparencia sobre negro deja el texto ilegible
  // al pasarlo a JPEG.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, lienzo.width, lienzo.height);
  ctx.drawImage(img, 0, 0, lienzo.width, lienzo.height);
  return lienzo;
}

/**
 * Comprime la captura para que quepa en el documento, perdiendo lo menos
 * posible de lo unico que importa: que el texto siga siendo legible.
 *
 * Antes esto bajaba a 900 px de ancho y calidad fija. Se sube a 1400, que es el
 * ancho al que normaliza el worker antes de leerla: mandarla mas pequeña
 * obligaba a AMPLIARLA alli, y ampliar no devuelve el detalle que se tiro.
 *
 * El orden de los recortes tambien importa: primero se baja CALIDAD, que se
 * lleva por delante el ruido de compresion, y solo cuando eso no basta se baja
 * el TAMAÑO, que se lleva por delante las letras.
 *
 * @returns {Promise<{dataUrl: string, ancho: number, alto: number, calidad: number}>}
 */
export async function comprimir(fichero) {
  return comprimirImagen(await cargarImagen(fichero));
}

/**
 * El trabajo de `comprimir`, sobre una imagen ya decodificada.
 *
 * ESTO NO ES SOLO COMPRIMIR, Y POR ESO NO PUEDE SER CONDICIONAL.
 *
 * Pasar por el lienzo es lo unico que quita el EXIF de la captura, y el EXIF de
 * una foto lleva DONDE se hizo. Las capturas se guardan en Firestore y fueron
 * parte de la fuga de #59: si llevaran EXIF, habrian llevado la casa de la
 * gente. Un lienzo solo guarda pixeles, asi que al volver a codificar no queda
 * ni un metadato.
 *
 * Es la unica capa que lo hace. `imagen.normalizarParaGuardar()` del backend
 * documenta esa misma garantia (RGPD, minimizacion de datos) pero no la llama
 * nadie: el servidor nunca vuelve a guardar la imagen, solo la lee.
 *
 * De ahi que el primer ancho sea `min(naturalWidth, ANCHO_SUBIDA)` y no un
 * `if (ya cabe) return fichero`: una captura pequeña TAMBIEN tiene que pasar
 * por aqui. Ese atajo parece gratis —ahorra el trabajo mas caro de la
 * pantalla— y lo que se lleva por delante es la unica limpieza de metadatos que
 * hay en todo el recorrido.
 *
 * Contrapartida conocida, en #66: el mismo recodificado borra las firmas de
 * Photoshop que el antifraude buscaba en el EXIF, asi que esa señal no puede
 * saltar nunca. Se decide alli. La privacidad va primero.
 */
function comprimirImagen(img) {
  const anchos = [
    Math.min(img.naturalWidth, LIMITES_CLIENTE.ANCHO_SUBIDA),
    ...LIMITES_CLIENTE.ANCHOS_DE_RESERVA.filter((a) => a < img.naturalWidth),
  ];

  let ultimo = null;
  for (const ancho of anchos) {
    const lienzo = dibujar(img, ancho);
    for (const calidad of LIMITES_CLIENTE.CALIDADES) {
      const dataUrl = lienzo.toDataURL('image/jpeg', calidad);
      ultimo = { dataUrl, ancho: lienzo.width, alto: lienzo.height, calidad };
      if (dataUrl.length <= LIMITES_CLIENTE.MAX_CARACTERES_DATA_URL) return ultimo;
    }
  }

  // Ni con la peor combinacion cabe. Se devuelve igual: el aviso lo pone
  // `evaluarMedidas` y la decision de intentarlo es de quien sube.
  return ultimo;
}

/**
 * Mira la captura y devuelve lo que convendria saber antes de subirla.
 *
 * Devuelve tambien la imagen ya comprimida, porque para saber si cabe hay que
 * comprimirla: hacerlo dos veces (una para avisar y otra para enviar) seria
 * repetir el unico trabajo caro de esta pantalla.
 *
 * @returns {Promise<{avisos: Array, medidas: object, comprimida: object}>}
 */
export async function revisar(fichero) {
  const img = await cargarImagen(fichero);

  const ancho = img.naturalWidth;
  const alto = img.naturalHeight;

  // La nitidez se mide siempre a la misma medida, o los numeros no se pueden
  // comparar entre una captura de un movil viejo y una de uno nuevo.
  const paraAnalisis = dibujar(img, Math.min(ancho, LIMITES_CLIENTE.ANCHO_ANALISIS));
  const pixeles = paraAnalisis.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, paraAnalisis.width, paraAnalisis.height);
  const nitidez = varianzaLaplaciano(aGrises(pixeles.data), paraAnalisis.width, paraAnalisis.height);

  // Se reaprovecha la imagen ya decodificada: volver a decodificarla para
  // comprimirla es el trabajo mas caro de esta pantalla, hecho dos veces.
  const comprimida = comprimirImagen(img);

  // `lastModified` es la fecha del FICHERO, no la del viaje: WhatsApp y varias
  // galerias la reescriben al guardarlo. Por eso el aviso que sale de aqui es
  // de los suaves y lo dice.
  const diasAntiguedad = fichero.lastModified
    ? (Date.now() - fichero.lastModified) / 864e5
    : null;

  const medidas = {
    tipo: fichero.type,
    ancho,
    alto,
    nitidez,
    diasAntiguedad,
    caracteresDataUrl: comprimida?.dataUrl.length || 0,
  };

  return { avisos: evaluarMedidas(medidas), medidas, comprimida };
}
