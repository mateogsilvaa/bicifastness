/**
 * Del veredicto del worker al castellano.
 *
 * El worker guarda en cada viaje un objeto `auditoria` pensado para QUIEN
 * REVISA: riesgo acumulado, gravedad de cada señal y mensajes con los numeros
 * exactos ("distancia perceptual 4", "2,7 desviaciones por debajo de la media
 * de la ruta"). Eso es justo lo que no puede ver quien sube el viaje, por dos
 * motivos:
 *
 *   1. No se entiende. "Riesgo 72" no le dice a nadie que hacer con su foto.
 *   2. Es el manual del antifraude. Quien conoce los umbrales sabe exactamente
 *      cuanto puede acercarse a ellos sin saltarlos.
 *
 * Asi que aqui NUNCA se lee `señal.mensaje`: se lee el `codigo`, que es una
 * etiqueta estable, y el texto sale de esta tabla. Un codigo desconocido cae en
 * el motivo generico, que tampoco cuenta nada.
 *
 * Regla practica para escribir estos textos: ni un solo numero. Si un texto
 * necesita una cifra para entenderse, es que esta contando un umbral. Hay un
 * test que lo comprueba.
 *
 * La ventana tambien esta cerrada ya: el analisis completo vive en
 * `auditorias/{viajeId}`, que solo lee la administracion, y en el viaje se queda
 * `motivos` — los codigos, ordenados de mas grave a menos por el servidor. Ni
 * riesgo, ni gravedades, ni mensajes con numeros. Lo unico que sigue leyendo la
 * forma antigua es el respaldo de `motivoDeViaje`, para los viajes que todavia
 * no ha tocado `scripts/migrar-auditorias.js`.
 *
 * Este fichero no importa nada a proposito: asi los tests pueden cargarlo tal
 * cual, sin navegador.
 */

/**
 * Los estados que puede ver el usuario.
 *
 * `extrayendo` no existe en la base de datos: es el rato entre que se pulsa
 * enviar y que el viaje esta escrito. Se cuenta como estado porque para quien
 * mira la pantalla lo es.
 */
export const ESTADOS = {
  extrayendo: {
    chip: 'pendiente',
    titulo: 'Subiendo la captura',
    texto: 'Estamos guardando tu trayecto. No cierres esta pagina.',
  },
  pendiente: {
    chip: 'pendiente',
    titulo: 'En cola',
    texto: 'Tu trayecto espera a que lo analicemos. Suele tardar unos diez minutos, '
      + 'y algun dia se va al cuarto de hora. Puedes cerrar la pagina: esto sigue solo.',
  },
  aprobado: {
    chip: 'verificado',
    titulo: 'Verificado',
    texto: 'El trayecto cuenta y ya suma en la clasificacion.',
  },
  revision: {
    chip: 'revision',
    titulo: 'Lo mira una persona',
    texto: 'El analisis automatico no lo ha visto claro, asi que lo revisa un administrador '
      + 'a mano. Normalmente el mismo dia. Te avisamos por correo.',
  },
  rechazado: {
    chip: 'rechazado',
    titulo: 'No lo hemos podido dar por bueno',
    texto: 'Este trayecto no cuenta para la clasificacion.',
  },
};

/** Lo que se dice cuando no hay codigo, o cuando el codigo no esta en la tabla. */
const GENERICO = {
  texto: 'No hemos podido verificar la captura.',
  queHacer: 'Sube la captura original de la app, tal cual sale, sin recortarla y sin reenviarla por mensajeria.',
};

/**
 * Un texto por cada codigo de señal de `backend/src/verificacion.js`.
 *
 * Que estan TODOS lo comprueba un test: si alguien añade una señal nueva al
 * motor y se olvida de esto, el usuario recibiria el motivo generico sin que
 * nadie se entere.
 */
const MOTIVOS = {
  // --- Plausibilidad fisica ---
  velocidad_imposible: {
    texto: 'El tiempo de la captura es mas rapido de lo que puede ir una BiciMAD entre esas dos estaciones.',
    queHacer: 'Casi siempre es una estacion mal escrita: comprueba cual era la de salida y cual la de meta.',
  },
  velocidad_sospechosa: {
    texto: 'El trayecto sale muy rapido para lo que hay entre esas dos estaciones.',
    queHacer: 'Comprueba que las estaciones son las que aparecen en la captura.',
  },
  velocidad_muy_baja: {
    texto: 'El trayecto sale mas lento que ir andando.',
    queHacer: 'Si paraste por el camino no pasa nada, lo miramos igual.',
  },
  ruta_trivial: {
    texto: 'Esas dos estaciones estan demasiado cerca para que el trayecto compita.',
    queHacer: 'Prueba con un trayecto entre estaciones mas separadas.',
  },
  geo_desconocida: {
    texto: 'No tenemos situada alguna de las dos estaciones.',
    queHacer: 'No es cosa tuya: lo mira una persona.',
  },

  // --- Lectura de la captura ---
  lectura_no_disponible: {
    texto: 'No hemos podido leer la captura.',
    queHacer: 'Sube la imagen original de la app, entera y sin recortar.',
  },
  no_es_bicimad: {
    texto: 'La imagen no parece la pantalla de resumen de un viaje de BiciMAD.',
    queHacer: 'Sube la captura que sale al terminar el trayecto, con las estaciones y el tiempo.',
  },
  lectura_poco_segura: {
    texto: 'La captura se lee con dificultad.',
    queHacer: 'Prueba con la original, a pantalla completa, sin recortar y sin pasarla por mensajeria.',
  },
  captura_incoherente: {
    texto: 'Las horas de la captura no cuadran con la duracion que aparece en ella.',
    queHacer: 'Sube la captura tal cual sale de la app, sin editarla.',
  },
  captura_desviada: {
    texto: 'Las horas de la captura y la duracion que marca no acaban de cuadrar.',
    queHacer: 'Sube la captura tal cual sale de la app.',
  },
  horas_ilegibles: {
    texto: 'No hemos podido leer las horas de salida y de llegada.',
    queHacer: 'Que se vea la pantalla entera, sin recortar la zona de las horas.',
  },
  estaciones_ilegibles: {
    texto: 'No hemos podido leer las estaciones en la captura.',
    queHacer: 'Que se vean los nombres de las dos estaciones, sin recortarlos.',
  },
  ruta_no_coincide: {
    texto: 'Las estaciones que has escrito no son las que aparecen en la captura.',
    queHacer: 'Corrigelas y vuelve a subir el trayecto.',
  },
  tiempo_no_coincide: {
    texto: 'El tiempo que has escrito no es el que aparece en la captura.',
    queHacer: 'Copia el tiempo tal cual lo da la app.',
  },
  tiempo_desviado: {
    texto: 'El tiempo que has escrito y el de la captura no coinciden.',
    queHacer: 'Copia el tiempo tal cual lo da la app.',
  },

  // --- Captura ya vista ---
  captura_reutilizada: {
    texto: 'Esta captura ya se habia subido antes.',
    queHacer: 'Cada trayecto necesita la suya.',
  },
  captura_casi_identica: {
    texto: 'Esta captura es la de un viaje que ya esta registrado.',
    queHacer: 'Recortarla o volver a comprimirla no la convierte en otra.',
  },
  captura_parecida: {
    texto: 'La captura se parece mucho a la de otro viaje ya registrado.',
    queHacer: 'Comprueba que no estas subiendo dos veces el mismo trayecto.',
  },
  metadatos_edicion: {
    texto: 'La imagen ha pasado por un editor.',
    queHacer: 'Sube la captura original, sin abrirla en ninguna aplicacion de retoque.',
  },

  // --- Contexto del piloto ---
  record_pulverizado: {
    texto: 'Seria el mejor tiempo de la ruta por mucha diferencia.',
    queHacer: 'Todo record grande lo confirma una persona. No hace falta que hagas nada.',
  },
  salto_personal: {
    texto: 'Mejoras tu propia marca en esta ruta por mucha diferencia.',
    queHacer: 'No hace falta que hagas nada: lo confirma una persona.',
  },
  salto_de_ritmo: {
    texto: 'Este trayecto va mucho mas rapido de lo que sueles ir.',
    queHacer: 'No hace falta que hagas nada: lo confirma una persona.',
  },
  atipico_estadistico: {
    texto: 'El tiempo se sale de lo que consigue el resto de gente en esta ruta.',
    queHacer: 'No hace falta que hagas nada: lo confirma una persona.',
  },
  horario_inusual: {
    texto: 'El trayecto figura en plena madrugada.',
    queHacer: 'Si es correcto, no hace falta que hagas nada.',
  },

  // --- Lo que ni siquiera llega al analisis (`worker.validarBasico`) ---
  ruta_inexistente: {
    texto: 'Alguna de las dos estaciones no existe.',
    queHacer: 'Comprueba los numeros de estacion en la propia captura.',
  },
  tiempo_fuera_de_rango: {
    texto: 'El tiempo que has escrito no cabe en un trayecto de BiciMAD.',
    queHacer: 'Copia el tiempo tal cual lo da la app.',
  },
  fecha_no_valida: {
    texto: 'La fecha del trayecto no se entiende.',
    queHacer: 'Vuelve a subirlo eligiendo el dia en el calendario.',
  },
  viaje_futuro: {
    texto: 'El trayecto figura en una fecha que todavia no ha llegado.',
    queHacer: 'Elige el dia en que hiciste el viaje.',
  },
  viaje_muy_antiguo: {
    texto: 'Solo se pueden reclamar trayectos del ultimo mes.',
    queHacer: 'Si es mas antiguo, ya no entra en la clasificacion.',
  },
  cupo_diario: {
    texto: 'Ya has subido todos los trayectos que caben en un dia.',
    queHacer: 'Manana puedes seguir.',
  },

  // --- Fallos nuestros ---
  captura_ausente: {
    texto: 'No nos ha llegado la captura del trayecto.',
    queHacer: 'Vuelve a subir el trayecto con su captura.',
  },
  captura_invalida: {
    texto: 'El fichero que nos llego no se puede abrir como imagen.',
    queHacer: 'Prueba a subir la captura otra vez, en JPG o PNG.',
  },
  error_worker: {
    texto: 'Nos ha fallado el analisis. No es cosa tuya.',
    queHacer: 'Lo mira una persona; no hace falta que lo vuelvas a subir.',
  },
};

/** Textos de un estado, con la cola como red si llega uno que no conocemos. */
export function estadoDeViaje(estado) {
  return ESTADOS[estado] || ESTADOS.pendiente;
}

/**
 * Por que se ha decidido lo que se ha decidido, en cristiano.
 *
 * Se queda con la señal MAS GRAVE de las que conoce, no con la primera: el
 * motor las emite en el orden en que corren las comprobaciones, asi que el
 * horario inusual (que casi no pesa) puede salir antes que la ruta que no
 * coincide, que es la razon de verdad.
 *
 * `motivoRevision` gana a todo lo demas: lo escribe a mano un administrador
 * para esta persona concreta, asi que ya esta en castellano y dice mas que
 * cualquier tabla.
 *
 * @param {object} viaje  documento de `tiempos_viaje`
 * @returns {{texto: string, queHacer: string, dePersona: boolean}}
 */
export function motivoDeViaje(viaje) {
  const escritoAMano = String(viaje?.motivoRevision || '').trim();
  if (escritoAMano) return { texto: escritoAMano, queHacer: '', dePersona: true };

  // `motivos` son los codigos, ordenados de mas grave a menos por el worker. El
  // orden viene ya hecho a proposito: las gravedades son parte del manual del
  // antifraude y no bajan al navegador.
  //
  // El respaldo es para los viajes de antes de que la auditoria se mudara a su
  // propia coleccion, que todavia la llevan dentro.
  const codigos = Array.isArray(viaje?.motivos)
    ? viaje.motivos
    : [...(viaje?.auditoria?.señales || [])]
      .sort((a, b) => (b?.gravedad || 0) - (a?.gravedad || 0))
      .map((s) => s?.codigo);

  const peor = codigos.find((c) => Object.prototype.hasOwnProperty.call(MOTIVOS, c));

  return { ...(peor ? MOTIVOS[peor] : GENERICO), dePersona: false };
}

/** El texto de un codigo suelto, o el generico si no se conoce. */
export function textoDeMotivo(codigo) {
  return { ...(MOTIVOS[codigo] || GENERICO) };
}

/**
 * Los motivos que puede elegir quien revisa a mano, en el orden en que se
 * usan de verdad.
 *
 * Es una lista CERRADA por dos razones. Una: escribir el motivo a mano en cada
 * caso es lo que hace que revisar diez viajes lleve media hora. Y dos: el
 * motivo elegido acaba tal cual en el correo que recibe la persona, asi que
 * sale del mismo sitio que el resto de textos y no de lo que se le ocurra a
 * quien revisa a las once de la noche.
 *
 * Se quedan fuera los codigos que no puede juzgar una persona mirando la
 * captura (los estadisticos, los de huella perceptual) y los que son fallos
 * nuestros.
 */
export const MOTIVOS_MANUALES = [
  'no_es_bicimad',
  'ruta_no_coincide',
  'tiempo_no_coincide',
  'captura_incoherente',
  'metadatos_edicion',
  'captura_reutilizada',
  'velocidad_imposible',
  'lectura_no_disponible',
];

/** Los codigos con texto propio. Lo usa el test que los ata al motor. */
export const CODIGOS_CON_TEXTO = Object.keys(MOTIVOS);
