/**
 * La ficha publica de un clan: su mapa, escudo, nombre, lema, barrio,
 * presentacion, cifras y quien va delante. Se abre al tocar un clan en el mapa
 * o en el ranking, y su cabecera es tambien la vista previa mientras el lider
 * lo crea o lo personaliza: lo que se ve al editar es lo que vera todo el mundo.
 *
 * Lo que cuesta abrirla: el documento del clan (publico) y su agregado
 * `agregados/clan-{id}` (los nombres de la plantilla). Dos lecturas.
 */

import { db, doc, getDoc } from '/assets/js/firebase.js';
import { el, icono, reemplazar, abrirHoja, esqueleto } from '/assets/js/dom.js';
import { miles } from '/assets/js/ui.js';
import { escudoClan, lemaSeguro, MAX_PRESENTACION, MAX_ZONA } from '/assets/js/escudo-clan.js';
import { mapaClan } from '/assets/js/mapa-clan.js';

/** Texto plano de la base de datos, con tope y sin enlaces (o vacio). */
const textoSeguro = (t, tope) => lemaSeguro(t, tope);

/**
 * La cabecera: arriba, su trozo de Madrid (mapa-clan.js); debajo, el escudo
 * montado sobre el mapa, el nombre, el lema y el barrio. Todo entra por
 * `textContent`.
 *
 * @param {object} clan
 * @param {object} [o]
 * @param {boolean} [o.previa]  la de los editores: mas baja
 * @param {Array<string>} [o.suyas]  estaciones que controla
 * @param {Array<string>} [o.foco]   donde mirar si no controla ninguna
 */
export function cabeceraClan(clan = {}, { previa = false, suyas = [], foco = [] } = {}) {
  const lema = textoSeguro(clan.descripcion, 80);
  const zona = textoSeguro(clan.zona, MAX_ZONA);
  return el('div', { clase: `ficha-clan-cabeza${previa ? ' previa' : ''}` }, [
    mapaClan({ color: clan.color, tema: clan.tema, suyas, foco }),
    el('div', { clase: 'ficha-clan-identidad' }, [
      escudoClan(clan, { clase: 'escudo-clan enorme', tam: previa ? 28 : 34 }),
      el('div', { clase: 'ficha-clan-textos' }, [
        el('h2', { clase: 'ficha-clan-nombre', texto: clan.nombre || 'Tu clan' }),
        lema
          ? el('p', { clase: 'ficha-clan-lema', texto: lema })
          : previa ? el('p', { clase: 'ficha-clan-lema sin-lema', texto: 'Sin lema todavía' }) : null,
      ]),
    ]),
    zona ? el('span', { clase: 'chip-clan ficha-clan-zona' }, [icono('pin', 'icono peq'), el('span', { texto: zona })]) : null,
  ]);
}

/**
 * Abre la ficha de un clan.
 *
 * @param {string} clanId
 * @param {object} [o]
 * @param {Array<string>} [o.suyas]  estaciones que controla (las sabe el mapa)
 * @param {number|null} [o.puesto]      en el ranking de clanes
 * @param {'mio'|'pedir'|null} [o.accion]  que boton lleva abajo
 * @param {Function} [o.alPedir]        pedir entrar (lo pone quien sabe hacerlo)
 */
export async function abrirFichaClan(clanId, { suyas = [], puesto = null, accion = null, alPedir = null } = {}) {
  const cuerpo = el('div', { clase: 'ficha-clan' }, esqueleto(3, 90));
  const { cerrar } = abrirHoja([cuerpo], { etiqueta: 'Clan', clase: 'dialogo-escritorio hoja-ficha-clan' });

  let datos = null;
  let publicado = {};
  try {
    const [documento, agregado] = await Promise.all([
      getDoc(doc(db, 'clanes', clanId)),
      getDoc(doc(db, 'agregados', `clan-${clanId}`)).catch(() => null),
    ]);
    datos = documento.exists() ? documento.data() : null;
    publicado = agregado?.exists() ? agregado.data() : {};
  } catch (error) {
    console.debug('No se ha podido leer el clan', error);
  }

  if (!datos) {
    reemplazar(cuerpo, el('div', { clase: 'vacio-rayas' }, [
      el('strong', { texto: 'Este clan ya no existe' }),
      el('span', { texto: 'Puede que se haya disuelto.' }),
    ]));
    return;
  }

  const clan = { ...datos, nombre: datos.nombre || clanId };
  const presentacion = textoSeguro(datos.presentacion, MAX_PRESENTACION);
  const miembros = (datos.miembros || []).length;
  const cabecilla = (publicado.miembros || []).slice(0, 5);
  const lider = (publicado.miembros || []).find((m) => m.uid === datos.lider)?.nombre;

  reemplazar(cuerpo, [
    cabeceraClan(clan, { suyas }),
    presentacion ? el('p', { clase: 'ficha-clan-presentacion', texto: presentacion }) : null,
    el('div', { clase: 'cifras-tres' }, [
      el('div', {}, [el('strong', { texto: String(miembros) }), el('span', { texto: miembros === 1 ? 'miembro' : 'miembros' })]),
      el('div', {}, [el('strong', { texto: miles(datos.biciRating || 0) }), el('span', { texto: 'BiciRating' })]),
      el('div', {}, [
        el('strong', { texto: String(suyas.length) }),
        el('span', { texto: puesto ? `estaciones · ${puesto}.º` : 'estaciones' }),
      ]),
    ]),
    cabecilla.length ? el('section', { clase: 'plantilla' }, [
      el('div', { clase: 'hoy-seccion' }, [el('h3', { texto: 'Plantilla' }), lider ? el('span', { texto: `Líder: ${lider}` }) : null]),
      ...cabecilla.map((m) => el('div', { clase: 'fila-miembro' }, [
        el('span', { clase: 'avatar-mini', texto: [...(m.nombre || 'P')][0].toUpperCase() }),
        el('span', { clase: 'quien' }, [
          el('span', { clase: 'nombre', texto: m.nombre }),
          el('span', { clase: 'clan', texto: m.uid === datos.lider ? 'Líder' : (datos.oficiales || []).includes(m.uid) ? 'Oficial' : 'Miembro' }),
        ]),
        el('strong', { clase: 'valor', texto: miles(m.puntos || 0) }),
      ])),
      miembros > cabecilla.length ? el('span', { clase: 'apagado ficha-clan-mas', texto: `y ${miembros - cabecilla.length} más` }) : null,
    ]) : null,
    accion === 'mio'
      ? el('span', { clase: 'chip-clan ficha-clan-tuyo', texto: 'Es tu clan' })
      : accion === 'pedir' && alPedir
        ? el('button', {
          clase: 'btn', texto: (datos.solicitudes || []).length >= 100 ? 'Cola llena' : 'Pedir entrar',
          attrs: { type: 'button', disabled: (datos.solicitudes || []).length >= 100 ? '' : null },
          on: { click: async (ev) => { ev.currentTarget.disabled = true; cerrar(); await alPedir(clanId); } },
        })
        : null,
  ]);
}
