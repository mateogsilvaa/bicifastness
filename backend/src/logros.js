'use strict';

/**
 * Concesion de insignias (#24).
 *
 * Las concede EL WORKER, nunca el navegador. No es una precaucion teorica: en
 * la v1 el cliente escribia su propio documento de usuario, y una insignia que
 * el navegador pueda darse no es un logro, es un campo de texto.
 *
 * La regla de Firestore lo respalda — `logros` no esta entre los campos que el
 * usuario puede tocar — pero conviene que tambien lo respalde el diseno: aqui
 * no hay ninguna funcion que reciba una insignia y la escriba. Se evalua el
 * estado del piloto contra el catalogo y sale lo que se ha ganado.
 *
 * El catalogo vive en `data/insignias.json` y lo reparte
 * `scripts/build-insignias.js`. Ver ahi por que estaba duplicado antes.
 */

const CATALOGO = require('../lib/insignias.json');

/**
 * Campos derivados que no estan en el documento del usuario pero se sacan de
 * el sin leer nada mas.
 *
 * Importa que sea asi: evaluar insignias no puede costar lecturas extra, o
 * conceder una medalla saldria mas caro que verificar el viaje que la gana.
 */
function derivados(usuario) {
  const porRuta = usuario.puntosPorRuta || {};

  const estaciones = new Set();
  for (const ruta of Object.keys(porRuta)) {
    const [origen, destino] = String(ruta).split('-');
    if (origen) estaciones.add(origen);
    if (destino) estaciones.add(destino);
  }

  return {
    tramosConPuntos: Object.keys(porRuta).length,
    estacionesVisitadas: estaciones.size,
  };
}

/**
 * Que insignias del catalogo cumple este piloto AHORA.
 *
 * Solo las que tienen `regla`. Las que no — fundador de clan, conquistador,
 * podio de tramo, las de temporada — las concede quien sabe de eso, y no se
 * conceden solas a proposito: una insignia que se otorga por accidente vale
 * menos que ninguna.
 */
function cumplidas(usuario) {
  const estado = { ...usuario, ...derivados(usuario) };
  const ganadas = [];

  for (const [clave, insignia] of Object.entries(CATALOGO.insignias)) {
    if (!insignia.regla) continue;

    const valor = Number(estado[insignia.regla.campo]) || 0;
    if (valor >= insignia.regla.minimo) ganadas.push(clave);
  }

  return ganadas;
}

/**
 * Las que se ha ganado y todavia no tiene.
 *
 * Devuelve solo lo NUEVO para que el worker pueda escribir un `arrayUnion` con
 * lo justo, o no escribir nada. Lo segundo es el caso normal: la mayoria de los
 * viajes no desbloquean ninguna insignia, y una escritura por viaje solo para
 * confirmar que no hay novedad es cuota tirada.
 */
function nuevas(usuario) {
  const tiene = new Set(Array.isArray(usuario.logros) ? usuario.logros : []);
  return cumplidas(usuario).filter((clave) => !tiene.has(clave));
}

/**
 * Descompone una insignia de temporada: `temporada-2026-07-oro`.
 * Devuelve null si no lo es.
 */
function deTemporada(clave) {
  const partes = String(clave).split('-');
  if (partes[0] !== 'temporada' || partes.length < 3) return null;

  const sufijo = partes[partes.length - 1];
  const temporada = partes.slice(1, -1).join('-');
  const plantilla = CATALOGO.temporada[sufijo];

  return plantilla ? { temporada, sufijo, ...plantilla } : null;
}

/** Lo que hay que pintar de una insignia, sea del catalogo o de temporada. */
function describir(clave) {
  const fija = CATALOGO.insignias[clave];
  if (fija) return { clave, ...fija };

  const temporada = deTemporada(clave);
  if (temporada) {
    return {
      clave,
      titulo: `${temporada.titulo} ${temporada.temporada}`,
      descripcion: `${temporada.descripcion} ${temporada.temporada}.`,
      modo: 'temporada',
      icono: temporada.icono,
    };
  }

  // Una insignia que nadie sabe describir. Antes esto devolvia null y el perfil
  // pintaba un hueco: la insignia estaba concedida y era invisible.
  return {
    clave,
    titulo: clave,
    descripcion: 'Insignia antigua.',
    modo: 'otro',
    icono: 'comprobado',
  };
}

module.exports = { cumplidas, nuevas, derivados, describir, deTemporada, CATALOGO };
