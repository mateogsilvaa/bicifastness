#!/usr/bin/env node
'use strict';

/**
 * Worker de verificacion de viajes.
 *
 * Este es el "servidor de confianza" de BiciFastness. No atiende peticiones:
 * se despierta cada pocos minutos desde GitHub Actions, coge los viajes que
 * esperan analisis y los resuelve.
 *
 * Por que asi y no con Cloud Functions: desplegar funciones en Firebase exige
 * el plan Blaze (tarjeta). GitHub Actions es gratis e ilimitado en repositorios
 * publicos, y aqui es donde vive el codigo de todas formas.
 *
 * Lo unico que se pierde frente a un servidor HTTP es la inmediatez: un viaje
 * tarda entre 5 y 10 minutos en resolverse en vez de segundos. A cambio, las
 * credenciales de administrador NUNCA tocan el navegador, que es lo que provoco
 * el compromiso anterior.
 *
 * No depende de ningun servicio de IA: la captura se lee con OCR local
 * (src/ocr.js). Ver ahi que se gana y que se pierde.
 *
 * Variables de entorno (GitHub Secrets):
 *   FIREBASE_SERVICE_ACCOUNT  JSON de la cuenta de servicio
 *   RESEND_API_KEY            clave de Resend (opcional: sin ella no se avisa)
 *
 * Uso:
 *   node backend/worker.js              procesa la cola
 *   node backend/worker.js --once       procesa como mucho un viaje (pruebas)
 *   node backend/worker.js --simular    analiza pero no escribe nada
 */

const admin = require('firebase-admin');

const { LIMITES, TIEMPO } = require('./src/config');
const { construirRuta, inicioDelDiaMadrid } = require('./src/util');
const imagen = require('./src/imagen');
const { leerCaptura } = require('./src/ocr');
const { evaluar, distanciaCalleMetros } = require('./src/verificacion');
const puntuacion = require('./src/puntuacion');
const distancias = require('./src/distancias');
const rachas = require('./src/rachas');
const correo = require('./src/correo');
const plantillas = require('./src/plantillas');
const metricas = require('./src/metricas');

const SIMULAR = process.argv.includes('--simular');
const SOLO_UNO = process.argv.includes('--once');

// Cuantos viajes se procesan por ejecucion. Con una ejecucion cada 5 minutos
// esto da holgura de sobra y evita agotar la cuota diaria de Firestore del plan
// gratuito (50.000 lecturas y 20.000 escrituras al dia).
const MAX_POR_TANDA = SOLO_UNO ? 1 : 25;

// El dominio tiene que estar verificado en Resend con SPF, DKIM y DMARC, o el
// correo se va a spam.
const REMITENTE = 'BiciFastness <avisos@bicifastness.es>';

function arrancar() {
  const credenciales = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!credenciales) {
    console.error('Falta FIREBASE_SERVICE_ACCOUNT.');
    process.exit(1);
  }

  let cuenta;
  try {
    cuenta = JSON.parse(credenciales);
  } catch {
    console.error('FIREBASE_SERVICE_ACCOUNT no es un JSON valido.');
    process.exit(1);
  }

  admin.initializeApp({ credential: admin.credential.cert(cuenta) });
  return admin.firestore();
}

const db = arrancar();
const AHORA = () => admin.firestore.FieldValue.serverTimestamp();

/**
 * Comprueba lo que el navegador no puede garantizar por si solo.
 *
 * Las reglas de Firestore validan la forma del documento y que el dueno sea
 * quien dice ser, pero no saben contar cuantos viajes ha subido alguien hoy ni
 * si la ruta existe de verdad. Eso se comprueba aqui, y lo que no cuadra se
 * rechaza sin llegar a gastar una pasada de OCR, que es lo mas lento del pipeline.
 */
async function validarBasico(viaje, uid) {
  try {
    construirRuta(...String(viaje.ruta || '').split('-'));
  } catch {
    return 'La ruta declarada no existe.';
  }

  if (!Number.isInteger(viaje.tiempoSegundos)
    || viaje.tiempoSegundos < TIEMPO.MIN_SEGUNDOS
    || viaje.tiempoSegundos > TIEMPO.MAX_SEGUNDOS) {
    return 'El tiempo declarado esta fuera de rango.';
  }

  const fecha = new Date(`${String(viaje.fechaViaje).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(fecha.getTime())) return 'La fecha del viaje no es valida.';

  const ahora = Date.now();
  if (fecha.getTime() > ahora + 864e5) return 'No se pueden registrar viajes futuros.';
  if (ahora - fecha.getTime() > LIMITES.DIAS_MAX_ANTIGUEDAD * 864e5) {
    return `Solo se admiten viajes de los ultimos ${LIMITES.DIAS_MAX_ANTIGUEDAD} dias.`;
  }

  // Cupo diario, contado en el servidor. En el navegador se puede saltar
  // cualquier limite abriendo la consola.
  const inicioHoy = inicioDelDiaMadrid(new Date());
  const hoy = await db.collection('tiempos_viaje')
    .where('uid', '==', uid)
    .where('creado', '>=', admin.firestore.Timestamp.fromMillis(inicioHoy))
    .get();

  // El propio viaje que estamos procesando cuenta dentro del resultado.
  if (hoy.size > LIMITES.VIAJES_POR_DIA) {
    return `Limite de ${LIMITES.VIAJES_POR_DIA} viajes al dia superado.`;
  }

  return null;
}

/** Contexto competitivo y estadistico que alimenta al motor. */
async function reunirContexto(viaje, uid) {
  const [rutaSnap, propiosSnap, huellasSnap] = await Promise.all([
    db.collection('tiempos_viaje')
      .where('ruta', '==', viaje.ruta).where('verificado', '==', true)
      .orderBy('tiempoSegundos', 'asc').limit(200).get(),
    db.collection('tiempos_viaje')
      .where('uid', '==', uid).where('verificado', '==', true)
      .orderBy('creado', 'desc').limit(40).get(),
    db.collection('huellas_captura').orderBy('creado', 'desc').limit(400).get(),
  ]);

  const tiemposRuta = rutaSnap.docs.map((d) => d.data().tiempoSegundos);
  const propios = propiosSnap.docs.map((d) => d.data());

  return {
    tiemposRuta,
    mejorTiempoRuta: tiemposRuta.length ? tiemposRuta[0] : null,
    mejorTiempoPropio: propios
      .filter((v) => v.ruta === viaje.ruta)
      .reduce((mejor, v) => (mejor === null || v.tiempoSegundos < mejor ? v.tiempoSegundos : mejor), null),
    velocidadesPrevias: propios
      .map((v) => {
        const metros = distanciaCalleMetros(...String(v.ruta || '').split('-'));
        return metros && v.tiempoSegundos ? (metros / v.tiempoSegundos) * 3.6 : null;
      })
      .filter(Boolean),
    shaPrevios: huellasSnap.docs.map((d) => ({ sha: d.data().sha, tripId: d.data().tripId, uid: d.data().uid })),
    hashesPrevios: huellasSnap.docs.map((d) => ({ dhash: d.data().dhash, tripId: d.data().tripId })),
  };
}

/** Procesa un viaje de principio a fin. */
async function procesar(doc) {
  const viaje = doc.data();
  const uid = viaje.uid;
  console.log(`\n[${doc.id}] ${viaje.username} — ruta ${viaje.ruta} en ${viaje.tiempoSegundos}s`);

  // 1. Validaciones que el cliente no puede garantizar.
  const problema = await validarBasico(viaje, uid);
  if (problema) {
    console.log(`  rechazado: ${problema}`);
    if (!SIMULAR) await resolver(doc, { decision: 'rechazado', resumen: problema, riesgo: 100, señales: [] });
    return 'rechazado';
  }

  // 2. La captura vive en su propia coleccion, que el cliente no puede leer.
  const capturaSnap = await db.doc(`capturas/${doc.id}`).get();
  if (!capturaSnap.exists) {
    console.log('  rechazado: no hay captura asociada');
    if (!SIMULAR) {
      await resolver(doc, { decision: 'rechazado', resumen: 'No se ha recibido la captura.', riesgo: 100, señales: [] });
    }
    return 'rechazado';
  }

  let buffer;
  let mime;
  try {
    ({ buffer, mime } = imagen.decodificarDataUrl(capturaSnap.data().datos));
  } catch (error) {
    console.log(`  rechazado: captura invalida (${error.message})`);
    if (!SIMULAR) {
      await resolver(doc, { decision: 'rechazado', resumen: 'La captura no es una imagen valida.', riesgo: 100, señales: [] });
    }
    return 'rechazado';
  }

  // 3. Huellas y metadatos.
  const [hashSha, hashPerceptual, inspeccion] = await Promise.all([
    Promise.resolve(imagen.hashExacto(buffer)),
    imagen.hashPerceptual(buffer),
    imagen.inspeccionar(buffer),
  ]);

  // 4. Contexto competitivo y lectura de la captura.
  const contexto = await reunirContexto(viaje, uid);
  const lectura = await leerCaptura({ buffer, mime });

  // 5. Veredicto.
  const veredicto = evaluar({
    ruta: viaje.ruta,
    tiempoSegundos: viaje.tiempoSegundos,
    lectura,
    hashSha,
    hashPerceptual,
    edicionSospechosa: inspeccion.sospechaEdicion,
    software: inspeccion.software,
    ...contexto,
  });

  console.log(`  -> ${veredicto.decision} (riesgo ${veredicto.riesgo}): ${veredicto.resumen}`);
  for (const s of veredicto.señales) console.log(`     [${s.gravedad}] ${s.mensaje}`);

  if (SIMULAR) return veredicto.decision;

  // 6. Guardar la huella para que la captura no se pueda reutilizar. `create`
  // y no `set`: si ya existe hay que conservar la del viaje original.
  await db.collection('huellas_captura').doc(hashSha).create({
    sha: hashSha, dhash: hashPerceptual, tripId: doc.id, uid, creado: AHORA(),
  }).catch((error) => {
    if (error.code !== 6) throw error; // 6 = ALREADY_EXISTS
  });

  await resolver(doc, veredicto);
  return veredicto.decision;
}

/** Escribe el veredicto y, si procede, recalcula la clasificacion. */
async function resolver(doc, veredicto) {
  const viaje = doc.data();
  const aprobado = veredicto.decision === 'aprobado';

  await doc.ref.update({
    estado: veredicto.decision,
    verificado: aprobado,
    auditoria: veredicto,
    revisadoPor: 'automatico',
    revisadoEn: AHORA(),
  });

  if (aprobado) {
    await premiar(doc, viaje);
    await puntuacion.recalcularTrasCambio(viaje.ruta);
  }

  // Las capturas rechazadas no aportan nada y ocupan cuota: el hash ya impide
  // reutilizar la imagen, asi que el fichero en si sobra.
  if (veredicto.decision === 'rechazado') {
    await db.doc(`capturas/${doc.id}`).delete().catch(() => {});
    await avisarRechazo(viaje, veredicto);
  }
}

/**
 * Avisa por correo de un rechazo automatico.
 *
 * Es el unico correo que se manda en el momento, y por un motivo: sin el, la
 * persona sube un viaje, no pasa nada y no sabe por que. Los avisos de viaje
 * aprobado NO van aqui, van agrupados, o se come el cupo diario de Resend en
 * cuanto haya unos pocos pilotos activos.
 *
 * Que falle el correo no puede afectar al veredicto: el viaje ya esta resuelto.
 */
async function avisarRechazo(viaje, veredicto) {
  try {
    const usuario = await db.doc(`usuarios/${viaje.uid}`).get();
    if (!usuario.exists) return;

    const datos = usuario.data();

    // El correo se pide a Firebase Auth, no al documento. Ahi es donde vive de
    // verdad, y ademas nunca esta obsoleto: si alguien lo cambia en su cuenta,
    // una copia en Firestore se quedaria apuntando a la direccion vieja.
    // OJO con el nombre: `correo` es el modulo de envio importado arriba. Una
    // variable local con ese nombre lo tapa dentro de esta funcion y
    // `correo.enviar(...)` reventaria.
    let destinatario = null;
    try {
      destinatario = (await admin.auth().getUser(viaje.uid)).email || null;
    } catch {
      // Cuenta borrada: no hay a quien avisar.
      return;
    }
    if (!destinatario) return;

    // Respeta la preferencia, si la hay. Un rechazo es transaccional y se puede
    // enviar sin consentimiento, pero si alguien lo ha desactivado a proposito
    // no se le insiste.
    if (datos.avisosCorreo === false) return;

    // El token de baja se crea la primera vez que se le escribe y se queda.
    // Si cambiara en cada correo, un enlace de hace dos dias dejaria de
    // funcionar, que es justo lo que hace que la gente marque spam.
    let tokenBaja = datos.tokenBaja;
    if (!tokenBaja) {
      tokenBaja = correo.generarTokenBaja();
      if (!SIMULAR) await usuario.ref.update({ tokenBaja });
    }

    const mensaje = plantillas.viajeRechazado({
      nombre: datos.username || 'piloto',
      ruta: viaje.ruta,
      // `resumen` es el texto para la persona. Las señales con sus pesos se
      // quedan en la auditoria: no salen en el correo.
      motivo: veredicto.resumen,
      tokenBaja,
    });

    const resultado = await correo.enviar({
      ...mensaje,
      para: destinatario,
      remitente: REMITENTE,
      apiKey: process.env.RESEND_API_KEY,
      simular: SIMULAR,
    });

    if (resultado.error) console.warn(`  aviso no enviado: ${resultado.error}`);
  } catch (err) {
    console.warn('  no se ha podido avisar del rechazo:', err.message);
  }
}

/**
 * Cierra un viaje aprobado: mide el trayecto, actualiza la racha del piloto y
 * le da los puntos que le tocan.
 *
 * Va en una transaccion sobre el documento del usuario porque la racha es
 * lectura-modificacion-escritura, y el worker puede aprobar dos viajes del
 * mismo piloto en la misma tanda: sin transaccion, el segundo pisaria al
 * primero. Los acumulados van con `increment` por el mismo motivo.
 *
 * La distancia y la velocidad NO las declara el usuario: salen del par de
 * estaciones y del tiempo, que es lo que el pipeline ya ha contrastado contra
 * la captura. Anadirlas al juego no abre superficie nueva de fraude.
 */
async function premiar(doc, viaje) {
  const [origen, destino] = String(viaje.ruta).split('-');

  const cache = {
    leer: async () => {
      const guardada = await db.doc(`distancias/${viaje.ruta}`).get();
      return guardada.exists ? guardada.data().metros : null;
    },
    escribir: async () => {},
  };

  const medida = await distancias.resolverConCache(origen, destino, cache);
  const metros = medida ? medida.metros : null;
  const kmh = distancias.velocidadKmh(metros, viaje.tiempoSegundos);

  const multRuta = await puntuacion.multiplicadorRuta(viaje.ruta);
  const cuando = new Date(`${String(viaje.fechaViaje).slice(0, 10)}T12:00:00Z`);

  const refUsuario = db.doc(`usuarios/${viaje.uid}`);
  let puntos;

  await db.runTransaction(async (tx) => {
    const usuario = await tx.get(refUsuario);
    if (!usuario.exists) return;

    const previo = usuario.data();
    const racha = rachas.registrarDiaActivo({
      racha: previo.racha,
      mejorRacha: previo.mejorRacha,
      escudos: previo.escudos,
      diasHastaEscudo: previo.diasHastaEscudo,
      ultimoDiaActivo: previo.ultimoDiaActivo,
    }, cuando);

    puntos = puntuacion.calcularPuntosViaje({
      distanciaMetros: metros,
      velocidadKmh: kmh,
      multiplicadorRuta: multRuta,
      racha: racha.racha,
      // Pendiente del issue #28: hace falta saber que clan controla la estacion.
      territorioPropio: false,
    });

    tx.update(refUsuario, {
      viajesVerificados: admin.firestore.FieldValue.increment(1),
      metrosTotales: admin.firestore.FieldValue.increment(metros || 0),
      segundosTotales: admin.firestore.FieldValue.increment(viaje.tiempoSegundos || 0),
      puntosTemporada: admin.firestore.FieldValue.increment(puntos.total),
      racha: racha.racha,
      mejorRacha: racha.mejorRacha,
      escudos: racha.escudos,
      diasHastaEscudo: racha.diasHastaEscudo,
      ultimoDiaActivo: racha.ultimoDiaActivo,
    });
  });

  if (!puntos) return;

  await doc.ref.update({
    distanciaMetros: metros,
    distanciaEstimada: medida ? medida.estimada : true,
    velocidadKmh: kmh === null ? null : Number(kmh.toFixed(2)),
    puntos: puntos.total,
    puntosDesglose: puntos.desglose,
    // Marca de que este viaje ya sumo. Es lo que permite deshacerlo despues sin
    // restar dos veces si el viaje se anula, se reactiva y se vuelve a anular.
    premiado: true,
  });

  console.log(`  +${puntos.total} puntos (${((metros || 0) / 1000).toFixed(2)} km`
    + `${kmh ? `, ${kmh.toFixed(1)} km/h` : ''}${medida && medida.estimada ? ', distancia estimada' : ''})`);
}

/**
 * Deshace lo que sumo un viaje que despues se ha anulado.
 *
 * Se resta EXACTAMENTE lo que se guardo en el propio viaje, no lo que se
 * volveria a calcular hoy: entre medias pueden haber cambiado los umbrales de
 * `config.js`, la racha del piloto o la ruta del dia, y recalcular restaria una
 * cantidad distinta de la que se sumo. La marca `premiado` evita restar dos
 * veces si el viaje se anula, se reactiva y se vuelve a anular.
 *
 * La RACHA no se toca, y es deliberado. Deshacerla bien exigiria saber si ese
 * dia le quedaban otros viajes verificados y, si no, recomponer la cadena
 * entera desde ahi. Desproporcionado para lo que es: la racha premia haber
 * aparecido, no la marca conseguida, y quitarsela meses despues a alguien
 * castiga mas de lo que corrige.
 */
async function revertirPremio(doc, viaje) {
  const refUsuario = db.doc(`usuarios/${viaje.uid}`);
  const menos = admin.firestore.FieldValue.increment;

  await refUsuario.update({
    viajesVerificados: menos(-1),
    metrosTotales: menos(-(viaje.distanciaMetros || 0)),
    segundosTotales: menos(-(viaje.tiempoSegundos || 0)),
    puntosTemporada: menos(-(viaje.puntos || 0)),
  }).catch((err) => {
    // Si el usuario ya no existe (cuenta borrada), no hay nada que devolver.
    console.warn(`No se han podido revertir los acumulados de ${viaje.uid}:`, err.message);
  });

  await doc.ref.update({ premiado: false });
  console.log(`  [${doc.id}] revertidos ${viaje.puntos || 0} puntos y `
    + `${((viaje.distanciaMetros || 0) / 1000).toFixed(2)} km`);
}

/**
 * Procesa las bajas de correo pedidas desde el enlace del propio correo.
 *
 * El navegador solo puede CREAR `solicitudes_baja/{token}`: no puede leer esa
 * coleccion ni tocar el perfil de nadie. Aqui se cambia el token por su dueño y
 * se apagan sus avisos.
 *
 * Se borra la solicitud siempre, incluso si el token ya no corresponde a nadie.
 * Si no, un token caducado se quedaria dando vueltas en cada pasada, y esa
 * coleccion la escribe gente sin sesion: es justo la que no debe acumular.
 */
async function procesarBajas() {
  const solicitudes = await db.collection('solicitudes_baja').limit(50).get();
  if (solicitudes.empty) return 0;

  let dadas = 0;

  for (const solicitud of solicitudes.docs) {
    const token = solicitud.id;

    const usuarios = await db.collection('usuarios')
      .where('tokenBaja', '==', token).limit(1).get();

    if (!usuarios.empty) {
      if (!SIMULAR) await usuarios.docs[0].ref.update({ avisosCorreo: false });
      dadas++;
    }

    if (!SIMULAR) await solicitud.ref.delete().catch(() => {});
  }

  console.log(`Bajas de correo procesadas: ${dadas} de ${solicitudes.size} solicitudes.`);
  return dadas;
}

/**
 * Aplica las decisiones que un administrador ha marcado desde el panel.
 *
 * El admin puede escribir `estado` gracias a su custom claim, pero recalcular
 * la clasificacion desde el navegador costaria cientos de lecturas. Marca la
 * decision y el worker hace el trabajo pesado.
 */
async function aplicarDecisionesManuales() {
  const pendientes = await db.collection('tiempos_viaje')
    .where('recalculoPendiente', '==', true).limit(20).get();

  if (pendientes.empty) return 0;

  const rutas = new Set();
  for (const doc of pendientes.docs) {
    const viaje = doc.data();
    rutas.add(viaje.ruta);

    // Un viaje que ya habia sumado y que deja de estar verificado hay que
    // deshacerlo, o el piloto se queda con los kilometros y los puntos de un
    // viaje anulado.
    if (viaje.premiado === true && viaje.verificado !== true) {
      if (!SIMULAR) await revertirPremio(doc, viaje);
      else console.log(`  [${doc.id}] se revertirian ${viaje.puntos || 0} puntos`);
    }

    if (!SIMULAR) await doc.ref.update({ recalculoPendiente: false });
  }

  if (!SIMULAR) {
    for (const ruta of rutas) await puntuacion.recalcularTrasCambio(ruta);
  }

  console.log(`Recalculadas ${rutas.size} rutas tras decisiones manuales.`);
  return pendientes.size;
}

async function main() {
  console.log(SIMULAR ? '=== SIMULACION: no se escribe nada ===' : '=== Worker de verificacion ===');

  const cola = await db.collection('tiempos_viaje')
    .where('estado', '==', 'pendiente')
    .orderBy('creado', 'asc')
    .limit(MAX_POR_TANDA)
    .get();

  console.log(`Viajes en cola: ${cola.size}`);

  const cuenta = { aprobado: 0, rechazado: 0, revision: 0, error: 0 };

  for (const doc of cola.docs) {
    try {
      const decision = await procesar(doc);
      cuenta[decision] = (cuenta[decision] || 0) + 1;
    } catch (error) {
      cuenta.error++;
      console.error(`  ERROR procesando ${doc.id}:`, error.message);
      // Un fallo no debe dejar el viaje atascado en la cola para siempre: pasa
      // a revision manual, que es el estado seguro.
      if (!SIMULAR) {
        await doc.ref.update({
          estado: 'revision',
          auditoria: {
            resumen: 'El analisis automatico ha fallado. Requiere revision humana.',
            riesgo: 50,
            señales: [{ codigo: 'error_worker', gravedad: 50, mensaje: error.message }],
          },
        }).catch(() => {});
      }
    }
  }

  await aplicarDecisionesManuales();
  await procesarBajas();

  // Los agregados se reconstruyen UNA VEZ al final, no por viaje: es la
  // operacion mas cara que hace el worker (#36).
  if (!SIMULAR && (cuenta.aprobado > 0 || cuenta.rechazado > 0)) {
    const escritos = await puntuacion.reconstruirAgregados();
    console.log(`Agregados reconstruidos: ${JSON.stringify(escritos)}`);
  }

  // Metricas: suma las sesiones del navegador en contadores diarios, poda el
  // detalle viejo y recalcula la retencion. Se hace siempre, aunque no haya
  // habido viajes: las visitas ocurren igual.
  if (!SIMULAR) {
    try {
      const sesiones = await metricas.agregarSesiones();
      const [usuariosSnap, viajesSnap] = await Promise.all([
        db.collection('usuarios').get(),
        db.collection('tiempos_viaje').where('verificado', '==', true).get(),
      ]);

      await metricas.resumir({
        usuarios: usuariosSnap.docs.map((d) => ({ uid: d.id, ...d.data() })),
        viajes: viajesSnap.docs.map((d) => d.data()),
      });

      console.log(`Metricas: ${sesiones.sesiones || 0} sesiones agregadas, `
        + `${sesiones.podados || 0} podadas.`);
    } catch (error) {
      // Que fallen las metricas no puede tumbar la verificacion de viajes.
      console.warn('No se han podido actualizar las metricas:', error.message);
    }
  }

  console.log(`\nResumen: ${cuenta.aprobado} aprobados, ${cuenta.rechazado} rechazados, `
    + `${cuenta.revision} a revision, ${cuenta.error} con error.`);
  process.exit(0);
}

main().catch((error) => {
  console.error('Fallo del worker:', error);
  process.exit(1);
});
