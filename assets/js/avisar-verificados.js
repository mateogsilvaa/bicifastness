/**
 * Al entrar: "se ha verificado tu viaje". Para los viajes que se verificaron
 * con la app cerrada (la verificacion tarda unos minutos y casi nadie espera
 * mirando), con la opcion de omitirlo o de ver el calculo de la puntuacion: la
 * misma pantalla que sale al abrir el viaje en el historial.
 *
 * Cada viaje se avisa UNA vez. Lo ya avisado (o celebrado en el acto, con la
 * app abierta) se apunta en este dispositivo. La primera vez que corre no se
 * avisa nada: se marcan como vistos los que ya habia, para no sacar de golpe
 * los viajes de hace meses.
 *
 * Coste: una consulta de hasta 5 documentos, una vez por sesion.
 */

import { db, collection, query, where, orderBy, limit, getDocs } from './firebase.js';
import { el, icono, abrirHoja } from './dom.js';
import { formatearTiempo } from './ui.js';
import { abrirVerificado, tramoDe } from './veredicto.js';

const CLAVE = 'bf_verificados_vistos';
const CLAVE_SESION = 'bf_verificados_mirado';
const MAX_RECORDADOS = 60;

function leerVistos() {
  try {
    const crudo = localStorage.getItem(CLAVE);
    return crudo === null ? null : new Set(JSON.parse(crudo));
  } catch {
    return null;
  }
}

function guardarVistos(vistos) {
  try { localStorage.setItem(CLAVE, JSON.stringify([...vistos].slice(-MAX_RECORDADOS))); } catch { /* modo privado */ }
}

/** Para quien celebra un viaje en el acto: que no se vuelva a avisar al entrar. */
export function marcarVerificadoVisto(viajeId) {
  if (!viajeId) return;
  const vistos = leerVistos() || new Set();
  vistos.add(viajeId);
  guardarVistos(vistos);
}

/**
 * Mira si hay viajes verificados sin avisar y, si los hay, saca el aviso.
 * @param {string} uid
 * @param {object} [opciones]
 * @param {number} [opciones.racha]  la racha actual, para el desglose
 * @param {() => boolean} [opciones.puede]  si en este momento se puede abrir
 *   (otro dialogo encima, el tutorial...). Se pregunta justo antes de abrir.
 */
export async function avisarVerificados(uid, { racha = 0, puede = () => true } = {}) {
  if (!uid) return;
  try {
    if (sessionStorage.getItem(CLAVE_SESION)) return;
    sessionStorage.setItem(CLAVE_SESION, '1');
  } catch { /* sin sessionStorage: se mira igual */ }

  let viajes;
  try {
    const snap = await getDocs(query(
      collection(db, 'tiempos_viaje'),
      where('uid', '==', uid), where('verificado', '==', true),
      orderBy('creado', 'desc'), limit(5),
    ));
    viajes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (error) {
    console.debug('No se han podido mirar los viajes verificados', error);
    return;
  }

  const vistos = leerVistos();
  if (vistos === null) {
    // Primera vez en este dispositivo: lo de antes no es noticia.
    guardarVistos(new Set(viajes.map((v) => v.id)));
    return;
  }
  const nuevos = viajes.filter((v) => !vistos.has(v.id));
  if (!nuevos.length || !puede()) return;

  const marcar = () => { for (const v of nuevos) vistos.add(v.id); guardarVistos(vistos); };
  marcar();
  abrirAviso(nuevos, racha);
}

function abrirAviso(nuevos, racha) {
  const uno = nuevos.length === 1;
  const puntos = nuevos.reduce((t, v) => t + (v.fueraDeCupo ? 0 : Number(v.puntos) || 0), 0);
  let cerrar = null;
  const ver = (viaje) => { cerrar(); abrirVerificado(viaje, { racha }); };

  ({ cerrar } = abrirHoja([
    el('div', { clase: 'aviso-verificados-icono' }, [icono('check')]),
    el('h2', { texto: uno ? 'Se ha verificado tu viaje' : `Se han verificado ${nuevos.length} viajes` }),
    el('p', {
      clase: 'apagado',
      texto: puntos ? `Has sumado ${puntos} puntos mientras no estabas.` : 'Ya cuentan para tu racha y tus estadísticas.',
    }),
    uno ? null : el('div', { clase: 'aviso-verificados-lista' }, nuevos.map((v) => el('button', {
      clase: 'fila-verificado', attrs: { type: 'button' }, on: { click: () => ver(v) },
    }, [
      el('span', { texto: tramoDe(v.ruta, { corto: true }) }),
      el('span', { clase: 'apagado', texto: formatearTiempo(v.tiempoSegundos) }),
      el('strong', { texto: v.fueraDeCupo ? 'sin puntos' : `+${v.puntos || 0}` }),
      icono('derecha', 'icono peq'),
    ]))),
    el('div', { clase: 'dos-botones-hoja' }, [
      el('button', { clase: 'btn plano', texto: 'Omitir', attrs: { type: 'button' }, on: { click: () => cerrar() } }),
      uno ? el('button', { clase: 'btn', texto: 'Verlo', attrs: { type: 'button' }, on: { click: () => ver(nuevos[0]) } }) : null,
    ]),
  ], { etiqueta: uno ? 'Viaje verificado' : 'Viajes verificados', clase: 'aviso-verificados' }));
}
