// Gestion del clan propio (#29), con la cara de 05 Mapa y clanes (5c-5f) y del
// panel de escritorio (8l).
//
// POR QUE EXISTE ESTE FICHERO. Las doce acciones de clan llevaban escritas en
// `acciones.js` —con sus reglas de Firestore y sus pruebas de regresion— y no
// las llamaba NINGUNA pagina. Va aparte de `paginas/territorio.js` porque el
// mapa es de lectura y esto es de escritura.
//
// DE DONDE SALEN LOS NOMBRES. `usuarios` dejo de ser publica al cerrar la fuga
// de correos (#60): la plantilla llega por `agregados/clan-{id}`, que publica el
// worker con lo que ya es publico en las clasificaciones.

import { db, doc, getDoc, collection, getDocs, query, where, limit } from '/assets/js/firebase.js';
import { id, el, icono, estado, reemplazar, avisar, esqueleto, abrirHoja } from '/assets/js/dom.js';
import { miles } from '/assets/js/ui.js';
import {
  MAX_MIEMBROS,
  crearClan, solicitarEntrada, retirarSolicitud, responderSolicitud,
  expulsarMiembro, cambiarOficial, cederLiderazgo, abandonarClan, disolverClan,
  crearInvitacion, usarInvitacion, confirmarEntrada,
} from '/assets/js/acciones.js';

/** Estado de la pantalla. Se vuelve a leer entero tras cada accion. */
let usuario = null;
let perfil = null;
let clan = null;
let clanId = null;
/** Lo que aporta el mapa: clanes, estaciones, ranking y nombres (getters). */
let contexto = { clanes: () => new Map(), estaciones: () => new Map(), ranking: () => [], nombreDe: (n) => n };

/** Los ocho colores del sistema para un clan (5e). */
export const COLORES_CLAN = ['#FF5A1F', '#E23D8C', '#13A89E', '#8B5CF6', '#E0A800', '#3D8B37', '#8A5A3C', '#5B6470'];

const colorSeguro = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : 'var(--tinta-3)');
const iniciales = (n) => String(n || '').split(/\s+/).filter(Boolean).map((p) => p[0]).join('').slice(0, 3).toUpperCase();
const numero = (n) => miles(n);

export function datosMiClan() { return clan; }

/** Lo que puede hacer quien esta mirando. */
function papel() {
  if (!clan || !usuario) return 'fuera';
  if (clan.lider === usuario.uid) return 'lider';
  if ((clan.oficiales || []).includes(usuario.uid)) return 'oficial';
  return 'miembro';
}
const mandaEnPlantilla = () => ['lider', 'oficial'].includes(papel());

// --- Piezas -------------------------------------------------------------------

/** Un boton que no se puede pulsar dos veces mientras trabaja. */
function boton(contenido, alPulsar, { clase = 'btn secundario', etiqueta = null } = {}) {
  return el('button', {
    clase,
    attrs: { type: 'button', 'aria-label': etiqueta },
    on: {
      click: async (ev) => {
        const b = ev.currentTarget;
        // Dos toques seguidos en un movil lento mandaban la accion dos veces. En
        // "expulsar" da igual; en "ceder el liderazgo" no.
        b.disabled = true;
        try {
          await alPulsar();
        } catch (error) {
          avisar(error.message || 'No se ha podido completar la acción.');
        } finally {
          b.disabled = false;
        }
      },
    },
  }, [].concat(contenido));
}

/** Confirmacion en hoja (5f; en escritorio, dialogo de 480 px). */
function confirmarEnHoja({ rotulo, titulo, texto, aceptar, peligro = false, grave = false, extra = null }) {
  return new Promise((resolver) => {
    let hecho = false;
    const fin = (v) => { if (!hecho) { hecho = true; resolver(v); } };
    const { cerrar } = abrirHoja([
      rotulo ? el('span', { clase: 'rotulo', texto: rotulo }) : null,
      el('h2', { clase: grave ? 'peligro' : '', texto: titulo }),
      el('p', { texto }),
      extra,
      el('div', { clase: 'dos-botones-hoja' }, [
        el('button', { clase: 'btn tonal', texto: 'Cancelar', attrs: { type: 'button' }, on: { click: () => { cerrar(); fin(false); } } }),
        el('button', { clase: `btn ${grave ? 'peligro lleno' : peligro ? 'peligro' : ''}`, texto: aceptar, attrs: { type: 'button' }, on: { click: () => { cerrar(); fin(true); } } }),
      ]),
    ], { etiqueta: titulo, clase: `dialogo-escritorio ${grave ? 'grave' : ''}`, alCerrar: () => fin(false) });
  });
}

// --- 5c · Mi clan ------------------------------------------------------------------

/** Las estaciones de tu clan que estan en juego, de mas a menos riesgo. */
function enAsedio() {
  const estaciones = contexto.estaciones();
  const clanes = contexto.clanes();
  return [...estaciones.entries()]
    .filter(([, s]) => s.enDisputa && s.cuota?.[clanId])
    .map(([n, s]) => {
      const total = Object.values(s.cuota).reduce((t, v) => t + v, 0) || 1;
      const [rivalId, rival] = Object.entries(s.cuota).filter(([c]) => c !== clanId).sort((a, b) => b[1] - a[1])[0] || [];
      return {
        numero: n,
        nombre: contexto.nombreDe(n),
        mio: Math.round((s.cuota[clanId] / total) * 100),
        rival: Math.round(((rival || 0) / total) * 100),
        color: colorSeguro(clanes.get(rivalId)?.color),
      };
    })
    .sort((a, b) => a.mio - b.mio);
}

function filaMiembro(m) {
  const esLider = clan.lider === m.uid;
  const esOficial = (clan.oficiales || []).includes(m.uid);
  const soyYo = m.uid === usuario?.uid;
  const cargo = esLider ? 'Líder' : esOficial ? 'Oficial' : 'Miembro';
  const puedeActuar = (papel() === 'lider' && !esLider) || (mandaEnPlantilla() && !esLider && !soyYo);

  return el('div', { clase: 'fila-miembro' }, [
    el('span', { clase: 'avatar-mini', texto: [...(m.nombre || 'P')][0].toUpperCase() }),
    el('span', { clase: 'quien' }, [
      el('span', { clase: `nombre ${soyYo ? 'tuyo' : ''}`, texto: soyYo ? `Tú · ${m.nombre}` : m.nombre }),
      el('span', { clase: 'clan', texto: `${cargo} · ${m.viajes || 0} trayectos` }),
    ]),
    el('strong', { clase: 'valor', texto: numero(m.puntos) }),
    puedeActuar ? el('button', {
      clase: 'boton-icono', attrs: { type: 'button', 'aria-label': `Opciones sobre ${m.nombre}` },
      on: { click: () => menuMiembro(m, { esLider, esOficial, soyYo }) },
    }, [icono('mas-h')]) : null,
  ]);
}

/** Lo que se puede hacer sobre una persona de la plantilla. */
function menuMiembro(m, { esLider, esOficial, soyYo }) {
  const acciones = [];
  // Al lider no se le expulsa ni se le degrada: primero cede el mando. Si no,
  // un oficial podria dejar el clan sin lider.
  if (papel() === 'lider' && !esLider) {
    acciones.push(boton(esOficial ? 'Quitar de oficial' : 'Hacer oficial', async () => {
      cerrar();
      await cambiarOficial(clanId, m.uid, !esOficial);
      await recargar();
    }));
    acciones.push(boton('Cederle el mando', async () => {
      cerrar();
      const seguro = await confirmarEnHoja({
        titulo: `¿Ceder el mando a ${m.nombre}?`,
        texto: 'Dejarás de poder gestionar el clan y solo esa persona podrá devolvértelo.',
        aceptar: 'Ceder el mando', peligro: true,
      });
      if (!seguro) return;
      await cederLiderazgo(clanId, m.uid);
      await recargar();
    }));
  }
  if (mandaEnPlantilla() && !esLider && !soyYo) {
    acciones.push(boton('Expulsar del clan', async () => {
      cerrar();
      const seguro = await confirmarEnHoja({
        titulo: `¿Expulsar a ${m.nombre}?`, texto: 'Sale del clan en el acto. Su influencia se queda y decae con el tiempo.',
        aceptar: 'Expulsar', peligro: true,
      });
      if (!seguro) return;
      await expulsarMiembro(clanId, m.uid);
      await recargar();
    }, { clase: 'btn peligro' }));
  }
  const { cerrar } = abrirHoja([el('h2', { texto: m.nombre }), ...acciones], { etiqueta: m.nombre, clase: 'dialogo-escritorio' });
}

/** 5d · Quien ha pedido entrar. Solo lo ve quien puede responder. */
function bloqueCandidatos() {
  const candidatos = clan.candidatos || [];
  if (!mandaEnPlantilla() || !candidatos.length) return null;
  return el('section', { clase: 'solicitudes' }, [
    el('div', { clase: 'hoy-seccion' }, [el('h3', { texto: 'Solicitudes' }), el('span', { clase: 'contador-azul', texto: String(candidatos.length) })]),
    ...candidatos.map((c) => el('div', { clase: 'fila-solicitud' }, [
      el('span', { clase: 'avatar-mini grande', texto: [...(c.nombre || 'P')][0].toUpperCase() }),
      el('span', { clase: 'quien' }, [
        el('strong', { texto: c.nombre }),
        el('span', { clase: 'clan', texto: `${c.viajes || 0} trayectos · ${numero(c.puntos)} BiciRating` }),
      ]),
      boton(icono('cerrar'), async () => { await responderSolicitud(clanId, c.uid, false); await recargar(); }, { clase: 'boton-cuadrado', etiqueta: `Rechazar a ${c.nombre}` }),
      boton(icono('check'), async () => { await responderSolicitud(clanId, c.uid, true); await recargar(); }, { clase: 'boton-cuadrado azul', etiqueta: `Aceptar a ${c.nombre}` }),
    ])),
  ]);
}

/** 5d · Invitar: enlace de un solo uso, compartir o copiar. Solo el lider. */
async function abrirInvitacion() {
  const { enlace, caduca } = await crearInvitacion(clanId);
  const campo = el('input', { attrs: { type: 'text', readonly: 'readonly', value: enlace, 'aria-label': 'Enlace de invitación' } });
  const copiar = el('button', {
    clase: 'enlace-boton azul', texto: 'Copiar', attrs: { type: 'button' },
    on: {
      click: async () => {
        try {
          await navigator.clipboard.writeText(enlace);
          copiar.textContent = 'Copiado';
        } catch {
          campo.select(); // sin permiso de portapapeles, al menos queda seleccionado
        }
      },
    },
  });
  const compartir = el('button', { clase: 'btn', attrs: { type: 'button' } }, [icono('compartir', 'icono peq'), el('span', { texto: 'Compartir enlace' })]);
  compartir.addEventListener('click', async () => {
    if (navigator.share) {
      try { await navigator.share({ title: `Únete a ${clan.nombre}`, text: `Entra en ${clan.nombre} en bicifastness`, url: enlace }); } catch { /* cancelado */ }
    } else {
      copiar.click();
    }
  });
  abrirHoja([
    el('h2', { texto: `Invitar a ${clan.nombre}` }),
    el('div', { clase: 'campo-enlace' }, [campo, copiar]),
    el('p', { texto: `El enlace vale una sola vez y caduca el ${caduca.toLocaleDateString('es-ES')}. Quien lo abra entra sin que tengas que aceptarlo.` }),
    compartir,
  ], { etiqueta: `Invitar a ${clan.nombre}`, clase: 'dialogo-escritorio' });
}

/**
 * 5f · Dejar el clan. Tres situaciones distintas, y solo una salida en cada una.
 *
 * `abandonarClan` se niega si eres el lider, asi que ensenarle a un lider el
 * boton de salir es ofrecerle algo que siempre va a fallar.
 */
function bloqueSalida() {
  const soyLider = papel() === 'lider';
  const solo = (clan.miembros || []).length <= 1;

  // Lider con gente dentro: primero cede. Irse dejaria el clan sin nadie que
  // pueda aceptar, expulsar ni disolver.
  if (soyLider && !solo) {
    return async () => {
      const elegir = el('select', { attrs: { id: 'nuevo-lider', 'aria-label': 'Nuevo líder' } },
        clan.miembros.filter((m) => m.uid !== usuario.uid).map((m) => el('option', { texto: m.nombre, attrs: { value: m.uid } })));
      const seguro = await confirmarEnHoja({
        rotulo: 'Líder con plantilla', titulo: 'Antes, cede el mando',
        texto: 'Eres el líder. Elige a alguien de la plantilla antes de irte.',
        extra: elegir, aceptar: 'Ceder y salir',
      });
      if (!seguro) return;
      await cederLiderazgo(clanId, elegir.value);
      await abandonarClan(clanId);
      await recargar();
    };
  }

  // Lider y ultimo: salir no se puede, asi que lo unico es disolver.
  if (soyLider) {
    return async () => {
      const seguro = await confirmarEnHoja({
        rotulo: 'Único miembro', titulo: 'Irte es disolverlo',
        texto: 'Eres el único que queda. El clan desaparece del mapa y del ranking; su nombre queda libre.',
        aceptar: `Disolver ${clan.nombre}`, grave: true,
      });
      if (!seguro) return;
      await disolverClan(clanId);
      await recargar();
    };
  }

  return async () => {
    const seguro = await confirmarEnHoja({
      rotulo: 'Miembro', titulo: `¿Dejar ${clan.nombre}?`,
      texto: 'Tu influencia se queda en el clan y decae con el tiempo. Puedes volver a pedir entrar.',
      aceptar: 'Dejar el clan', peligro: true,
    });
    if (!seguro) return;
    await abandonarClan(clanId);
    await recargar();
  };
}

function pintarConClan(destino) {
  const ranking = contexto.ranking();
  const puesto = ranking.findIndex((c) => c.nombre === clan.nombre) + 1;
  const asedio = enAsedio();
  const salir = bloqueSalida();

  const menu = el('button', { clase: 'boton-cuadrado', attrs: { type: 'button', 'aria-label': 'Más opciones del clan' } }, [icono('mas-h')]);
  menu.addEventListener('click', () => {
    const { cerrar } = abrirHoja([
      el('h2', { texto: clan.nombre }),
      el('button', { clase: 'btn peligro', texto: papel() === 'lider' && clan.miembros.length <= 1 ? 'Disolver el clan' : 'Dejar el clan', attrs: { type: 'button' }, on: { click: () => { cerrar(); salir().catch((e) => avisar(e.message)); } } }),
    ], { etiqueta: 'Opciones del clan', clase: 'dialogo-escritorio' });
  });

  reemplazar(destino, el('div', { clase: 'mi-clan' }, [
    el('div', { clase: 'mi-clan-cabeza' }, [
      el('span', { clase: 'escudo-clan grande', estilo: { background: colorSeguro(clan.color) }, texto: iniciales(clan.nombre) }),
      el('span', { clase: 'datos' }, [
        el('h2', { texto: clan.nombre }),
        el('span', { clase: 'apagado', texto: [`${clan.numMiembros}/${MAX_MIEMBROS} miembros`, `${numero(clan.biciRating)} BiciRating`, puesto ? `${puesto}.º` : null].filter(Boolean).join(' · ') }),
      ]),
    ]),
    clan.descripcion ? el('p', { clase: 'apagado lema', texto: clan.descripcion }) : null,
    bloqueCandidatos(),
    asedio.length ? el('section', { clase: 'asedio' }, [
      el('h3', { texto: 'En asedio' }),
      ...asedio.slice(0, 5).map((a) => el('div', { clase: 'fila-asedio' }, [
        el('span', { clase: 'nombre', texto: a.nombre }),
        el('span', { clase: 'barra-asedio', attrs: { 'aria-hidden': 'true' } }, [
          el('span', { estilo: { width: `${a.mio}%`, background: colorSeguro(clan.color) } }),
          el('span', { estilo: { width: `${a.rival}%`, background: a.color } }),
        ]),
        el('strong', { texto: String(a.mio), attrs: { 'aria-label': `${a.mio} % tuyo` } }),
      ])),
      asedio.length > 5 ? el('span', { clase: 'pista', texto: `y ${asedio.length - 5} más en juego` }) : null,
    ]) : el('p', { clase: 'nota-territorio', texto: 'Ninguna de vuestras estaciones está en juego ahora mismo.' }),
    el('section', { clase: 'plantilla' }, [
      el('div', { clase: 'hoy-seccion' }, [el('h3', { texto: 'Plantilla' }), el('span', { texto: 'BiciRating' })]),
      ...(clan.miembros || []).map(filaMiembro),
    ]),
    el('div', { clase: 'acciones-clan' }, [
      papel() === 'lider'
        ? boton([icono('enlace', 'icono peq'), el('span', { texto: 'Invitar' })], abrirInvitacion, { clase: 'btn secundario' })
        : el('span', { clase: 'apagado menor', texto: 'Para traer a alguien, pídele al líder un enlace.' }),
      menu,
    ]),
  ]));
}

// --- 5e · Sin clan -------------------------------------------------------------------

/** Clanes con estaciones en tus rutas: lo mas facil es entrar en uno de esos. */
function clanesCerca() {
  const mias = new Set();
  for (const ruta of Object.keys(perfil?.puntosPorRuta || {})) for (const e of ruta.split('-')) mias.add(String(Number(e)) === e ? e : e.replace(/^0+/, ''));
  const estaciones = contexto.estaciones();
  const clanes = contexto.clanes();
  const encontrados = new Map();
  for (const n of mias) {
    const s = estaciones.get(n);
    if (s?.clanDominante && !encontrados.has(s.clanDominante)) encontrados.set(s.clanDominante, n);
  }
  const ranking = contexto.ranking();
  const lista = [...encontrados.entries()].map(([cid, n]) => ({ cid, estacion: n, ...clanes.get(cid) }));
  // Sin estaciones en comun, los primeros del ranking.
  if (!lista.length) {
    for (const [cid, c] of clanes) {
      if (lista.length >= 3) break;
      lista.push({ cid, ...c });
    }
  }
  return lista.slice(0, 3).map((c) => ({ ...c, miembros: ranking.find((r) => r.nombre === c.nombre)?.viajes }));
}

function pintarSinClan(destino) {
  const cerca = clanesCerca();
  const usados = new Set(cerca.map((c) => c.color));
  let color = COLORES_CLAN.find((c) => !usados.has(c)) || COLORES_CLAN[0];

  const nombre = el('input', { attrs: { type: 'text', id: 'clan-nombre', maxlength: '28', placeholder: 'Nombre del clan', autocomplete: 'off', 'aria-describedby': 'clan-nombre-estado' } });
  const estadoNombre = el('span', { clase: 'estado-nombre', attrs: { id: 'clan-nombre-estado', 'aria-live': 'polite' } });
  let espera = null;
  let libre = false;
  nombre.addEventListener('input', () => {
    clearTimeout(espera);
    libre = false;
    const limpio = nombre.value.trim();
    if (limpio.length < 3) { estadoNombre.textContent = limpio ? 'Muy corto' : ''; estadoNombre.className = 'estado-nombre mal'; return; }
    estadoNombre.textContent = 'Comprobando…';
    estadoNombre.className = 'estado-nombre espera';
    espera = setTimeout(async () => {
      const cid = limpio.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
      try {
        const existe = (await getDoc(doc(db, 'clanes', cid))).exists();
        libre = !existe;
        estadoNombre.textContent = existe ? 'Ocupado' : 'Libre';
        estadoNombre.className = `estado-nombre ${existe ? 'mal' : 'libre'}`;
      } catch {
        libre = true; // sin poder mirarlo se deja intentar: crearClan lo comprueba
        estadoNombre.textContent = '';
      }
    }, 400);
  });

  const muestras = el('div', { clase: 'colores-clan', attrs: { role: 'radiogroup', 'aria-label': 'Color del clan' } });
  const pintarMuestras = () => reemplazar(muestras, COLORES_CLAN.map((c) => el('button', {
    clase: `muestra-color ${usados.has(c) ? 'usado' : ''}`,
    attrs: { type: 'button', role: 'radio', 'aria-checked': String(c === color), 'aria-label': `Color ${c}${usados.has(c) ? ', ya lo usa un clan cerca' : ''}` },
    estilo: { background: c },
    on: { click: () => { color = c; pintarMuestras(); } },
  })));
  pintarMuestras();

  const codigo = el('input', { attrs: { type: 'text', id: 'codigo-invitacion', placeholder: 'Código de invitación', autocomplete: 'off', 'aria-label': 'Código de invitación' } });
  const entrar = boton('Entrar', async () => {
    const valor = codigo.value.trim().split('invitacion=').pop();
    if (!valor) return;
    await usarInvitacion(valor);
    avisar('Petición enviada. En unos minutos estarás dentro.', 'exito');
    await recargar();
  }, { clase: 'btn tonal' });

  reemplazar(destino, el('div', { clase: 'sin-clan' }, [
    el('h2', { texto: 'Solo se conquista en equipo' }),
    el('p', { clase: 'apagado', texto: 'Los clanes se disputan las estaciones. Si tu clan controla una, tus trayectos que la tocan suman un 10 % más.' }),
    cerca.length ? el('span', { clase: 'rotulo', texto: perfil?.puntosPorRuta && cerca.some((c) => c.estacion) ? 'Cerca de tus estaciones' : 'Clanes activos' }) : null,
    cerca.length ? el('div', { clase: 'lista-ranking clanes' }, cerca.map((c) => el('div', { clase: 'fila-clan' }, [
      el('span', { clase: 'escudo-clan', estilo: { background: colorSeguro(c.color) }, texto: iniciales(c.nombre) }),
      el('span', { clase: 'quien' }, [
        el('span', { clase: 'nombre', texto: c.nombre }),
        el('span', { clase: 'clan', texto: [c.miembros ? `${c.miembros} miembros` : null, c.estacion ? `controla ${contexto.nombreDe(c.estacion)}` : null].filter(Boolean).join(' · ') }),
      ]),
      boton('Pedir', () => pedirEntrada(c.cid), { clase: 'btn secundario pedir', etiqueta: `Pedir entrar en ${c.nombre}` }),
    ]))) : null,
    el('div', { clase: 'fila-codigo' }, [codigo, entrar]),
    el('div', { clase: 'crear-clan' }, [
      el('h3', { texto: 'Crear un clan' }),
      el('label', { clase: 'solo-lectores', attrs: { for: 'clan-nombre' }, texto: 'Nombre del clan' }),
      el('div', { clase: 'campo-nombre' }, [nombre, estadoNombre]),
      muestras,
      usados.size ? el('span', { clase: 'pista', texto: 'Los colores apagados ya los usa un clan con estaciones cerca de ti.' }) : null,
      boton('Crear el clan', async () => {
        if (!libre) throw new Error('Elige un nombre libre de al menos 3 letras.');
        const nuevo = await crearClan({ nombre: nombre.value.trim(), descripcion: '', color });
        avisar('Clan creado.', 'exito');
        clanId = nuevo;
        await recargar();
      }, { clase: 'btn' }),
    ]),
  ]));
}

// --- Carga ---------------------------------------------------------------------

/**
 * ¿Hay algun clan que ya me liste y del que mi perfil no se haya enterado?
 *
 * Pasa siempre que a alguien lo aceptan, y por diseño: aceptar toca solo el
 * documento del CLAN, porque el `clanId` de una persona lo escribe ella. Se
 * busca por `miembros`, no por un parametro en la URL: ninguna de las dos vias
 * de entrar deja rastro en la direccion. Solo se consulta si el perfil dice que
 * no tienes clan, o sea casi nunca.
 */
async function clanQueYaMeLista() {
  const encontrados = await getDocs(query(
    collection(db, 'clanes'),
    where('miembros', 'array-contains', usuario.uid),
    limit(1),
  ));
  if (encontrados.empty) return null;
  const cual = encontrados.docs[0].id;
  await confirmarEntrada(cual);
  return cual;
}

/**
 * Lee un clan: la estructura del documento, los nombres del agregado.
 *
 * **El documento del clan manda.** El agregado `agregados/clan-{id}` solo
 * aporta los nombres, y puede faltar (un clan recien creado no lo tiene) o ir
 * por detras (al aceptar a alguien, el documento cambia en el momento).
 */
async function leerClan(cual) {
  if (!cual) return null;

  const [documento, agregado] = await Promise.all([
    getDoc(doc(db, 'clanes', cual)),
    getDoc(doc(db, 'agregados', `clan-${cual}`)).catch(() => null),
  ]);
  if (!documento.exists()) return null;

  const datos = documento.data();
  const publicado = agregado?.exists() ? agregado.data() : {};
  const fichas = new Map([...(publicado.miembros || []), ...(publicado.candidatos || [])].map((m) => [m.uid, m]));
  const ficha = (uid) => fichas.get(uid) || { uid, nombre: 'Piloto', avatar: null, puntos: 0, viajes: 0, metros: 0 };

  return {
    clanId: cual,
    nombre: datos.nombre || cual,
    descripcion: datos.descripcion || '',
    color: datos.color || null,
    lider: datos.lider || null,
    oficiales: datos.oficiales || [],
    biciRating: datos.biciRating || 0,
    numMiembros: (datos.miembros || []).length,
    miembros: (datos.miembros || []).map(ficha).sort((a, b) => b.puntos - a.puntos),
    candidatos: (datos.solicitudes || []).map(ficha),
  };
}

export async function recargar() {
  const destino = id('panel-miclan');
  if (!destino) return;

  if (!usuario) {
    reemplazar(destino, el('div', { clase: 'resumen-invitado' }, [
      el('span', {}, [el('strong', { texto: 'Entra para unirte a un clan' })]),
      el('a', { clase: 'btn', texto: 'Entrar', attrs: { href: '/entrar/' } }),
    ]));
    return;
  }

  reemplazar(destino, ...esqueleto(3, 72));
  try {
    const suyo = await getDoc(doc(db, 'usuarios', usuario.uid));
    perfil = suyo.exists() ? suyo.data() : null;
    clanId = perfil?.clanId || null;
    clan = await leerClan(clanId);

    // Si algun clan me lista y mi perfil aun no lo sabe, se arregla solo.
    if (!clan) {
      const encontrado = await clanQueYaMeLista();
      if (encontrado) {
        clanId = encontrado;
        clan = await leerClan(encontrado);
      }
    }

    if (clan) pintarConClan(destino);
    else pintarSinClan(destino);
  } catch (error) {
    console.debug('No se ha podido cargar el clan', error);
    estado(id('mensaje'), 'No hemos podido cargar tu clan. Vuelve a intentarlo.', 'error');
    reemplazar(destino, el('div', {}));
  }
}

/**
 * Un enlace de invitacion abre `/territorio/?invitacion=CODIGO`. Se consume una
 * vez y se limpia de la URL: si no, recargar vuelve a intentarlo.
 */
async function atenderInvitacion() {
  const url = new URL(window.location.href);
  const codigo = url.searchParams.get('invitacion');
  if (!codigo || !usuario) return;
  url.searchParams.delete('invitacion');
  window.history.replaceState({}, '', url);
  try {
    await usarInvitacion(codigo);
    avisar('Invitación aceptada. En unos minutos estarás dentro del clan.', 'exito');
  } catch (error) {
    avisar(error.message || 'Esa invitación no se ha podido usar.');
  }
}

/** La arranca `paginas/territorio.js` cuando ya sabe si hay sesion. */
export async function iniciar(u, datosDelMapa = null) {
  usuario = u;
  if (datosDelMapa) contexto = { ...contexto, ...datosDelMapa };
  await atenderInvitacion();
  await recargar();
}

/** Para que la pestaña "Clanes" pueda ofrecer pedir entrada. */
export async function pedirEntrada(cual) {
  if (!usuario) { window.location.assign('/entrar/'); return; }
  if (perfil?.clanId) {
    avisar('Ya estás en un clan. Sal de él antes de pedir entrar en otro.', 'info');
    return;
  }
  // Las solicitudes estan en vivo en el documento: no hay que esperar a que se
  // rehaga ningun agregado para saber si ya pediste.
  const objetivo = await leerClan(cual);
  const yaPedida = (objetivo?.candidatos || []).some((c) => c.uid === usuario.uid);
  if (yaPedida) {
    await retirarSolicitud(cual);
    avisar('Solicitud retirada.', 'exito');
  } else {
    await solicitarEntrada(cual);
    avisar('Solicitud enviada. Te avisarán cuando respondan.', 'exito');
  }
  await recargar();
}
