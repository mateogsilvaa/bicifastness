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
  collection, getDocs, query, where,
} from '/assets/js/firebase.js';
import { crearPerfil, aceptarLegal } from '/assets/js/acciones.js';
import { iniciarPagina, pedirReaceptacion, nombreRuta, formatearTiempo, formatearFecha } from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';

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

  reemplazar(id('racha'), el('div', { clase: `aviso ${activoHoy ? 'ok' : 'atencion'}` }, [
    el('p', { clase: 'etiqueta', texto: `Racha de ${dias} ${dias === 1 ? 'dia' : 'dias'}` }),
    el('p', {
      texto: activoHoy
        ? 'Hoy ya esta salvado.'
        : escudos > 0
          ? `Hoy todavia no. Si no sales, se gasta un escudo (te quedan ${escudos}).`
          : 'Hoy todavia no, y no te quedan escudos: si no sales, la pierdes.',
    }),
  ]));
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
    const mios = await getDocs(query(
      collection(db, 'tiempos_viaje'),
      where('uid', '==', uid),
      where('verificado', '==', true),
    ));

    if (mios.empty) {
      reemplazar(destino, el('div', { clase: 'vacio' }, [
        el('h3', { texto: 'Todavia no tienes ningun trayecto' }),
        el('p', { texto: 'Sube la captura de tu proximo viaje y empiezas a puntuar.' }),
      ]));
      return;
    }

    const viajes = mios.docs.map((d) => d.data());
    // El mas reciente por fecha de viaje, no por fecha de subida: es el que la
    // persona recuerda haber hecho.
    const ultimo = viajes.slice().sort((a, b) =>
      String(b.fechaViaje || '').localeCompare(String(a.fechaViaje || '')))[0];

    // Puesto en esa ruta, contando solo la mejor marca de cada piloto.
    const enRuta = await getDocs(query(
      collection(db, 'tiempos_viaje'),
      where('ruta', '==', ultimo.ruta),
      where('verificado', '==', true),
    ));

    const mejorPorPiloto = new Map();
    for (const d of enRuta.docs) {
      const v = d.data();
      const previo = mejorPorPiloto.get(v.uid);
      if (!previo || v.tiempoSegundos < previo) mejorPorPiloto.set(v.uid, v.tiempoSegundos);
    }

    const orden = [...mejorPorPiloto.entries()].sort((a, b) => a[1] - b[1]);
    const puesto = orden.findIndex(([u]) => u === uid) + 1;

    reemplazar(destino, el('div', { clase: 'bloque' }, [
      el('p', { clase: 'etiqueta', texto: nombreRuta(ultimo.ruta) }),
      el('p', { clase: 'crono', texto: formatearTiempo(ultimo.tiempoSegundos), estilo: { margin: '0 0 var(--e4)' } }),

      el('div', { clase: 'fila', estilo: { gap: 'var(--e6)', flexWrap: 'wrap' } }, [
        dato('Tu puesto', puesto ? `${puesto} de ${orden.length}` : '—'),
        dato('Fecha', ultimo.fechaViaje ? formatearFecha(ultimo.fechaViaje) : '—', 'menor'),
        dato('Trayectos', String(viajes.length)),
      ]),

      // Solo se ofrece batir el record si no es tuyo: proponerselo a quien ya lo
      // tiene es ruido.
      puesto === 1
        ? el('p', { clase: 'menor apagado', estilo: { marginTop: 'var(--e4)', marginBottom: '0' },
            texto: 'Tienes el record de esta ruta. A ver cuanto lo aguantas.' })
        : el('p', { clase: 'menor apagado', estilo: { marginTop: 'var(--e4)', marginBottom: '0' },
            texto: `El mejor tiempo de esta ruta esta en ${formatearTiempo(orden[0][1])}.` }),
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

    if (datos.username) {
      id('titulo-panel').textContent = datos.username.toUpperCase();
    }

    // El orden importa: primero lo que se puede perder hoy, luego lo que se
    // puede hacer, y al final lo que ya paso.
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
