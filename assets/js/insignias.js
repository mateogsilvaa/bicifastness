/**
 * Vitrina de insignias (#24).
 *
 * Sustituye a `insignias.js` y `cinsignias.js`, que vivian en la raiz, eran el
 * mismo diccionario copiado dos veces y pintaban `<i class="fi fi-rr-home">`:
 * clases de una fuente de iconos que ninguna pagina carga ya y que la CSP no
 * admitiria. Se veian como cajas vacias.
 *
 * El catalogo sale de `assets/data/insignias.js`, generado desde la misma
 * fuente que usa el worker. Aqui no se decide quien gana que: eso lo hace el
 * worker y solo el worker.
 */

import { el, icono } from './dom.js';
import { INSIGNIAS, TEMPORADA } from '../data/insignias.js';

const MODOS = {
  fondo: 'Fondo',
  sprint: 'Sprint',
  constancia: 'Constancia',
  exploracion: 'Exploracion',
  temporada: 'Temporada',
  clan: 'Clan',
  otro: 'Otras',
};

/**
 * Descompone una insignia de temporada: `temporada-2026-07-oro`.
 *
 * Las de temporada no se pueden listar una a una porque cambian cada mes. Antes
 * el cierre de temporada las concedia con un id que no estaba en ningun
 * diccionario, asi que el perfil no pintaba nada: se concedian y no se veian.
 */
function deTemporada(clave) {
  const partes = String(clave).split('-');
  if (partes[0] !== 'temporada' || partes.length < 3) return null;

  const sufijo = partes[partes.length - 1];
  const plantilla = TEMPORADA[sufijo];
  if (!plantilla) return null;

  const temporada = partes.slice(1, -1).join('-');
  return {
    titulo: `${plantilla.titulo} ${temporada}`,
    descripcion: `${plantilla.descripcion} ${temporada}.`,
    modo: 'temporada',
    icono: plantilla.icono,
  };
}

/** Lo que hay que pintar de una insignia concedida. */
export function describir(clave) {
  return INSIGNIAS[clave]
    || deTemporada(clave)
    // Una insignia que nadie sabe describir se pinta igual, con su clave. Antes
    // devolvia null y se pintaba un hueco: concedida e invisible.
    || { titulo: clave, descripcion: 'Insignia antigua.', modo: 'otro', icono: 'comprobado' };
}

function ficha(datos, conseguida) {
  return el('div', {
    clase: 'fila',
    titulo: datos.descripcion,
    estilo: {
      gap: 'var(--e3)',
      padding: 'var(--e3)',
      border: 'var(--borde)',
      borderRadius: 'var(--radio)',
      // Las no conseguidas se ven, pero apagadas. Ensenarlas es el objetivo:
      // una vitrina que solo muestra lo que ya tienes no invita a nada.
      opacity: conseguida ? '1' : '.45',
    },
  }, [
    icono(datos.icono),
    el('div', {}, [
      el('div', { texto: datos.titulo, estilo: { fontWeight: '700' } }),
      el('div', { clase: 'menor apagado', texto: datos.descripcion }),
    ]),
    // El estado no puede ser solo la opacidad: quien no distingue bien los
    // grises, o usa un lector de pantalla, se queda sin saber cuales tiene.
    conseguida
      ? el('span', { clase: 'chip verificado', texto: 'Conseguida' })
      : el('span', { clase: 'chip', texto: 'Pendiente' }),
  ]);
}

/**
 * Todas las insignias, las conseguidas primero y agrupadas por modo.
 *
 * Agrupar por modo importa: es lo que hace visible que el juego tiene tres
 * formas de jugarse. Un fondista que solo ve medallas de sprint concluye que
 * esto no es para el.
 */
export function generarNodosInsignias(logros) {
  const tiene = new Set(Array.isArray(logros) ? logros : []);

  // Las de temporada solo existen si se han ganado: no tiene sentido enseñar
  // "oro de julio" como objetivo pendiente cuando julio ya paso.
  const concedidasSueltas = [...tiene].filter((clave) => !INSIGNIAS[clave]);

  const porModo = new Map();
  const anadir = (clave, datos, conseguida) => {
    const modo = datos.modo || 'otro';
    if (!porModo.has(modo)) porModo.set(modo, []);
    porModo.get(modo).push({ clave, datos, conseguida });
  };

  for (const [clave, datos] of Object.entries(INSIGNIAS)) anadir(clave, datos, tiene.has(clave));
  for (const clave of concedidasSueltas) anadir(clave, describir(clave), true);

  const nodos = [];
  for (const [modo, etiqueta] of Object.entries(MODOS)) {
    const grupo = porModo.get(modo);
    if (!grupo?.length) continue;

    grupo.sort((a, b) => Number(b.conseguida) - Number(a.conseguida));

    nodos.push(el('div', { clase: 'pila', estilo: { marginBottom: 'var(--e5)' } }, [
      el('p', { clase: 'etiqueta', texto: `${etiqueta} · ${grupo.filter((g) => g.conseguida).length}/${grupo.length}` }),
      ...grupo.map(({ datos, conseguida }) => ficha(datos, conseguida)),
    ]));
  }

  return nodos;
}
