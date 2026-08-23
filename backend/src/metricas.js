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

const db = () => admin.firestore();

/** Cuantos dias se conserva el detalle de sesiones antes de podarlo. */
const DIAS_DETALLE = 7;

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

/**
 * Suma las sesiones del navegador en contadores diarios y borra el detalle
 * viejo.
 *
 * El detalle no se conserva porque no aporta: una vez sumado, un documento por
 * sesion solo ocupa. Y menos documentos sueltos por ahi es menos superficie.
 */
async function agregarSesiones() {
  const sesiones = await db().collection('sesiones_web').get();
  if (sesiones.empty) return { dias: 0, sesiones: 0 };

  /** dia -> { evento: total } */
  const porDia = new Map();
  const limite = dia(new Date(Date.now() - DIAS_DETALLE * 86400000));
  const podar = [];

  for (const doc of sesiones.docs) {
    const datos = doc.data();
    const fecha = datos.dia;
    if (!fecha) continue;

    if (!porDia.has(fecha)) porDia.set(fecha, { sesiones: 0 });
    const acumulado = porDia.get(fecha);
    acumulado.sesiones++;

    for (const [clave, valor] of Object.entries(datos)) {
      if (typeof valor !== 'number') continue;
      acumulado[clave] = (acumulado[clave] || 0) + valor;
    }

    if (fecha < limite) podar.push(doc.ref);
  }

  for (const [fecha, totales] of porDia) {
    await db().doc(`metricas/${fecha}`).set({
      ...totales,
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
    const lunes = new Date(alta);
    lunes.setUTCDate(lunes.getUTCDate() - ((lunes.getUTCDay() + 6) % 7));
    const semana = dia(lunes);

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

  return [...cohortes.values()].sort((a, b) => b.semana.localeCompare(a.semana)).slice(0, 12);
}

/**
 * Resumen que lee el panel: un solo documento con todas las ventanas.
 *
 * Que sea uno importa: la alternativa es que el panel lea 180 documentos de
 * `metricas/` cada vez que se abre.
 */
/**
 * Cada cuanto se rehace el resumen caro, en minutos.
 *
 * `resumir` necesita `usuarios` y `tiempos_viaje` ENTEROS: la retencion por
 * cohortes y los viajes por ventana no salen de otro sitio. El worker corre
 * cada 5 minutos, asi que hacerlo en cada pasada costaba 288 x (usuarios +
 * viajes) lecturas al dia — 402.000 con 175 usuarios y 1.022 viajes, ocho veces
 * la cuota diaria del plan Spark, con seis personas usando la web y aunque no
 * pasara absolutamente nada.
 *
 * Seis horas son de sobra para un panel de metricas: nadie mira la retencion a
 * 30 dias y espera verla cambiar en cinco minutos. Baja el coste a 4 pasadas
 * al dia en vez de 288.
 *
 * Lo que SI sigue en cada pasada es `agregarSesiones`, que es la parte barata y
 * la que no puede esperar: poda el detalle viejo segun llega.
 */
const MINUTOS_ENTRE_RESUMENES = 360;

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

async function resumir({ usuarios = [], viajes = [] } = {}) {
  const diarios = await db().collection('metricas')
    .orderBy(admin.firestore.FieldPath.documentId(), 'desc')
    .limit(200).get();

  const porDia = diarios.docs.map((d) => ({ dia: d.id, ...d.data() }));
  const hoy = dia(new Date());

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
      viajesVerificados: viajes.filter((v) => String(v.fechaViaje || '') >= desde).length,
    };
  }

  await db().doc('agregados/metricas').set({
    ventanas,
    cohortes: calcularCohortes(usuarios, viajes),
    totales: {
      usuarios: usuarios.length,
      viajesVerificados: viajes.length,
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
  resumir,
  dia,
  diasEntre,
  VENTANAS,
  DIAS_DETALLE,
  DIAS_ERRORES,
  podarErrores,
};
