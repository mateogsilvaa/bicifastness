/**
 * Las redes sociales de cada piloto, en su ficha publica.
 *
 * Se guarda SOLO el nombre de usuario de cada red, nunca una URL: el enlace se
 * monta aqui con un dominio fijo. Asi nadie puede colar en su ficha un enlace a
 * cualquier sitio, y las reglas (`vitrinas/{nombre}`) comprueban el mismo
 * patron que `REDES[x].patron`, de modo que lo que no pase aqui tampoco pasa alli.
 */

import { el, icono } from './dom.js';

export const REDES = {
  instagram: { nombre: 'Instagram', patron: /^[A-Za-z0-9._]{1,30}$/, url: (u) => `https://www.instagram.com/${u}/` },
  tiktok: { nombre: 'TikTok', patron: /^[A-Za-z0-9._]{2,24}$/, url: (u) => `https://www.tiktok.com/@${u}` },
  strava: { nombre: 'Strava', patron: /^[0-9]{1,12}$/, url: (u) => `https://www.strava.com/athletes/${u}`, ayuda: 'El número de tu perfil de atleta' },
  x: { nombre: 'X', patron: /^[A-Za-z0-9_]{1,15}$/, url: (u) => `https://x.com/${u}` },
};

/** De lo que escribe la persona (con @, o pegando el enlace) al nombre a secas. */
export function limpiarUsuario(red, texto) {
  let t = String(texto || '').trim();
  if (!t) return '';
  if (red === 'strava') {
    const m = t.match(/athletes\/(\d+)/);
    if (m) return m[1];
  } else {
    const m = t.match(/(?:instagram\.com|tiktok\.com|x\.com|twitter\.com)\/@?([A-Za-z0-9._]+)/i);
    if (m) t = m[1];
  }
  return t.replace(/^@/, '').replace(/\/+$/, '');
}

/** Solo las redes que conocemos y con un nombre valido: llegan de la base de datos. */
export function redesValidas(redes) {
  const fuera = {};
  if (!redes || typeof redes !== 'object') return fuera;
  for (const [red, datos] of Object.entries(REDES)) {
    if (typeof redes[red] === 'string' && datos.patron.test(redes[red])) fuera[red] = redes[red];
  }
  return fuera;
}

/** Los enlaces de la ficha. `null` si no tiene ninguna. */
export function enlacesRedes(redes) {
  const validas = Object.entries(redesValidas(redes));
  if (!validas.length) return null;
  return el('div', { clase: 'redes-piloto' }, validas.map(([red, usuario]) => el('a', {
    clase: 'red-piloto',
    attrs: {
      href: REDES[red].url(usuario), target: '_blank', rel: 'noopener noreferrer nofollow ugc',
      'aria-label': `${REDES[red].nombre} de ${usuario}`,
    },
  }, [icono('enlace'), el('span', { texto: REDES[red].nombre })])));
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "Desde marzo de 2026". Acepta un Timestamp de Firestore, una fecha o un texto ISO. */
export function textoDesde(desde) {
  const fecha = desde?.toDate ? desde.toDate() : desde ? new Date(desde) : null;
  if (!fecha || Number.isNaN(fecha.getTime())) return null;
  return `En BiciFastness desde ${MESES[fecha.getMonth()]} de ${fecha.getFullYear()}`;
}
