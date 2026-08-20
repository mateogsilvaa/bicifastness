// Modulo de la pagina /admin/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.


import {
  auth, db, onAuthStateChanged,
  collection, getDocs, query, where, orderBy, limit,
} from '/assets/js/firebase.js';
import { iniciarPagina, nombreRuta, formatearFecha, formatearTiempo, normalizarEstacion } from '/assets/js/ui.js';
import { id, el, estado, reemplazar, imagen, confirmar, avisar, esqueleto, pedirTexto } from '/assets/js/dom.js';
import { MOTIVOS_MANUALES, textoDeMotivo } from '/assets/js/motivos.js';
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
    setTimeout(() => window.location.replace('/'), 1500);
    return;
  }

  id('cargando').classList.add('oculto');
  id('panel').classList.remove('oculto');
  cargarRevision();
  cargarReportes();
  cargarObjetivos();
});

// --- Cola de revision -------------------------------------------------------
/**
 * UN caso cada vez, no una rejilla de tarjetas.
 *
 * La revision manual es lo que se comio el tiempo en la v1, y va a seguir
 * existiendo porque el pipeline manda aqui lo dudoso a proposito. Lo que se
 * puede arreglar es lo que cuesta CADA caso, y con una rejilla costaba mucho:
 * abrir la captura en un visor, cerrarla, acordarse de lo que decia, compararlo
 * con lo declarado y decidir.
 *
 * Ahora esta todo a la vez en la pantalla: la captura al lado de lo declarado y
 * lo leido, con las diferencias marcadas; por que ha llegado aqui; y como se
 * comporta ese piloto normalmente. Con dos teclas se resuelve y salta al
 * siguiente.
 */
let cola = [];
let indice = 0;

/** A partir de aqui la cola deja de ser "unos casos" y es un problema. */
const COLA_PREOCUPANTE = 20;

async function cargarRevision() {
  const destino = id('caso');
  reemplazar(destino, esqueleto(1, 320));

  try {
    const snapshot = await getDocs(query(
      collection(db, 'tiempos_viaje'),
      where('estado', '==', 'revision'),
      orderBy('creado', 'desc')
    ));

    cola = snapshot.docs.map((d) => ({ id: d.id, viaje: d.data() }));
    indice = 0;
    pintarCaso();
  } catch (error) {
    reemplazar(destino, el('div', { clase: 'vacio', texto: `Error al cargar: ${error.message}` }));
  }
}

function actualizarContador() {
  id('cuenta-revision').textContent = String(cola.length);

  const aviso = id('aviso-cola');
  aviso.classList.toggle('oculto', cola.length <= COLA_PREOCUPANTE);
  aviso.textContent = `Hay ${cola.length} viajes esperando. Cada dia que uno pasa en la cola `
    + 'es un dia que alguien no sabe si su trayecto cuenta.';
}

/** Fila de la comparacion, marcada si lo leido no cuadra con lo declarado. */
function filaCotejo(campo, declarado, leido) {
  const falta = leido === null || leido === undefined || leido === '';
  const difiere = !falta && String(declarado) !== String(leido);

  return el('tr', { clase: difiere ? 'difiere' : '' }, [
    el('th', { texto: campo }),
    el('td', { texto: String(declarado) }),
    el('td', { texto: falta ? 'no se ha leido' : String(leido) }),
  ]);
}

/**
 * Lo declarado contra lo leido en la captura.
 *
 * Es la tabla que resuelve la mayoria de los casos: si las dos columnas
 * cuadran, el viaje casi siempre es bueno y lo que lo trajo aqui fue otra cosa.
 */
function cotejo(viaje) {
  const lectura = viaje.auditoria?.lectura;
  if (!lectura) {
    return el('p', { clase: 'meta', texto: 'De esta captura no se pudo leer nada: decide mirando la imagen.' });
  }

  const [origen, destino] = String(viaje.ruta || '').split('-');
  const sinCeros = (v) => String(v ?? '').replace(/^0+/, '');
  const reloj = (s) => (s === null || s === undefined ? null : formatearTiempo(s));

  return el('table', { clase: 'cotejo' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', { texto: '' }),
      el('th', { texto: 'Declarado' }),
      el('th', { texto: `Leido (confianza ${lectura.confianza ?? 0})` }),
    ])]),
    el('tbody', {}, [
      filaCotejo('Salida', sinCeros(origen), sinCeros(lectura.origen)),
      filaCotejo('Meta', sinCeros(destino), sinCeros(lectura.destino)),
      filaCotejo('Tiempo', formatearTiempo(viaje.tiempoSegundos), reloj(lectura.segundosDuracion)),
      filaCotejo('Horas', 'las de la captura', lectura.horaSalida ? `${lectura.horaSalida} a ${lectura.horaLlegada}` : null),
    ]),
  ]);
}

/** Por que ha llegado aqui: las señales tal cual, con su peso. */
function porQue(viaje) {
  const auditoria = viaje.auditoria || {};
  const señales = auditoria.señales || [];

  return el('div', { clase: 'veredicto' }, [
    el('strong', { texto: `Riesgo ${auditoria.riesgo || 0} — ${auditoria.resumen || 'sin analisis'}` }),
    auditoria.metros
      ? el('p', { clase: 'meta', texto: `${auditoria.metros} m estimados · ${auditoria.kmh} km/h de media` })
      : null,
    señales.length
      ? el('ul', {}, señales.map((s) => el('li', { texto: `[${s.gravedad}] ${s.mensaje}` })))
      : el('p', { clase: 'meta', texto: 'Sin señales: ha llegado aqui por otra via.' }),
  ]);
}

/**
 * Como se comporta este piloto normalmente.
 *
 * Un descuadre raro en alguien con veinte viajes limpios no significa lo mismo
 * que el mismo descuadre en quien ya lleva dos rechazos. Cuesta una consulta
 * acotada por caso, y solo la hace la administracion.
 */
async function pintarHistorial(uid, destino) {
  try {
    const snapshot = await getDocs(query(
      collection(db, 'tiempos_viaje'),
      where('uid', '==', uid),
      orderBy('creado', 'desc'),
      limit(20)
    ));

    const viajes = snapshot.docs.map((d) => d.data());
    const cuantos = (estado) => viajes.filter((v) => v.estado === estado).length;
    const sospechosos = viajes.filter((v) => (v.auditoria?.riesgo || 0) >= 25).length;

    reemplazar(destino, el('p', { clase: 'meta' }, [
      el('strong', { texto: `Ultimos ${viajes.length} viajes: ` }),
      `${cuantos('aprobado')} aprobados, ${cuantos('rechazado')} rechazados, `
      + `${cuantos('revision')} en revision. `,
      sospechosos
        ? el('strong', { texto: `${sospechosos} con señales de riesgo.` })
        : 'Ninguno con señales de riesgo.',
    ]));
  } catch (error) {
    reemplazar(destino, el('p', { clase: 'meta', texto: `Sin historial: ${error.message}` }));
  }
}

/**
 * Lista cerrada de motivos, con el que sugiere el analisis ya elegido.
 *
 * Que venga preseleccionado es medio ahorro de tiempo y medio consistencia: el
 * motor ya ha dicho lo que le chirria, y quien revisa casi siempre esta de
 * acuerdo. Cambiarlo es un clic.
 */
function selectorMotivo(viaje) {
  const señales = viaje.auditoria?.señales || [];
  const peor = señales
    .filter((s) => MOTIVOS_MANUALES.includes(s.codigo))
    .sort((a, b) => (b.gravedad || 0) - (a.gravedad || 0))[0];

  return el('select', { attrs: { id: 'motivo-rechazo', 'aria-label': 'Motivo del rechazo' } }, [
    ...MOTIVOS_MANUALES.map((codigo) => el('option', {
      texto: textoDeMotivo(codigo).texto,
      attrs: { value: codigo, selected: peor?.codigo === codigo ? '' : null },
    })),
    el('option', { texto: 'Otro (lo escribo yo)', attrs: { value: 'otro' } }),
  ]);
}

function pintarCaso() {
  const destino = id('caso');
  actualizarContador();

  if (!cola.length) {
    reemplazar(destino, el('div', { clase: 'vacio' }, [
      el('h3', { texto: 'Todo al dia' }),
      el('p', { texto: 'No hay ningun viaje esperando revision.' }),
    ]));
    return;
  }

  if (indice >= cola.length) indice = cola.length - 1;
  const { id: viajeId, viaje } = cola[indice];

  const historial = el('div', {}, [el('p', { clase: 'meta', texto: 'Cargando historial del piloto...' })]);
  const captura = el('div', { clase: 'caso-captura' }, [
    el('div', { clase: 'esqueleto', estilo: { height: '420px' } }),
  ]);

  const aprobar = el('button', {
    clase: 'btn-aprobar', texto: 'Aprobar (A)',
    on: { click: () => decidir('aprobar') },
  });
  const rechazar = el('button', {
    clase: 'btn-rechazar', texto: 'Rechazar (R)',
    on: { click: () => decidir('rechazar') },
  });

  reemplazar(destino, el('div', { clase: 'caso' }, [
    captura,

    el('div', {}, [
      el('div', { clase: 'cabecera' }, [
        el('span', { texto: nombreRuta(viaje.ruta) }),
        el('span', { texto: `${indice + 1} de ${cola.length}` }),
      ]),
      el('p', { clase: 'meta' }, [
        el('strong', { texto: viaje.username || 'Sin nombre' }),
        ` · ${formatearFecha(viaje.fechaViaje)}`,
      ]),

      cotejo(viaje),
      porQue(viaje),
      historial,

      el('div', { clase: 'acciones' }, [rechazar, aprobar]),

      el('div', { clase: 'campo', estilo: { marginTop: 'var(--e3)' } }, [
        el('label', { texto: 'Motivo si se rechaza', attrs: { for: 'motivo-rechazo' } }),
        selectorMotivo(viaje),
      ]),

      el('p', { clase: 'atajos meta' }, [
        'Teclado: ', el('kbd', { texto: 'A' }), ' aprobar · ',
        el('kbd', { texto: 'R' }), ' rechazar · ',
        el('kbd', { texto: 'J' }), ' / ', el('kbd', { texto: 'K' }), ' moverse por la cola',
      ]),
    ]),
  ]));

  pintarHistorial(viaje.uid, historial);

  verCaptura(viajeId)
    .then((datos) => reemplazar(captura, imagen(datos, {
      attrs: { alt: 'Captura del viaje' },
      titulo: 'Pulsa para verla a pantalla completa',
      estilo: { width: '100%', cursor: 'zoom-in' },
      on: { click: () => ampliar(datos) },
    })))
    .catch((error) => reemplazar(captura, el('div', { clase: 'vacio', texto: error.message })));
}

/**
 * Resuelve el caso y salta al siguiente.
 *
 * Sin dialogo de confirmacion: con los dos botones separados, el motivo a la
 * vista y la cola navegable hacia atras, confirmar cada decision solo añade un
 * clic a algo que se hace diez veces seguidas. Lo que si queda es rastro en
 * `auditoria_admin`, que es lo que de verdad protege de un error.
 */
async function decidir(accion) {
  if (!cola.length) return;
  const { id: viajeId } = cola[indice];

  let motivo = null;
  if (accion === 'rechazar') {
    const elegido = id('motivo-rechazo')?.value;
    if (elegido === 'otro') {
      motivo = await pedirTexto('Motivo del rechazo. Lo va a leer quien subio el viaje.', {
        etiqueta: 'Motivo', textoAceptar: 'Rechazar', minimo: 10,
      });
      if (!motivo) return;
    } else {
      // El texto sale de `motivos.js`, que es de donde sale tambien lo que ve
      // el piloto en su historial: un solo sitio para las dos cosas.
      motivo = textoDeMotivo(elegido).texto;
    }
  }

  try {
    await resolverViaje(viajeId, accion, motivo);
    cola.splice(indice, 1);
    pintarCaso();
  } catch (error) {
    avisar(`No se ha podido guardar: ${error.message}`);
  }
}

/** Atajos de teclado: diez casos seguidos a raton son diez casos lentos. */
document.addEventListener('keydown', (evento) => {
  if (evento.ctrlKey || evento.metaKey || evento.altKey) return;

  // Nada de atajos mientras se escribe o se elige en un desplegable, ni con la
  // captura abierta a pantalla completa.
  const foco = document.activeElement?.tagName;
  if (foco === 'INPUT' || foco === 'TEXTAREA' || foco === 'SELECT') return;
  if (id('visor').style.display === 'flex') return;
  if (!cola.length) return;

  const tecla = evento.key.toLowerCase();

  if (tecla === 'a') {
    evento.preventDefault();
    decidir('aprobar');
  } else if (tecla === 'r') {
    evento.preventDefault();
    decidir('rechazar');
  } else if (tecla === 'j' || evento.key === 'ArrowRight') {
    evento.preventDefault();
    indice = Math.min(indice + 1, cola.length - 1);
    pintarCaso();
  } else if (tecla === 'k' || evento.key === 'ArrowLeft') {
    evento.preventDefault();
    indice = Math.max(indice - 1, 0);
    pintarCaso();
  }
});

/** La captura a pantalla completa, para mirar un detalle. */
function ampliar(datos) {
  const visor = id('visor');
  reemplazar(visor, imagen(datos, { attrs: { alt: 'Captura ampliada' } }));
  visor.style.display = 'flex';
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
