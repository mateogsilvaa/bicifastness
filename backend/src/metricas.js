'use strict';

/**
 * Metricas diarias y retencion.
 *
 * Dos fuentes muy distintas, y conviene tener clara la diferencia:
 *
 *   EMBUDO      viene del navegador (`sesiones_web`). Anonimo por completo: son
 *               contadores de eventos, sin nada que identifique a nadie.
 *
 *   RETENCION   NO viene del navegador. Se calcula aqui cruzando la fecha de
 *               alta de cada usuario con las fechas de sus trayectos
 *               verificados, que son datos que el worker ya lee. Asi se
 *               responde "¿vuelve la gente?" sin poner una sola cookie ni
 *               seguir a nadie entre visitas.
 *
 * Esa segunda decision es la que evita tener que elegir entre saber si el
 * producto funciona y no rastrear a los usuarios.
 */

const admin = require('firebase-admin');

// Firestore se coge de `db.js`, no de `admin` directamente: es lo que permite
// que el contador de cuota (#38) vea TODO lo que hace el backend.
const { db } = require('./db');

/**
 * Cuantas sesiones se suman por pasada.
 *
 * Antes se leia `sesiones_web` ENTERA en cada pasada del worker — 288 veces al
 * dia — para volver a sumar lo mismo y podar unas pocas. Con 200 activos eran
 * 400 documentos por pasada, 115.200 lecturas al dia (docs/COSTE.md).
 *
 * Ahora cada sesion se suma UNA vez y se borra en el acto, asi que entre pasada
 * y pasada la coleccion esta practicamente vacia y la lectura cuesta lo que
 * haya llegado en esos cinco minutos. El tope existe para que un pico no se
 * lleve el tiempo del worker, que es lo que verifica los viajes de todo el
 * mundo; lo que no entre se suma en la siguiente.
 *
 * Borrar en el acto es ademas mejor para quien nos visita: el detalle por
 * sesion deja de existir en cuanto esta contado.
 */
const MAX_SESIONES_POR_PASADA = 450;

/**
 * Cuantos dias se conserva un error del cliente desde la ultima vez que paso.
 *
 * Existe porque la politica de privacidad promete un plazo, y un plazo que no
 * ejecuta nadie no es un plazo. Hasta ahora `errores_cliente` solo se vaciaba a
 * mano desde el panel, o sea nunca: los errores se acumulaban indefinidamente,
 * con su traza y su ruta dentro.
 *
 * 90 dias es de sobra. Un error que no se ha repetido en tres meses o esta
 * arreglado o no le importa a nadie.
 */
const DIAS_ERRORES = 90;

/** Ventanas que ensena el panel. */
const VENTANAS = { hoy: 1, semana: 7, mes: 30, semestre: 180 };

/** YYYY-MM-DD de una fecha. */
function dia(fecha) {
  return fecha.toISOString().slice(0, 10);
}

/** Dias enteros entre dos YYYY-MM-DD. */
function diasEntre(desde, hasta) {
  return Math.round((Date.parse(hasta) - Date.parse(desde)) / 86400000);
}

/** El lunes de la semana de una fecha, en YYYY-MM-DD. */
function lunesDe(fecha) {
  const lunes = new Date(fecha);
  lunes.setUTCDate(lunes.getUTCDate() - ((lunes.getUTCDay() + 6) % 7));
  return dia(lunes);
}

/**
 * Suma las sesiones del navegador en contadores diarios y borra el detalle
 * viejo.
 *
 * El detalle no se conserva porque no aporta: una vez sumado, un documento por
 * sesion solo ocupa. Y menos documentos sueltos por ahi es menos superficie.
 */
async function agregarSesiones() {
  const sesiones = await db().collection('sesiones_web').limit(MAX_SESIONES_POR_PASADA).get();
  if (sesiones.empty) return { dias: 0, sesiones: 0 };

  /** dia -> { evento: total } */
  const porDia = new Map();
  const podar = [];

  for (const doc of sesiones.docs) {
    const datos = doc.data();
    const fecha = datos.dia;

    // Sin dia no se puede sumar a ningun contador, pero tampoco puede quedarse
    // ahi para siempre haciendo que la consulta lo devuelva en cada pasada.
    if (!fecha) { podar.push(doc.ref); continue; }

    if (!porDia.has(fecha)) porDia.set(fecha, { sesiones: 0 });
    const acumulado = porDia.get(fecha);
    acumulado.sesiones++;

    for (const [clave, valor] of Object.entries(datos)) {
      if (typeof valor !== 'number') continue;
      acumulado[clave] = (acumulado[clave] || 0) + valor;
    }

    podar.push(doc.ref);
  }

  // Los contadores se INCREMENTAN, no se reescriben. Antes se volvia a sumar la
  // coleccion entera cada vez y se escribia el total absoluto, que salia bien
  // pero solo porque no se borraba nada. Sumando lo nuevo sobre lo que ya
  // habia, cada sesion se cuenta una vez y el detalle puede desaparecer.
  for (const [fecha, totales] of porDia) {
    const incrementos = {};
    for (const [clave, valor] of Object.entries(totales)) {
      incrementos[clave] = admin.firestore.FieldValue.increment(valor);
    }

    await db().doc(`metricas/${fecha}`).set({
      ...incrementos,
      actualizado: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  // En tandas: un batch de Firestore admite 500 operaciones.
  for (let i = 0; i < podar.length; i += 450) {
    const lote = db().batch();
    for (const ref of podar.slice(i, i + 450)) lote.delete(ref);
    await lote.commit();
  }

  return { dias: porDia.size, sesiones: sesiones.size, podados: podar.length };
}

/**
 * Retencion por cohortes, calculada sobre los datos que ya existen.
 *
 * Se agrupa por semana de alta y se mira que porcentaje sigue subiendo
 * trayectos a los 1, 7, 14 y 30 dias. Es lo unico que dice si las mecanicas de
 * retencion sirven o solo lo parecen.
 *
 * @param {Array} usuarios  con `creado`
 * @param {Array} viajes    verificados, con `uid` y `fechaViaje`
 */
function calcularCohortes(usuarios, viajes) {
  /** uid -> Set de dias con trayecto verificado */
  const diasActivos = new Map();
  for (const v of viajes) {
    if (!v.uid || !v.fechaViaje) continue;
    if (!diasActivos.has(v.uid)) diasActivos.set(v.uid, new Set());
    diasActivos.get(v.uid).add(String(v.fechaViaje).slice(0, 10));
  }

  /** semana de alta -> { total, activosA: {1,7,14,30} } */
  const cohortes = new Map();

  for (const u of usuarios) {
    const alta = u.creado?.toDate?.() || (u.creado ? new Date(u.creado) : null);
    if (!alta || Number.isNaN(alta.getTime())) continue;

    // Lunes de la semana del alta: agrupar por semana suaviza el ruido de los
    // dias sueltos sin perder la forma de la curva.
    const semana = lunesDe(alta);

    if (!cohortes.has(semana)) {
      cohortes.set(semana, { semana, total: 0, d1: 0, d7: 0, d14: 0, d30: 0 });
    }
    const cohorte = cohortes.get(semana);
    cohorte.total++;

    const suyos = diasActivos.get(u.uid);
    if (!suyos) continue;

    const desde = dia(alta);

    // Lo que decide es el trayecto MAS LEJANO, no uno cualquiera: la pregunta
    // de una cohorte es "¿hasta cuando siguio ahi?".
    //
    // Mirar solo el primero daba un numero equivocado y ademas inestable: quien
    // hizo un viaje el dia 2 y otro el dia 40 contaba como que se fue en el 2,
    // y cual se miraba dependia del orden en que llegaran los viajes.
    let ultimo = -1;
    for (const activo of suyos) {
      ultimo = Math.max(ultimo, diasEntre(desde, activo));
    }

    // Cada usuario suma como mucho uno en cada ventana.
    if (ultimo >= 1) cohorte.d1++;
    if (ultimo >= 7) cohorte.d7++;
    if (ultimo >= 14) cohorte.d14++;
    if (ultimo >= 30) cohorte.d30++;
  }

  return [...cohortes.values()]
    .sort((a, b) => b.semana.localeCompare(a.semana))
    .slice(0, SEMANAS_COHORTE);
}

/**
 * Cada cuanto se rehace el resumen, en minutos.
 *
 * Sigue teniendo sentido aunque el resumen ya no lea colecciones enteras: son
 * unas cuantas consultas y una escritura, y nadie mira la retencion a 30 dias
 * esperando verla cambiar en cinco minutos.
 *
 * Lo que SI sigue en cada pasada es `agregarSesiones`, que es la parte que no
 * puede esperar: poda el detalle viejo segun llega.
 */
const MINUTOS_ENTRE_RESUMENES = 360;

/**
 * Cuantas semanas de cohorte se conservan, y hasta cuando una puede cambiar.
 *
 * Una cohorte es "que porcentaje de los que se dieron de alta esa semana seguia
 * subiendo trayectos a los 1, 7, 14 y 30 dias". Pasados esos 30 dias — mas los 6
 * de la propia semana, mas un margen — el numero YA NO PUEDE CAMBIAR: esta
 * congelado para siempre.
 *
 * Esa es toda la idea. Solo hay que recalcular las cohortes vivas, que salen de
 * los usuarios dados de alta hace poco; las demas se copian del resumen
 * anterior. Antes, para calcular una cifra que llevaba meses fija, se leian
 * `usuarios` y `tiempos_viaje` ENTEROS cuatro veces al dia.
 */
const SEMANAS_COHORTE = 12;
const DIAS_COHORTE_VIVA = 45;

/**
 * ¿Toca rehacer el resumen caro?
 *
 * Se mira la marca del propio agregado, no una variable en memoria: el worker
 * arranca de cero en cada ejecucion de GitHub Actions, asi que cualquier estado
 * que viva en el proceso vale exactamente para una pasada.
 *
 * Ante la duda (no existe, no se puede leer, la marca es ilegible) devuelve
 * `true`: es preferible una lectura de mas que un panel congelado para siempre.
 */
/**
 * Borra los errores del cliente que llevan mas de `DIAS_ERRORES` sin repetirse.
 *
 * Se filtra por `visto`, que es la ULTIMA vez que ocurrio: un error que sigue
 * pasando no se borra por antiguo, se borra cuando deja de pasar.
 */
async function podarErrores(ahora = Date.now()) {
  const limite = new Date(ahora - DIAS_ERRORES * 86400000);

  const viejos = await db().collection('errores_cliente')
    .where('visto', '<', limite)
    .limit(450)
    .get();

  if (viejos.empty) return 0;

  const lote = db().batch();
  for (const doc of viejos.docs) lote.delete(doc.ref);
  await lote.commit();

  return viejos.size;
}

function hayQueResumir(marca, ahora = Date.now()) {
  if (marca === null || marca === undefined) return true;

  // `serverTimestamp()` no vuelve como cadena, vuelve como Timestamp. Si solo
  // se contemplara el string, esto diria siempre que si y el limitador no
  // limitaria nada.
  const cuando = typeof marca?.toMillis === 'function' ? marca.toMillis() : Date.parse(marca);
  if (!Number.isFinite(cuando)) return true;

  return (ahora - cuando) >= MINUTOS_ENTRE_RESUMENES * 60000;
}

/** La misma pregunta, leyendo la marca de Firestore. Una lectura. */
async function tocaResumir(ahora = Date.now()) {
  try {
    const snap = await db().doc('agregados/metricas').get();
    return hayQueResumir(snap.exists ? snap.data().actualizado : null, ahora);
  } catch {
    return true;
  }
}

/**
 * El dia del ultimo trayecto verificado de un piloto, o `null`.
 *
 * Una lectura, con el indice `uid + verificado + fechaViaje` que ya existe. Es
 * lo UNICO que las cohortes necesitan de los viajes de alguien: la pregunta es
 * "¿hasta cuando siguio ahi?", y eso lo contesta el mas lejano.
 */
async function ultimoDiaConViaje(uid) {
  const snap = await db().collection('tiempos_viaje')
    .where('uid', '==', uid)
    .where('verificado', '==', true)
    .orderBy('fechaViaje', 'desc')
    .limit(1)
    .get();

  if (snap.empty) return null;
  return String(snap.docs[0].data().fechaViaje || '').slice(0, 10) || null;
}

/**
 * Las cohortes, recalculando solo las que todavia pueden cambiar.
 *
 * Las congeladas se copian del resumen anterior. Las vivas salen de los
 * usuarios dados de alta desde el lunes de hace `DIAS_COHORTE_VIVA` dias: se
 * arranca en LUNES a proposito, porque si no la semana del corte saldria a
 * medias — le faltarian los que se dieron de alta entre el lunes y el corte — y
 * pisaria a la version completa que ya estaba guardada.
 */
async function cohortesVivas(previas = []) {
  const corte = lunesDe(new Date(Date.now() - DIAS_COHORTE_VIVA * 86400000));

  const nuevosSnap = await db().collection('usuarios')
    .where('creado', '>=', new Date(`${corte}T00:00:00Z`))
    .get();

  const usuarios = nuevosSnap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  const ultimos = await Promise.all(usuarios.map((u) => ultimoDiaConViaje(u.uid)));

  // `calcularCohortes` solo mira el dia MAS LEJANO de cada uno, asi que un solo
  // viaje por piloto — el ultimo — da exactamente el mismo resultado que
  // pasarle su historial entero. Se reutiliza la funcion tal cual, con sus
  // pruebas, en vez de escribir una segunda que calcule lo mismo de otra forma.
  const viajes = usuarios
    .map((u, i) => (ultimos[i] ? { uid: u.uid, fechaViaje: ultimos[i] } : null))
    .filter(Boolean);

  const vivas = calcularCohortes(usuarios, viajes).filter((c) => c.semana >= corte);
  const congeladas = (previas || []).filter((c) => c && c.semana && c.semana < corte);

  return [...vivas, ...congeladas]
    .sort((a, b) => b.semana.localeCompare(a.semana))
    .slice(0, SEMANAS_COHORTE);
}

/**
 * Las cohortes calculadas a lo bestia: las dos colecciones enteras.
 *
 * Se usa UNA vez, la primera, y por un motivo concreto: se conservan doce
 * semanas de cohorte pero solo seis y pico siguen vivas. Las otras cinco no se
 * pueden deducir de nada — ya estan congeladas y sus datos no se vuelven a
 * mirar — asi que o se calculan una vez o no existen nunca.
 *
 * A partir de ahi se copian del resumen anterior y esto no se vuelve a llamar.
 */
async function cohortesCompletas() {
  const [usuariosSnap, viajesSnap] = await Promise.all([
    db().collection('usuarios').get(),
    db().collection('tiempos_viaje').where('verificado', '==', true).get(),
  ]);

  return calcularCohortes(
    usuariosSnap.docs.map((d) => ({ uid: d.id, ...d.data() })),
    viajesSnap.docs.map((d) => d.data()));
}

/** Cuantos documentos hay, sin traerselos: una lectura por cada mil. */
async function contar(consulta) {
  const conteo = await consulta.count().get();
  return conteo.data().count;
}

/**
 * Resumen que lee el panel: un solo documento con todas las ventanas.
 *
 * Que sea uno importa: la alternativa es que el panel lea 180 documentos de
 * `metricas/` cada vez que se abre.
 *
 * DE DONDE VIENE. Esto leia `usuarios` y `tiempos_viaje` ENTEROS — 15.441
 * lecturas con 15.000 viajes acumulados — y era el ultimo sitio del worker que
 * lo hacia, o sea el ultimo coste que crecia solo por llevar tiempo abierto.
 * Ahora nada de lo que pide crece con lo acumulado:
 *
 * - las cohortes congeladas se copian del resumen anterior;
 * - las vivas salen de los usuarios dados de alta hace poco, a una lectura por
 *   cabeza para su ultimo trayecto;
 * - los totales y los viajes por ventana salen de consultas de conteo, que
 *   cobran una lectura por cada MIL documentos contados.
 */
async function resumir() {
  const [diarios, previo] = await Promise.all([
    db().collection('metricas')
      .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
      .limit(200).get(),
    db().doc('agregados/metricas').get(),
  ]);

  const porDia = diarios.docs.map((d) => ({ dia: d.id, ...d.data() }));
  const hoy = dia(new Date());

  const verificados = db().collection('tiempos_viaje').where('verificado', '==', true);

  const ventanas = {};
  for (const [nombre, dias] of Object.entries(VENTANAS)) {
    const desde = dia(new Date(Date.now() - (dias - 1) * 86400000));
    const dentro = porDia.filter((d) => d.dia >= desde && d.dia <= hoy);

    const suma = (campo) => dentro.reduce((t, d) => t + (d[campo] || 0), 0);

    ventanas[nombre] = {
      sesiones: suma('sesiones'),
      paginasVistas: suma('pagina_vista'),
      subidasAbiertas: suma('subida_abierta'),
      subidasEnviadas: suma('subida_enviada'),
      subidasFallidas: suma('subida_fallida'),
      registrosAbiertos: suma('registro_abierto'),
      registrosCompletados: suma('registro_completado'),
      // Viajes verificados en la ventana, que sale de los datos, no del cliente.
      viajesVerificados: await contar(verificados.where('fechaViaje', '>=', desde)),
    };
  }

  const [usuariosTotal, viajesTotal] = await Promise.all([
    contar(db().collection('usuarios')),
    contar(verificados),
  ]);

  // La primera vez no hay de donde copiar las congeladas: se calculan a lo
  // bestia una sola vez. Despues, siempre incremental.
  const previas = previo.exists ? previo.data().cohortes : null;
  const cohortes = Array.isArray(previas)
    ? await cohortesVivas(previas)
    : await cohortesCompletas();

  await db().doc('agregados/metricas').set({
    ventanas,
    cohortes,
    totales: {
      usuarios: usuariosTotal,
      viajesVerificados: viajesTotal,
    },
    actualizado: admin.firestore.FieldValue.serverTimestamp(),
  });

  return ventanas;
}

module.exports = {
  agregarSesiones,
  tocaResumir,
  hayQueResumir,
  MINUTOS_ENTRE_RESUMENES,
  calcularCohortes,
  cohortesVivas,
  cohortesCompletas,
  ultimoDiaConViaje,
  lunesDe,
  resumir,
  SEMANAS_COHORTE,
  DIAS_COHORTE_VIVA,
  dia,
  diasEntre,
  VENTANAS,
  MAX_SESIONES_POR_PASADA,
  DIAS_ERRORES,
  podarErrores,
};
