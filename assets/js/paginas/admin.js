// Modulo de la pagina /admin/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.


import {
  auth, db, onAuthStateChanged,
  collection, doc, getDoc, getDocs, query, where, orderBy, limit,
} from '/assets/js/firebase.js';
import { iniciarPagina, nombreRuta, nombreEstacion, formatearFecha, formatearTiempo, normalizarEstacion } from '/assets/js/ui.js';
import { id, el, icono, estado, reemplazar, imagen, confirmar, avisar, esqueleto, pedirTexto } from '/assets/js/dom.js';
import { MOTIVOS_MANUALES, textoDeMotivo } from '/assets/js/motivos.js';
import { montarCabeceraAdmin, contadorAdmin, marcarSeccionAdmin } from '/assets/js/admin-cabecera.js';
import { INSIGNIAS } from '/assets/data/insignias.js';
import {
  resolverViaje, resolverReporte, verCaptura,
  gestionarInsignia, destacarRuta, suspenderUsuario, escribirAPiloto,
} from '/assets/js/acciones.js';

iniciarPagina('admin');
montarCabeceraAdmin('revision', {
  // El buscador de la cabecera lleva a "Pilotos y clanes" con lo escrito.
  alBuscar: (texto) => {
    if (window.location.hash !== '#pilotos') window.location.hash = 'pilotos';
    const campo = id('busca-objetivo');
    campo.value = texto;
    campo.dispatchEvent(new Event('input'));
  },
});

// --- Secciones (por hash: #revision, #denuncias, #pilotos) --------------------
const SECCIONES = ['revision', 'denuncias', 'pilotos'];
function mostrarSeccion() {
  const pedida = window.location.hash.slice(1);
  const activa = SECCIONES.includes(pedida) ? pedida : 'revision';
  for (const sec of SECCIONES) id(`seccion-${sec}`).classList.toggle('oculto', sec !== activa);
  marcarSeccionAdmin(activa);
}
window.addEventListener('hashchange', mostrarSeccion);
mostrarSeccion();

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

// --- Cola de revision (09 · 9a) ------------------------------------------------
/**
 * Lista a la izquierda y el caso a la derecha, con TODO lo necesario para
 * decidir a la vez en pantalla: la captura al lado de lo declarado y lo leido,
 * por que ha llegado aqui y como se comporta ese piloto. Con el teclado se
 * resuelve y salta al siguiente: A aprobar, R rechazar, 1-8 motivo, J/K moverse.
 */
let cola = [];
let indice = 0;
let filtro = 'todos';
let motivoElegido = null;

/** A partir de aqui la cola deja de ser "unos casos" y es un problema. */
const COLA_PREOCUPANTE = 20;

/** Lo que pesa mas en cada codigo, para el color del borde (sin leer la auditoria). */
const GRAVES = ['captura_reutilizada', 'metadatos_edicion', 'velocidad_imposible', 'no_es_bicimad', 'captura_incoherente', 'duplicado_exacto'];
const ES_RECORD = (v) => (v.motivos || []).some((c) => /record/.test(c));

function riesgoDe(v) {
  if (v.impugnado) return 'bajo';
  const codigos = v.motivos || [];
  if (codigos.some((c) => GRAVES.includes(c))) return 'alto';
  return codigos.length ? 'medio' : 'bajo';
}

function porQueLlego(v) {
  if (v.impugnado) return 'Impugnado por el piloto';
  const primero = (v.motivos || [])[0];
  return primero ? textoDeMotivo(primero).texto : 'Sin señales: revisión manual';
}

function hace(fecha) {
  const t = fecha?.toDate?.()?.getTime?.();
  if (!t) return '';
  const min = Math.round((Date.now() - t) / 60000);
  return min < 60 ? `hace ${min} min` : min < 1440 ? `hace ${Math.round(min / 60)} h` : `hace ${Math.round(min / 1440)} d`;
}

const tramoCorto = (ruta) => String(ruta || '').split('-').map((c) => nombreEstacion(c) || c).join(' → ');

function visibles() {
  if (filtro === 'records') return cola.filter(({ viaje }) => ES_RECORD(viaje));
  if (filtro === 'impugnados') return cola.filter(({ viaje }) => viaje.impugnado);
  return cola;
}

async function cargarRevision() {
  reemplazar(id('caso'), esqueleto(1, 320));
  try {
    const snapshot = await getDocs(query(
      collection(db, 'tiempos_viaje'),
      where('estado', '==', 'revision'),
      orderBy('creado', 'desc')
    ));
    cola = snapshot.docs.map((d) => ({ id: d.id, viaje: d.data() }));
    indice = 0;
    pintarCola();
  } catch (error) {
    reemplazar(id('caso'), el('div', { clase: 'vacio', texto: `Error al cargar: ${error.message}` }));
  }
}

function actualizarContador() {
  id('cuenta-revision').textContent = String(cola.length);
  contadorAdmin('adm-cuenta-revision', cola.length);
  const aviso = id('aviso-cola');
  aviso.classList.toggle('oculto', cola.length <= COLA_PREOCUPANTE);
  aviso.textContent = `Hay ${cola.length} viajes esperando. Cada día que uno pasa en la cola `
    + 'es un día que alguien no sabe si su trayecto cuenta.';
}

function pintarFiltros() {
  const impugnados = cola.filter(({ viaje }) => viaje.impugnado).length;
  const records = cola.filter(({ viaje }) => ES_RECORD(viaje)).length;
  reemplazar(id('filtros-cola'), [
    ['todos', 'Todos'],
    ['records', `Récords${records ? ` · ${records}` : ''}`],
    ['impugnados', `Impugnados${impugnados ? ` · ${impugnados}` : ''}`],
  ].map(([clave, texto]) => el('button', {
    attrs: { type: 'button', 'aria-pressed': String(filtro === clave) }, texto,
    on: { click: () => { filtro = clave; indice = 0; pintarCola(); } },
  })));
}

function pintarCola() {
  actualizarContador();
  pintarFiltros();
  const lista = visibles();
  if (indice >= lista.length) indice = Math.max(0, lista.length - 1);
  reemplazar(id('lista-cola'), lista.map(({ id: viajeId, viaje }, i) => el('button', {
    clase: 'adm-item', attrs: { type: 'button', 'aria-current': i === indice ? 'true' : null, 'data-viaje': viajeId },
    on: { click: () => { indice = i; pintarCola(); } },
  }, [
    el('span', { clase: `adm-riesgo ${riesgoDe(viaje)}`, attrs: { 'aria-hidden': 'true' } }),
    el('span', { clase: 'adm-item-texto' }, [
      el('strong', { texto: tramoCorto(viaje.ruta) }),
      el('small', { texto: `${viaje.username || 'Sin nombre'} · ${hace(viaje.creado)}` }),
      el('em', { clase: riesgoDe(viaje), texto: porQueLlego(viaje) }),
    ]),
    el('span', { clase: 'adm-item-tiempo', texto: formatearTiempo(viaje.tiempoSegundos) }),
  ])));
  pintarCaso();
}

/** Fila del cotejo, marcada si lo leido no cuadra con lo declarado. */
function filaCotejo(campo, leido, declarado) {
  const falta = leido === null || leido === undefined || leido === '';
  const difiere = !falta && String(declarado) !== String(leido);
  return el('tr', { clase: difiere ? 'difiere' : '' }, [
    el('th', { texto: campo, attrs: { scope: 'row' } }),
    el('td', { texto: falta ? 'no se ha leído' : String(leido) }),
    el('td', { texto: String(declarado) }),
    el('td', { clase: difiere ? '' : 'ok', texto: falta ? '—' : difiere ? 'NO' : 'OK' }),
  ]);
}

/**
 * Lo leido contra lo declarado. Es la tabla que resuelve la mayoria de los
 * casos: si cuadra, lo que lo trajo aqui fue otra cosa.
 */
function cotejo(viaje, auditoria) {
  const lectura = auditoria?.lectura;
  if (!lectura) return el('p', { clase: 'meta', texto: 'De esta captura no se pudo leer nada: decide mirando la imagen.' });
  const [origen, destino] = String(viaje.ruta || '').split('-');
  const sinCeros = (v) => String(v ?? '').replace(/^0+/, '');
  const reloj = (seg) => (seg === null || seg === undefined ? null : formatearTiempo(seg));
  return el('div', { clase: 'adm-bloque' }, [
    el('table', { clase: 'adm-cotejo' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { texto: 'Campo' }), el('th', { texto: `Leído (confianza ${lectura.confianza ?? 0})` }), el('th', { texto: 'Declarado' }), el('th', { texto: '' }),
      ])]),
      el('tbody', {}, [
        filaCotejo('Salida', sinCeros(lectura.origen), sinCeros(origen)),
        filaCotejo('Meta', sinCeros(lectura.destino), sinCeros(destino)),
        filaCotejo('Duración', reloj(lectura.segundosDuracion), formatearTiempo(viaje.tiempoSegundos)),
        el('tr', {}, [
          el('th', { texto: 'Horas', attrs: { scope: 'row' } }),
          el('td', { texto: lectura.horaSalida ? `${lectura.horaSalida} → ${lectura.horaLlegada}` : 'no se han leído' }),
          el('td', { texto: '—' }), el('td', { texto: '' }),
        ]),
        el('tr', {}, [
          el('th', { texto: 'Fecha', attrs: { scope: 'row' } }),
          el('td', { texto: viaje.metadatos?.capturadaEn ? `fichero del ${formatearFecha(viaje.metadatos.capturadaEn)}` : '—' }),
          el('td', { texto: formatearFecha(viaje.fechaViaje) }), el('td', { texto: '' }),
        ]),
      ]),
    ]),
  ]);
}

/** Por que ha llegado aqui: las señales con sus numeros. SOLO en administracion. */
function porQue(auditoria = {}) {
  const señales = auditoria.señales || [];
  return el('div', { clase: 'adm-bloque relleno' }, [
    el('span', { clase: 'adm-rotulo', texto: `Señales del análisis (solo administración) · riesgo ${auditoria.riesgo || 0}` }),
    auditoria.metros ? el('span', { clase: 'meta', texto: `${auditoria.metros} m estimados · ${auditoria.kmh} km/h de media` }) : null,
    ...(señales.length
      ? señales.map((sn) => el('span', { clase: 'adm-senal' }, [
        el('span', {}, [el('code', { texto: sn.codigo || '' }), ` · ${sn.mensaje || ''}`]),
        el('strong', { texto: `gravedad ${sn.gravedad}` }),
      ]))
      : [el('span', { clase: 'meta', texto: 'Sin señales: ha llegado aquí por otra vía.' })]),
  ]);
}

/**
 * El cotejo y las señales viven en `auditorias/{viajeId}`, que solo lee la
 * administracion. Una lectura por caso revisado, y solo aqui.
 */
async function pintarAnalisis(viajeId, viaje, destino, etiquetas) {
  let auditoria = null;
  try {
    const snap = await getDoc(doc(db, 'auditorias', viajeId));
    auditoria = snap.exists() ? snap.data() : null;
  } catch (error) {
    reemplazar(destino, el('p', { clase: 'meta', texto: `Sin análisis: ${error.message}` }));
    return;
  }
  // Un viaje de antes de la mudanza todavia lo lleva dentro.
  const datos = auditoria || viaje.auditoria || null;
  if (!datos) {
    reemplazar(destino, el('p', { clase: 'meta', texto: 'Este viaje no tiene análisis guardado: decide mirando la captura.' }));
    return;
  }
  reemplazar(destino, [cotejo(viaje, datos), porQue(datos)]);
  reemplazar(etiquetas, [
    viaje.varianteCaptura ? el('span', { texto: viaje.varianteCaptura }) : null,
    el('span', { texto: viaje.metadatos?.software ? `EXIF: ${viaje.metadatos.software}` : 'EXIF: sin software' }),
    el('span', { texto: (datos.señales || []).some((sn) => /reutiliz|duplic/.test(sn.codigo || '')) ? 'huella repetida' : 'huella única' }),
  ]);
}

/** Los ocho motivos cerrados como botones, con el que sugiere el analisis ya elegido. */
function botonesMotivo(viaje) {
  const sugerido = (viaje.motivos || []).find((c) => MOTIVOS_MANUALES.includes(c)) || MOTIVOS_MANUALES[0];
  motivoElegido = sugerido;
  const contenedor = el('div', { clase: 'adm-motivos', attrs: { role: 'radiogroup', 'aria-label': 'Motivo si rechazas' } });
  const pintar = () => reemplazar(contenedor, [
    ...MOTIVOS_MANUALES.map((codigo, i) => el('button', {
      attrs: { type: 'button', role: 'radio', 'aria-pressed': String(motivoElegido === codigo), 'aria-checked': String(motivoElegido === codigo), title: textoDeMotivo(codigo).texto },
      on: { click: () => { motivoElegido = codigo; pintar(); } },
    }, [el('kbd', { texto: String(i + 1) }), el('span', { texto: CORTO[codigo] || codigo })])),
    el('button', {
      attrs: { type: 'button', role: 'radio', 'aria-pressed': String(motivoElegido === 'otro'), 'aria-checked': String(motivoElegido === 'otro') },
      on: { click: () => { motivoElegido = 'otro'; pintar(); } },
    }, [el('kbd', { texto: '9' }), el('span', { texto: 'Otro (lo escribo yo)' })]),
  ]);
  contenedor.elegir = (n) => {
    motivoElegido = n === 9 ? 'otro' : MOTIVOS_MANUALES[n - 1] || motivoElegido;
    pintar();
  };
  pintar();
  return contenedor;
}

/** Nombres cortos de los motivos para los botones (el texto largo va al piloto). */
const CORTO = {
  no_es_bicimad: 'No es BiciMAD',
  ruta_no_coincide: 'Ruta no coincide',
  tiempo_no_coincide: 'Tiempo no coincide',
  captura_incoherente: 'Captura incoherente',
  metadatos_edicion: 'Editada',
  captura_reutilizada: 'Reutilizada',
  velocidad_imposible: 'Velocidad imposible',
  lectura_no_disponible: 'Ilegible',
};

let selectorActual = null;

function pintarCaso() {
  const destino = id('caso');
  const lista = visibles();
  if (!lista.length) {
    reemplazar(destino, el('div', { clase: 'vacio' }, [
      el('h3', { texto: cola.length ? 'Nada con este filtro' : 'Todo al día' }),
      el('p', { texto: cola.length ? 'Cambia el filtro de la cola.' : 'No hay ningún viaje esperando revisión.' }),
    ]));
    return;
  }
  const { id: viajeId, viaje } = lista[indice];
  const historial = el('div', {}, [el('p', { clase: 'meta', texto: 'Cargando historial del piloto…' })]);
  const analisis = el('div', { clase: 'adm-datos' }, [el('p', { clase: 'meta', texto: 'Cargando el análisis…' })]);
  const etiquetas = el('div', { clase: 'adm-etiquetas' });
  const marco = el('div', { clase: 'adm-captura-marco' }, [el('div', { clase: 'esqueleto', estilo: { height: '420px' } })]);
  selectorActual = botonesMotivo(viaje);
  const riesgo = riesgoDe(viaje);
  const subido = viaje.creado?.toDate?.();

  reemplazar(destino, el('div', { clase: 'adm-caso' }, [
    el('div', { clase: 'adm-captura' }, [marco, etiquetas]),
    el('div', { clase: 'adm-datos' }, [
      el('div', { clase: 'adm-titulo' }, [
        el('div', {}, [
          el('h2', { texto: tramoCorto(viaje.ruta) }),
          el('p', { texto: [
            viaje.username || 'Sin nombre',
            subido ? `subido ${formatearFecha(subido)} ${subido.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}` : null,
            `viaje ${formatearFecha(viaje.fechaViaje)}`,
          ].filter(Boolean).join(' · ') }),
        ]),
        el('span', { clase: `chip ${riesgo === 'alto' ? 'rechazado' : riesgo === 'medio' ? 'revision' : 'pendiente'}`, texto: `Riesgo ${riesgo}` }),
      ]),
      viaje.uid ? el('div', {}, [botonEscribir(viaje.uid, `Trayecto ${tramoCorto(viaje.ruta)}`)]) : null,
      viaje.impugnado && viaje.alegacion ? el('div', { clase: 'adm-bloque relleno' }, [
        el('span', { clase: 'adm-rotulo', texto: 'Lo que dice el piloto al pedir revisión humana' }),
        el('span', { texto: viaje.alegacion }),
      ]) : null,
      analisis,
      historial,
      el('div', { clase: 'pila', estilo: { gap: 'var(--e2)' } }, [
        el('span', { clase: 'adm-rotulo', texto: 'Motivo si rechazas (llega tal cual al correo del piloto)' }),
        selectorActual,
      ]),
      el('div', { clase: 'adm-decidir' }, [
        el('button', { clase: 'btn aprobar', attrs: { type: 'button' }, on: { click: () => decidir('aprobar') } }, [icono('check', 'icono peq'), el('span', { texto: 'Aprobar' }), el('kbd', { texto: 'A' })]),
        el('button', { clase: 'btn peligro', attrs: { type: 'button' }, on: { click: () => decidir('rechazar') } }, [el('span', { texto: 'Rechazar' }), el('kbd', { texto: 'R' })]),
        el('span', { clase: 'hueco' }),
        el('span', { clase: 'pista', texto: `J / K para moverse · ${indice + 1} de ${lista.length}` }),
      ]),
    ]),
  ]));

  pintarAnalisis(viajeId, viaje, analisis, etiquetas);
  pintarHistorial(viaje.uid, historial);
  verCaptura(viajeId)
    .then((datos) => reemplazar(marco, imagen(datos, {
      attrs: { alt: 'Captura del viaje' },
      titulo: 'Pulsa para verla a pantalla completa',
      on: { click: () => ampliar(datos) },
    })))
    .catch((error) => reemplazar(marco, el('div', { clase: 'vacio', texto: error.message })));
}

/**
 * Como se comporta este piloto normalmente. Un descuadre raro en alguien con
 * veinte viajes limpios no significa lo mismo que en quien ya lleva dos
 * rechazos. Una consulta acotada por caso, solo en administracion.
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
    const cuantos = (e) => viajes.filter((v) => v.estado === e).length;
    const sospechosos = viajes.filter((v) => (v.motivos || []).length > 0).length;
    reemplazar(destino, el('p', { clase: 'meta' }, [
      el('strong', { texto: `Últimos ${viajes.length} viajes del piloto: ` }),
      `${cuantos('aprobado')} aprobados, ${cuantos('rechazado')} rechazados, ${cuantos('revision')} en revisión. `,
      sospechosos ? el('strong', { texto: `${sospechosos} con señales de riesgo.` }) : 'Ninguno con señales de riesgo.',
    ]));
  } catch (error) {
    reemplazar(destino, el('p', { clase: 'meta', texto: `Sin historial: ${error.message}` }));
  }
}

/**
 * Resuelve el caso y salta al siguiente. Sin dialogo de confirmacion: confirmar
 * cada decision solo añade un clic a algo que se hace diez veces seguidas. Lo
 * que protege de un error es el rastro en `auditoria_admin`.
 */
async function decidir(accion) {
  const lista = visibles();
  if (!lista.length) return;
  const { id: viajeId } = lista[indice];

  let motivo = null;
  if (accion === 'rechazar') {
    if (motivoElegido === 'otro') {
      motivo = await pedirTexto('Motivo del rechazo. Lo va a leer quien subió el viaje.', {
        etiqueta: 'Motivo', textoAceptar: 'Rechazar', minimo: 10,
      });
      if (!motivo) return;
    } else {
      // El texto sale de `motivos.js`, que es de donde sale tambien lo que ve
      // el piloto en su historial: un solo sitio para las dos cosas.
      motivo = textoDeMotivo(motivoElegido).texto;
    }
  }

  try {
    await resolverViaje(viajeId, accion, motivo);
    cola = cola.filter((c) => c.id !== viajeId);
    pintarCola();
  } catch (error) {
    avisar(`No se ha podido guardar: ${error.message}`);
  }
}

/** Atajos: A aprobar, R rechazar, 1-9 motivo, J/K moverse. */
document.addEventListener('keydown', (evento) => {
  if (evento.ctrlKey || evento.metaKey || evento.altKey) return;
  const foco = document.activeElement?.tagName;
  if (foco === 'INPUT' || foco === 'TEXTAREA' || foco === 'SELECT') return;
  if (id('visor').style.display === 'flex') return;
  if (id('seccion-revision').classList.contains('oculto')) return;
  const lista = visibles();
  if (!lista.length) return;

  const tecla = evento.key.toLowerCase();
  if (tecla === 'a') { evento.preventDefault(); decidir('aprobar'); }
  else if (tecla === 'r') { evento.preventDefault(); decidir('rechazar'); }
  else if (/^[1-9]$/.test(tecla)) { evento.preventDefault(); selectorActual?.elegir(Number(tecla)); }
  else if (tecla === 'j' || evento.key === 'ArrowDown') { evento.preventDefault(); indice = Math.min(indice + 1, lista.length - 1); pintarCola(); }
  else if (tecla === 'k' || evento.key === 'ArrowUp') { evento.preventDefault(); indice = Math.max(indice - 1, 0); pintarCola(); }
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
    contadorAdmin('adm-cuenta-denuncias', snapshot.size);

    if (snapshot.empty) {
      reemplazar(rejilla, el('div', { clase: 'vacio', texto: 'No hay reportes pendientes.' }));
      return;
    }

    reemplazar(rejilla, snapshot.docs.map((doc) => tarjetaDeReporte(doc)));
  } catch (error) {
    reemplazar(rejilla, el('div', { clase: 'vacio', texto: `Error: ${error.message}` }));
  }
}

/**
 * Un reporte, en la cola de moderacion.
 *
 * Hay dos clases y no se resuelven igual (#64):
 *
 *   - los de VIAJE los manda alguien desde la clasificacion. Llevan captura que
 *     mirar y se pueden resolver quitando el viaje del ranking
 *   - los de NOMBRE los pone el worker al ver un nombre de piloto o de clan con
 *     caracteres invisibles o una palabra de la lista. No hay captura que ver ni
 *     viaje que quitar: o es falsa alarma, o se suspende la cuenta
 *
 * Ensenar "Eliminar viaje" en uno de nombre seria un boton que no puede hacer
 * nada, y "Ver captura reportada" abriria un visor vacio.
 */
function tarjetaDeReporte(doc) {
  const reporte = doc.data();
  const esDeNombre = reporte.tipo === 'nombre';

  const botonIgnorar = el('button', {
    clase: 'btn plano', texto: 'Falsa alarma',
    on: { click: () => resolver(doc.id, 'ignorar', botonIgnorar, reporte.viajeId) },
  });

  const titulo = esDeNombre
    ? `Nombre de ${reporte.ambito === 'clan' ? 'clan' : 'piloto'} a revisar`
    : `Reporte en ${nombreRuta(reporte.ruta)}`;

  const acciones = [botonIgnorar];

  if (!esDeNombre) {
    const botonBorrar = el('button', {
      clase: 'btn peligro', texto: 'Eliminar viaje',
      on: { click: () => resolver(doc.id, 'eliminar_viaje', botonBorrar, reporte.viajeId) },
    });
    acciones.push(botonBorrar);
  }

  if (reporte.reportadoUid) {
    acciones.push(botonEscribir(reporte.reportadoUid, esDeNombre ? 'Tu nombre de piloto' : `Trayecto ${nombreRuta(reporte.ruta)}`));
  }
  acciones.push(botonSuspender(reporte));

  return el('article', { clase: 'tarjeta riesgo-alto', attrs: { 'data-reporte': doc.id } }, [
    el('div', { clase: 'cabecera' }, [el('span', { texto: titulo })]),
    el('p', { clase: 'meta', texto: reporte.motivo || 'Sin motivo indicado.' }),
    // El nombre, aparte y con `texto`, que es lo que nunca interpreta marcado.
    // Llega ya limpio de invisibles desde el worker, pero es el dato que ha
    // escrito un usuario y se pinta como tal.
    esDeNombre && reporte.nombre
      ? el('p', { clase: 'meta', texto: `Tal y como se ve: ${reporte.nombre}` })
      : null,
    esDeNombre ? null : el('button', {
      clase: 'btn plano', texto: 'Ver captura reportada',
      on: { click: (e) => abrirCaptura(reporte.viajeId, e.currentTarget) },
    }),
    el('div', { clase: 'acciones' }, acciones),
  ]);
}

/**
 * Escribir a un piloto por correo, desde bicifastness@gmail.com. Dos pasos:
 * asunto y texto. Lo envia el worker en su siguiente pasada; las respuestas
 * llegan a la bandeja del proyecto.
 */
function botonEscribir(uid, sobre = null) {
  const boton = el('button', {
    clase: 'btn plano',
    attrs: { type: 'button' },
    on: {
      click: async () => {
        const asunto = await pedirTexto('Asunto del correo', {
          multilinea: false, textoAceptar: 'Siguiente', minimo: 4, marcador: 'Sobre tu trayecto de ayer',
        });
        if (!asunto) return;
        const texto = await pedirTexto('¿Qué le quieres decir?', {
          etiqueta: sobre ? `Irá con la referencia «${sobre}» y firmado por el equipo.` : 'Irá firmado por el equipo.',
          textoAceptar: 'Enviar correo', minimo: 10,
        });
        if (!texto) return;
        boton.disabled = true;
        try {
          await escribirAPiloto(uid, { asunto: asunto.slice(0, 120), texto: texto.slice(0, 4000), sobre });
          boton.lastChild.textContent = 'Enviado';
        } catch (error) {
          avisar(error.message || 'No se ha podido enviar el mensaje.');
          boton.disabled = false;
        }
      },
    },
  }, [icono('correo', 'icono peq'), el('span', { texto: 'Escribir al piloto' })]);
  return boton;
}

/**
 * Suspender a quien reincide.
 *
 * `suspenderUsuario` llevaba escrita, con su regla, y no la llamaba ninguna
 * pantalla: el panel resolvia un reporte y no podia hacer nada con quien vuelve
 * a las andadas. Un circuito de moderacion que solo sabe borrar viajes de uno en
 * uno no es un circuito de moderacion.
 *
 * Va aqui y no en una pantalla de usuarios porque es donde se toma la decision:
 * con el caso delante. Y pide motivo, que se guarda: suspender sin dejar escrito
 * por que es como se acumulan las cuentas que nadie se atreve a reactivar.
 */
function botonSuspender(reporte) {
  if (!reporte.reportadoUid) return null;

  const boton = el('button', {
    clase: 'btn peligro',
    texto: 'Suspender al autor',
    on: {
      click: async () => {
        const motivo = await pedirTexto('¿Por que se suspende esta cuenta?', {
          textoAceptar: 'Suspender',
          etiqueta: 'Le llega al piloto por correo, tal cual, y queda en su perfil.',
          minimo: 10,
        });
        if (!motivo) return;

        boton.disabled = true;
        try {
          await suspenderUsuario(reporte.reportadoUid, true, motivo);
          boton.textContent = 'Suspendida';
        } catch (error) {
          avisar(error.message || 'No se ha podido suspender la cuenta.');
          boton.disabled = false;
        }
      },
    },
  });

  return boton;
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
      el('span', { texto: o.tipo === 'usuarios' ? 'Piloto' : 'Clan', estilo: { color: 'var(--tinta-3)' } }),
    ]))
    : [el('div', { texto: 'Sin resultados', estilo: { color: 'var(--tinta-3)' } })]);

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
  reemplazar(rejilla, Object.entries(INSIGNIAS).map(([clave, info]) => {
    const casilla = el('input', {
      attrs: { type: 'checkbox', checked: objetivo.logros.includes(clave) ? '' : null },
      estilo: { width: '18px', height: '18px', accentColor: 'var(--azul)' },
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
        // Del sprite propio. Antes era `<i class="fi fi-rr-home">`, de una
        // fuente de iconos que ninguna pagina carga ya y que la CSP no admite:
        // se pintaban cajas vacias.
        icono(info.icono),
        el('span', { texto: info.titulo }),
      ]),
      casilla,
    ]);
  }));
  rejilla.style.display = 'grid';
}
