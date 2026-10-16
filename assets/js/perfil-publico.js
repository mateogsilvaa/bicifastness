/**
 * La ficha publica de un piloto: banner, foto, nombre, lema, liga, cifras y
 * logros. Es lo que ve cualquiera al tocar un nombre en el ranking, y lo que
 * ves tu en Tu > Perfil publico mientras eliges banner y lema.
 *
 * Aqui no se lee nada: todo llega por argumento (como en `yo-vistas.js`), asi
 * que la misma ficha sirve para las dos pantallas y se puede probar sin red.
 */

import { el, icono } from './dom.js';
import { chipDivision, emblemaLiga, NIVELES } from './ligas.js';
import { INSIGNIAS, TEMPORADA } from '../data/insignias.js';
import { LEMAS, imagenBanner } from '../data/recompensas.js';

/** Un color de clan solo entra si es un hex de verdad: llega de la base de datos. */
const colorSeguro = (c) => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : null);

/** El banner, como fondo. Lo que no este en el catalogo cae al de serie. */
export function banner(id, { clase = '' } = {}) {
  return el('div', {
    clase: `banner-piloto ${clase}`.trim(),
    attrs: { 'aria-hidden': 'true' },
    estilo: { backgroundImage: `url("${imagenBanner(id)}")` },
  });
}

/**
 * Un lema, pintado con su estilo (`.lema-{estilo}` en app.css). Nunca entre
 * comillas: cada uno lleva su forma, y algunos se mueven.
 *
 * Todo el texto entra por `textContent`; los estilos solo reparten ese texto en
 * trozos para poder animarlos por separado.
 *
 * @param {string} id
 * @param {object} [o]
 * @param {string|null} [o.colorClan]  para el estilo `clan`
 * @param {boolean} [o.quieto]  sin movimiento (listas de bloqueados)
 */
export function lema(id, { colorClan = null, quieto = false } = {}) {
  const datos = LEMAS[id];
  if (!datos) return null;
  const nodo = el('span', { clase: `lema lema-${datos.estilo}${quieto ? ' quieto' : ''}` });
  const color = colorSeguro(colorClan);
  if (color) nodo.style.setProperty('--color-clan', color);

  const parte = (clase, texto) => el('span', { clase, texto });
  const texto = datos.texto;
  // "Principal (aparte)": el aparte va en pequeño y, segun el estilo, aparece despues.
  const aparte = /^(.*?)\s*\((.+)\)$/.exec(texto);

  if (datos.estilo === 'cuestas') {
    // Cada palabra un escalon mas arriba.
    texto.split(' ').forEach((palabra, i) => {
      const w = parte('escalon', palabra);
      w.style.setProperty('--i', String(i));
      nodo.append(w, ' ');
    });
  } else if (datos.estilo === 'amor') {
    // Las erres del final se estiran.
    const cola = /r{2,}$/.exec(texto)?.[0] || '';
    nodo.append(parte('base', texto.slice(0, texto.length - cola.length)), cola ? parte('erres', cola) : '', parte('corazon', ''));
  } else if (aparte && (datos.estilo === 'mentira' || datos.estilo === 'sello')) {
    nodo.append(parte('principal', aparte[1]), ' ', parte('aparte', `(${aparte[2]})`));
  } else {
    nodo.append(parte('principal', texto));
  }
  nodo.title = texto;
  return nodo;
}

/**
 * La cabecera: banner, avatar montado encima, nombre, lema y chips.
 *
 * @param {object} p
 * @param {string} p.nombre
 * @param {HTMLElement} p.avatar  el avatar ya creado (la foto llega aparte)
 * @param {string|null} p.banner
 * @param {string|null} p.lema
 * @param {string|null} p.clan  nombre del clan
 * @param {string|null} [p.colorClan]  su color (el lema `clan` lo usa)
 * @param {string|null} p.division
 * @param {string|null} p.liga  "Plata · grupo 4" o null
 */
export function cabeceraPiloto({ nombre, avatar, banner: idBanner, lema: idLema, clan, colorClan, division, liga, detalle }) {
  avatar.classList.add('avatar-ficha');
  return el('div', { clase: 'ficha-publica' }, [
    banner(idBanner),
    el('div', { clase: 'ficha-publica-cuerpo' }, [
      avatar,
      el('h2', { clase: 'ficha-publica-nombre', texto: nombre }),
      idLema ? el('p', { clase: 'ficha-publica-lema' }, [lema(idLema, { colorClan })]) : null,
      el('div', { clase: 'ficha-publica-chips' }, [
        division ? chipDivision(division, liga) : null,
        el('span', { clase: 'chip-clan', texto: clan || 'Sin clan' }),
      ]),
      detalle ? el('span', { clase: 'apagado ficha-publica-detalle', texto: detalle }) : null,
    ]),
  ]);
}

/** El color del clan en el avatar, si es un color valido. */
export function colorAvatar(avatar, color) {
  const c = colorSeguro(color);
  if (c) avatar.style.background = c;
  return avatar;
}

/** Cifras en rejilla de tres: `[['Puesto', '12.º'], ...]`. */
export function cifrasPiloto(cifras) {
  return el('div', { clase: 'cifras-piloto' }, cifras.map(([t, v]) => el('div', {}, [
    el('span', { texto: t }), el('strong', { texto: v }),
  ])));
}

/**
 * Los logros conseguidos, de lo mas reciente y dificil a lo mas facil: las de
 * temporada primero (la ultima arriba), luego las del catalogo de mayor a
 * menor. Lo desconocido se ignora.
 */
export function logrosOrdenados(logros = []) {
  const tiene = new Set(logros);
  const temporada = logros
    .map((clave) => {
      const partes = String(clave).split('-');
      if (partes[0] !== 'temporada' || partes.length < 3) return null;
      const plantilla = TEMPORADA[partes[partes.length - 1]];
      return plantilla ? { clave, orden: partes.slice(1, -1).join('-'), ...plantilla } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.orden.localeCompare(a.orden));
  const catalogo = Object.entries(INSIGNIAS).filter(([k]) => tiene.has(k)).reverse()
    .map(([clave, ins]) => ({ clave, ...ins }));
  return [...temporada, ...catalogo];
}

/** La rejilla de logros. Con `max`, los primeros y "y N mas". */
export function logrosPiloto(logros = [], { max = 9 } = {}) {
  const lista = logrosOrdenados(logros);
  if (!lista.length) return el('p', { clase: 'menor apagado', texto: 'Todavía no tiene insignias.' });
  const vistas = lista.slice(0, max);
  return el('div', {}, [
    el('div', { clase: 'insignias-rejilla logros-publicos' }, vistas.map((ins) => el('div', {
      clase: 'insignia conseguida', titulo: ins.descripcion,
    }, [
      el('span', { clase: `disco${ins.modo === 'liga' ? ' con-emblema' : ''}` }, [
        ins.modo === 'liga' && ins.regla ? emblemaLiga(NIVELES[(ins.regla.minimo || 1) - 1], { tamano: 30 }) : icono(ins.icono || 'medalla'),
      ]),
      el('span', { clase: 'titulo', texto: ins.titulo }),
    ]))),
    lista.length > max ? el('p', { clase: 'menor apagado logros-mas', texto: `y ${lista.length - max} más` }) : null,
  ]);
}

/** El esqueleto de la ficha, mientras llegan los datos. */
export function fichaCargando() {
  return el('div', { clase: 'pila-esqueleto', attrs: { 'aria-hidden': 'true' } }, [
    el('div', { clase: 'esqueleto', estilo: { height: '120px', borderRadius: '20px' } }),
    el('div', { clase: 'esqueleto redondo', estilo: { width: '84px', height: '84px', marginTop: '-54px', marginLeft: '16px', border: '4px solid var(--papel-2)' } }),
    el('div', { clase: 'esqueleto', estilo: { height: '26px', width: '55%' } }),
    el('div', { clase: 'esqueleto', estilo: { height: '16px', width: '40%' } }),
    el('div', { clase: 'esqueleto', estilo: { height: '150px' } }),
    el('div', { clase: 'esqueleto', estilo: { height: '180px' } }),
  ]);
}
