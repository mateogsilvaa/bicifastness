'use strict';

/**
 * Pruebas del motor de verificacion. Sin framework: `node --test` basta.
 *   npm test
 */

const test = require('node:test');
const assert = require('node:assert');

const { evaluar, distribucion, distanciaCalleMetros, velocidadKmh } = require('../src/verificacion');

// Ruta real: 002 (Metro Callao) -> 110 (Intercambiador de Moncloa).
const RUTA = '002-110';
const METROS = distanciaCalleMetros('002', '110');

/** Auditoria de IA "perfecta" para un tiempo dado. */
function lecturaLimpia(segundos, ruta = RUTA) {
  const [o, d] = ruta.split('-').map((v) => v.replace(/^0+/, ''));
  const salida = 10 * 3600;
  const llegada = salida + segundos;
  const hhmmss = (s) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, '0')).join(':');
  return {
    disponible: true, esBicimad: true, confianza: 95,
    motivoManipulacion: '', origen: o, destino: d,
    segundosDuracion: segundos, horaSalida: hhmmss(salida), horaLlegada: hhmmss(llegada),
  };
}

function contextoBase(overrides = {}) {
  const tiempoSegundos = overrides.tiempoSegundos ?? 600;
  return {
    ruta: RUTA,
    tiempoSegundos,
    lectura: lecturaLimpia(tiempoSegundos),
    hashSha: 'a'.repeat(64),
    hashPerceptual: '0f0f0f0f0f0f0f0f',
    shaPrevios: [],
    hashesPrevios: [],
    mejorTiempoRuta: null,
    mejorTiempoPropio: null,
    edicionSospechosa: false,
    software: null,
    ...overrides,
  };
}

test('la ruta de prueba tiene una distancia razonable', () => {
  assert.ok(METROS > 2000 && METROS < 6000, `distancia inesperada: ${METROS}`);
});

test('un viaje limpio y plausible se aprueba solo', () => {
  const r = evaluar(contextoBase());
  assert.strictEqual(r.decision, 'aprobado');
  assert.strictEqual(r.señales.length, 0);
});

test('un tiempo fisicamente imposible se rechaza solo', () => {
  // Recorrer ~3,5 km en 120 s son mas de 100 km/h.
  const r = evaluar(contextoBase({ tiempoSegundos: 120 }));
  assert.strictEqual(r.decision, 'rechazado');
  assert.ok(r.señales.some((s) => s.codigo === 'velocidad_imposible'));
  assert.match(r.resumen, /imposible/);
});

test('una velocidad alta pero posible va a revision, no a la basura', () => {
  // Ajustamos el tiempo para caer entre 21 y 25 km/h.
  const segundos = Math.round((METROS / 1000) / 23 * 3600);
  const r = evaluar(contextoBase({ tiempoSegundos: segundos }));
  assert.strictEqual(r.decision, 'revision');
  assert.ok(r.señales.some((s) => s.codigo === 'velocidad_sospechosa'));
});

test('descuadre entre las horas y el recuadro de duracion = manipulacion', () => {
  const lectura = lecturaLimpia(600);
  lectura.segundosDuracion = 300; // el usuario ha retocado solo el numero grande
  // La segunda lectura lee lo mismo: el numero esta retocado, no mal leido.
  const r = evaluar(contextoBase({ tiempoSegundos: 300, lectura, segundaLectura: { ...lectura } }));
  assert.strictEqual(r.decision, 'rechazado');
  assert.ok(r.señales.some((s) => s.codigo === 'captura_incoherente'));
});

test('un descuadre que la segunda lectura no confirma va a revision, no se rechaza', () => {
  // Un 1 leido como 7 en la barra descuadra igual que un retoque. Sin una
  // segunda lectura que lo confirme, decide una persona.
  const lectura = lecturaLimpia(600);
  lectura.horaLlegada = '10:25:00';
  const r = evaluar(contextoBase({ lectura }));
  assert.strictEqual(r.decision, 'revision');
  assert.ok(r.señales.some((s) => s.codigo === 'captura_descuadrada'));
});

test('varias dudas de lectura juntas no rechazan una captura: la mira una persona', () => {
  // "Se lee otra ruta" (60) + "no se leen las horas" (15) sumaban 75 y
  // rechazaban solas una captura buena y borrosa.
  const lectura = lecturaLimpia(600);
  lectura.origen = '3';
  lectura.horaSalida = '';
  const r = evaluar(contextoBase({ lectura }));
  assert.strictEqual(r.decision, 'revision');
  assert.ok(r.riesgo >= 70);
});

test('la captura reenviada byte a byte se rechaza', () => {
  const r = evaluar(contextoBase({
    shaPrevios: [{ sha: 'a'.repeat(64), tripId: 'viaje-viejo', uid: 'otro' }],
  }));
  assert.strictEqual(r.decision, 'rechazado');
  assert.ok(r.señales.some((s) => s.codigo === 'captura_reutilizada'));
});

test('la misma captura recomprimida tambien se rechaza (hash perceptual)', () => {
  const r = evaluar(contextoBase({
    hashPerceptual: '0f0f0f0f0f0f0f0f',
    // Un solo bit de diferencia: misma imagen, otro fichero.
    hashesPrevios: [{ dhash: '0f0f0f0f0f0f0f0e', tripId: 'viaje-viejo' }],
  }));
  assert.strictEqual(r.decision, 'rechazado');
  assert.ok(r.señales.some((s) => s.codigo === 'captura_casi_identica'));
});

test('una captura distinta no se confunde con un duplicado', () => {
  const r = evaluar(contextoBase({
    hashPerceptual: '0f0f0f0f0f0f0f0f',
    hashesPrevios: [{ dhash: 'f0f0f0f0f0f0f0f0', tripId: 'otro' }],
  }));
  assert.strictEqual(r.decision, 'aprobado');
});

test('una lectura poco fiable no se aprueba sola', () => {
  // Al quitar la IA, esto dejo de ser un rechazo automatico y paso a ser una
  // duda: sin nadie que juzgue la imagen, lo honesto es que lo mire una
  // persona en vez de rechazarle el viaje a alguien por un OCR flojo.
  const lectura = lecturaLimpia(600);
  lectura.confianza = 20;

  const r = evaluar(contextoBase({ lectura }));
  assert.strictEqual(r.decision, 'revision');
  assert.ok(r.señales.some((s) => s.codigo === 'lectura_poco_segura'));
});

test('una captura que no es de BiciMAD se rechaza sola', () => {
  // Esto lo decidia la IA con `es_bicimad`. Ahora sale de si el texto leido
  // contiene marcadores de la app: es heuristica, pero es determinista y basta
  // para descartar una foto cualquiera.
  const lectura = {
    disponible: true, esBicimad: false, confianza: 90,
    origen: '', destino: '', segundosDuracion: null, horaSalida: '18:42', horaLlegada: '', fecha: '',
  };

  const r = evaluar(contextoBase({ lectura }));
  assert.strictEqual(r.decision, 'rechazado');
  assert.ok(r.señales.some((s) => s.codigo === 'no_es_bicimad'));
});

test('una captura de BiciMAD mal leida no se rechaza como "no es BiciMAD"', () => {
  // Lo que se quejaba: con el viaje delante, "no es la app de BiciMAD". Si hay
  // una estacion, un tiempo o el azul de la app, la mira una persona.
  for (const parcial of [
    { origen: '124' },
    { segundosDuracion: 1038 },
    { franjasAzules: 1 },
  ]) {
    const lectura = {
      disponible: true, esBicimad: false, confianza: 90,
      origen: '', destino: '', segundosDuracion: null, horaSalida: '', horaLlegada: '', fecha: '', ...parcial,
    };
    const r = evaluar(contextoBase({ lectura }));
    assert.strictEqual(r.decision, 'revision', JSON.stringify(parcial));
    assert.ok(r.señales.some((s) => s.codigo === 'bicimad_dudosa'));
  }
  // Y una lectura borrosa sin nada legible tampoco se rechaza: no se sabe.
  const borrosa = { disponible: true, esBicimad: false, confianza: 30, origen: '', destino: '', segundosDuracion: null };
  assert.strictEqual(evaluar(contextoBase({ lectura: borrosa })).decision, 'revision');
});

test('si el OCR no responde, el viaje va a revision (no se aprueba a ciegas)', () => {
  const r = evaluar(contextoBase({
    lectura: { disponible: false, error: 'timeout' },
  }));
  assert.strictEqual(r.decision, 'revision');
  assert.ok(r.señales.some((s) => s.codigo === 'lectura_no_disponible'));
});

test('romper el record por mucho margen siempre pasa por revision humana', () => {
  const r = evaluar(contextoBase({ tiempoSegundos: 600, mejorTiempoRuta: 900 }));
  assert.strictEqual(r.decision, 'revision');
  assert.ok(r.señales.some((s) => s.codigo === 'record_pulverizado'));
});

test('mejorar el record por poco margen no molesta a nadie', () => {
  const r = evaluar(contextoBase({ tiempoSegundos: 600, mejorTiempoRuta: 620 }));
  assert.strictEqual(r.decision, 'aprobado');
});

test('los metadatos de un editor de imagen levantan sospecha, pero no deciden solos', () => {
  // CAMBIO DE PESO, Y ES A PROPOSITO (#66). Valia 45 —bastaba para mandar a
  // revision el solo— cuando se creia que el dato salia del EXIF del fichero,
  // o sea del servidor. Resulta que no podia: el navegador recodifica toda
  // captura en un `<canvas>` y eso borra el EXIF antes de que salga del movil.
  // La señal no habia saltado NUNCA en produccion.
  //
  // Ahora el dato lo declara el navegador leyendo el fichero original. Eso
  // pilla a quien edita sin pensar, pero no a quien va en serio: le basta con
  // no mandarlo. Una pista que se puede omitir no puede pesar como una prueba.
  //
  // Y sobre todo: RECORTAR ES LEGITIMO Y COMUN. `normalizar.js` dice que "mucha
  // gente recorta para quitar la barra de estado". Si eso mandara a revision el
  // solo, media subida honrada acabaria esperando a una persona.
  const r = evaluar(contextoBase({ edicionSospechosa: true, software: 'Snapseed' }));

  assert.ok(r.señales.some((s) => s.codigo === 'metadatos_edicion'),
    'la señal no se emite');
  assert.strictEqual(r.decision, 'aprobado',
    'declarar un editor manda a revision el solo: recortar la captura es legitimo');
});

test('pero sumada a otra cosa, si inclina la balanza', () => {
  // Para eso sigue estando. Sola no decide; junto a algo mas, empuja por encima
  // del umbral de revision.
  const soloRecord = evaluar(contextoBase({ mejorTiempoRuta: 900 }));
  const conEditor = evaluar(contextoBase({
    mejorTiempoRuta: 900, edicionSospechosa: true, software: 'Photoshop',
  }));

  assert.ok(conEditor.riesgo > soloRecord.riesgo,
    'declarar un editor no suma nada al riesgo');
});

test('la ruta leida en la foto no coincide con la declarada', () => {
  const lectura = lecturaLimpia(600);
  lectura.origen = '999';
  const r = evaluar(contextoBase({ lectura }));
  assert.ok(['revision', 'rechazado'].includes(r.decision));
  assert.ok(r.señales.some((s) => s.codigo === 'ruta_no_coincide'));
});

test('el veredicto es serializable y explica siempre el motivo', () => {
  const r = evaluar(contextoBase({ tiempoSegundos: 120 }));
  assert.doesNotThrow(() => JSON.stringify(r));
  assert.ok(r.resumen.length > 0);
  assert.ok(Number.isFinite(r.riesgo));
  assert.ok(r.señales.every((s) => s.codigo && s.mensaje));
  // Las marcas internas no se filtran al documento guardado.
  assert.ok(r.señales.every((s) => !('decisiva' in s)));
});

test('velocidadKmh calcula bien', () => {
  assert.strictEqual(Math.round(velocidadKmh(1000, 360)), 10);
});

// --- Deteccion estadistica ----------------------------------------------------

test('un tiempo muy fuera de la distribucion de la ruta se marca', () => {
  // La ruta se corre habitualmente en torno a 600 s con poca dispersion.
  const distribucionRuta = distribucion([590, 600, 605, 610, 615, 620, 625, 630]);
  const r = evaluar(contextoBase({ tiempoSegundos: 450, distribucionRuta, mejorTiempoRuta: 590 }));
  assert.ok(r.señales.some((s) => s.codigo === 'atipico_estadistico'));
});

test('con pocas marcas no se aplica la estadistica (no hay muestra)', () => {
  const r = evaluar(contextoBase({ tiempoSegundos: 450, distribucionRuta: distribucion([600, 620]) }));
  assert.ok(!r.señales.some((s) => s.codigo === 'atipico_estadistico'));
});

test('un tiempo normal dentro de la distribucion no molesta', () => {
  const distribucionRuta = distribucion([560, 580, 600, 610, 620, 640, 660, 700]);
  const r = evaluar(contextoBase({ tiempoSegundos: 595, distribucionRuta }));
  assert.ok(!r.señales.some((s) => s.codigo === 'atipico_estadistico'));
  assert.strictEqual(r.decision, 'aprobado');
});

test('una ruta donde todos hacen el mismo tiempo no genera falsos positivos', () => {
  // Desviacion tipica cero: dividir por ella daria Infinity.
  const distribucionRuta = distribucion([600, 600, 600, 600, 600, 600, 600]);
  const r = evaluar(contextoBase({ tiempoSegundos: 600, distribucionRuta }));
  assert.ok(!r.señales.some((s) => s.codigo === 'atipico_estadistico'));
});

// --- Perfil del piloto ---------------------------------------------------------

test('un salto brusco sobre el ritmo habitual del piloto se marca', () => {
  // Va siempre a ~12 km/h y de golpe aparece muy por encima.
  const r = evaluar(contextoBase({
    tiempoSegundos: 400,
    velocidadesPrevias: [11.5, 12, 12.4, 11.8, 12.1],
  }));
  assert.ok(r.señales.some((s) => s.codigo === 'salto_de_ritmo'));
});

test('sin historial suficiente no se juzga el ritmo del piloto', () => {
  const r = evaluar(contextoBase({ tiempoSegundos: 400, velocidadesPrevias: [12, 12] }));
  assert.ok(!r.señales.some((s) => s.codigo === 'salto_de_ritmo'));
});

test('mantener el ritmo de siempre no levanta ninguna alerta', () => {
  const r = evaluar(contextoBase({
    tiempoSegundos: 600,
    velocidadesPrevias: [20, 21, 20.5, 21.2, 20.8],
  }));
  assert.ok(!r.señales.some((s) => s.codigo === 'salto_de_ritmo'));
});

// --- Horario -------------------------------------------------------------------

test('un trayecto de madrugada se anota como contexto', () => {
  const lectura = lecturaLimpia(600);
  lectura.horaSalida = '03:20:00';
  lectura.horaLlegada = '03:30:00';
  const r = evaluar(contextoBase({ lectura }));
  assert.ok(r.señales.some((s) => s.codigo === 'horario_inusual'));
  // Por si sola no basta para sacarlo de aprobado: es solo un dato.
  assert.strictEqual(r.decision, 'aprobado');
});

test('un trayecto a media tarde no genera nada', () => {
  const r = evaluar(contextoBase());
  assert.ok(!r.señales.some((s) => s.codigo === 'horario_inusual'));
});

// --- Combinacion ---------------------------------------------------------------

test('varias señales debiles juntas mandan el viaje a revision', () => {
  // Ninguna es concluyente, pero sumadas pasan del umbral de aprobacion.
  const lectura = lecturaLimpia(600);
  lectura.horaSalida = '03:00:00';
  lectura.horaLlegada = '03:10:00';
  const r = evaluar(contextoBase({
    tiempoSegundos: 600,
    lectura,
    distribucionRuta: distribucion([700, 710, 715, 720, 725, 730, 740, 750]),
    velocidadesPrevias: [9, 9.5, 10, 9.8, 10.2],
  }));
  assert.strictEqual(r.decision, 'revision');
  assert.ok(r.señales.length >= 3, `esperaba varias señales, hay ${r.señales.length}`);
});

// --- Varios viajes con la misma captura (#11) ---------------------------------

test('dos viajes de la MISMA captura no son un duplicado', () => {
  // El historial de la app es una lista: una captura puede sostener tres
  // trayectos. Los tres comparten imagen y, por tanto, huella. Si eso contara
  // como "captura reutilizada", subir los tres acabaria con dos rechazados.
  const capturaId = 'captura-compartida';
  const r = evaluar(contextoBase({
    capturaId,
    shaPrevios: [{ sha: 'a'.repeat(64), tripId: 'viaje-hermano', uid: 'yo', capturaId }],
    hashesPrevios: [{ dhash: '0f0f0f0f0f0f0f0f', tripId: 'viaje-hermano', capturaId }],
  }));

  assert.strictEqual(r.decision, 'aprobado');
  assert.ok(!r.señales.some((s) => s.codigo === 'captura_reutilizada'));
  assert.ok(!r.señales.some((s) => s.codigo === 'captura_casi_identica'));
});

test('la misma imagen subida en OTRO lote sigue siendo un duplicado', () => {
  // Lo de arriba no puede convertirse en una puerta: si la huella viene de otra
  // captura, es reenvio y se rechaza igual que siempre.
  const r = evaluar(contextoBase({
    capturaId: 'captura-de-ahora',
    shaPrevios: [{ sha: 'a'.repeat(64), tripId: 'viaje-viejo', uid: 'otro', capturaId: 'captura-de-antes' }],
  }));

  assert.strictEqual(r.decision, 'rechazado');
  assert.ok(r.señales.some((s) => s.codigo === 'captura_reutilizada'));
});

test('una huella antigua sin capturaId sigue detectando el reenvio', () => {
  // Las huellas escritas antes de #11 no llevan `capturaId`. No pueden dejar de
  // proteger por eso.
  const r = evaluar(contextoBase({
    capturaId: 'captura-de-ahora',
    shaPrevios: [{ sha: 'a'.repeat(64), tripId: 'viaje-viejo', uid: 'otro', capturaId: null }],
  }));

  assert.strictEqual(r.decision, 'rechazado');
  assert.ok(r.señales.some((s) => s.codigo === 'captura_reutilizada'));
});

// --- La fecha del viaje ------------------------------------------------------
//
// La fecha la escribe la persona y decide la racha y las misiones de hoy. Una
// captura vieja sin usar, declarada como de hoy, salvaba una racha sin pedalear.

/** Un instante concreto en hora de Madrid (verano, UTC+2). */
const enMadrid = (dia, hhmm) => new Date(`${dia}T${hhmm}:00+02:00`);

test('un viaje de hoy que termina despues de haberse subido no se aprueba', () => {
  // La captura marca llegada 10:10 y se sube a las 08:00 del mismo dia.
  const r = evaluar(contextoBase({
    fechaViaje: '2026-07-15', subidoEn: enMadrid('2026-07-15', '08:00'),
  }));
  assert.strictEqual(r.decision, 'revision');
  assert.ok(r.señales.some((s) => s.codigo === 'llegada_posterior_a_subida'));
});

test('subirlo al terminar, o mas tarde, no levanta nada', () => {
  for (const hora of ['10:12', '10:20', '23:00']) {
    const r = evaluar(contextoBase({
      fechaViaje: '2026-07-15', subidoEn: enMadrid('2026-07-15', hora),
    }));
    assert.strictEqual(r.decision, 'aprobado', `subido a las ${hora}`);
  }
});

test('un viaje de ayer subido hoy por la mañana no se confunde con trampa', () => {
  const r = evaluar(contextoBase({
    fechaViaje: '2026-07-14', subidoEn: enMadrid('2026-07-15', '08:00'),
  }));
  assert.strictEqual(r.decision, 'aprobado');
});

test('una captura anterior al dia del viaje no se aprueba sola', () => {
  const r = evaluar(contextoBase({
    fechaViaje: '2026-07-15', capturadaEn: '2026-07-02', subidoEn: enMadrid('2026-07-15', '20:00'),
  }));
  assert.strictEqual(r.decision, 'revision');
  assert.ok(r.señales.some((s) => s.codigo === 'captura_anterior_al_viaje'));
});

test('una captura posterior al viaje es lo normal: se hace al terminar o despues', () => {
  for (const capturadaEn of ['2026-07-15', '2026-07-16', '2026-07-20']) {
    const r = evaluar(contextoBase({ fechaViaje: '2026-07-15', capturadaEn }));
    assert.strictEqual(r.decision, 'aprobado', capturadaEn);
  }
});

test('sin fecha de fichero ni hora de subida, todo sigue como antes', () => {
  const r = evaluar(contextoBase({ fechaViaje: '2026-07-15' }));
  assert.strictEqual(r.decision, 'aprobado');
});


// --- Verificacion ultra precisa ------------------------------------------------

const codigos = (r) => r.señales.map((s) => s.codigo);

test('el reloj del movil no puede marcar antes de la llegada', () => {
  // Salida 10:00, llegada 10:10 (lecturaLimpia): una captura a las 09:30 es imposible.
  const lectura = { ...lecturaLimpia(600), relojBarra: '09:30' };
  const r = evaluar(contextoBase({ lectura }));
  assert.ok(codigos(r).includes('reloj_anterior_a_llegada'));
  assert.notStrictEqual(r.decision, 'aprobado');

  const buena = evaluar(contextoBase({ lectura: { ...lecturaLimpia(600), relojBarra: '10:12' } }));
  assert.strictEqual(buena.decision, 'aprobado');
});

test('dos lecturas que no coinciden no aprueban solas', () => {
  const r = evaluar(contextoBase({ segundaLectura: { ...lecturaLimpia(600), segundosDuracion: 660 } }));
  assert.ok(codigos(r).includes('lectura_sin_consenso'));
  assert.strictEqual(r.decision, 'revision');

  // Lo que la segunda no lee no es un desacuerdo.
  const parcial = evaluar(contextoBase({ segundaLectura: { disponible: true, origen: '', destino: '', segundosDuracion: null } }));
  assert.strictEqual(parcial.decision, 'aprobado');
});

test('una imagen apaisada suma, pero sola no manda a revision', () => {
  const r = evaluar(contextoBase({ ancho: 1080, alto: 700 }));
  assert.ok(codigos(r).includes('formato_no_movil'));
  assert.strictEqual(r.decision, 'aprobado');
  assert.ok(!codigos(evaluar(contextoBase({ ancho: 1080, alto: 2280 }))).includes('formato_no_movil'));
});

test('la misma bici a la misma hora con dos personas va a revision', () => {
  const lectura = { ...lecturaLimpia(600), numeroBici: '2471' };
  const usosBici = [{ tripId: 'otro', uid: 'otra-persona', salida: '10:02', llegada: '10:15' }];
  const r = evaluar(contextoBase({ lectura, uid: 'yo', usosBici }));
  assert.ok(codigos(r).includes('bici_en_dos_sitios'));
  assert.notStrictEqual(r.decision, 'aprobado');

  // La misma persona (otro trayecto de la misma captura) o a otra hora: nada.
  const mia = evaluar(contextoBase({ lectura, uid: 'yo', usosBici: [{ ...usosBici[0], uid: 'yo' }] }));
  const luego = evaluar(contextoBase({ lectura, uid: 'yo', usosBici: [{ ...usosBici[0], salida: '11:00', llegada: '11:20' }] }));
  assert.strictEqual(mia.decision, 'aprobado');
  assert.strictEqual(luego.decision, 'aprobado');
});

test('el minuto de redondeo de las horas no hace la captura desviada', () => {
  // 22:46:37 -> 23:03:20 son 16:43, pero en minutos (22:46 -> 23:03) son 17.
  const { evaluar } = require('../src/verificacion');
  const v = evaluar({
    ruta: '001-002', tiempoSegundos: 1003,
    lectura: { disponible: true, esBicimad: true, confianza: 90, origen: '001', destino: '002', horaSalida: '22:46', horaLlegada: '23:03', segundosDuracion: 1003 },
    shaPrevios: [], hashesPrevios: [], velocidadesPrevias: [], usosBici: [],
  });
  assert.ok(!v.señales.some((s) => s.codigo === 'captura_desviada' || s.codigo === 'captura_incoherente'));
});
