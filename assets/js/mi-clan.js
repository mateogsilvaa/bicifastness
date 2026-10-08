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
import {
  escudoClan, COLORES_CLAN, EMBLEMAS, svgEmblema, lemaSeguro, MAX_LEMA, inicialesDe, contienePalabrasProhibidas,
} from '/assets/js/escudo-clan.js';
import { id, el, icono, estado, reemplazar, avisar, esqueleto, abrirHoja } from '/assets/js/dom.js';
import { miles, NOMBRE_DIVISION } from '/assets/js/ui.js';
import {
  crearClan, solicitarEntrada, retirarSolicitud, responderSolicitud,
  expulsarMiembro, cambiarOficial, cederLiderazgo, abandonarClan, disolverClan,
  crearInvitacion, usarInvitacion, confirmarEntrada, personalizarClan,
} from '/assets/js/acciones.js';

/** Estado de la pantalla. Se vuelve a leer entero tras cada accion. */
let usuario = null;
let perfil = null;
let clan = null;
let clanId = null;
/** Lo que aporta el mapa: clanes, estaciones, ranking y nombres (getters). */
let contexto = { clanes: () => new Map(), estaciones: () => new Map(), ranking: () => [], nombreDe: (n) => n };

// Los colores, emblemas y el escudo viven en escudo-clan.js: el mismo clan se
// pinta igual en el mapa, el ranking, Hoy y aqui.
export { COLORES_CLAN };

const colorSeguro = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : 'var(--tinta-3)');
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
function confirmarEnHoja({ rotulo, titulo, texto, aceptar, peligro = false, grave = false, extra = null, soloAceptar = false }) {
  return new Promise((resolver) => {
    let hecho = false;
    const fin = (v) => { if (!hecho) { hecho = true; resolver(v); } };
    const { cerrar } = abrirHoja([
      rotulo ? el('span', { clase: 'rotulo', texto: rotulo }) : null,
      el('h2', { texto: titulo }),
      el('p', { texto }),
      extra,
      // 5f: el miembro elige entre cancelar y salir; el lider (ceder) y el
      // ultimo (disolver) solo ven su unica salida, y se cierra deslizando.
      el('div', { clase: 'dos-botones-hoja' }, [
        soloAceptar ? null : el('button', { clase: 'btn tonal', texto: 'Cancelar', attrs: { type: 'button' }, on: { click: () => { cerrar(); fin(false); } } }),
        el('button', { clase: `btn ${grave ? 'peligro lleno' : peligro ? 'peligro' : ''}`, texto: aceptar, attrs: { type: 'button' }, on: { click: () => { cerrar(); fin(true); } } }),
      ]),
    ], { etiqueta: titulo, clase: `dialogo-escritorio hoja-confirmar ${grave ? 'grave' : ''}`, alCerrar: () => fin(false) });
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
      el('span', { clase: 'clan', texto: cargo }),
    ]),
    // 5c/8l: lo que lleva cada uno esta semana ("+212"; "0" si no ha salido).
    el('strong', { clase: 'valor', texto: m.semana ? `+${numero(m.semana)}` : '0' }),
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
  // 8l: en escritorio, un aviso de una linea; "Ver" despliega las tarjetas.
  const seccion = el('section', { clase: 'solicitudes' });
  const aviso = el('button', { clase: 'aviso-solicitudes', attrs: { type: 'button', 'aria-expanded': 'false' } }, [
    el('span', { clase: 'contador-azul', texto: String(candidatos.length) }),
    el('span', { clase: 'texto', texto: 'Solicitudes para entrar' }),
    el('span', { clase: 'ver', texto: 'Ver' }),
  ]);
  aviso.addEventListener('click', () => {
    const abierta = seccion.classList.toggle('abierta');
    aviso.setAttribute('aria-expanded', String(abierta));
    aviso.querySelector('.ver').textContent = abierta ? 'Ocultar' : 'Ver';
  });
  return reemplazar(seccion, [
    aviso,
    el('div', { clase: 'hoy-seccion' }, [el('h3', { texto: 'Solicitudes' }), el('span', { clase: 'contador-azul', texto: String(candidatos.length) })]),
    ...candidatos.map((c) => el('div', { clase: 'fila-solicitud' }, [
      el('span', { clase: 'avatar-mini grande', texto: [...(c.nombre || 'P')][0].toUpperCase() }),
      el('span', { clase: 'quien' }, [
        el('strong', { texto: c.nombre }),
        // 5d: "Plata · 38 trayectos · sin clan" / "… · antes en Retiro Riders".
        el('span', { clase: 'clan', texto: [
          NOMBRE_DIVISION[c.division] || null,
          `${c.viajes || 0} ${c.viajes === 1 ? 'trayecto' : 'trayectos'}`,
          c.clanId && c.clanId !== clanId ? `antes en ${contexto.clanes().get(c.clanId)?.nombre || 'otro clan'}` : 'sin clan',
        ].filter(Boolean).join(' · ') }),
      ]),
      boton(icono('cerrar'), async () => { await responderSolicitud(clanId, c.uid, false); await recargar(); }, { clase: 'boton-cuadrado', etiqueta: `Rechazar a ${c.nombre}` }),
      boton(icono('check'), async () => { await responderSolicitud(clanId, c.uid, true); await recargar(); }, { clase: 'boton-cuadrado azul', etiqueta: `Aceptar a ${c.nombre}` }),
    ])),
  ]);
}

/** 5d · Invitar: enlace de un solo uso, compartir o copiar. Solo el lider. */
async function abrirInvitacion() {
  const { enlace, caduca } = await crearInvitacion(clanId);
  // 5d: se enseña sin el "https://", como en el diseño; se copia entero.
  const campo = el('input', { attrs: { type: 'text', readonly: 'readonly', value: enlace.replace(/^https?:\/\//, ''), 'aria-label': 'Enlace de invitación' } });
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
  const compartir = el('button', { clase: 'btn', attrs: { type: 'button' } }, [icono('compartir', 'icono'), el('span', { texto: 'Compartir enlace' })]);
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
    // 5d en el movil; 8l, en la tarjeta flotante del escritorio, mas corto.
    el('p', { attrs: { title: `Caduca el ${caduca.toLocaleDateString('es-ES')}` } }, [
      el('span', { clase: 'solo-movil-i', texto: 'El enlace vale una sola vez y caduca. Quien lo abra entra sin que tengas que aceptarlo.' }),
      el('span', { clase: 'solo-escritorio-i', texto: 'Vale una sola vez y caduca. Quien lo abra entra directamente.' }),
    ]),
    compartir,
  ], { etiqueta: `Invitar a ${clan.nombre}`, clase: 'dialogo-escritorio hoja-invitar' });
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
        extra: elegir, aceptar: 'Ceder y salir', soloAceptar: true,
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
        aceptar: `Disolver ${clan.nombre}`, grave: true, soloAceptar: true,
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

/**
 * Personalizar el clan (solo el lider): color, emblema o siglas y un lema. Se
 * ve el escudo en vivo mientras se elige; se guarda con una escritura y el
 * resto de la web lo recoge en la siguiente pasada de los agregados.
 */
function hojaPersonalizar() {
  const elegido = {
    color: clan.color || COLORES_CLAN[0],
    emblema: clan.emblema || null,
    siglas: clan.siglas || '',
    descripcion: clan.descripcion || '',
  };
  const muestra = el('div', { clase: 'personalizar-muestra' });
  const pintarMuestra = () => reemplazar(muestra, [
    escudoClan({ ...elegido, nombre: clan.nombre, siglas: elegido.siglas || null }, { clase: 'escudo-clan grande', tam: 30 }),
    el('span', { clase: 'datos' }, [
      el('strong', { texto: clan.nombre }),
      elegido.descripcion
        ? el('span', { clase: 'lema-clan', texto: elegido.descripcion })
        : el('span', { clase: 'apagado', texto: 'Sin lema' }),
    ]),
  ]);

  const colores = el('div', { clase: 'muestras-color', attrs: { role: 'radiogroup', 'aria-label': 'Color del clan' } });
  const pintarColores = () => reemplazar(colores, COLORES_CLAN.map((c) => el('button', {
    clase: 'muestra-color',
    estilo: { background: c },
    attrs: { type: 'button', role: 'radio', 'aria-checked': String(c === elegido.color), 'aria-label': `Color ${c}` },
    on: { click: () => { elegido.color = c; pintarColores(); pintarMuestra(); } },
  })));

  const emblemas = el('div', { clase: 'rejilla-emblemas', attrs: { role: 'radiogroup', 'aria-label': 'Emblema' } });
  const pintarEmblemas = () => reemplazar(emblemas, [
    el('button', {
      clase: `emblema-opcion${!elegido.emblema ? ' elegida' : ''}`,
      texto: (elegido.siglas || inicialesDe(clan.nombre)).slice(0, 3),
      attrs: { type: 'button', role: 'radio', 'aria-checked': String(!elegido.emblema), 'aria-label': 'Siglas' },
      on: { click: () => { elegido.emblema = null; pintarEmblemas(); pintarMuestra(); } },
    }),
    ...Object.entries(EMBLEMAS).map(([clave, { nombre }]) => el('button', {
      clase: `emblema-opcion${elegido.emblema === clave ? ' elegida' : ''}`,
      attrs: { type: 'button', role: 'radio', 'aria-checked': String(elegido.emblema === clave), 'aria-label': nombre, title: nombre },
      on: { click: () => { elegido.emblema = clave; pintarEmblemas(); pintarMuestra(); } },
    }, [svgEmblema(clave, 20)])),
  ]);

  const siglas = el('input', { attrs: { type: 'text', maxlength: '3', placeholder: inicialesDe(clan.nombre), 'aria-label': 'Siglas (hasta 3)', autocapitalize: 'characters' } });
  siglas.value = elegido.siglas;
  siglas.addEventListener('input', () => {
    siglas.value = siglas.value.toUpperCase().replace(/[^A-Z0-9ÑÁÉÍÓÚ]/g, '').slice(0, 3);
    elegido.siglas = siglas.value;
    pintarEmblemas();
    pintarMuestra();
  });
  const lema = el('input', { attrs: { type: 'text', maxlength: String(MAX_LEMA), placeholder: 'Un lema (opcional)', 'aria-label': 'Lema del clan' } });
  lema.value = elegido.descripcion;
  lema.addEventListener('input', () => { elegido.descripcion = lema.value; pintarMuestra(); });
  const error = el('p', { clase: 'encuesta-pista error', attrs: { 'aria-live': 'polite' } });

  pintarMuestra();
  pintarColores();
  pintarEmblemas();
  const { cerrar } = abrirHoja([
    el('div', { clase: 'personalizar-clan' }, [
      el('h2', { texto: 'Personalizar el clan' }),
      muestra,
      el('span', { clase: 'rotulo', texto: 'Color' }), colores,
      el('span', { clase: 'rotulo', texto: 'Emblema' }), emblemas,
      el('div', { clase: 'personalizar-campos' }, [
        el('label', { clase: 'campo' }, [el('span', { texto: 'Siglas' }), siglas]),
        el('label', { clase: 'campo' }, [el('span', { texto: 'Lema' }), lema]),
      ]),
      error,
      el('button', {
        clase: 'btn', texto: 'Guardar', attrs: { type: 'button' },
        on: {
          click: async () => {
            const limpio = lemaSeguro(elegido.descripcion);
            if (elegido.descripcion.trim() && !limpio) { error.textContent = 'El lema no puede llevar enlaces.'; return; }
            if (contienePalabrasProhibidas(limpio)) { error.textContent = 'Ese lema no se puede publicar.'; return; }
            try {
              await personalizarClan(clanId, {
                color: elegido.color, emblema: elegido.emblema, siglas: elegido.siglas, descripcion: limpio,
              });
              cerrar();
              await recargar();
            } catch {
              error.textContent = 'No se ha podido guardar. Vuelve a intentarlo.';
            }
          },
        },
      }),
    ]),
  ], { etiqueta: 'Personalizar el clan', clase: 'dialogo-escritorio' });
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
      papel() === 'lider' ? el('button', { clase: 'btn secundario', texto: 'Personalizar el clan', attrs: { type: 'button' }, on: { click: () => { cerrar(); hojaPersonalizar(); } } }) : null,
      el('button', { clase: 'btn peligro', texto: papel() === 'lider' && clan.miembros.length <= 1 ? 'Disolver el clan' : 'Dejar el clan', attrs: { type: 'button' }, on: { click: () => { cerrar(); salir().catch((e) => avisar(e.message)); } } }),
    ], { etiqueta: 'Opciones del clan', clase: 'dialogo-escritorio' });
  });

  reemplazar(destino, el('div', { clase: 'mi-clan' }, [
    el('div', { clase: 'mi-clan-cabeza' }, [
      escudoClan(clan, { clase: 'escudo-clan grande', tam: 26 }),
      el('span', { clase: 'datos' }, [
        el('h2', { texto: clan.nombre }),
        clan.descripcion ? el('span', { clase: 'lema-clan', texto: lemaSeguro(clan.descripcion) }) : null,
        // 5c: "19 miembros · 16.980 BiciRating · 2.º"; 8l: con sus estaciones.
        el('span', { clase: 'apagado' }, [
          `${clan.numMiembros} ${clan.numMiembros === 1 ? 'miembro' : 'miembros'} · `,
          el('span', { clase: 'solo-movil-i', texto: `${numero(clan.biciRating)} BiciRating` }),
          el('span', { clase: 'solo-escritorio-i', texto: `${[...contexto.estaciones().values()].filter((s) => s.clanDominante === clanId).length} estaciones` }),
          puesto ? ` · ${puesto}.º` : '',
        ]),
      ]),
    ]),
    bloqueCandidatos(),
    asedio.length ? el('section', { clase: 'asedio' }, [
      el('h3', { texto: 'En asedio' }),
      ...asedio.slice(0, 3).map((a) => el('div', { clase: 'fila-asedio' }, [
        el('span', { clase: 'nombre', texto: a.nombre }),
        el('span', { clase: 'barra-asedio', attrs: { 'aria-hidden': 'true' } }, [
          el('span', { estilo: { width: `${a.mio}%`, background: colorSeguro(clan.color) } }),
          el('span', { estilo: { width: `${a.rival}%`, background: a.color } }),
        ]),
        el('strong', { texto: String(a.mio), attrs: { 'aria-label': `${a.mio} % tuyo` } }),
      ])),
    ]) : el('p', { clase: 'nota-territorio', texto: 'Ninguna de vuestras estaciones está en juego ahora mismo.' }),
    el('section', { clase: 'plantilla' }, [
      el('div', { clase: 'hoy-seccion' }, [el('h3', { texto: 'Plantilla' }), el('span', { texto: 'esta semana' })]),
      ...(clan.miembros || []).map(filaMiembro),
    ]),
    el('div', { clase: 'acciones-clan' }, [
      // 8l: el lider invita (azul); 5c: el resto ve el mismo boton, con borde,
      // y le explica que el enlace lo crea el lider.
      papel() === 'lider'
        ? boton([icono('enlace', 'icono peq'), el('span', { texto: 'Invitar' })], abrirInvitacion, { clase: 'btn' })
        : boton([icono('enlace', 'icono peq'), el('span', { texto: 'Invitar' })], () => avisar('Los enlaces de invitación los crea el líder: pídele uno.'), { clase: 'btn secundario' }),
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
      escudoClan(c),
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
    emblema: datos.emblema || null,
    siglas: datos.siglas || null,
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
