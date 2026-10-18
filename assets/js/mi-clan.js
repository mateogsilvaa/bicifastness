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
import { escudoClan, COLORES_CLAN, COLORES_PRINCIPALES, lemaSeguro, contienePalabrasProhibidas } from '/assets/js/escudo-clan.js';
import {
  identidadInicial, pestanasEscudo, camposFicha, identidadParaGuardar, siglasDe, MAX_NOMBRE,
} from '/assets/js/editor-clan.js';
import { cabeceraClan, fichaEscala, abrirFichaClan, abrirCapa, temaDe, COLORES_TEMA } from '/assets/js/ficha-clan.js';
import { mapaClan } from '/assets/js/mapa-clan.js';
import { ESTACIONES } from '/assets/data/estaciones.js';
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
function confirmarEnHoja({ rotulo, titulo, texto, aceptar, cancelar = 'Cancelar', peligro = false, grave = false, extra = null, soloAceptar = false }) {
  return new Promise((resolver) => {
    let hecho = false;
    const fin = (v) => { if (!hecho) { hecho = true; resolver(v); } };
    const { cerrar } = abrirHoja([
      rotulo ? el('span', { clase: 'rotulo', texto: rotulo }) : null,
      el('h2', { texto: titulo }),
      texto ? el('p', { texto }) : null,
      extra,
      // 5f: el miembro elige entre cancelar y salir; el lider (ceder) y el
      // ultimo (disolver) solo ven su unica salida, y se cierra deslizando.
      el('div', { clase: 'dos-botones-hoja' }, [
        soloAceptar ? null : el('button', { clase: 'btn tonal', texto: cancelar, attrs: { type: 'button' }, on: { click: () => { fin(false); cerrar(); } } }),
        el('button', { clase: `btn ${grave ? 'peligro lleno' : peligro ? 'peligro' : ''}`, texto: aceptar, attrs: { type: 'button' }, on: { click: () => { fin(true); cerrar(); } } }),
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

/** Las estaciones que controla un clan, segun el mapa. */
function estacionesDe(cual) {
  return [...contexto.estaciones().entries()].filter(([, s]) => s.clanDominante === cual).map(([n]) => n);
}

/** Las de los demas clanes, en su color: en el mapa se lee la frontera. */
function vecinasDe(cual) {
  const clanes = contexto.clanes();
  return [...contexto.estaciones().entries()]
    .filter(([, s]) => s.clanDominante && s.clanDominante !== cual)
    .map(([n, s]) => ({ n, color: clanes.get(s.clanDominante)?.color }));
}

/** Tus tres estaciones habituales: las que mas puntos te han dado. */
function misEstaciones() {
  const cuenta = new Map();
  for (const [ruta, puntos] of Object.entries(perfil?.puntosPorRuta || {})) {
    for (const e of ruta.split('-')) {
      const n = e.replace(/^0+(?=\d)/, '');
      cuenta.set(n, (cuenta.get(n) || 0) + (Number(puntos) || 1));
    }
  }
  return [...cuenta.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
}

/**
 * Colores que ya lleva un clan con estaciones a menos de 1 km de las tuyas
 * (16c): no se pueden elegir, para que en el mapa no se confundan.
 */
function coloresVecinos() {
  const mias = misEstaciones().map((n) => ESTACIONES[n]).filter(Boolean);
  const vecinos = new Map();
  if (!mias.length) return vecinos;
  const metros = (a, b) => Math.hypot((a.lat - b.lat) * 111320, (a.lon - b.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180));
  const clanes = contexto.clanes();
  for (const [n, s] of contexto.estaciones()) {
    const clanVecino = clanes.get(s.clanDominante);
    const e = ESTACIONES[n];
    if (!clanVecino?.color || !e || vecinos.has(clanVecino.color)) continue;
    if (mias.some((m) => metros(m, e) < 1000)) vecinos.set(clanVecino.color, clanVecino.nombre);
  }
  return vecinos;
}

/** La vista previa del escudo en el ordenador: grande y a los tamaños en que se vera (16j). */
function tamanosEscudo(datosClan) {
  return el('div', { clase: 'tamanos-escudo' }, [['ranking', 'ranking'], ['mapa', 'mapa'], ['lista', 'lista']].map(([clase, rotulo]) => el('span', { clase }, [
    escudoClan(datosClan),
    el('small', { texto: rotulo }),
  ])));
}

/**
 * Editar el clan (16i, solo el lider): la ficha arriba y dos pestañas, Escudo
 * y Ficha. Guardar solo se activa si hay cambios; salir con cambios pregunta.
 * Se guarda con una escritura y el resto de la web lo recoge en la siguiente
 * pasada de los agregados.
 */
function hojaPersonalizar() {
  const elegido = identidadInicial(clan);
  const suyas = estacionesDe(clanId);
  const mapa = { suyas, vecinas: vecinasDe(clanId) };
  const inicial = JSON.stringify(identidadParaGuardar(elegido).datos);
  const hayCambios = () => JSON.stringify(identidadParaGuardar(elegido).datos) !== inicial;
  const datosClan = () => ({ ...elegido, nombre: clan.nombre, siglas: elegido.siglas || null });

  const previa = el('div', { clase: 'vista-ficha' });
  const aviso = el('p', { clase: 'aviso-color' });
  const error = el('p', { clase: 'error-clan', attrs: { 'aria-live': 'polite' } });
  const guardar = [
    el('button', { clase: 'btn guardar-barra', texto: 'Guardar', attrs: { type: 'button', disabled: '' } }),
    el('button', { clase: 'btn', texto: 'Guardar', attrs: { type: 'button', disabled: '' } }),
  ];
  let ficha = null;
  const repintar = () => {
    reemplazar(previa, [
      cabeceraClan(datosClan(), mapa),
      fichaEscala(datosClan(), {
        ...mapa,
        cifras: [[String(suyas.length), 'estaciones'], [miles(clan.biciRating || 0), 'BiciRating'], [String(clan.numMiembros), clan.numMiembros === 1 ? 'miembro' : 'miembros']],
        plantilla: clan.miembros, miembros: clan.numMiembros, lider: clan.lider, yo: usuario?.uid,
      }),
    ]);
    const cambiaColor = elegido.color !== (clan.color || elegido.color);
    aviso.textContent = cambiaColor && suyas.length ? `Cambiar el color mueve también vuestras ${suyas.length} estaciones en el mapa.` : '';
    for (const b of guardar) b.disabled = !hayCambios();
    ficha?.repintar();
  };
  const escudo = pestanasEscudo(elegido, repintar, { nombre: () => clan.nombre, estilo: 'chips' });
  ficha = camposFicha(elegido, repintar, { mapa: () => mapa, siglas: true });

  const panelEscudo = el('div', { clase: 'panel-editar' }, [escudo.barra, escudo.paneles, aviso]);
  const panelFicha = el('div', { clase: 'panel-editar oculto' }, [ficha]);
  const botonesEF = {};
  const segmento = el('div', { clase: 'segmentado', attrs: { role: 'tablist', 'aria-label': 'Qué quieres cambiar' } },
    [['escudo', 'Escudo', panelEscudo], ['ficha', 'Ficha', panelFicha]].map(([clave, texto, panel]) => {
      botonesEF[clave] = el('button', {
        texto, attrs: { type: 'button', role: 'tab', 'aria-selected': String(clave === 'escudo') },
        on: {
          click: () => {
            panelEscudo.classList.toggle('oculto', panel !== panelEscudo);
            panelFicha.classList.toggle('oculto', panel !== panelFicha);
            for (const [k, b] of Object.entries(botonesEF)) b.setAttribute('aria-selected', String(k === clave));
          },
        },
      });
      return botonesEF[clave];
    }));

  let capa = null;
  const salir = async () => {
    if (hayCambios()) {
      const seguro = await confirmarEnHoja({ titulo: '¿Salir sin guardar?', texto: '', cancelar: 'Seguir editando', aceptar: 'Salir' });
      if (!seguro) return;
    }
    capa.cerrar();
  };
  const alGuardar = async () => {
    const { datos, error: motivo } = identidadParaGuardar(elegido);
    if (motivo) { error.textContent = motivo; return; }
    for (const b of guardar) b.disabled = true;
    try {
      await personalizarClan(clanId, datos);
      capa.cerrar();
      avisar('Clan actualizado.', 'exito');
      await recargar();
    } catch {
      error.textContent = 'No se ha podido guardar. Vuelve a intentarlo.';
      for (const b of guardar) b.disabled = false;
    }
  };
  for (const b of guardar) b.addEventListener('click', alGuardar);
  const cerrarX = () => el('button', { clase: 'boton-capa', attrs: { type: 'button', 'aria-label': 'Cerrar' }, on: { click: salir } }, [icono('cerrar', 'icono')]);

  repintar();
  capa = abrirCapa([
    el('div', { clase: 'hoja-clan-barra' }, [cerrarX(), el('h2', { texto: 'Editar clan' }), guardar[0]]),
    el('div', { clase: 'hoja-clan-izq' }, [previa]),
    el('div', { clase: 'hoja-clan-der' }, [
      el('div', { clase: 'cabeza-der' }, [segmento, cerrarX()]),
      el('div', { clase: 'contenido-der' }, [panelEscudo, panelFicha, error]),
      el('div', { clase: 'pie-der' }, [el('span'), guardar[1]]),
    ]),
  ], { etiqueta: 'Editar clan', clase: 'hoja-clan editar', alEscape: salir });
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
      el('button', { clase: 'btn secundario', texto: 'Ver la ficha del clan', attrs: { type: 'button' }, on: { click: () => { cerrar(); verFicha(clanId); } } }),
      papel() === 'lider' ? el('button', { clase: 'btn secundario', texto: 'Personalizar el clan', attrs: { type: 'button' }, on: { click: () => { cerrar(); hojaPersonalizar(); } } }) : null,
      el('button', { clase: 'btn peligro', texto: papel() === 'lider' && clan.miembros.length <= 1 ? 'Disolver el clan' : 'Dejar el clan', attrs: { type: 'button' }, on: { click: () => { cerrar(); salir().catch((e) => avisar(e.message)); } } }),
    ], { etiqueta: 'Opciones del clan', clase: 'dialogo-escritorio' });
  });

  reemplazar(destino, el('div', { clase: 'mi-clan' }, [
    el('div', { clase: 'mi-clan-cabeza' }, [
      el('button', {
        clase: 'abre-ficha', attrs: { type: 'button', 'aria-label': `Ver la ficha de ${clan.nombre}` },
        on: { click: () => verFicha(clanId) },
      }, [escudoClan(clan, { clase: 'escudo-clan grande', tam: 26 })]),
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
      papel() === 'lider'
        ? el('button', { clase: 'boton-cuadrado', attrs: { type: 'button', 'aria-label': 'Personalizar el clan', title: 'Personalizar el clan' }, on: { click: () => hojaPersonalizar() } }, [icono('lapiz')])
        : null,
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

const PASOS_CREAR = ['Nombre', 'Escudo', 'Ficha'];
const TEXTO_SIGUIENTE = ['Siguiente: el escudo', 'Siguiente: la ficha'];

/**
 * Crear un clan (16a-16e; 16j y 16k en el ordenador): tres pasos a pantalla
 * completa con el escudo, o la ficha, siempre a la vista y actualizandose en
 * vivo. Solo el nombre es obligatorio; lo demas se puede cambiar despues.
 */
function abrirCrear() {
  const vecinos = coloresVecinos();
  const elegido = identidadInicial({}, Object.keys(COLORES_PRINCIPALES).find((c) => !vecinos.has(c)) || COLORES_CLAN[0]);
  const foco = misEstaciones();
  const mapa = { foco };
  let paso = 0;
  let espera = null;
  let libre = false;
  let siglasTocadas = false;
  const escritorio = window.matchMedia('(min-width: 900px)').matches;

  // --- Paso 1 · Nombre (16a)
  const nombre = el('input', { attrs: { type: 'text', id: 'clan-nombre', maxlength: String(MAX_NOMBRE), autocomplete: 'off', 'aria-describedby': 'clan-nombre-estado' } });
  const estadoNombre = el('span', { clase: 'estado-nombre-clan', attrs: { id: 'clan-nombre-estado', 'aria-live': 'polite' } });
  const cuenta = el('small', { clase: 'contador-nombre', texto: `0 / ${MAX_NOMBRE}` });
  const siglas = el('input', { attrs: { type: 'text', maxlength: '3', 'aria-label': 'Siglas', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false' } });
  const nombreActual = () => nombre.value.trim() || 'Tu clan';
  const pasoNombre = el('div', { clase: 'paso-nombre' }, [
    el('label', { clase: 'campo-nombre-clan', attrs: { for: 'clan-nombre' } }, [
      el('span', { clase: 'etiqueta', texto: 'Nombre del clan' }),
      el('span', { clase: 'caja' }, [nombre, estadoNombre]),
      cuenta,
    ]),
    el('div', { clase: 'fila-siglas' }, [
      el('div', {}, [el('strong', { texto: 'Siglas' }), el('span', { texto: 'Salen en el ranking y, si no eliges emblema, en el escudo.' })]),
      siglas,
    ]),
  ]);

  // --- Lo que se ve: el escudo (pasos 1 y 2) o la ficha (paso 3)
  const escenario = el('div', { clase: 'escenario-escudo' });
  const vistaFicha = el('div', { clase: 'vista-ficha' });
  const datosClan = () => ({ ...elegido, nombre: nombreActual(), siglas: elegido.siglas || null });
  let ficha = null;
  const repintar = () => {
    const d = datosClan();
    reemplazar(escenario, [
      escudoClan(d, { clase: 'escudo-clan escudo-grande' }),
      el('span', { clase: 'nombre', texto: nombreActual() }),
      el('span', { clase: 'nota', texto: 'Así empieza tu escudo. Lo vestirás en el paso 2.' }),
      tamanosEscudo(d),
    ]);
    reemplazar(vistaFicha, [
      cabeceraClan(d, mapa),
      fichaEscala(d, {
        ...mapa,
        cifras: [['0', 'estaciones'], ['1', 'miembros'], ['—', 'puesto']],
        plantilla: [{ uid: usuario?.uid, nombre: perfil?.username || 'Tú', puntos: null }], miembros: 1, lider: usuario?.uid, yo: usuario?.uid,
      }),
    ]);
    ficha?.repintar();
  };

  // --- Paso 2 · Escudo (16b-16d) y paso 3 · Ficha (16e)
  const escudo = pestanasEscudo(elegido, repintar, { nombre: nombreActual, vecinos });
  ficha = camposFicha(elegido, repintar, { mapa: () => mapa, plegar: !escritorio });
  const paneles = [pasoNombre, escudo.paneles, ficha];

  const progreso = () => el('div', { clase: 'hoja-clan-progreso', attrs: { 'aria-hidden': 'true' } }, PASOS_CREAR.map(() => el('span')));
  const progresos = [progreso(), progreso(), progreso()];
  const textosPaso = [];
  const textoPaso = () => { const s = el('span', { clase: 'paso' }); textosPaso.push(s); return s; };
  const error = el('p', { clase: 'error-clan', attrs: { 'aria-live': 'polite' } });
  const siguiente = el('button', { clase: 'btn siguiente-clan', attrs: { type: 'button' } });
  const atrasPie = el('button', { clase: 'atras-pie', attrs: { type: 'button' } });
  const botonBarra = el('button', { clase: 'boton-capa', attrs: { type: 'button' } });
  let capa = null;

  function pintarPaso() {
    capa?.capa.classList.remove('paso-1', 'paso-2', 'paso-3');
    capa?.capa.classList.add(`paso-${paso + 1}`);
    paneles.forEach((p, i) => p.classList.toggle('oculto', i !== paso));
    escudo.barra.classList.toggle('oculto', paso !== 1);
    for (const p of progresos) [...p.children].forEach((s, i) => s.classList.toggle('hecho', i <= paso));
    for (const s of textosPaso) s.textContent = `${paso + 1} de ${PASOS_CREAR.length}`;
    reemplazar(botonBarra, icono(paso === 0 ? 'cerrar' : 'atras', 'icono'));
    botonBarra.setAttribute('aria-label', paso === 0 ? 'Cerrar' : 'Atrás');
    atrasPie.textContent = paso === 0 ? '' : `← ${PASOS_CREAR[paso - 1]}`;
    reemplazar(siguiente, paso < 2
      ? [el('span', { texto: TEXTO_SIGUIENTE[paso] }), icono('flecha', 'icono')]
      : [el('span', { texto: `Fundar ${nombreActual()}` })]);
    siguiente.disabled = !libre;
    error.textContent = '';
    if (paso === 1) escudo.repintar();
  }

  const marcar = (texto, clase) => {
    reemplazar(estadoNombre, clase === 'libre' ? [icono('check', 'icono'), texto] : [texto]);
    estadoNombre.className = `estado-nombre-clan ${clase}`;
  };
  nombre.addEventListener('input', () => {
    clearTimeout(espera);
    libre = false;
    siguiente.disabled = true;
    cuenta.textContent = `${nombre.value.length} / ${MAX_NOMBRE}`;
    if (!siglasTocadas) { elegido.siglas = siglasDe(nombre.value); siglas.value = elegido.siglas; }
    repintar();
    if (paso === 2) reemplazar(siguiente, el('span', { texto: `Fundar ${nombreActual()}` }));
    const limpio = nombre.value.trim();
    if (limpio.length < 3) { marcar('', ''); return; }
    // Solo letras, numeros, espacios y algun signo corriente: nada de
    // emojis, simbolos raros ni caracteres invisibles en un nombre publico.
    if (!/^[\p{L}\p{N}][\p{L}\p{N} '._-]*$/u.test(limpio) || contienePalabrasProhibidas(limpio)) { marcar('No permitido', 'mal'); return; }
    marcar('…', 'espera');
    espera = setTimeout(async () => {
      const cid = limpio.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
      try {
        const existe = (await getDoc(doc(db, 'clanes', cid))).exists();
        libre = !existe;
        marcar(existe ? 'Ocupado' : 'Libre', existe ? 'mal' : 'libre');
      } catch {
        libre = true; // sin poder mirarlo se deja intentar: crearClan lo comprueba
        marcar('', '');
      }
      siguiente.disabled = !libre;
    }, 400);
  });
  nombre.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && libre) siguiente.click(); });
  siglas.addEventListener('input', () => {
    siglasTocadas = true;
    siglas.value = siglas.value.toUpperCase().replace(/[^A-Z0-9ÑÁÉÍÓÚ]/g, '').slice(0, 3);
    elegido.siglas = siglas.value;
    repintar();
  });

  const atras = () => { if (paso === 0) capa.cerrar(); else { paso -= 1; pintarPaso(); } };
  botonBarra.addEventListener('click', atras);
  atrasPie.addEventListener('click', atras);
  siguiente.addEventListener('click', async () => {
    if (!libre) return;
    if (paso < 2) { paso += 1; pintarPaso(); return; }
    const { datos, error: motivo } = identidadParaGuardar(elegido);
    if (motivo) { error.textContent = motivo; return; }
    siguiente.disabled = true;
    try {
      const nuevo = await crearClan({ nombre: nombre.value.trim(), ...datos });
      capa.cerrar();
      clanId = nuevo;
      await recargar();
      abrirFundado({ ...datos, nombre: nombre.value.trim() }, foco);
    } catch (e) {
      error.textContent = e.message || 'No se ha podido crear el clan.';
      siguiente.disabled = false;
    }
  });

  const cerrarX = el('button', { clase: 'boton-capa', attrs: { type: 'button', 'aria-label': 'Cerrar' } }, [icono('cerrar', 'icono')]);
  repintar();
  capa = abrirCapa([
    el('div', { clase: 'hoja-clan-barra' }, [botonBarra, el('h2', { texto: 'Nuevo clan' }), textoPaso()]),
    progresos[0],
    el('div', { clase: 'hoja-clan-izq' }, [
      el('div', { clase: 'cabeza-izq' }, [el('div', {}, [el('strong', { texto: 'Nuevo clan' }), textoPaso()]), progresos[1]]),
      escenario,
      vistaFicha,
    ]),
    el('div', { clase: 'hoja-clan-der' }, [
      el('div', { clase: 'cabeza-der' }, [
        escudo.barra,
        el('span', { clase: 'titulo-der' }, ['Nuevo clan ', textoPaso()]),
        cerrarX,
      ]),
      progresos[2],
      el('div', { clase: 'contenido-der' }, [...paneles, error]),
      el('div', { clase: 'pie-der' }, [atrasPie, siguiente]),
    ]),
  ], { etiqueta: 'Nuevo clan', clase: 'hoja-clan crear paso-1' });
  cerrarX.addEventListener('click', capa.cerrar);
  pintarPaso();
  nombre.focus();
}

/**
 * Clan fundado (16f): el escudo cae sobre el mapa con tus estaciones
 * habituales marcadas. Lo siguiente util: invitar.
 */
function abrirFundado(datosClan, foco) {
  const tema = temaDe(datosClan);
  const invitar = el('button', { clase: 'btn' }, [icono('compartir', 'icono'), el('span', { texto: 'Invitar a la primera persona' })]);
  const verla = el('button', { clase: 'enlace-fundado', texto: 'Ver la ficha del clan', attrs: { type: 'button' } });
  const capa = abrirCapa([
    // La caja es vertical: el mapa se recorta y sin esto los anillos crecen 3 veces.
    mapaClan({ color: datosClan.color, tema, foco, ancho: 1500 }),
    el('div', { clase: 'contenido-fundado' }, [
      escudoClan(datosClan, { clase: 'escudo-clan', aro: COLORES_TEMA[tema].fondo }),
      el('h2', { texto: datosClan.nombre }),
      el('p', { texto: 'Ya existe. Tus tres estaciones habituales están marcadas: pedalead por ellas y serán vuestras.' }),
      el('span', { clase: 'relleno' }),
      invitar,
      verla,
    ]),
  ], { etiqueta: `${datosClan.nombre} fundado`, clase: `clan-fundado ${tema}` });
  invitar.addEventListener('click', async () => {
    invitar.disabled = true;
    try {
      const { enlace } = await crearInvitacion(clanId);
      if (navigator.share) {
        try { await navigator.share({ title: `Únete a ${datosClan.nombre}`, text: `Entra en ${datosClan.nombre} en bicifastness`, url: enlace }); } catch { /* cancelado */ }
      } else {
        await navigator.clipboard.writeText(enlace);
        avisar('Enlace de invitación copiado.', 'exito');
      }
    } catch (e) {
      avisar(e.message || 'No se ha podido crear la invitación.');
    } finally {
      invitar.disabled = false;
    }
  });
  verla.addEventListener('click', () => { capa.cerrar(); verFicha(clanId); });
}

function pintarSinClan(destino) {
  const cerca = clanesCerca();

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
      el('button', {
        clase: 'quien abre-ficha', attrs: { type: 'button', 'aria-label': `Ver la ficha de ${c.nombre}` },
        on: { click: () => verFicha(c.cid) },
      }, [
        el('span', { clase: 'nombre', texto: c.nombre }),
        el('span', { clase: 'clan', texto: [c.miembros ? `${c.miembros} miembros` : null, c.estacion ? `controla ${contexto.nombreDe(c.estacion)}` : null].filter(Boolean).join(' · ') }),
      ]),
      boton('Pedir', () => pedirEntrada(c.cid), { clase: 'btn secundario pedir', etiqueta: `Pedir entrar en ${c.nombre}` }),
    ]))) : null,
    el('div', { clase: 'fila-codigo' }, [codigo, entrar]),
    el('button', { clase: 'btn', texto: 'Crear un clan', attrs: { type: 'button' }, on: { click: () => abrirCrear() } }),
  ]));
}

/**
 * La ficha publica de un clan, con lo que sabe esta pantalla: sus estaciones,
 * las de sus vecinos, su puesto y si se puede pedir entrar.
 */
export function verFicha(cual) {
  const ranking = contexto.ranking();
  const nombreClan = contexto.clanes().get(cual)?.nombre;
  const puesto = nombreClan ? ranking.findIndex((c) => c.nombre === nombreClan) + 1 : 0;
  return abrirFichaClan(cual, {
    suyas: estacionesDe(cual), vecinas: vecinasDe(cual), puesto: puesto || null, total: ranking.length || null,
    yo: usuario?.uid || null, puedePedir: Boolean(usuario) && !perfil?.clanId,
    alPedir: pedirEntrada, alEditar: cual === clanId && papel() === 'lider' ? hojaPersonalizar : null,
  });
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
    color2: datos.color2 || null,
    patron: datos.patron || null,
    forma: datos.forma || null,
    emblema: datos.emblema || null,
    siglas: datos.siglas || null,
    zona: datos.zona || '',
    presentacion: datos.presentacion || '',
    tema: datos.tema || null,
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
