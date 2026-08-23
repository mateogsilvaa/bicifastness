// Modulo de la pagina /
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// Una sola ruta con dos caras: sin sesion cuenta que es esto, con sesion dice
// en que punto estas. Antes eran dos pantallas, y `/home/` no era mas que un
// indice de enlaces a las demas.

import {
  auth, db, onAuthStateChanged, doc, getDoc,
  collection, getDocs, getCountFromServer, query, where, orderBy, limit,
} from '/assets/js/firebase.js';
import { crearPerfil, aceptarLegal } from '/assets/js/acciones.js';
import { iniciarPagina, pedirReaceptacion, nombreRuta, formatearTiempo, formatearFecha } from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';
import { seguirViaje, viajeRecordado, olvidarViaje, pintarEstado } from '/assets/js/estado-viaje.js';
import { ofrecerInstalacion, guardarResumenOffline } from '/assets/js/instalar.js';
import { traerAgregado, puestoPorMarca } from '/assets/js/agregados.js';
import { destacar } from '/assets/js/celebrar.js';

iniciarPagina('ahora');

const landing = id('landing');
const panel = id('panel');

/** Hoy, en formato YYYY-MM-DD y hora local. */
function hoy() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * La racha, lo primero.
 *
 * Es lo unico de esta pantalla que se puede PERDER hoy, y por eso va arriba: la
 * pregunta que responde el panel es que hago hoy, no que hice.
 */
function pintarRacha(perfil) {
  const dias = perfil.racha || 0;
  const escudos = perfil.escudos || 0;
  const activoHoy = perfil.ultimoDiaActivo
    && new Date(perfil.ultimoDiaActivo).toDateString() === new Date().toDateString();

  if (!dias) {
    reemplazar(id('racha'), el('div', { clase: 'aviso' }, [
      el('p', { clase: 'etiqueta', texto: 'Racha' }),
      el('p', { texto: 'Sube un trayecto hoy y empiezas racha.' }),
    ]));
    return;
  }

  const contador = el('span', { clase: 'cifra', texto: String(dias) });

  reemplazar(id('racha'), el('div', { clase: `aviso ${activoHoy ? 'ok' : 'atencion'}` }, [
    el('p', { clase: 'etiqueta', texto: 'Racha' }),
    el('div', { clase: 'fila', estilo: { alignItems: 'baseline', gap: 'var(--e2)' } }, [
      contador,
      el('span', { texto: dias === 1 ? 'dia' : 'dias' }),
    ]),
    el('p', {
      estilo: { marginBottom: '0' },
      texto: activoHoy
        ? 'Hoy ya esta salvado.'
        : escudos > 0
          ? `Hoy todavia no. Si no sales, se gasta un escudo (te quedan ${escudos}).`
          : 'Hoy todavia no, y no te quedan escudos: si no sales, la pierdes.',
    }),
  ]));

  // Solo cuando SUBE, y comparando con lo que habia la ultima vez que se miro.
  // Pulsar en cada carga convierte el aviso en decoracion y deja de llamar la
  // atencion, que es lo unico que tiene que hacer (#51).
  if (subioLaRacha(dias)) destacar(contador);
}

/**
 * ¿Ha subido la racha desde la ultima vez que se pinto?
 *
 * Se guarda en la pestana, no en el disco: lo que interesa es "ha cambiado
 * desde que lo vi", y eso muere con la sesion. En `localStorage` un dato viejo
 * de hace tres semanas dispararia una celebracion sin motivo.
 */
function subioLaRacha(dias) {
  try {
    const previa = Number(sessionStorage.getItem('bf_racha_vista'));
    sessionStorage.setItem('bf_racha_vista', String(dias));
    return Number.isFinite(previa) && dias > previa;
  } catch {
    return false;
  }
}

/**
 * Las misiones del dia. Un solo documento, el mismo para todo el mundo.
 */
async function pintarMisiones(perfil) {
  try {
    const snap = await getDoc(doc(db, 'config', 'misiones', 'dias', hoy()));
    if (!snap.exists()) { reemplazar(id('misiones'), el('div', {})); return; }

    const progreso = perfil.misiones?.fecha === hoy() ? (perfil.misiones.progreso || []) : [];

    reemplazar(id('misiones'), el('div', { clase: 'bloque' }, [
      el('p', { clase: 'etiqueta', texto: 'Misiones de hoy' }),
      ...snap.data().misiones.map((m, i) => {
        const p = progreso[i];
        const hecha = p?.completada;

        return el('div', { clase: 'fila separada', estilo: { marginBottom: 'var(--e3)' } }, [
          el('div', {}, [
            el('div', { clase: 'nombre', texto: m.texto }),
            el('div', { clase: 'clan', texto: m.ayuda }),
          ]),
          el('span', {
            clase: `chip ${hecha ? 'verificado' : 'pendiente'}`,
            texto: hecha ? 'Hecha' : 'Pendiente',
          }),
        ]);
      }),
    ]));
  } catch (error) {
    console.debug('No se han podido cargar las misiones', error);
    reemplazar(id('misiones'), el('div', {}));
  }
}

/**
 * La ruta del dia: la clasificacion que empieza vacia cada mañana y que puede
 * ganar cualquiera, incluido quien se registro ayer.
 */
async function pintarRutaDelDia() {
  try {
    const snap = await getDoc(doc(db, 'config', 'general'));
    const ruta = snap.exists() ? snap.data().rutaDestacada : null;
    if (!ruta) { reemplazar(id('ruta-del-dia'), el('div', {})); return; }

    reemplazar(id('ruta-del-dia'), el('div', { clase: 'bloque' }, [
      el('p', { clase: 'etiqueta', texto: 'Ruta del dia · puntos x2' }),
      el('h2', { clase: 'h2', texto: nombreRuta(ruta) }),
      el('a', {
        clase: 'btn secundario',
        texto: 'Ver la clasificacion de hoy',
        attrs: { href: `/clasificacion/?ruta=${encodeURIComponent(ruta)}` },
      }),
    ]));
  } catch (error) {
    console.debug('No se ha podido cargar la ruta del dia', error);
    reemplazar(id('ruta-del-dia'), el('div', {}));
  }
}

/**
 * El viaje que se acaba de subir, mientras el worker lo mira.
 *
 * Solo se sigue el documento apuntado al subir, y solo dura lo que dure la
 * pestaña: no se busca "el ultimo viaje pendiente" con una consulta, porque eso
 * seria una lectura por viaje en cada carga de la portada, para algo que la
 * mayoria de las veces no existe.
 */
function seguirViajeEnCurso() {
  const destino = id('viaje-en-curso');
  const viajeId = viajeRecordado();
  if (!viajeId) return;

  seguirViaje(viajeId, (viaje) => {
    if (!viaje) { olvidarViaje(); reemplazar(destino); return; }

    pintarEstado(destino, viaje);
    // Ya hay veredicto: se ha contado aqui y no hace falta volver a contarlo en
    // la siguiente carga. A partir de ahora vive en el historial.
    if (viaje.estado !== 'pendiente') olvidarViaje();
  });
}

/** Bloque con una cifra grande y su etiqueta. */
function dato(etiqueta, valor, clase = 'cifra') {
  return el('div', {}, [
    el('p', { clase: 'etiqueta', texto: etiqueta }),
    el('p', { clase: clase, texto: valor, estilo: { margin: '0' } }),
  ]);
}

/**
 * Tu ultima marca y en que puesto te deja.
 *
 * El puesto es lo que hace que esto valga: "12:40" solo no dice nada; "12:40,
 * 3.o de 9" dice si hay algo que hacer hoy.
 */
async function pintarUltimaMarca(uid) {
  const destino = id('ultima-marca');
  reemplazar(destino, el('div', { clase: 'esqueleto fila' }));

  try {
    // Tres consultas acotadas en vez de dos sin techo (#37).
    //
    // Antes esto leia TODOS los viajes del piloto y despues TODOS los viajes
    // verificados de su ultima ruta. La segunda no tenia limite ninguno: una
    // ruta popular con 3.000 marcas costaba 3.000 lecturas cada vez que alguien
    // abria la portada, que es la pantalla que mas se abre.
    const [ultimoSnap, total] = await Promise.all([
      // El mas reciente por fecha de VIAJE, no de subida: es el que la persona
      // recuerda haber hecho.
      getDocs(query(
        collection(db, 'tiempos_viaje'),
        where('uid', '==', uid),
        where('verificado', '==', true),
        orderBy('fechaViaje', 'desc'),
        limit(1),
      )),
      // Cuenta sin traerse nada: una lectura por cada 1.000 contados.
      getCountFromServer(query(
        collection(db, 'tiempos_viaje'),
        where('uid', '==', uid),
        where('verificado', '==', true),
      )),
    ]);

    if (ultimoSnap.empty) {
      reemplazar(destino, el('div', { clase: 'vacio' }, [
        el('h3', { texto: 'Todavia no tienes ningun trayecto' }),
        el('p', { texto: 'Sube la captura de tu proximo viaje y empiezas a puntuar.' }),
      ]));
      return;
    }

    const ultimo = ultimoSnap.docs[0].data();
    const cuantos = total.data().count;

    // El puesto sale del agregado de la ruta, que el worker ya deja ordenado y
    // con una fila por piloto. Una lectura, y ademas cacheada en la pestana.
    const agregado = await traerAgregado(`ruta-${ultimo.ruta}`);
    const { puesto, total: pilotos } = puestoPorMarca(agregado, ultimo.tiempoSegundos);
    const mejor = agregado?.filas?.[0]?.marca ?? null;
    reemplazar(destino, el('div', { clase: 'bloque' }, [
      el('p', { clase: 'etiqueta', texto: nombreRuta(ultimo.ruta) }),
      el('p', { clase: 'crono', texto: formatearTiempo(ultimo.tiempoSegundos), estilo: { margin: '0 0 var(--e4)' } }),

      el('div', { clase: 'fila', estilo: { gap: 'var(--e6)', flexWrap: 'wrap' } }, [
        dato('Tu puesto', puesto ? `${puesto} de ${pilotos}` : '—'),
        dato('Fecha', ultimo.fechaViaje ? formatearFecha(ultimo.fechaViaje) : '—', 'menor'),
        dato('Trayectos', String(cuantos)),
      ]),

      // Solo se ofrece batir el record si no es tuyo: proponerselo a quien ya lo
      // tiene es ruido. `mejor` sale de la primera fila del agregado, que ya
      // viene ordenada; si el agregado aun no existe, no se dice nada en vez de
      // inventarse un tiempo.
      puesto === 1
        ? el('p', { clase: 'menor apagado', estilo: { marginTop: 'var(--e4)', marginBottom: '0' },
            texto: 'Tienes el record de esta ruta. A ver cuanto lo aguantas.' })
        : mejor !== null
          ? el('p', { clase: 'menor apagado', estilo: { marginTop: 'var(--e4)', marginBottom: '0' },
              texto: `El mejor tiempo de esta ruta esta en ${formatearTiempo(mejor)}.` })
          : null,
    ]));
  } catch (error) {
    console.debug('No se ha podido cargar la ultima marca', error);
    reemplazar(destino, el('div', {}));
    estado(id('mensaje'), 'No hemos podido cargar tus datos. Vuelve a intentarlo.', 'error');
  }
}

/** Estado del clan, si el piloto tiene uno. */
async function pintarClan(clanId) {
  const destino = id('estado-clan');
  if (!clanId) {
    reemplazar(destino, el('div', { clase: 'aviso' }, [
      el('p', { clase: 'etiqueta', texto: 'Sin clan' }),
      el('p', { texto: 'Los clanes se reparten las estaciones de la ciudad. Puedes unirte a uno desde tu perfil.' }),
    ]));
    return;
  }

  try {
    const clan = await getDoc(doc(db, 'clanes', clanId));
    if (!clan.exists()) { reemplazar(destino, el('div', {})); return; }

    const datos = clan.data();
    reemplazar(destino, el('div', { clase: 'bloque' }, [
      el('p', { clase: 'etiqueta', texto: 'Tu clan' }),
      el('h2', { clase: 'h2', texto: datos.nombre || clanId }),
      el('div', { clase: 'fila', estilo: { gap: 'var(--e6)', flexWrap: 'wrap' } }, [
        dato('BiciRating', String(datos.biciRating || 0)),
        dato('Miembros', String(datos.numMiembros || 0)),
      ]),
    ]));
  } catch (error) {
    console.debug('No se ha podido cargar el clan', error);
    reemplazar(destino, el('div', {}));
  }
}

// --- Sesion ------------------------------------------------------------------

onAuthStateChanged(auth, async (usuario) => {
  if (!usuario) {
    landing.classList.remove('oculto');
    panel.classList.add('oculto');
    return;
  }

  landing.classList.add('oculto');
  panel.classList.remove('oculto');

  try {
    const perfil = await getDoc(doc(db, 'usuarios', usuario.uid));

    // Si el alta se corto entre crear la cuenta en Auth y crear el perfil, la
    // sesion quedaba viva pero inservible: no se podia subir nada y no habia
    // forma de arreglarlo desde la interfaz.
    if (!perfil.exists()) {
      panel.classList.add('oculto');
      id('recuperar-perfil').classList.remove('oculto');
      return;
    }

    const datos = perfil.data();
    pedirReaceptacion(datos, aceptarLegal);

    // Copia minima para que /offline/ pueda ensenar algo util en vez del error
    // del navegador. Son datos propios y no salen de este movil.
    guardarResumenOffline(datos);

    // Solo sale si ya ha subido un viaje, si no esta instalada ya y si no dijo
    // que no antes.
    ofrecerInstalacion(id('invitacion-instalar'));

    if (datos.username) {
      id('titulo-panel').textContent = datos.username.toUpperCase();
    }

    // El orden importa: primero lo que se acaba de subir y esta en el aire,
    // luego lo que se puede perder hoy, luego lo que se puede hacer, y al final
    // lo que ya paso.
    seguirViajeEnCurso();
    pintarRacha(datos);
    await pintarMisiones(datos);
    await pintarRutaDelDia();
    await pintarUltimaMarca(usuario.uid);
    await pintarClan(datos.clanId || null);
  } catch (error) {
    console.debug('No se ha podido cargar el perfil', error);
    estado(id('mensaje'), 'No hemos podido cargar tu perfil. Vuelve a intentarlo.', 'error');
  }
});

// --- Alta a medias -----------------------------------------------------------

id('rec-enviar').addEventListener('click', async () => {
  const boton = id('rec-enviar');
  const mensaje = id('rec-mensaje');

  if (!id('rec-legal').checked) {
    estado(mensaje, 'Debes aceptar los terminos y la politica de privacidad.', 'error');
    return;
  }

  boton.disabled = true;
  try {
    await crearPerfil({ username: id('rec-username').value, email: auth.currentUser.email });
    window.location.reload();
  } catch (error) {
    estado(mensaje, error.message, 'error');
    boton.disabled = false;
  }
});
