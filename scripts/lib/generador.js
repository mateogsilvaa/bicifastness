'use strict';

/**
 * Generador de datos de prueba realistas (#56).
 *
 * Casi todo lo del roadmap se estrena en produccion sin haber corrido nunca con
 * volumen. El cierre de temporada, en concreto, toca a TODOS los usuarios y
 * pone contadores a cero: no puede ser la primera vez el dia 1.
 *
 * Aqui solo se GENERA. Escribir es cosa de `scripts/generar-datos.js`, y correr
 * las operaciones periodicas encima, de `backend/test/ensayo.test.js`.
 *
 * Es DETERMINISTA a proposito. Un generador con `Math.random()` da un ensayo
 * distinto cada vez: cuando algo falla no se puede repetir, y cuando pasa no se
 * sabe si es que esta bien o es que hoy tocaron datos faciles. Con semilla, un
 * fallo se reproduce pasando el mismo numero.
 */

const ESTACIONES = require('../../backend/lib/estaciones.json');

/**
 * Generador congruencial lineal. No es criptografia, es repetibilidad: lo unico
 * que se le pide es dar siempre la misma secuencia para la misma semilla.
 */
function aleatorio(semilla = 42) {
  let estado = semilla >>> 0;
  return () => {
    estado = (estado * 1664525 + 1013904223) >>> 0;
    return estado / 4294967296;
  };
}

const NIVELES = ['hierro', 'bronce', 'plata', 'oro', 'platino', 'leyenda'];

const NOMBRES = [
  'Alba', 'Bruno', 'Celia', 'Dario', 'Elena', 'Fer', 'Gema', 'Hugo', 'Ines',
  'Jorge', 'Kira', 'Lucas', 'Marta', 'Nacho', 'Olga', 'Pablo', 'Quique',
  'Rocio', 'Sergio', 'Tania', 'Unai', 'Vera', 'Wendy', 'Ximo', 'Yaiza', 'Zoe',
];

const CLANES = [
  'Rayos', 'Asfalto', 'Retiro', 'Cuesta', 'Manzanares', 'Gran Via', 'Norte',
  'Sur', 'Chamberi', 'Latina', 'Salamanca', 'Arganzuela', 'Tetuan', 'Usera',
  'Moncloa', 'Vallecas', 'Barajas', 'Hortaleza', 'Carabanchel', 'Centro',
];

const dia = (fecha) => fecha.toISOString().slice(0, 10);

/**
 * Genera un conjunto de datos completo.
 *
 * Los repartos NO son uniformes, y eso es el punto: con todo el mundo igual, el
 * cierre de temporada y las divisiones se comportan de una manera que no es la
 * real. Aqui hay gente que sube mucho y gente que subio dos veces y lo dejo,
 * rutas que concentran la mitad de los viajes y clanes de un solo miembro.
 */
function generar({
  usuarios: numUsuarios = 200,
  clanes: numClanes = 20,
  viajes: numViajes = 5000,
  meses = 3,
  semilla = 42,
  hasta = new Date('2026-08-23T00:00:00Z'),
} = {}) {
  const rnd = aleatorio(semilla);
  const entre = (min, max) => min + Math.floor(rnd() * (max - min + 1));
  const uno = (lista) => lista[Math.floor(rnd() * lista.length)];

  const estaciones = Object.keys(ESTACIONES);

  // --- Clanes ---------------------------------------------------------------
  const clanes = Array.from({ length: numClanes }, (_, i) => ({
    id: `clan-${i + 1}`,
    nombre: `${CLANES[i % CLANES.length]} ${i + 1}`,
    lider: null,
    miembros: [],
    numMiembros: 0,
    biciRating: 0,
    logros: [],
    color: `#${Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0')}`,
  }));

  // --- Usuarios -------------------------------------------------------------
  //
  // La actividad se reparte como en la realidad, no a partes iguales: un quinto
  // de la gente hace la mitad de los viajes, y hay una cola larga de cuentas que
  // subieron un par de veces. Si esto fuera uniforme, el cierre de temporada
  // repartiria insignias de una forma que no se parece a la de verdad.
  const usuarios = Array.from({ length: numUsuarios }, (_, i) => {
    const nombre = `${uno(NOMBRES)}${i}`;
    const intensidad = rnd() < 0.2 ? entre(6, 12) : (rnd() < 0.5 ? entre(2, 5) : 1);

    return {
      uid: `uid-${i + 1}`,
      username: nombre,
      usernameLower: nombre.toLowerCase(),
      avatarUrl: null,
      biciRating: 0,
      puntosTemporada: 0,
      viajesVerificados: 0,
      metrosTotales: 0,
      puntosPorRuta: {},
      logros: [],
      clanId: null,
      favoritas: [],
      suspendido: false,
      racha: 0,
      mejorRacha: 0,
      escudos: 0,
      ultimoDiaActivo: null,
      division: uno(NIVELES),
      intensidad,
    };
  });

  // Un tercio se queda sin clan: no todo el mundo se une a uno, y el reparto de
  // territorio tiene que aguantarlo.
  for (const u of usuarios) {
    if (rnd() < 0.66) {
      const clan = uno(clanes);
      u.clanId = clan.id;
      clan.miembros.push(u.uid);
      if (!clan.lider) clan.lider = u.uid;
    }
  }
  for (const c of clanes) c.numMiembros = c.miembros.length;

  // --- Rutas ----------------------------------------------------------------
  //
  // Un puñado de rutas concentra la mayoria de los viajes, que es lo que pasa de
  // verdad: la gente repite trayecto. Importa porque es lo que hace que el
  // agregado de una ruta sea grande y el de otra tenga tres filas.
  const rutasPopulares = Array.from({ length: 12 }, () => {
    const a = uno(estaciones);
    let b = uno(estaciones);
    while (b === a) b = uno(estaciones);
    return `${a}-${b}`;
  });

  const rutaAleatoria = () => {
    const a = uno(estaciones);
    let b = uno(estaciones);
    while (b === a) b = uno(estaciones);
    return `${a}-${b}`;
  };

  // --- Viajes ---------------------------------------------------------------
  const pesoTotal = usuarios.reduce((t, u) => t + u.intensidad, 0);
  const desde = new Date(hasta.getTime() - meses * 30 * 86400000);

  const viajes = [];
  for (let i = 0; i < numViajes; i++) {
    // Elige piloto proporcionalmente a su intensidad.
    let objetivo = rnd() * pesoTotal;
    let piloto = usuarios[0];
    for (const u of usuarios) {
      objetivo -= u.intensidad;
      if (objetivo <= 0) { piloto = u; break; }
    }

    const ruta = rnd() < 0.55 ? uno(rutasPopulares) : rutaAleatoria();
    const cuando = new Date(desde.getTime() + rnd() * (hasta.getTime() - desde.getTime()));
    const tiempoSegundos = entre(240, 2400);

    // Uno de cada diez no llego a aprobarse: la cola de revision y los rechazos
    // existen, y las operaciones periodicas tienen que ignorarlos.
    const suerte = rnd();
    const estado = suerte < 0.88 ? 'aprobado' : (suerte < 0.95 ? 'revision' : 'rechazado');

    viajes.push({
      id: `viaje-${i + 1}`,
      uid: piloto.uid,
      username: piloto.username,
      ruta,
      tiempoSegundos,
      tiempoFormateado: `${Math.floor(tiempoSegundos / 60)}:${String(tiempoSegundos % 60).padStart(2, '0')}`,
      fechaViaje: dia(cuando),
      distanciaMetros: entre(800, 9000),
      distanciaEstimada: rnd() < 0.7,
      estado,
      verificado: estado === 'aprobado',
      revisadoPor: estado === 'aprobado' ? 'automatico' : null,
      creado: cuando,
    });
  }

  // --- Totales derivados ----------------------------------------------------
  //
  // Se calculan de los viajes y no se inventan: si los contadores del usuario no
  // cuadran con sus viajes, el ensayo mide una situacion imposible y las
  // conclusiones no valen.
  for (const v of viajes) {
    if (!v.verificado) continue;
    const piloto = usuarios.find((u) => u.uid === v.uid);
    piloto.viajesVerificados++;
    piloto.metrosTotales += v.distanciaMetros;
    piloto.puntosTemporada += Math.round(5 + v.distanciaMetros / 500);
    piloto.biciRating += Math.round(5 + v.distanciaMetros / 500);
    piloto.puntosPorRuta[v.ruta] = (piloto.puntosPorRuta[v.ruta] || 0) + 10;
  }

  for (const u of usuarios) {
    u.mejorRacha = u.viajesVerificados > 0 ? entre(1, Math.min(30, u.viajesVerificados)) : 0;
    u.racha = rnd() < 0.3 ? entre(1, u.mejorRacha || 1) : 0;
    delete u.intensidad;
  }

  for (const c of clanes) {
    c.biciRating = c.miembros
      .reduce((t, uid) => t + (usuarios.find((u) => u.uid === uid)?.biciRating || 0), 0);
  }

  // --- Estadisticas de estacion --------------------------------------------
  const estacionesTocadas = new Set();
  for (const v of viajes) {
    if (!v.verificado) continue;
    const [a, b] = v.ruta.split('-');
    estacionesTocadas.add(a);
    estacionesTocadas.add(b);
  }

  const estadisticas = [...estacionesTocadas].map((id) => ({
    id,
    influencia: Object.fromEntries(
      clanes.slice(0, entre(1, 4)).map((c) => [c.id, Math.round(rnd() * 100)])),
    actualizado: hasta,
  }));

  return { usuarios, clanes, viajes, estadisticas };
}

module.exports = { generar, aleatorio, NIVELES };
