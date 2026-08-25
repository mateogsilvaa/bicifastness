// Gestion del clan propio (#29).
//
// POR QUE EXISTE ESTE FICHERO. Las doce acciones de clan llevaban escritas en
// `acciones.js` —con sus reglas de Firestore y sus pruebas de regresion— y no
// las llamaba NINGUNA pagina. El backend estaba entero y no habia interfaz: un
// lider no podia aceptar a nadie, ni expulsar, ni ceder el mando, ni invitar.
//
// Va aparte de `paginas/territorio.js` porque son dos cosas distintas que
// comparten pantalla: el mapa es de lectura y esto es de escritura. Juntarlas
// haria un fichero de seiscientas lineas donde cada cambio toca lo que no es.
//
// DE DONDE SALEN LOS NOMBRES. `usuarios` dejo de ser publica al cerrar la fuga
// de correos (#60), asi que el navegador no puede leer el perfil de otro. Sin
// eso, un lider veria una lista de identificadores y no sabria a quien esta
// expulsando. La plantilla llega por `agregados/clan-{id}`, que publica el
// worker con lo que ya es publico en las clasificaciones: nombre, avatar,
// puntos y viajes. Ni correo, ni ultima actividad.

import { db, doc, getDoc } from '/assets/js/firebase.js';
import { id, el, estado, reemplazar, confirmar, pedirTexto, avisar, esqueleto } from '/assets/js/dom.js';
import {
  MAX_MIEMBROS,
  crearClan, solicitarEntrada, retirarSolicitud, responderSolicitud,
  expulsarMiembro, cambiarOficial, cederLiderazgo, abandonarClan, disolverClan,
  crearInvitacion, usarInvitacion, confirmarEntrada,
} from '/assets/js/acciones.js';

/** Estado de la pantalla. Se vuelve a leer entero tras cada accion. */
let usuario = null;
let perfil = null;
let clan = null;          // agregados/clan-{id}
let clanId = null;

/** Lo que puede hacer quien esta mirando. */
function papel() {
  if (!clan || !usuario) return 'fuera';
  if (clan.lider === usuario.uid) return 'lider';
  if ((clan.oficiales || []).includes(usuario.uid)) return 'oficial';
  return 'miembro';
}

const mandaEnPlantilla = () => ['lider', 'oficial'].includes(papel());

// --- Piezas -------------------------------------------------------------------

function boton(texto, alPulsar, { clase = 'btn plano', peligroso = false } = {}) {
  return el('button', {
    clase: peligroso ? 'btn plano peligro' : clase,
    texto,
    attrs: { type: 'button' },
    on: {
      click: async (ev) => {
        const b = ev.currentTarget;
        // Sin esto, dos toques seguidos en un movil lento mandan la accion dos
        // veces. En "expulsar" da igual; en "ceder el liderazgo" no.
        b.disabled = true;
        try {
          await alPulsar();
        } catch (error) {
          avisar(error.message || 'No se ha podido completar la accion.');
        } finally {
          b.disabled = false;
        }
      },
    },
  });
}

/** Una fila de la plantilla, con lo que se puede hacer sobre esa persona. */
function filaMiembro(m) {
  const esLider = clan.lider === m.uid;
  const esOficial = (clan.oficiales || []).includes(m.uid);
  const soyYo = m.uid === usuario?.uid;

  const cargo = esLider ? 'Lider' : esOficial ? 'Oficial' : null;

  const acciones = [];

  // Al lider no se le expulsa ni se le degrada: primero cede el mando. Si no,
  // un oficial podria dejar el clan sin lider.
  if (papel() === 'lider' && !esLider) {
    acciones.push(boton(esOficial ? 'Quitar oficial' : 'Hacer oficial', async () => {
      await cambiarOficial(clanId, m.uid, !esOficial);
      await recargar();
    }));

    acciones.push(boton('Ceder el mando', async () => {
      const seguro = await confirmar(
        `Vas a ceder el liderazgo a ${m.nombre}. Dejaras de poder gestionar el clan `
        + 'y solo esa persona podra devolvertelo.',
        { textoAceptar: 'Ceder el mando', peligroso: true },
      );
      if (!seguro) return;
      await cederLiderazgo(clanId, m.uid);
      await recargar();
    }, { peligroso: true }));
  }

  if (mandaEnPlantilla() && !esLider && !soyYo) {
    acciones.push(boton('Expulsar', async () => {
      const seguro = await confirmar(`Vas a expulsar a ${m.nombre} del clan.`,
        { textoAceptar: 'Expulsar', peligroso: true });
      if (!seguro) return;
      await expulsarMiembro(clanId, m.uid);
      await recargar();
    }, { peligroso: true }));
  }

  return el('tr', {}, [
    el('th', { attrs: { scope: 'row' }, clase: 'nombre' }, [
      el('div', { texto: m.nombre + (soyYo ? ' (tu)' : '') }),
      el('div', {
        clase: 'clan',
        texto: [cargo, `${m.puntos} puntos`, `${m.viajes} viajes`,
          `${((m.metros || 0) / 1000).toFixed(0)} km`].filter(Boolean).join(' · '),
      }),
    ]),
    el('td', { clase: 'col-marca' }, acciones.length ? acciones : [el('span', { clase: 'apagado', texto: '—' })]),
  ]);
}

function tablaPlantilla() {
  const filas = (clan.miembros || []).map(filaMiembro);

  return el('div', { clase: 'tabla-scroll' }, [
    el('table', { clase: 'tabla' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { texto: `Plantilla (${filas.length}/${MAX_MIEMBROS})`, attrs: { scope: 'col' } }),
        el('th', { texto: '', attrs: { scope: 'col' } }),
      ])]),
      el('tbody', {}, filas),
    ]),
  ]);
}

/** Quien ha pedido entrar. Solo lo ve quien puede responder. */
function bloqueCandidatos() {
  const candidatos = clan.candidatos || [];
  if (!mandaEnPlantilla() || !candidatos.length) return null;

  return el('div', { clase: 'bloque' }, [
    el('p', { clase: 'etiqueta', texto: `Quieren entrar (${candidatos.length})` }),
    ...candidatos.map((c) => el('div', { clase: 'fila separada' }, [
      el('div', { clase: 'nombre', texto: c.nombre }),
      el('div', {}, [
        boton('Aceptar', async () => {
          await responderSolicitud(clanId, c.uid, true);
          await recargar();
        }),
        boton('Rechazar', async () => {
          await responderSolicitud(clanId, c.uid, false);
          await recargar();
        }, { peligroso: true }),
      ]),
    ])),
  ]);
}

/** Crear un enlace de invitacion. Solo el lider. */
function bloqueInvitacion() {
  if (papel() !== 'lider') return null;

  const salida = el('div', { clase: 'campo', estilo: { marginTop: 'var(--e3)' } });

  return el('div', { clase: 'bloque' }, [
    el('p', { clase: 'etiqueta', texto: 'Invitar' }),
    el('p', {
      clase: 'menor apagado',
      texto: 'El enlace vale una sola vez y caduca. Quien lo abra entra sin que tengas que aceptarlo.',
    }),
    boton('Crear enlace', async () => {
      const { enlace, caduca } = await crearInvitacion(clanId);

      // Un input de solo lectura y no un parrafo: en movil, seleccionar texto
      // suelto para copiarlo es un suplicio.
      const campo = el('input', {
        attrs: { type: 'text', readonly: 'readonly', value: enlace, 'aria-label': 'Enlace de invitacion' },
      });

      reemplazar(salida,
        campo,
        el('p', {
          clase: 'menor apagado',
          texto: `Caduca el ${caduca.toLocaleDateString('es-ES')}.`,
        }),
        boton('Copiar', async () => {
          try {
            await navigator.clipboard.writeText(enlace);
            avisar('Enlace copiado.', 'exito');
          } catch {
            // Sin permiso de portapapeles, al menos se deja seleccionado.
            campo.select();
            avisar('Copialo tu: no me dejan tocar el portapapeles.', 'info');
          }
        }, { clase: 'btn secundario' }));

      campo.focus();
      campo.select();
    }),
    salida,
  ]);
}

/** Salir, y disolver si eres el ultimo que manda. */
function bloqueSalida() {
  const soyLider = papel() === 'lider';
  const solo = (clan.miembros || []).length <= 1;

  return el('div', { clase: 'bloque' }, [
    el('p', { clase: 'etiqueta', texto: 'Dejar el clan' }),

    soyLider && !solo
      ? el('p', {
        clase: 'menor apagado',
        texto: 'Eres el lider: cede el mando a alguien de la plantilla antes de irte, '
          + 'o el clan se queda sin nadie que pueda gestionarlo.',
      })
      : boton('Salir del clan', async () => {
        const seguro = await confirmar('Vas a salir del clan. Tus puntos son tuyos y no se pierden.',
          { textoAceptar: 'Salir', peligroso: true });
        if (!seguro) return;
        await abandonarClan(clanId);
        await recargar();
      }, { peligroso: true }),

    soyLider && solo
      ? boton('Disolver el clan', async () => {
        const seguro = await confirmar(
          'Vas a disolver el clan. Desaparece del mapa y del ranking, y no hay vuelta atras.',
          { textoAceptar: 'Disolver', peligroso: true },
        );
        if (!seguro) return;
        await disolverClan(clanId);
        await recargar();
      }, { peligroso: true })
      : null,
  ]);
}

// --- Pantallas ----------------------------------------------------------------

function pintarConClan(destino) {
  reemplazar(destino,
    el('div', { clase: 'bloque' }, [
      el('div', { clase: 'fila separada' }, [
        el('div', {}, [
          el('h2', { clase: 'h2', texto: clan.nombre }),
          el('p', { clase: 'clan', texto: `${clan.biciRating || 0} puntos · ${clan.numMiembros || 0} miembros` }),
        ]),
        // El color va como fondo de un nodo propio, nunca interpolado dentro de
        // un atributo `style` de texto: asi se colaba codigo en la v1.
        el('span', {
          clase: 'marca-clan',
          attrs: { 'aria-hidden': 'true' },
          estilo: { background: /^#[0-9a-f]{3,8}$/i.test(clan.color || '') ? clan.color : 'var(--tinta-3)' },
        }),
      ]),
      clan.descripcion ? el('p', { clase: 'menor', texto: clan.descripcion }) : null,
    ]),
    bloqueCandidatos(),
    tablaPlantilla(),
    bloqueInvitacion(),
    bloqueSalida(),
  );
}

function pintarSinClan(destino) {
  const nombre = el('input', { attrs: { type: 'text', id: 'clan-nombre', maxlength: '28', placeholder: 'Los Rayos' } });
  const lema = el('input', { attrs: { type: 'text', id: 'clan-lema', maxlength: '120', placeholder: 'Opcional' } });
  const color = el('input', { attrs: { type: 'color', id: 'clan-color', value: '#2f6fed' } });

  reemplazar(destino,
    el('div', { clase: 'vacio' }, [
      el('h3', { texto: 'Todavia no estas en ningun clan' }),
      el('p', { texto: 'Los clanes se disputan las estaciones del mapa. Puedes crear uno o pedir entrar en otro desde la pestaña Clanes.' }),
    ]),

    el('div', { clase: 'bloque' }, [
      el('p', { clase: 'etiqueta', texto: 'Crear un clan' }),
      el('div', { clase: 'campo' }, [el('label', { texto: 'Nombre', attrs: { for: 'clan-nombre' } }), nombre]),
      el('div', { clase: 'campo' }, [el('label', { texto: 'Lema', attrs: { for: 'clan-lema' } }), lema]),
      el('div', { clase: 'campo' }, [el('label', { texto: 'Color', attrs: { for: 'clan-color' } }), color]),
      boton('Crear el clan', async () => {
        const clanNuevo = await crearClan({
          nombre: nombre.value.trim(),
          descripcion: lema.value.trim(),
          color: color.value,
        });
        avisar('Clan creado.', 'exito');
        clanId = clanNuevo;
        await recargar();
      }, { clase: 'btn' }),
    ]),

    el('div', { clase: 'bloque' }, [
      el('p', { clase: 'etiqueta', texto: 'Tengo un codigo de invitacion' }),
      boton('Usar un codigo', async () => {
        const codigo = await pedirTexto('Pega aqui el codigo de la invitacion', { textoAceptar: 'Entrar' });
        if (!codigo) return;
        await usarInvitacion(codigo.trim());
        avisar('Peticion enviada. En unos minutos estaras dentro.', 'exito');
        await recargar();
      }, { clase: 'btn secundario' }),
    ]),
  );
}

// --- Carga ---------------------------------------------------------------------

/**
 * Si el clan ya me lista pero mi perfil no lo sabe, lo confirmo.
 *
 * Aceptar a alguien solo toca el documento del CLAN: el `clanId` de la persona
 * lo escribe ella, porque su documento solo lo puede escribir ella. Sin este
 * paso, quien es aceptado se queda en un limbo — la plantilla le cuenta, su
 * perfil dice que no tiene clan — y no hay nada en pantalla que lo explique.
 */
async function confirmarSiHaceFalta(clanDelAgregado) {
  if (!clanDelAgregado || perfil?.clanId === clanDelAgregado.clanId) return false;
  if (!(clanDelAgregado.miembros || []).some((m) => m.uid === usuario.uid)) return false;

  await confirmarEntrada(clanDelAgregado.clanId);
  return true;
}

async function leerClan(cual) {
  if (!cual) return null;
  const snap = await getDoc(doc(db, 'agregados', `clan-${cual}`));
  return snap.exists() ? snap.data() : null;
}

export async function recargar() {
  const destino = id('panel-miclan');
  if (!destino) return;

  if (!usuario) {
    reemplazar(destino, el('div', { clase: 'vacio' }, [
      el('h3', { texto: 'Entra para unirte a un clan' }),
      el('p', {}, [el('a', { clase: 'btn', texto: 'Entrar', attrs: { href: '/entrar/' } })]),
    ]));
    return;
  }

  reemplazar(destino, ...esqueleto(3, 72));

  try {
    const suyo = await getDoc(doc(db, 'usuarios', usuario.uid));
    perfil = suyo.exists() ? suyo.data() : null;
    clanId = perfil?.clanId || null;

    clan = await leerClan(clanId);

    // Si el clan me lista y mi perfil aun no, se arregla solo y se relee.
    if (!clan) {
      const pendiente = new URLSearchParams(window.location.search).get('clan');
      const candidato = await leerClan(pendiente);
      if (await confirmarSiHaceFalta(candidato)) {
        clanId = candidato.clanId;
        clan = candidato;
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
 * Un enlace de invitacion abre `/territorio/?invitacion=CODIGO`.
 *
 * Se consume una sola vez y se limpia de la URL: dejarlo ahi hace que recargar
 * la pagina vuelva a intentarlo, y que el codigo acabe pegado en cualquier sitio
 * donde alguien comparta el enlace de su clan.
 */
async function atenderInvitacion() {
  const url = new URL(window.location.href);
  const codigo = url.searchParams.get('invitacion');
  if (!codigo || !usuario) return;

  url.searchParams.delete('invitacion');
  window.history.replaceState({}, '', url);

  try {
    await usarInvitacion(codigo);
    avisar('Invitacion aceptada. En unos minutos estaras dentro del clan.', 'exito');
  } catch (error) {
    avisar(error.message || 'Esa invitacion no se ha podido usar.');
  }
}

/** La arranca `paginas/territorio.js` cuando ya sabe si hay sesion. */
export async function iniciar(u) {
  usuario = u;
  await atenderInvitacion();
  await recargar();
}

/** Para que la pestaña "Clanes" pueda ofrecer pedir entrada. */
export async function pedirEntrada(cual) {
  if (!usuario) { window.location.assign('/entrar/'); return; }

  if (perfil?.clanId) {
    avisar('Ya estas en un clan. Sal de el antes de pedir entrar en otro.', 'info');
    return;
  }

  const yaPedida = clan === null && (await leerClan(cual))?.candidatos?.some((c) => c.uid === usuario.uid);

  if (yaPedida) {
    await retirarSolicitud(cual);
    avisar('Solicitud retirada.', 'exito');
  } else {
    await solicitarEntrada(cual);
    avisar('Solicitud enviada. Te avisaran cuando respondan.', 'exito');
  }
  await recargar();
}
