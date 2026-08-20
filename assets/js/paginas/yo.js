// Modulo de la pagina /yo/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.


import {
  auth, db, onAuthStateChanged, signOut,
  collection, getDocs, query, where, orderBy, doc, getDoc,
} from '/assets/js/firebase.js';
import { iniciarPagina, alternarTema, nombreRuta, formatearFecha, formatearTiempo } from '/assets/js/ui.js';
import { id, el, estado, reemplazar, confirmar, pedirTexto, esqueleto } from '/assets/js/dom.js';
import { generarNodosInsignias } from '/insignias.js';
import { impugnarViaje, exportarMisDatos, solicitarBorradoCuenta, guardarAvisosCorreo } from '/assets/js/acciones.js';

iniciarPagina('yo');


let usuario = null;

onAuthStateChanged(auth, async (u) => {
  if (!u) { window.location.replace('/entrar/'); return; }
  usuario = u;
  id('email').textContent = u.email;
  await cargarPerfil();
  await cargarHistorial();
});

async function cargarPerfil() {
  const snap = await getDoc(doc(db, 'usuarios', usuario.uid));
  if (!snap.exists()) {
    estado(id('msg-avatar'), 'Tu perfil aun no esta creado. Vuelve a registrarte.', 'aviso');
    return;
  }
  const perfil = snap.data();

  id('nombre').textContent = perfil.username || 'Piloto';
  id('rating').textContent = perfil.biciRating || 0;
  id('verificados').textContent = perfil.viajesVerificados || 0;
  id('clan').textContent = perfil.clanId ? `Clan: ${perfil.clanId}` : 'Sin clan';
  id('avatar').src = perfil.avatarUrl
    || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(perfil.username || 'P')}&backgroundColor=0071c3`;

  reemplazar(id('insignias'), generarNodosInsignias(perfil.logros || []));

  // Activados salvo que se hayan apagado a proposito: `undefined` significa que
  // nunca se ha tocado la preferencia, no que este desactivada.
  id('avisos-correo').checked = perfil.avisosCorreo !== false;

  pintarModos(perfil);
  await cargarTemporadas();
}

/**
 * Las tres cifras de los modos.
 *
 * Se calculan aqui, del propio documento del usuario, y no se leen de un
 * agregado: el agregado solo trae a quien puntua, y quien acaba de empezar no
 * sale en ninguno. Verse con ceros propios es mejor que no verse.
 */
function pintarModos(perfil) {
  const sprint = Object.values(perfil.puntosPorRuta || {}).reduce((t, p) => t + p, 0);

  id('modo-sprint').textContent = String(sprint);
  id('modo-fondo').textContent = ((perfil.metrosTotales || 0) / 1000).toFixed(1);
  id('modo-constancia').textContent = String(perfil.mejorRacha || 0);

  // La racha viva importa mas que la mejor historica cuando esta activa: es la
  // que se puede perder hoy.
  const viva = perfil.racha || 0;
  id('racha-actual').textContent = viva > 0
    ? `mejor racha · ${viva} ${viva === 1 ? 'dia' : 'dias'} ahora`
    : 'mejor racha';
}

/**
 * Historial de temporadas cerradas.
 *
 * Vive en una subcoleccion del propio usuario, asi que se borra con su cuenta
 * sin tener que ir a buscarlo a otro sitio.
 */
async function cargarTemporadas() {
  const destino = id('temporadas');

  try {
    const snap = await getDocs(collection(db, 'usuarios', usuario.uid, 'temporadas'));
    if (snap.empty) { reemplazar(destino, el('div', {})); return; }

    const filas = snap.docs
      .map((d) => d.data())
      .sort((a, b) => String(b.temporada).localeCompare(String(a.temporada)));

    reemplazar(destino,
      el('h2', { clase: 'h2', texto: 'Temporadas anteriores' }),
      el('div', { clase: 'tabla-scroll' }, [
        el('table', { clase: 'tabla' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { texto: 'Temporada', attrs: { scope: 'col' } }),
            el('th', { texto: 'Puesto', clase: 'col-marca', attrs: { scope: 'col' } }),
            el('th', { texto: 'Puntos', clase: 'col-fecha', attrs: { scope: 'col' } }),
          ])]),
          el('tbody', {}, filas.map((t) => el('tr', {}, [
            el('th', { texto: t.temporada, attrs: { scope: 'row' }, clase: 'nombre' }),
            el('td', { clase: 'col-marca' }, [
              el('span', { clase: 'marca', texto: t.posicion ? `${t.posicion}` : '—' }),
            ]),
            el('td', { clase: 'col-fecha menor apagado', texto: String(t.puntos || 0) }),
          ]))),
        ]),
      ]));
  } catch (error) {
    console.debug('No se han podido cargar las temporadas', error);
    reemplazar(destino, el('div', {}));
  }
}

async function cargarHistorial() {
  const contenedor = id('historial');
  reemplazar(contenedor, esqueleto(3, 74));
  try {
    const snapshot = await getDocs(query(
      collection(db, 'tiempos_viaje'),
      where('uid', '==', usuario.uid),
      orderBy('creado', 'desc')
    ));

    id('total-viajes').textContent = snapshot.size;

    if (snapshot.empty) {
      reemplazar(contenedor, el('div', { clase: 'vacio' }, [
        el('p', { texto: 'Aun no has subido ningun viaje.', estilo: { margin: '0 0 12px', fontWeight: '700' } }),
        el('a', { texto: 'Subir mi primer tiempo', attrs: { href: '/subir/' },
          estilo: { color: 'var(--primary-claro)', fontWeight: '700', textDecoration: 'none' } }),
      ]));
      return;
    }

    reemplazar(contenedor, snapshot.docs.map((d) => {
      const viaje = d.data();
      // El chip lleva SIEMPRE la palabra: el color no puede ser el unico
      // portador del estado.
      const estados = {
        aprobado: ['verificado', 'Verificado'],
        revision: ['revision', 'En revision'],
        rechazado: ['rechazado', 'Rechazado'],
      };
      const [clase, texto] = estados[viaje.estado] || ['pendiente', 'Pendiente'];

      return el('div', { clase: 'bloque' }, [
        el('div', { clase: 'fila separada' }, [
          el('div', {}, [
            el('div', { clase: 'nombre', texto: nombreRuta(viaje.ruta) }),
            el('div', { clase: 'clan', texto: formatearFecha(viaje.fechaViaje) }),
          ]),
          el('div', { estilo: { textAlign: 'right' } }, [
            el('div', { clase: 'marca', texto: formatearTiempo(viaje.tiempoSegundos) }),
            el('span', { clase: `chip ${clase}`, texto }),
          ]),
        ]),

        // Si se ha rechazado, el piloto merece saber por que.
        viaje.estado === 'rechazado' && (viaje.motivoRevision || viaje.auditoria?.resumen)
          ? el('div', { clase: 'aviso error', estilo: { marginTop: 'var(--e3)', marginBottom: '0' } }, [
            el('p', { clase: 'etiqueta', texto: 'Motivo' }),
            el('p', { texto: viaje.motivoRevision || viaje.auditoria.resumen }),
          ])
          : null,

        // Derecho a que una persona revise una decision automatica
        // (art. 22.3 RGPD). Solo tiene sentido si quien rechazo fue la maquina.
        viaje.estado === 'rechazado' && viaje.revisadoPor === 'automatico' && !viaje.impugnado
          ? el('button', {
            clase: 'btn plano',
            texto: 'Pedir revision humana',
            attrs: { type: 'button' },
            on: { click: (e) => impugnar(d.id, e.currentTarget) },
          })
          : null,

        viaje.impugnado
          ? el('p', { clase: 'menor apagado', estilo: { marginTop: 'var(--e3)', marginBottom: '0' },
              texto: 'Has pedido revision humana. Un administrador lo mirara.' })
          : null,
      ]);
    }));
  } catch (error) {
    reemplazar(contenedor, el('p', { texto: `No se ha podido cargar el historial: ${error.message}` }));
  }
}

/**
 * Pide que una persona revise un rechazo automatico.
 * Es un derecho del art. 22.3 del RGPD, no una cortesia: la politica de
 * privacidad lo promete y hasta ahora no habia forma de ejercerlo.
 */
async function impugnar(viajeId, boton) {
  const alegacion = await pedirTexto(
    'Explica por que crees que el rechazo es un error. Lo leera un administrador.',
    { etiqueta: 'Tu explicacion', textoAceptar: 'Pedir revision', minimo: 15,
      marcador: 'Por ejemplo: la captura es autentica, el trayecto lo hice el...' }
  );
  if (!alegacion) return;

  boton.disabled = true;
  boton.textContent = 'Enviando...';
  try {
    await impugnarViaje(viajeId, alegacion);
    estado(id('msg-datos'), 'Revision solicitada. Te responderemos por el estado del viaje.', 'ok');
    await cargarHistorial();
  } catch (error) {
    boton.disabled = false;
    boton.textContent = 'Pedir revision humana';
    estado(id('msg-datos'), error.message, 'error');
  }
}

// La subida de avatar se ha retirado: Cloud Storage exige el plan Blaze y
// meter la imagen en Firestore encareceria cada lectura del ranking, que trae
// todos los perfiles. El avatar se genera a partir del nombre de piloto.

// --- Acciones ---

/**
 * Interruptor de avisos por correo.
 *
 * Por defecto ACTIVADOS: los avisos son sobre los propios trayectos de quien los
 * recibe (un rechazo hay que poder arreglarlo), asi que es informacion del
 * servicio, no promocion. Quien no los quiera los apaga aqui o desde el enlace
 * de cualquier correo, sin tener que iniciar sesion.
 */
id('avisos-correo').addEventListener('change', async (evento) => {
  const casilla = evento.currentTarget;
  casilla.disabled = true;
  try {
    await guardarAvisosCorreo(casilla.checked);
    estado(id('msg-avisos'),
      casilla.checked ? 'Te avisaremos por correo.' : 'No volveremos a escribirte.', 'ok');
  } catch (error) {
    // Se devuelve la casilla a donde estaba: dejarla marcada cuando no se ha
    // guardado hace creer que si.
    casilla.checked = !casilla.checked;
    estado(id('msg-avisos'), error.message, 'error');
  } finally {
    casilla.disabled = false;
  }
});

id('btn-tema').addEventListener('click', alternarTema);
id('btn-salir').addEventListener('click', async () => {
  await signOut(auth);
  window.location.replace('/entrar/');
});

id('btn-exportar').addEventListener('click', async () => {
  const boton = id('btn-exportar');
  boton.disabled = true;
  estado(id('msg-datos'), 'Preparando la descarga...');
  try {
    const datos = await exportarMisDatos();
    const blob = new Blob([JSON.stringify(datos, null, 2)], { type: 'application/json' });
    const enlace = document.createElement('a');
    enlace.href = URL.createObjectURL(blob);
    enlace.download = `bicifastness-mis-datos-${new Date().toISOString().slice(0, 10)}.json`;
    enlace.click();
    URL.revokeObjectURL(enlace.href);
    estado(id('msg-datos'), 'Descarga lista.', 'exito');
  } catch (error) {
    estado(id('msg-datos'), error.message, 'error');
  } finally {
    boton.disabled = false;
  }
});

id('btn-borrar').addEventListener('click', async () => {
  const confirmado = await confirmar(
    'Vas a eliminar tu cuenta de forma permanente. Tus tiempos verificados se anonimizaran y perderas el acceso. Esta accion no se puede deshacer.',
    { textoAceptar: 'Eliminar mi cuenta', peligroso: true }
  );
  if (!confirmado) return;

  const escrito = await pedirTexto(
    'Esto es irreversible. Escribe la frase exacta para confirmar.',
    { etiqueta: 'Confirmacion', textoAceptar: 'Eliminar definitivamente',
      multilinea: false, exacto: 'BORRAR MI CUENTA', marcador: 'BORRAR MI CUENTA' }
  );
  if (escrito !== 'BORRAR MI CUENTA') {
    estado(id('msg-datos'), 'No se ha borrado nada.', 'aviso');
    return;
  }

  try {
    await solicitarBorradoCuenta('BORRAR MI CUENTA');
    window.location.replace('/entrar/');
  } catch (error) {
    estado(id('msg-datos'), error.message, 'error');
  }
});
