/**
 * La ficha publica de un clan (16 Clanes, 16g oscuro, 16h claro y 16l en el
 * ordenador) y las cabeceras que la anticipan mientras se crea o se edita.
 *
 * La cabecera no es un banner: es el trozo de Madrid que controla el clan
 * (mapa-clan.js). El tema del CLAN pinta toda la ficha, no solo el mapa, con
 * independencia del tema claro u oscuro de la app.
 *
 * Lo que cuesta abrirla: el documento del clan (publico) y su agregado
 * `agregados/clan-{id}` (los nombres de la plantilla). Dos lecturas.
 */

import { db, doc, getDoc } from '/assets/js/firebase.js';
import { el, icono, reemplazar, avisar } from '/assets/js/dom.js';
import { miles } from '/assets/js/ui.js';
import { escudoClan, lemaSeguro, colorSeguroClan, MAX_PRESENTACION, MAX_ZONA } from '/assets/js/escudo-clan.js';
import { mapaClan, TEMAS } from '/assets/js/mapa-clan.js';

/** Los colores de cada tema que hacen falta fuera del CSS (el aro del escudo). */
export const COLORES_TEMA = {
  oscuro: { fondo: '#0E0F10', tarjeta: '#18191B' },
  claro: { fondo: '#F3F1EC', tarjeta: '#FFFFFF' },
};
export const temaDe = (clan) => (TEMAS[clan?.tema] ? clan.tema : 'oscuro');

const texto = (t, tope) => lemaSeguro(t, tope);
const esEscritorio = () => window.matchMedia('(min-width: 900px)').matches;

/**
 * La tarjeta de vista previa (16e, 16i): mapa, escudo con aro, nombre y lema.
 *
 * @param {object} clan
 * @param {object} [o]
 * @param {Array<string>} [o.suyas]   estaciones que controla
 * @param {Array<string>} [o.foco]    sin territorio: las habituales de quien lo crea
 * @param {Array<object>} [o.vecinas] estaciones de otros clanes ({n, color})
 */
export function cabeceraClan(clan = {}, { suyas = [], foco = [], vecinas = [] } = {}) {
  const tema = temaDe(clan);
  const lema = texto(clan.descripcion, 80);
  return el('div', { clase: `previa-clan ${tema}` }, [
    el('div', { clase: `ficha-clan-cabeza previa ${tema}` }, [
      mapaClan({ color: clan.color, tema, suyas, foco, vecinas }),
      !suyas.length && foco.length ? el('span', { clase: 'chip-previa', texto: 'Aún sin territorio · tus estaciones' }) : null,
    ]),
    el('div', { clase: 'ficha-clan-identidad' }, [
      escudoClan(clan, { clase: 'escudo-clan enorme', aro: COLORES_TEMA[tema].tarjeta, grosorAro: 12 }),
      el('span', { clase: 'textos-previa' }, [
        el('strong', { clase: 'ficha-clan-nombre', texto: clan.nombre || 'Tu clan' }),
        el('span', { clase: 'ficha-clan-lema', texto: lema || 'Sin lema todavía' }),
      ]),
    ]),
  ]);
}

/** Una fila de "Los que más suman". */
function filaPlantilla(m, i, { lider, yo }) {
  const nombre = m.uid === yo ? `Tú · ${m.nombre}` : m.nombre;
  return el('div', { clase: 'fila-suman' }, [
    el('span', { clase: 'pos', texto: String(i + 1) }),
    el('span', { clase: 'inicial', texto: [...(m.nombre || 'P')][0].toUpperCase() }),
    el('span', { clase: 'nombre' }, [nombre, m.uid === lider ? el('small', { texto: 'Líder' }) : null]),
    m.puntos != null ? el('strong', { texto: miles(m.puntos || 0) }) : null,
  ]);
}

/**
 * La ficha publica a escala (16k, y editar en el ordenador): lo que vera todo
 * el mundo, mientras se crea o se edita.
 */
export function fichaEscala(clan = {}, { suyas = [], foco = [], vecinas = [], cifras = [], plantilla = [], miembros = 1, lider = null, yo = null } = {}) {
  const tema = temaDe(clan);
  const lema = texto(clan.descripcion, 80);
  const zona = texto(clan.zona, MAX_ZONA);
  return el('div', { clase: `ficha-escala ficha-clan ${tema}` }, [
    el('div', { clase: `ficha-clan-cabeza escala ${tema}` }, [
      mapaClan({ color: clan.color, tema, suyas, foco, vecinas, ancho: 440 }),
      el('span', { clase: 'chip-previa izquierda', texto: 'Vista previa · así te verán' }),
    ]),
    el('div', { clase: 'ficha-clan-identidad' }, [escudoClan(clan, { clase: 'escudo-clan enorme', aro: COLORES_TEMA[tema].fondo })]),
    el('div', { clase: 'ficha-clan-textos' }, [
      el('span', { clase: 'ficha-clan-nombre', texto: clan.nombre || 'Tu clan' }),
      lema ? el('span', { clase: 'ficha-clan-lema', texto: lema }) : null,
      zona ? el('span', { clase: 'ficha-clan-zona' }, [icono('pin', 'icono'), zona]) : null,
    ]),
    el('div', { clase: 'ficha-clan-cifras' }, cifras.map(([v, t]) => el('div', {}, [el('strong', { texto: v }), el('span', { texto: t })]))),
    el('div', { clase: 'cabeza-suman' }, [el('span', { texto: 'Los que más suman' }), el('small', { texto: `${miembros} ${miembros === 1 ? 'miembro' : 'miembros'}` })]),
    ...plantilla.slice(0, 5).map((m, i) => filaPlantilla(m, i, { lider, yo })),
    el('span', { clase: 'relleno' }),
    el('span', { clase: 'boton-falso', texto: 'Pedir entrar', attrs: { 'aria-hidden': 'true' } }),
  ]);
}

/**
 * Una capa de los clanes (crear, editar, ficha, clan fundado): a pantalla
 * completa en el movil, dialogo sobre el mapa en el ordenador. Escape y el
 * velo cierran (o preguntan, con `alEscape`).
 */
export function abrirCapa(contenido, { etiqueta, clase, alCerrar = null, alEscape = null }) {
  const antes = document.activeElement;
  const velo = el('div', { clase: 'velo-clan' });
  const capa = el('div', { clase, attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': etiqueta, tabindex: '-1' } }, contenido);
  let cerrada = false;
  const cerrar = () => {
    if (cerrada) return;
    cerrada = true;
    velo.remove();
    capa.remove();
    document.removeEventListener('keydown', teclas);
    if (antes && typeof antes.focus === 'function') antes.focus();
    alCerrar?.();
  };
  // Con una hoja de confirmar encima, Escape es de ella.
  const teclas = (e) => { if (e.key === 'Escape' && !document.querySelector('.hoja')) (alEscape || cerrar)(); };
  velo.addEventListener('click', () => (alEscape || cerrar)());
  document.addEventListener('keydown', teclas);
  document.body.append(velo, capa);
  capa.focus();
  return { capa, cerrar };
}

/**
 * Abre la ficha de un clan.
 *
 * @param {string} clanId
 * @param {object} [o]
 * @param {Array<string>} [o.suyas]    estaciones que controla (las sabe el mapa)
 * @param {Array<object>} [o.vecinas]  estaciones de otros clanes ({n, color})
 * @param {number|null} [o.puesto]     en el ranking de clanes
 * @param {number|null} [o.total]      clanes en el ranking
 * @param {string|null} [o.yo]         uid de quien mira
 * @param {boolean} [o.puedePedir]     tiene sesion y no tiene clan
 * @param {Function} [o.alPedir]       pedir entrar
 * @param {Function} [o.alEditar]      el lapiz del lider
 */
export async function abrirFichaClan(clanId, {
  suyas = [], vecinas = [], puesto = null, total = null, yo = null, puedePedir = false, alPedir = null, alEditar = null,
} = {}) {
  const { capa, cerrar } = abrirCapa([el('div', { clase: 'esqueleto ficha-clan-carga', attrs: { 'aria-hidden': 'true' } })], { etiqueta: 'Clan', clase: 'ficha-clan oscuro capa-ficha-clan' });

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

  // En el movil se vuelve con la flecha (16g); en el ordenador, la X arriba a la derecha (16l).
  const volver = el('button', { clase: 'boton-capa volver', attrs: { type: 'button', 'aria-label': esEscritorio() ? 'Cerrar' : 'Volver' }, on: { click: cerrar } }, [icono(esEscritorio() ? 'cerrar' : 'atras', 'icono')]);
  if (!datos) {
    reemplazar(capa, [el('div', { clase: 'barra-ficha' }, [volver]), el('div', { clase: 'vacio-rayas' }, [
      el('strong', { texto: 'Este clan ya no existe' }),
      el('span', { texto: 'Puede que se haya disuelto.' }),
    ])]);
    return;
  }

  const clan = { ...datos, nombre: datos.nombre || clanId };
  const tema = temaDe(clan);
  capa.className = `ficha-clan ${tema} capa-ficha-clan`;
  capa.style.setProperty('--color-clan', colorSeguroClan(clan.color) || '#8A8F98');

  const lema = texto(datos.descripcion, 80);
  const zona = texto(datos.zona, MAX_ZONA);
  const presentacion = texto(datos.presentacion, MAX_PRESENTACION);
  const miembros = (datos.miembros || []).length;
  const plantilla = publicado.miembros || [];
  const km = Math.round(plantilla.reduce((t, m) => t + (m.metros || 0), 0) / 1000);
  const esLider = Boolean(yo) && datos.lider === yo;
  const esMiembro = Boolean(yo) && (datos.miembros || []).includes(yo);
  const pedida = Boolean(yo) && (datos.solicitudes || []).includes(yo);

  const compartir = el('button', { clase: 'boton-capa', attrs: { type: 'button', 'aria-label': 'Compartir el clan' } }, [icono('compartir', 'icono')]);
  compartir.addEventListener('click', async () => {
    const url = `${window.location.origin}/territorio/?clan=${encodeURIComponent(clanId)}`;
    if (navigator.share) {
      try { await navigator.share({ title: clan.nombre, url }); } catch { /* cancelado */ }
    } else {
      try { await navigator.clipboard.writeText(url); avisar('Enlace copiado.', 'exito'); } catch { /* sin permiso */ }
    }
  });
  const editar = esLider && alEditar
    ? el('button', { clase: 'boton-capa', attrs: { type: 'button', 'aria-label': 'Editar el clan' }, on: { click: () => { cerrar(); alEditar(); } } }, [icono('lapiz', 'icono')])
    : null;

  // "Pedir entrar" / "Solicitud enviada" / nada si ya eres de dentro.
  const boton = () => {
    if (esMiembro) return null;
    if (pedida) return el('button', { clase: 'btn', texto: 'Solicitud enviada', attrs: { type: 'button', disabled: '' } });
    if (!puedePedir || !alPedir) return null;
    return el('button', {
      clase: 'btn', texto: 'Pedir entrar', attrs: { type: 'button' },
      on: { click: async (ev) => { ev.currentTarget.disabled = true; cerrar(); await alPedir(clanId); } },
    });
  };

  const cifras = [
    [String(suyas.length), suyas.length === 1 ? 'estación' : 'estaciones'],
    [puesto ? `${puesto}.º` : '—', total ? `de ${total} clanes` : 'puesto'],
    [miles(datos.biciRating || 0), 'BiciRating'],
    [`${miles(km)} km`, 'en total'],
  ];
  const pie = boton();

  reemplazar(capa, [
    el('div', { clase: `ficha-clan-cabeza ${tema}` }, [
      mapaClan({ color: clan.color, tema, suyas, vecinas, ancho: esEscritorio() ? 720 : 390 }),
      el('div', { clase: 'barra-ficha' }, [volver, el('span', { clase: 'acciones' }, [editar, compartir])]),
      el('span', { clase: 'territorio-clan', texto: [`${suyas.length} ${suyas.length === 1 ? 'estación' : 'estaciones'}`, zona].filter(Boolean).join(' · ') }),
    ]),
    el('div', { clase: 'ficha-clan-identidad' }, [
      escudoClan(clan, { clase: 'escudo-clan enorme', aro: COLORES_TEMA[tema].fondo }),
      el('div', { clase: 'ficha-clan-titulo' }, [
        el('h2', { clase: 'ficha-clan-nombre', texto: clan.nombre }),
        lema ? el('p', { clase: 'ficha-clan-lema', texto: lema }) : null,
      ]),
      puesto ? el('span', { clase: 'puesto', texto: `${puesto}.º de ${total} clanes` }) : null,
      el('span', { clase: 'boton-identidad' }, [boton()]),
    ]),
    el('div', { clase: 'ficha-clan-cuerpo' }, [
      el('div', { clase: 'columna-datos' }, [
        presentacion ? el('p', { clase: 'ficha-clan-presentacion', texto: presentacion }) : null,
        el('div', { clase: 'ficha-clan-cifras' }, cifras.map(([v, t], i) => el('div', { clase: i === 1 ? 'cifra-puesto' : '' }, [el('strong', { texto: v }), el('span', { texto: t })]))),
      ]),
      el('div', { clase: 'columna-plantilla' }, [
        el('div', { clase: 'cabeza-suman' }, [el('span', { texto: 'Los que más suman' }), el('small', { texto: `${miembros} ${miembros === 1 ? 'miembro' : 'miembros'}` })]),
        ...plantilla.slice(0, 5).map((m, i) => filaPlantilla(m, i, { lider: datos.lider, yo })),
      ]),
    ]),
    pie ? el('div', { clase: 'ficha-clan-pie' }, [pie]) : null,
  ]);
}
