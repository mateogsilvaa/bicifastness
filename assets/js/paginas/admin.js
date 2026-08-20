// Modulo de la pagina /admin/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.


import {
  auth, db, onAuthStateChanged,
  collection, getDocs, query, where, orderBy,
} from '/assets/js/firebase.js';
import { iniciarPagina, nombreRuta, formatearFecha, formatearTiempo, normalizarEstacion } from '/assets/js/ui.js';
import { id, el, estado, reemplazar, imagen, confirmar, avisar, esqueleto } from '/assets/js/dom.js';
import { DICCIONARIO_INSIGNIAS } from '/insignias.js';
import {
  resolverViaje, resolverReporte, verCaptura,
  gestionarInsignia, destacarRuta,
} from '/assets/js/acciones.js';

iniciarPagina('admin');


// --- Control de acceso ---
onAuthStateChanged(auth, async (usuario) => {
  if (!usuario) { window.location.replace('/entrar/'); return; }

  // El rol se lee del token, que va firmado por Firebase. La version anterior
  // lo leia de un documento de Firestore que el propio usuario podia escribir,
  // asi que cualquiera se concedia el panel a si mismo.
  const token = await usuario.getIdTokenResult(true);
  if (token.claims.admin !== true) {
    id('cargando').textContent = 'No tienes permisos de administrador.';
    setTimeout(() => window.location.replace('/home/'), 1500);
    return;
  }

  id('cargando').classList.add('oculto');
  id('panel').classList.remove('oculto');
  cargarRevision();
  cargarReportes();
  cargarObjetivos();
});

// --- Viajes en revision ---
async function cargarRevision() {
  const rejilla = id('rejilla-revision');
  reemplazar(rejilla, esqueleto(3, 200));

  try {
    const snapshot = await getDocs(query(
      collection(db, 'tiempos_viaje'),
      where('estado', '==', 'revision'),
      orderBy('creado', 'desc')
    ));

    id('cuenta-revision').textContent = snapshot.size;

    if (snapshot.empty) {
      reemplazar(rejilla, el('div', { clase: 'vacio', texto: 'Todo al dia. No hay nada esperando revision.' }));
      return;
    }

    reemplazar(rejilla, snapshot.docs.map((doc) => tarjetaViaje(doc.id, doc.data())));
  } catch (error) {
    reemplazar(rejilla, el('div', { clase: 'vacio', texto: `Error al cargar: ${error.message}` }));
  }
}

/**
 * Tarjeta de un viaje.
 * Todo el texto entra por textContent y los botones por addEventListener.
 * La version anterior construia esto con `innerHTML +=` interpolando
 * `email_real` y `foto_url` — dos campos que controlaba quien subia el viaje —
 * tanto dentro del HTML como dentro de atributos onclick. Registrandose con un
 * nombre preparado se ejecutaba JavaScript aqui, en la sesion del admin.
 */
function tarjetaViaje(viajeId, viaje) {
  const auditoria = viaje.auditoria || {};
  const riesgo = auditoria.riesgo || 0;
  const clase = riesgo >= 50 ? 'riesgo-alto' : riesgo >= 25 ? 'riesgo-medio' : '';

  const botonAprobar = el('button', {
    clase: 'btn-aprobar', texto: 'Aprobar',
    on: { click: () => decidir(viajeId, 'aprobar', botonAprobar) },
  });
  const botonRechazar = el('button', {
    clase: 'btn-rechazar', texto: 'Rechazar',
    on: { click: () => decidir(viajeId, 'rechazar', botonRechazar) },
  });

  return el('article', { clase: `tarjeta ${clase}`, attrs: { 'data-viaje': viajeId } }, [
    el('div', { clase: 'cabecera' }, [
      el('span', { texto: nombreRuta(viaje.ruta) }),
      el('span', { texto: formatearTiempo(viaje.tiempoSegundos) }),
    ]),

    el('p', { clase: 'meta' }, [
      el('strong', { texto: viaje.username || 'Sin nombre' }),
      ` · ${formatearFecha(viaje.fechaViaje)}`,
      el('br'),
      auditoria.metros ? `${auditoria.metros} m estimados · ${auditoria.kmh} km/h de media` : '',
    ]),

    el('div', { clase: 'veredicto' }, [
      el('strong', { texto: `Riesgo ${riesgo} — ${auditoria.resumen || 'sin analisis'}` }),
      auditoria.señales?.length
        ? el('ul', {}, auditoria.señales.map((s) => el('li', { texto: `[${s.gravedad}] ${s.mensaje}` })))
        : null,
    ]),

    el('button', {
      clase: 'btn-ver', texto: 'Ver captura',
      on: { click: (e) => abrirCaptura(viajeId, e.currentTarget) },
    }),

    el('div', { clase: 'acciones' }, [botonRechazar, botonAprobar]),
  ]);
}

async function decidir(viajeId, accion, boton) {
  const confirmado = await confirmar(
    accion === 'aprobar'
      ? 'Aprobar este viaje y anadirlo al ranking?'
      : 'Rechazar este viaje? Dejara de contar para el ranking.',
    { textoAceptar: accion === 'aprobar' ? 'Aprobar' : 'Rechazar', peligroso: accion === 'rechazar' }
  );
  if (!confirmado) return;

  boton.disabled = true;
  boton.textContent = 'Guardando...';
  try {
    await resolverViaje(viajeId, accion);
    document.querySelector(`[data-viaje="${CSS.escape(viajeId)}"]`)?.remove();
    const contador = id('cuenta-revision');
    contador.textContent = Math.max(0, Number(contador.textContent) - 1);
  } catch (error) {
    boton.disabled = false;
    boton.textContent = accion === 'aprobar' ? 'Aprobar' : 'Rechazar';
    avisar(error.message);
  }
}

/** Pide al servidor una URL firmada de 10 minutos y la muestra. */
async function abrirCaptura(viajeId, boton) {
  const original = boton.textContent;
  boton.disabled = true;
  boton.textContent = 'Abriendo...';
  try {
    const url = await verCaptura(viajeId);
    const visor = id('visor');
    reemplazar(visor, imagen(url, { attrs: { alt: 'Captura del viaje' } }));
    visor.style.display = 'flex';
  } catch (error) {
    avisar(error.message);
  } finally {
    boton.disabled = false;
    boton.textContent = original;
  }
}

const visor = id('visor');
visor.addEventListener('click', () => { visor.style.display = 'none'; });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') visor.style.display = 'none';
});

// --- Reportes ---
async function cargarReportes() {
  const rejilla = id('rejilla-reportes');
  try {
    const snapshot = await getDocs(query(
      collection(db, 'reportes'),
      where('estado', '==', 'pendiente'),
      orderBy('creado', 'desc')
    ));

    id('cuenta-reportes').textContent = snapshot.size;

    if (snapshot.empty) {
      reemplazar(rejilla, el('div', { clase: 'vacio', texto: 'No hay reportes pendientes.' }));
      return;
    }

    reemplazar(rejilla, snapshot.docs.map((doc) => {
      const reporte = doc.data();
      const botonBorrar = el('button', {
        clase: 'btn-rechazar', texto: 'Eliminar viaje',
        on: { click: () => resolver(doc.id, 'eliminar_viaje', botonBorrar, reporte.viajeId) },
      });
      const botonIgnorar = el('button', {
        clase: 'btn-ver', texto: 'Falsa alarma',
        on: { click: () => resolver(doc.id, 'ignorar', botonIgnorar, reporte.viajeId) },
      });

      return el('article', { clase: 'tarjeta riesgo-alto', attrs: { 'data-reporte': doc.id } }, [
        el('div', { clase: 'cabecera' }, [el('span', { texto: `Reporte en ${nombreRuta(reporte.ruta)}` })]),
        el('p', { clase: 'meta', texto: reporte.motivo || 'Sin motivo indicado.' }),
        el('button', {
          clase: 'btn-ver', texto: 'Ver captura reportada',
          on: { click: (e) => abrirCaptura(reporte.viajeId, e.currentTarget) },
        }),
        el('div', { clase: 'acciones' }, [botonIgnorar, botonBorrar]),
      ]);
    }));
  } catch (error) {
    reemplazar(rejilla, el('div', { clase: 'vacio', texto: `Error: ${error.message}` }));
  }
}

async function resolver(reporteId, accion, boton, viajeId) {
  const confirmado = await confirmar(
    accion === 'ignorar' ? 'Marcar este reporte como falsa alarma?' : 'Eliminar el viaje reportado del ranking?',
    { peligroso: accion !== 'ignorar' }
  );
  if (!confirmado) return;

  boton.disabled = true;
  try {
    await resolverReporte(reporteId, accion, viajeId);
    document.querySelector(`[data-reporte="${CSS.escape(reporteId)}"]`)?.remove();
    const contador = id('cuenta-reportes');
    contador.textContent = Math.max(0, Number(contador.textContent) - 1);
  } catch (error) {
    boton.disabled = false;
    avisar(error.message);
  }
}

// --- Ruta destacada ---
id('btn-destacar').addEventListener('click', async () => {
  const boton = id('btn-destacar');
  boton.disabled = true;
  try {
    const ruta = `${normalizarEstacion(id('ruta-origen').value)}-${normalizarEstacion(id('ruta-destino').value)}`;
    await destacarRuta(ruta);
    estado(id('msg-destacar'), `Ruta ${ruta} destacada y puntuaciones recalculadas.`, 'exito');
  } catch (error) {
    estado(id('msg-destacar'), error.message, 'error');
  } finally {
    boton.disabled = false;
  }
});

// --- Insignias ---
let objetivos = [];

async function cargarObjetivos() {
  const [usuarios, clanes] = await Promise.all([
    getDocs(collection(db, 'usuarios')),
    getDocs(collection(db, 'clanes')),
  ]);
  objetivos = [
    ...usuarios.docs.map((d) => ({ id: d.id, tipo: 'usuarios', nombre: d.data().username || d.id, logros: d.data().logros || [] })),
    ...clanes.docs.map((d) => ({ id: d.id, tipo: 'clanes', nombre: d.data().nombre || d.id, logros: d.data().logros || [] })),
  ];
}

id('busca-objetivo').addEventListener('input', (evento) => {
  const termino = evento.target.value.trim().toLowerCase();
  const caja = id('resultados-busqueda');

  if (!termino) { caja.style.display = 'none'; return; }

  const encontrados = objetivos
    .filter((o) => o.nombre.toLowerCase().includes(termino))
    .slice(0, 10);

  reemplazar(caja, encontrados.length
    ? encontrados.map((o) => el('div', {
      on: { click: () => seleccionar(o) },
    }, [
      el('span', { texto: o.nombre }),
      el('span', { texto: o.tipo === 'usuarios' ? 'Piloto' : 'Clan', estilo: { color: 'var(--text-muted)' } }),
    ]))
    : [el('div', { texto: 'Sin resultados', estilo: { color: 'var(--text-muted)' } })]);

  caja.style.display = 'block';
});

document.addEventListener('click', (e) => {
  if (e.target.id !== 'busca-objetivo') id('resultados-busqueda').style.display = 'none';
});

function seleccionar(objetivo) {
  id('busca-objetivo').value = '';
  id('resultados-busqueda').style.display = 'none';
  id('objetivo-actual').textContent =
    `Editando: ${objetivo.nombre} (${objetivo.tipo === 'usuarios' ? 'piloto' : 'clan'})`;

  const rejilla = id('rejilla-insignias');
  reemplazar(rejilla, Object.entries(DICCIONARIO_INSIGNIAS).map(([clave, info]) => {
    const casilla = el('input', {
      attrs: { type: 'checkbox', checked: objetivo.logros.includes(clave) ? '' : null },
      estilo: { width: '18px', height: '18px', accentColor: 'var(--primary)' },
      on: {
        change: async (e) => {
          const otorgar = e.target.checked;
          e.target.disabled = true;
          try {
            await gestionarInsignia(objetivo.tipo, objetivo.id, clave, otorgar);
            objetivo.logros = otorgar
              ? [...objetivo.logros, clave]
              : objetivo.logros.filter((l) => l !== clave);
          } catch (error) {
            e.target.checked = !otorgar;
            avisar(error.message);
          } finally {
            e.target.disabled = false;
          }
        },
      },
    });

    return el('div', { clase: 'fila-insignia' }, [
      el('span', { estilo: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
        el('i', { clase: info.icono, estilo: { color: info.color } }),
        el('span', { texto: info.titulo }),
      ]),
      casilla,
    ]);
  }));
  rejilla.style.display = 'grid';
}
