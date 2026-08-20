// Modulo de la pagina /ranking/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.


import {
  auth, db, onAuthStateChanged,
  collection, getDocs, query, where, doc, getDoc,
} from '/assets/js/firebase.js';
import { iniciarPagina, nombreRuta, nombreEstacion, formatearFecha, formatearTiempo } from '/assets/js/ui.js';
import { id, el, estado, reemplazar, imagen, confirmar, avisar, esqueleto } from '/assets/js/dom.js';
import { generarNodosInsignias } from '/insignias.js';
import { reportarViaje, guardarFavoritas } from '/assets/js/acciones.js';

iniciarPagina('ranking');


let usuarioActual = null;
let favoritas = [];
let viajes = [];
let pilotos = new Map();
let rutas = [];
let rutaDestacada = null;
let rutaSeleccionada = null;

onAuthStateChanged(auth, async (usuario) => {
  usuarioActual = usuario;
  if (usuario) {
    const perfil = await getDoc(doc(db, 'usuarios', usuario.uid));
    favoritas = perfil.exists() ? (perfil.data().favoritas || []) : [];
  }
  cargar();
});

async function cargar() {
  reemplazar(id('lista'), esqueleto(5, 70));
  id('seccion-ranking').classList.remove('oculto');
  try {
    const [usuariosSnap, viajesSnap, confSnap] = await Promise.all([
      getDocs(collection(db, 'usuarios')),
      getDocs(query(collection(db, 'tiempos_viaje'), where('verificado', '==', true))),
      getDoc(doc(db, 'config', 'general')),
    ]);

    const ordenados = usuariosSnap.docs
      .map((d) => ({ uid: d.id, ...d.data() }))
      .sort((a, b) => (b.biciRating || 0) - (a.biciRating || 0));
    ordenados.forEach((u, i) => pilotos.set(u.uid, { ...u, puesto: i + 1 }));

    viajes = viajesSnap.docs.map((d) => ({ viajeId: d.id, ...d.data() }));
    rutas = [...new Set(viajes.map((v) => v.ruta))].sort();
    rutaDestacada = confSnap.exists() ? confSnap.data().rutaDestacada : null;
    if (rutaDestacada && !rutas.includes(rutaDestacada)) rutas.push(rutaDestacada);

    estado(id('mensaje'), '');
    pintarRutas();
  } catch (error) {
    estado(id('mensaje'), `No se han podido cargar los rankings: ${error.message}`, 'error');
  }
}

function botonRuta(ruta) {
  const clases = ['ruta-btn'];
  if (ruta === rutaDestacada) clases.push('destacada');
  if (ruta === rutaSeleccionada) clases.push('activa');
  return el('button', {
    clase: clases.join(' '),
    texto: `${ruta === rutaDestacada ? '🔥 ' : ''}${nombreRuta(ruta)}`,
    on: { click: () => seleccionar(ruta) },
  });
}

function pintarRutas() {
  const destacadas = [rutaDestacada, ...favoritas].filter(Boolean);
  const unicas = [...new Set(destacadas)];

  reemplazar(id('rutas'), unicas.length
    ? unicas.map(botonRuta)
    : [el('span', {
      texto: 'Busca una ruta arriba y anclala para tenerla siempre a mano.',
      estilo: { color: 'var(--text-muted)', fontSize: '.88rem', padding: '10px 0' },
    })]);
}

id('busca-ruta').addEventListener('input', (evento) => {
  const termino = evento.target.value.trim().toLowerCase();
  if (!termino) { pintarRutas(); return; }

  const coincide = rutas.filter((ruta) => {
    const [o, d] = ruta.split('-');
    return ruta.toLowerCase().includes(termino)
      || (nombreEstacion(o) || '').toLowerCase().includes(termino)
      || (nombreEstacion(d) || '').toLowerCase().includes(termino);
  });

  reemplazar(id('rutas'), coincide.length
    ? coincide.slice(0, 40).map(botonRuta)
    : [el('span', { texto: 'Ninguna ruta coincide.', estilo: { color: 'var(--text-muted)', padding: '10px 0' } })]);
});

function seleccionar(ruta) {
  rutaSeleccionada = ruta;
  id('seccion-ranking').classList.remove('oculto');
  reemplazar(id('titulo-ruta'), nombreRuta(ruta));

  const fijar = id('btn-fijar');
  const fijada = favoritas.includes(ruta);
  fijar.classList.toggle('fijada', fijada);
  reemplazar(fijar, el('i', { clase: fijada ? 'fi fi-sr-bookmark' : 'fi fi-rr-bookmark' }));

  // Solo el mejor tiempo de cada piloto entra en la clasificacion.
  const mejorPorPiloto = new Map();
  for (const viaje of viajes.filter((v) => v.ruta === ruta)) {
    const previo = mejorPorPiloto.get(viaje.uid);
    if (!previo || viaje.tiempoSegundos < previo.tiempoSegundos) mejorPorPiloto.set(viaje.uid, viaje);
  }

  const clasificacion = [...mejorPorPiloto.values()].sort((a, b) => a.tiempoSegundos - b.tiempoSegundos);

  if (!clasificacion.length) {
    reemplazar(id('lista'), el('div', { clase: 'vacio' }, [
      el('p', { texto: 'Aun no hay tiempos en esta ruta.', estilo: { margin: '0 0 6px', fontWeight: '700' } }),
      el('p', { texto: 'Se el primero en dominarla.', estilo: { margin: '0' } }),
    ]));
    return;
  }

  const mejor = clasificacion[0].tiempoSegundos;
  reemplazar(id('lista'), clasificacion.map((viaje, indice) => fila(viaje, indice, mejor)));
}

function fila(viaje, indice, mejor) {
  const puesto = indice + 1;
  const piloto = pilotos.get(viaje.uid) || {};
  const nombre = piloto.username || 'Piloto';
  const diferencia = viaje.tiempoSegundos - mejor;

  const avatar = imagen(
    piloto.avatarUrl || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(nombre)}&backgroundColor=0071c3`,
    { clase: 'avatar', attrs: { alt: `Avatar de ${nombre}`, loading: 'lazy' }, on: { click: () => abrirFicha(viaje.uid) } }
  );

  return el('div', { clase: `fila ${puesto <= 3 ? `p${puesto}` : ''}` }, [
    el('div', { clase: 'puesto', texto: `#${puesto}` }),
    avatar,
    el('div', {
      clase: 'piloto',
      attrs: { role: 'button', tabindex: '0' },
      on: {
        click: () => abrirFicha(viaje.uid),
        keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirFicha(viaje.uid); } },
      },
    }, [
      el('strong', { texto: nombre }),
      el('span', { texto: formatearFecha(viaje.fechaViaje) }),
    ]),
    el('div', { clase: 'marca' }, [
      el('strong', { texto: formatearTiempo(viaje.tiempoSegundos) }),
      el('span', { texto: puesto === 1 ? 'Lider' : `+${formatearTiempo(diferencia)}` }),
    ]),
    el('button', {
      clase: 'btn-reportar',
      attrs: { title: 'Reportar tiempo sospechoso', 'aria-label': `Reportar el tiempo de ${nombre}` },
      on: { click: (e) => reportar(viaje, e.currentTarget) },
    }, [el('i', { clase: 'fi fi-rr-flag' })]),
  ]);
}

async function reportar(viaje, boton) {
  if (!usuarioActual) { window.location.href = '/entrar/'; return; }

  const confirmado = await confirmar(
    'Vas a reportar este tiempo como sospechoso. Los reportes sin fundamento repetidos pueden acarrear la suspension de tu cuenta. Continuar?',
    { textoAceptar: 'Reportar', peligroso: true }
  );
  if (!confirmado) return;

  boton.disabled = true;
  try {
    await reportarViaje(viaje);
    estado(id('mensaje'), 'Reporte enviado. Un administrador lo revisara.', 'exito');
  } catch (error) {
    boton.disabled = false;
    avisar(error.message);
  }
}

id('btn-fijar').addEventListener('click', async () => {
  if (!usuarioActual) { window.location.href = '/entrar/'; return; }
  if (!rutaSeleccionada) return;

  const nuevas = favoritas.includes(rutaSeleccionada)
    ? favoritas.filter((r) => r !== rutaSeleccionada)
    : [...favoritas, rutaSeleccionada];

  if (nuevas.length > 3) {
    estado(id('mensaje'), 'Solo puedes anclar 3 rutas.', 'aviso');
    return;
  }

  try {
    await guardarFavoritas(nuevas);
    favoritas = nuevas;
    seleccionar(rutaSeleccionada);
    if (!id('busca-ruta').value.trim()) pintarRutas();
  } catch (error) {
    estado(id('mensaje'), error.message, 'error');
  }
});

// --- Ficha del piloto ---
function abrirFicha(uid) {
  const piloto = pilotos.get(uid);
  if (!piloto) return;

  const nombre = piloto.username || 'Piloto';
  const modal = id('modal-piloto');

  reemplazar(modal, el('div', { clase: 'ficha' }, [
    imagen(piloto.avatarUrl || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(nombre)}&backgroundColor=0071c3`,
      { attrs: { alt: `Avatar de ${nombre}` } }),
    el('h3', { texto: nombre, estilo: { margin: '14px 0 4px' } }),
    piloto.clanId ? el('p', { texto: `Clan: ${piloto.clanId}`, estilo: { color: 'var(--text-muted)', fontSize: '.85rem', margin: '0' } }) : null,
    el('div', { clase: 'cifras' }, [
      el('div', {}, [el('strong', { texto: String(piloto.biciRating || 0) }), el('span', { texto: 'BiciRating' })]),
      el('div', {}, [el('strong', { texto: `#${piloto.puesto}` }), el('span', { texto: 'Puesto global' })]),
      el('div', {}, [el('strong', { texto: String(piloto.viajesVerificados || 0) }), el('span', { texto: 'Viajes' })]),
    ]),
    el('div', { estilo: { display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center' } },
      generarNodosInsignias(piloto.logros || [])),
    el('button', { texto: 'Cerrar', on: { click: () => { modal.style.display = 'none'; } } }),
  ]));

  modal.style.display = 'flex';
}

id('modal-piloto').addEventListener('click', (e) => {
  if (e.target.id === 'modal-piloto') e.target.style.display = 'none';
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') id('modal-piloto').style.display = 'none';
});
