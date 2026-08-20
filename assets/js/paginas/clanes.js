// Modulo de la pagina /clanes/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.


import {
  auth, db, onAuthStateChanged,
  collection, getDocs, doc, getDoc,
} from '/assets/js/firebase.js';
import { iniciarPagina } from '/assets/js/ui.js';
import { id, el, estado, reemplazar, confirmar, avisar, esqueleto } from '/assets/js/dom.js';
import { generarNodosInsignias } from '/cinsignias.js';
import {
  crearClan, solicitarEntrada, responderSolicitud,
  expulsarMiembro, abandonarClan, disolverClan,
} from '/assets/js/acciones.js';

iniciarPagina('clanes');

// Toda operacion de clan pasa por el servidor, que comprueba quien es lider y
// quien es miembro. Antes esta pagina escribia directamente en Firestore, asi
// que cualquiera podia meterse en un clan, expulsar a otros o disolverlo.

let usuario = null;
let perfil = null;
let clanes = [];
let pilotos = new Map();

onAuthStateChanged(auth, async (u) => {
  usuario = u;
  if (u) {
    const snap = await getDoc(doc(db, 'usuarios', u.uid));
    perfil = snap.exists() ? snap.data() : null;
  }
  await cargar();
});

async function cargar() {
  reemplazar(id('vista-lista'), el('div', { clase: 'rejilla' }, esqueleto(4, 170)));
  try {
    const [clanesSnap, usuariosSnap] = await Promise.all([
      getDocs(collection(db, 'clanes')),
      getDocs(collection(db, 'usuarios')),
    ]);
    clanes = clanesSnap.docs
      .map((d) => ({ clanId: d.id, ...d.data() }))
      .sort((a, b) => (b.biciRating || 0) - (a.biciRating || 0));
    pilotos = new Map(usuariosSnap.docs.map((d) => [d.id, d.data()]));
    estado(id('mensaje'), '');
    pintarLista();
    pintarMio();
  } catch (error) {
    estado(id('mensaje'), `No se han podido cargar los clanes: ${error.message}`, 'error');
  }
}

function pintarLista() {
  if (!clanes.length) {
    reemplazar(id('vista-lista'), el('div', { clase: 'vacio', texto: 'Aun no hay ningun clan. Se el primero en fundar uno.' }));
    return;
  }

  reemplazar(id('vista-lista'), el('div', { clase: 'rejilla' }, clanes.map((clan) => {
    const puedeSolicitar = usuario && perfil && !perfil.clanId;
    const yaSolicitado = (clan.solicitudes || []).includes(usuario?.uid);

    const tarjeta = el('article', { clase: 'clan' }, [
      el('h3', { texto: clan.nombre }),
      el('p', { texto: clan.descripcion || 'Sin descripcion.' }),
      el('div', { clase: 'clan-cifras' }, [
        el('span', {}, [el('strong', { texto: String(clan.biciRating || 0) }), ' puntos']),
        el('span', {}, [el('strong', { texto: String(clan.numMiembros ?? (clan.miembros || []).length) }), ' miembros']),
      ]),
      el('div', { estilo: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' } },
        generarNodosInsignias(clan.logros || [])),
      puedeSolicitar
        ? el('button', {
          texto: yaSolicitado ? 'Solicitud enviada' : 'Solicitar entrada',
          attrs: { disabled: yaSolicitado ? '' : null },
          on: { click: (e) => accion('solicitar', { clanId: clan.clanId }, e.currentTarget) },
        })
        : null,
    ]);

    // El servidor solo admite color hexadecimal; aqui ademas se asigna por
    // propiedad y no concatenando una cadena de estilos.
    tarjeta.style.borderLeftColor = clan.color || 'var(--primary)';
    return tarjeta;
  })));
}

function pintarMio() {
  const vista = id('vista-mio');
  const aviso = (texto) => reemplazar(vista, el('div', { clase: 'vacio', texto }));

  if (!usuario) return aviso('Inicia sesion para gestionar tu clan.');
  if (!perfil?.clanId) return aviso('No perteneces a ningun clan todavia.');

  const clan = clanes.find((c) => c.clanId === perfil.clanId);
  if (!clan) return aviso('Tu clan ya no existe.');

  const soyLider = clan.lider === usuario.uid;
  const solicitudes = soyLider ? (clan.solicitudes || []) : [];

  reemplazar(vista, el('div', { clase: 'card' }, [
    el('h2', { texto: clan.nombre }),
    el('p', { texto: clan.descripcion || '', estilo: { color: 'var(--text-muted)', fontSize: '.88rem' } }),

    el('h3', {
      texto: 'Miembros',
      estilo: { fontSize: '.85rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginTop: '22px' },
    }),
    ...(clan.miembros || []).map((uid) => el('div', { clase: 'miembro' }, [
      el('span', {}, [
        pilotos.get(uid)?.username || 'Piloto',
        ' ',
        clan.lider === uid ? el('span', { clase: 'lider', texto: 'Lider' }) : null,
      ]),
      soyLider && uid !== usuario.uid
        ? el('button', {
          texto: 'Expulsar',
          on: { click: (e) => accion('expulsar', { clanId: clan.clanId, miembroUid: uid }, e.currentTarget) },
        })
        : null,
    ])),

    solicitudes.length
      ? el('h3', {
        texto: 'Solicitudes pendientes',
        estilo: { fontSize: '.85rem', textTransform: 'uppercase', color: 'var(--text-muted)', marginTop: '24px' },
      })
      : null,

    ...solicitudes.map((uid) => el('div', { clase: 'miembro' }, [
      el('span', { texto: pilotos.get(uid)?.username || 'Piloto' }),
      el('span', { estilo: { display: 'flex', gap: '8px' } }, [
        el('button', {
          texto: 'Aceptar',
          estilo: { border: '1px solid var(--exito)', color: 'var(--exito)' },
          on: { click: (e) => accion('responder_solicitud', { clanId: clan.clanId, candidatoUid: uid, aceptar: true }, e.currentTarget) },
        }),
        el('button', {
          texto: 'Rechazar',
          on: { click: (e) => accion('responder_solicitud', { clanId: clan.clanId, candidatoUid: uid, aceptar: false }, e.currentTarget) },
        }),
      ]),
    ])),

    el('div', { estilo: { marginTop: '26px' } }, [
      soyLider
        ? el('button', {
          texto: 'Disolver clan',
          estilo: { background: 'transparent', border: '1px solid var(--error)', color: 'var(--error)' },
          on: {
            click: async (e) => {
              const ok = await confirmar(
                'Al disolver el clan todos sus miembros quedan libres y no podras fundar otro durante 5 dias. Continuar?',
                { textoAceptar: 'Disolver', peligroso: true });
              if (ok) accion('disolver', { clanId: clan.clanId }, e.currentTarget);
            },
          },
        })
        : el('button', {
          texto: 'Abandonar clan',
          estilo: { background: 'transparent', border: '1px solid var(--error)', color: 'var(--error)' },
          on: {
            click: async (e) => {
              const ok = await confirmar('Seguro que quieres abandonar el clan?', { peligroso: true });
              if (ok) accion('abandonar', {}, e.currentTarget);
            },
          },
        }),
    ]),
  ]));
}

// Cada accion es ahora una escritura directa a Firestore, validada por las
// reglas: solo el lider puede expulsar o disolver, y cualquiera puede meter o
// sacar su propia solicitud.
const OPERACIONES = {
  solicitar: (d) => solicitarEntrada(d.clanId),
  responder_solicitud: (d) => responderSolicitud(d.clanId, d.candidatoUid, d.aceptar),
  expulsar: (d) => expulsarMiembro(d.clanId, d.miembroUid),
  abandonar: (d) => abandonarClan(perfil.clanId),
  disolver: (d) => disolverClan(d.clanId),
};

async function accion(nombre, datos, boton) {
  if (boton) boton.disabled = true;
  try {
    await OPERACIONES[nombre](datos);
    const snap = await getDoc(doc(db, 'usuarios', usuario.uid));
    perfil = snap.exists() ? snap.data() : null;
    await cargar();
    estado(id('mensaje'), 'Hecho.', 'exito');
  } catch (error) {
    if (boton) boton.disabled = false;
    avisar(error.message);
  }
}

id('btn-crear').addEventListener('click', async () => {
  const boton = id('btn-crear');
  boton.disabled = true;
  try {
    await crearClan({
      nombre: id('nombre-clan').value,
      descripcion: id('desc-clan').value,
      color: id('color-clan').value,
    });
    estado(id('msg-crear'), 'Clan creado.', 'exito');
    const snap = await getDoc(doc(db, 'usuarios', usuario.uid));
    perfil = snap.exists() ? snap.data() : null;
    await cargar();
    cambiarPestana('mio');
  } catch (error) {
    estado(id('msg-crear'), error.message, 'error');
  } finally {
    boton.disabled = false;
  }
});

// --- Pestanas ---
function cambiarPestana(cual) {
  for (const nombre of ['lista', 'mio', 'crear']) {
    id(`vista-${nombre}`).classList.toggle('oculto', nombre !== cual);
    id(`tab-${nombre}`).classList.toggle('activa', nombre === cual);
  }
}
for (const nombre of ['lista', 'mio', 'crear']) {
  id(`tab-${nombre}`).addEventListener('click', () => cambiarPestana(nombre));
}
