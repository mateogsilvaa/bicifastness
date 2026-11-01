// Modulo de la pagina /yo/ (Tu).
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// Aqui se decide que se lee y cuando; como se pinta vive en `yo-vistas.js`.
//
// LO QUE CUESTA (docs/COSTE.md). El resumen lee el perfil, el clan, dos
// conteos (una lectura cada uno por cada mil contados) y cuatro agregados de
// clasificacion que se guardan en la sesion. El historial y las temporadas NO
// se leen hasta que alguien abre esa subpantalla: antes se pagaban veinte
// viajes en cada visita al perfil aunque nadie bajara a mirarlos.

import {
  auth, db, onAuthStateChanged, signOut,
  collection, getDocs, getCountFromServer, query, where, orderBy, limit, startAfter, doc, getDoc,
} from '/assets/js/firebase.js';
import { iniciarPagina, nombreRuta, temaElegido, elegirTema } from '/assets/js/ui.js';
import { id, el, estado, reemplazar, icono, abrirHoja, avisar } from '/assets/js/dom.js';
import {
  exportarMisDatos, solicitarBorradoCuenta, guardarAvisosCorreo, guardarFavoritas,
} from '/assets/js/acciones.js';
import { vaciarCache } from '/assets/js/cache.js';
import { prepararFoto, subirFoto, quitarFoto } from '/assets/js/foto-perfil.js';
import { ponerFoto, fotoPropiaLocal } from '/assets/js/foto-local.js';
import { abrirResuelto } from '/assets/js/veredicto.js';
import { guardarResumenOffline, olvidarResumenOffline } from '/assets/js/instalar.js';
import { traerAgregado } from '/assets/js/agregados.js';
import { sonidoActivo, activarSonido, sonar } from '/assets/js/celebrar.js';
import {
  suscribir, desuscribir, suscripcionActual,
} from '/assets/js/push.js';
import { guardarSuscripcionPush, olvidarSuscripcionPush, ajustarAvisoPush } from '/assets/js/acciones.js';
import { TIPOS as TIPOS_PUSH } from '/assets/data/push-tipos.js';
import { VERSION_APP } from '/assets/data/version.js';
import {
  pintarCabecera, pintarRating, pintarCifras, pintarMenu, pintarInsignias,
  nodosHistorial, FILTROS, pintarTemporadas, nombreMes,
  marcarAdministrador, marcarTienda, marcarAvisos,
} from '/assets/js/yo-vistas.js';
import { tiendaAbierta } from '/assets/js/tienda.js';
import { estadoAvisos, guiaAvisos, avisoDePrueba } from '/assets/js/guia-avisos.js';
import { leerVitrina, guardarVitrina, leerConfigRecompensas } from '/assets/js/vitrina.js';
import { REDES, limpiarUsuario } from '/assets/js/redes.js';
import { abrirTutorial } from '/assets/js/tutorial.js';
import { tieneDosPasos, activarDosPasos, desactivarDosPasos, mensajeDosPasos } from '/assets/js/dos-pasos.js';
import { banner, lema, cabeceraPiloto, colorAvatar } from '/assets/js/perfil-publico.js';
import { BANNERS, LEMAS, BANNER_POR_DEFECTO, laTiene, comoSeGana, imagenBanner, colaboracionDe } from '/assets/data/recompensas.js';

iniciarPagina('yo');

let usuario = null;
let perfil = null;

// --- Iconos de la maqueta -------------------------------------------------------
// Los enlaces de volver y el de ajustes solo llevan icono: su nombre accesible
// va en `aria-label`, en el HTML.
for (const volver of document.querySelectorAll('.subcabecera .boton-icono')) volver.prepend(icono('atras'));
id('ir-ajustes').append(icono('ajustes'));
id('ir-historial-e').prepend(icono('reloj'));
id('ir-ajustes-e').prepend(icono('ajustes'));
id('btn-salir').prepend(icono('salir'));
id('exportar-e').prepend(icono('descargar'));

// 8o: los botones de "Tus datos" hacen lo mismo que los de Mis datos, y el
// indice lleva a cada seccion sin cambiar de pantalla.
for (const boton of document.querySelectorAll('[data-igual]')) {
  boton.addEventListener('click', () => id(boton.dataset.igual).click());
}
for (const boton of document.querySelectorAll('[data-ir]')) {
  boton.addEventListener('click', () => {
    for (const b of document.querySelectorAll('[data-ir]')) b.removeAttribute('aria-current');
    boton.setAttribute('aria-current', 'true');
    id(boton.dataset.ir).scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// 8o: en escritorio el correo es un aviso mas; en el movil va en "Otros" (6e).
const escritorioAjustes = window.matchMedia('(min-width: 1200px)');
// Guardada aqui y no buscada cada vez: al repintar los avisos, la lista se
// vacia con la fila dentro y `id()` ya no la encuentra. Y `prepend(null)` pinta
// el texto "null" donde iba el correo.
const filaCorreo = id('fila-correo');
const colocarCorreo = () => {
  (escritorioAjustes.matches ? id('lista-avisos') : id('lista-otros')).prepend(filaCorreo);
  // Y la version, al pie del indice.
  if (escritorioAjustes.matches) document.querySelector('.indice-ajustes').append(id('pie-version'));
  else id('vista-ajustes').append(id('pie-version'));
};
escritorioAjustes.addEventListener('change', colocarCorreo);

// --- Vistas ------------------------------------------------------------------
//
// Una sola pagina y el hash decide que se ve. Moverse entre subpantallas no
// recarga ni vuelve a leer nada, y el boton atras del movil funciona solo.

const VISTAS = ['resumen', 'insignias', 'historial', 'temporadas', 'rutas', 'perfil', 'ajustes', 'datos', 'adios'];
const cargadas = new Set();

// Desde el correo de trayecto rechazado (10a): `?viaje=ID` abre ese trayecto en
// el historial y `&revision=1`, ademas, la hoja de "que lo mire una persona".
const deCorreo = new URLSearchParams(window.location.search);
let viajePedido = deCorreo.get('viaje');
const revisionPedida = deCorreo.get('revision') === '1';
if (viajePedido) {
  history.replaceState(null, '', `${window.location.pathname}#historial`);
}

function mostrarVista() {
  const pedida = window.location.hash.slice(1);
  const vista = VISTAS.includes(pedida) ? pedida : 'resumen';

  // 8m: en escritorio ancho no hace falta entrar a subpantallas para ver
  // insignias y temporadas: van en la columna lateral del resumen.
  const ancho = vista === 'resumen' && window.matchMedia('(min-width: 1200px)').matches;
  const lateral = ancho ? ['insignias'] : [];
  for (const v of VISTAS) id(`vista-${v}`).classList.toggle('oculto', v !== vista && !lateral.includes(v));
  id('principal').classList.toggle('yo-ancho', ancho);
  window.scrollTo(0, 0);

  if (perfil) {
    cargarVista(vista);
    for (const v of lateral) cargarVista(v);
    // Las barras de temporadas del resumen (8m) salen de la misma lectura.
    if (ancho) cargarVista('temporadas');
  }
}

/** Lo que cuesta lecturas se pide la primera vez que se abre, y solo entonces. */
function cargarVista(vista) {
  if (vista === 'insignias') pintarInsignias(perfil);
  if (vista === 'rutas') pintarFavoritas(perfil);

  if (cargadas.has(vista)) return;
  cargadas.add(vista);

  if (vista === 'historial') cargarHistorial();
  if (vista === 'temporadas') cargarTemporadas();
  if (vista === 'ajustes') montarAvisosPush(perfil);
  if (vista === 'perfil') cargarVitrina();
}

window.addEventListener('hashchange', mostrarVista);

onAuthStateChanged(auth, async (u) => {
  if (!u) { window.location.replace('/entrar/'); return; }
  usuario = u;
  // El rol de administrador va en el token firmado; leerlo no cuesta red.
  try { marcarAdministrador((await u.getIdTokenResult()).claims.admin === true); } catch { marcarAdministrador(false); }
  try {
    await cargarPerfil();
  } catch (error) {
    // Sin esto, un fallo de red dejaba Tu en blanco y sin decir nada.
    estado(id('msg-perfil'), 'No hemos podido cargar tu perfil. Comprueba la conexión y recarga.', 'error');
    console.error('No se ha podido cargar el perfil', error);
  }
  mostrarVista();
});

// --- Resumen -------------------------------------------------------------------

// Lo que completa la cabecera cuando llega: el clan y el grupo de la liga.
let clanDatos = null;
let claveGrupo = null;
let puestoGeneral = null;

// --- Foto de perfil ------------------------------------------------------------
// Tocar el avatar abre la hoja: elegir una foto (se reduce aqui mismo, en el
// navegador, a 128 px) o quitar la que hay. Una escritura por cambio.
function hojaFoto() {
  if (!perfil) return;
  const fichero = id('foto-fichero');
  const muestra = el('span', { clase: 'avatar-inicial', texto: [...(perfil.username || 'P')][0].toUpperCase() });
  ponerFoto(muestra, fotoPropiaLocal());
  const nota = el('p', { clase: 'apagado', texto: 'Se recorta en cuadrado y se reduce en tu móvil antes de subirla: nunca sale la foto original.' });
  const { cerrar } = abrirHoja([
    el('div', { clase: 'hoja-foto' }, [
      el('h2', { texto: 'Foto de perfil' }),
      muestra,
      nota,
      el('button', { clase: 'btn', texto: 'Elegir foto', attrs: { type: 'button' }, on: { click: () => fichero.click() } }),
      fotoPropiaLocal()
        ? el('button', {
          clase: 'btn secundario', texto: 'Quitar foto', attrs: { type: 'button' },
          on: {
            click: async () => {
              try {
                await quitarFoto(perfil);
                ponerFoto(id('avatar'), null);
                cerrar();
              } catch {
                avisar('No se ha podido quitar la foto. Vuelve a intentarlo.');
              }
            },
          },
        })
        : null,
    ]),
  ], { etiqueta: 'Foto de perfil', clase: 'dialogo-escritorio' });

  fichero.onchange = async () => {
    const elegido = fichero.files?.[0];
    fichero.value = '';
    if (!elegido) return;
    try {
      nota.textContent = 'Subiendo…';
      const foto = await prepararFoto(elegido);
      await subirFoto(perfil, foto);
      const { img } = foto;
      ponerFoto(id('avatar'), img);
      cerrar();
    } catch (error) {
      nota.textContent = error?.message && !/permission|insufficient/i.test(error.message)
        ? error.message
        : 'No se ha podido subir la foto. Vuelve a intentarlo.';
    }
  };
}
id('avatar')?.addEventListener('click', hojaFoto);

async function cargarPerfil() {
  const snap = await getDoc(doc(db, 'usuarios', usuario.uid));
  if (!snap.exists()) {
    estado(id('msg-perfil'), 'Tu perfil aún no está creado. Vuelve a la portada para terminar el alta.', 'error');
    return;
  }
  perfil = snap.data();
  // La ficha del lateral (08) y /offline/ salen de aqui: pintar el lateral no
  // puede costar una lectura en cada pagina.
  guardarResumenOffline(perfil);

  // Primero lo que ya esta en el documento, para que la pantalla no espere a
  // nada; despues se completa con lo que cuesta una lectura.
  pintarCabecera(perfil, clanDatos, claveGrupo);
  pintarRating(perfil);
  pintarCifras(perfil, null);
  pintarMenu(perfil);
  // Tu banner y tu lema en la tarjeta del resumen: una lectura, que la vista
  // de Perfil publico ya no repite (`leerVitrina` la guarda).
  leerVitrina(perfil.username).then((v) => { vitrina = v; pintarTarjetaVitrina(); }).catch(() => { /* se queda el de serie */ });
  estadoAvisos().then((s) => marcarAvisos(TEXTO_AVISOS[s])).catch(() => { /* sin estado, la entrada sin detalle */ });
  tiendaAbierta().then(marcarTienda).catch(() => { /* sin tienda, el menu de siempre */ });
  pintarAjustes(perfil);
  pintarDosPasos();
  comprobarAdmin().then(() => { if (esAdminToken) montarAvisosPush(perfil).catch(() => {}); });

  // Activados salvo que se hayan apagado a proposito: `undefined` significa que
  // nunca se ha tocado la preferencia, no que este desactivada.
  id('avisos-correo').checked = perfil.avisosCorreo !== false;
  colocarCorreo();

  await Promise.all([cargarClan(), contarTrayectos(), cargarPuestos()]);
}

/** El nombre y el color del clan. Un documento publico, una lectura. */
async function cargarClan() {
  if (!perfil.clanId) return;
  try {
    const clan = await getDoc(doc(db, 'clanes', perfil.clanId));
    if (clan.exists()) { clanDatos = clan.data(); pintarCabecera(perfil, clanDatos, claveGrupo); }
  } catch (error) {
    console.debug('No se ha podido leer el clan', error);
  }
}

/**
 * Cuantos trayectos ha subido, y cuantos esperan a una persona.
 *
 * Con la consulta de conteo, no trayendose la coleccion: Firestore cobra UNA
 * lectura por cada 1.000 documentos contados (#37). Si falla, las cifras se
 * quedan con lo que dice el perfil en vez de enseñar un cero que seria mentira.
 */
async function contarTrayectos() {
  const mios = [collection(db, 'tiempos_viaje'), where('uid', '==', usuario.uid)];
  const [total, enRevision] = await Promise.all([
    getCountFromServer(query(...mios)).then((r) => r.data().count).catch(() => null),
    getCountFromServer(query(...mios, where('estado', '==', 'revision')))
      .then((r) => r.data().count).catch(() => 0),
  ]);
  pintarCifras(perfil, total);
  pintarMenu(perfil, { enRevision });
}

/**
 * El puesto en el general y en cada modo, de los agregados de clasificacion.
 *
 * Los agregados no llevan uid (#60): la fila propia se encuentra por el nombre
 * de piloto, que es unico. Solo se mira la primera pagina (200): mas abajo no
 * se enseña puesto, y la barra de modos lo trata como "sin puesto".
 */
async function cargarPuestos() {
  const buscar = async (nombre) => {
    try {
      const agregado = await traerAgregado(nombre);
      const fila = agregado?.filas?.find((f) => f.nombre === perfil.username);
      return fila ? { pos: fila.pos, total: agregado.total ?? agregado.filas.length } : null;
    } catch {
      return null;
    }
  };
  const grupo = traerAgregado('grupos').then((g) => g?.porPiloto?.[perfil.username] || null).catch(() => null);
  const [general, sprint, fondo, constancia, clave] = await Promise.all([
    buscar('ranking-general'), buscar('ranking-sprint'), buscar('ranking-fondo'), buscar('ranking-constancia'), grupo,
  ]);
  pintarRating(perfil, { general, sprint, fondo, constancia });
  puestoGeneral = general;
  if (clave) { claveGrupo = clave; pintarCabecera(perfil, clanDatos, claveGrupo); }
}

// --- Perfil publico: banner y lema -----------------------------------------------
//
// Una lectura (tu vitrina) la primera vez que se abre, y una escritura por
// cada cambio. Lo que se puede elegir sale del catalogo; lo que tienes, de
// `perfil.recompensas`, que solo escriben el worker y la administracion.

let vitrina = null;
let configRec = null;

async function cargarVitrina() {
  [vitrina, configRec] = await Promise.all([leerVitrina(perfil.username), leerConfigRecompensas()]);
  id('ver-mi-ficha').href = `/clasificacion/?piloto=${encodeURIComponent(perfil.username)}`;
  // La fecha de alta se copia a la ficha publica una vez: el perfil es
  // privado y la ficha no puede leerlo.
  if (!vitrina.desde && perfil.creado?.toDate) {
    guardarVitrina(perfil, vitrina).then(() => { vitrina = { ...vitrina, desde: perfil.creado }; }).catch(() => { /* la proxima vez */ });
  }
  pintarVitrina();
  for (const red of Object.keys(REDES)) id(`red-${red}`).value = vitrina.redes?.[red] || '';
}

// --- Administracion ----------------------------------------------------------------
//
// Con el rol de admin (del token firmado, no del perfil), un acceso al panel
// desde Ajustes y el aviso de "trayecto para revisar" en la lista de avisos.

let esAdminToken = false;
async function comprobarAdmin() {
  try {
    esAdminToken = (await auth.currentUser?.getIdTokenResult())?.claims?.admin === true;
  } catch { esAdminToken = false; }
  id('sec-admin').classList.toggle('oculto', !esAdminToken);
  id('lista-admin').classList.toggle('oculto', !esAdminToken);
}

// --- Verificacion en dos pasos ----------------------------------------------------

function pintarDosPasos() {
  const activa = tieneDosPasos(auth.currentUser);
  id('dos-pasos').checked = activa;
  id('dos-pasos-detalle').textContent = activa
    ? 'Activada: al entrar te pediremos el código de tu app de autenticación'
    : 'Al entrar, además de la contraseña, un código de tu app de autenticación';
}

id('dos-pasos').addEventListener('change', async (evento) => {
  const casilla = evento.currentTarget;
  const quiere = casilla.checked;
  casilla.disabled = true;
  estado(id('msg-seguridad'), '');
  try {
    if (quiere) {
      const ok = await activarDosPasos(auth.currentUser);
      if (ok) estado(id('msg-seguridad'), 'Activada. La próxima vez que entres te pediremos el código.', 'exito');
    } else if (window.confirm('¿Quitar la verificación en dos pasos? Tu cuenta quedará protegida solo por la contraseña.')) {
      await desactivarDosPasos(auth.currentUser);
      estado(id('msg-seguridad'), 'Desactivada.', 'info');
    }
  } catch (error) {
    console.debug('Dos pasos', error);
    estado(id('msg-seguridad'), mensajeDosPasos(error), 'error');
  }
  casilla.disabled = false;
  pintarDosPasos();
});

id('ver-tutorial').addEventListener('click', () => abrirTutorial({ uid: usuario?.uid }));

id('panel-vitrina-redes').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const redes = {};
  for (const [red, datos] of Object.entries(REDES)) {
    const usuarioRed = limpiarUsuario(red, id(`red-${red}`).value);
    if (!usuarioRed) continue;
    if (!datos.patron.test(usuarioRed)) {
      estado(id('msg-vitrina'), `${datos.nombre}: ${datos.ayuda || 'ese nombre de usuario no es válido'}.`, 'error');
      id(`red-${red}`).focus();
      return;
    }
    redes[red] = usuarioRed;
  }
  await elegirVitrina({ redes });
  if (id('msg-vitrina').textContent === '') estado(id('msg-vitrina'), 'Redes guardadas.', 'exito');
});

/** La tarjeta del resumen: tu banner de fondo y tu lema. */
function pintarTarjetaVitrina() {
  if (!vitrina) return;
  id('banner-yo').className = 'banner-piloto';
  id('banner-yo').style.backgroundImage = `url("${imagenBanner(vitrina.banner)}")`;
  id('lema-yo').textContent = LEMAS[vitrina.lema] ? LEMAS[vitrina.lema].texto : 'Elige tu banner y tu lema';
}

// La pestaña abierta del editor y si estan desplegados los que faltan por ganar:
// se recuerdan para que elegir algo no lo pliegue todo otra vez.
const PANELES_VITRINA = ['banner', 'lema', 'redes'];
const verPorGanar = { banner: false, lema: false };

function mostrarPanelVitrina(cual) {
  for (const p of PANELES_VITRINA) {
    id(`tab-vitrina-${p}`).setAttribute('aria-selected', String(p === cual));
    id(`panel-vitrina-${p}`).classList.toggle('oculto', p !== cual);
  }
  estado(id('msg-vitrina'), '');
}
for (const p of PANELES_VITRINA) id(`tab-vitrina-${p}`).addEventListener('click', () => mostrarPanelVitrina(p));

function pintarVitrina() {
  pintarTarjetaVitrina();
  // Lo que tienes: lo ganado (`recompensas`) y lo que da una insignia que ya tienes.
  const tienes = (clave) => laTiene(clave, perfil, configRec);
  const nombre = perfil.username || 'Piloto';
  const avatar = colorAvatar(el('span', { clase: 'avatar-inicial', texto: [...nombre][0]?.toUpperCase() || 'P' }), clanDatos?.color);
  ponerFoto(avatar, fotoPropiaLocal());
  reemplazar(id('vitrina-previa'), cabeceraPiloto({
    nombre, avatar, banner: vitrina.banner, lema: vitrina.lema,
    redes: vitrina.redes, desde: vitrina.desde || perfil.creado,
    clan: clanDatos?.nombre || null, division: perfil.division || 'sin-clasificar',
  }));

  // Lo que tienes, a la vista; lo que falta, plegado: con 20 banners y 10 lemas
  // casi todo sera "por ganar", y no tiene que ocupar la pantalla.
  const pista = (texto) => estado(id('msg-vitrina'), texto);
  const plegable = (cual, cuantos, contenido) => {
    if (!cuantos) return null;
    const d = el('details', { clase: 'por-ganar', attrs: { open: verPorGanar[cual] ? '' : null } }, [
      el('summary', {}, [icono('candado'), el('span', { texto: `Por ganar · ${cuantos}` }), icono('abajo', 'icono chevron')]),
      ...contenido,
    ]);
    d.addEventListener('toggle', () => { verPorGanar[cual] = d.open; });
    return d;
  };

  // Banners: miniaturas en rejilla.
  // Los hechos con un artista o una empresa llevan su firma debajo.
  const pieColaboracion = (clave) => {
    const c = colaboracionDe(clave);
    return c ? el('span', { clase: 'colaboracion' }, ['bicifastness x', el('img', { attrs: { src: c.logo, alt: c.nombre, loading: 'lazy' } })]) : null;
  };
  const puesto = vitrina.banner || BANNER_POR_DEFECTO;
  const opcionBanner = ([clave, b]) => {
    const tiene = tienes(clave);
    return el('button', {
      clase: `opcion-banner${tiene ? '' : ' bloqueada'}`,
      attrs: {
        type: 'button', role: 'radio', 'aria-checked': String(tiene && clave === puesto),
        'aria-disabled': tiene ? null : 'true', 'aria-label': tiene ? b.titulo : `${b.titulo}, bloqueado`,
      },
      on: { click: () => (tiene ? elegirVitrina({ banner: clave }) : pista(`${b.titulo}: ${comoSeGana(clave, b.como, configRec)}`)) },
    }, [banner(clave), el('span', { texto: b.titulo }), pieColaboracion(clave), tiene ? null : icono('candado', 'icono candado-sobre')]);
  };
  const banners = Object.entries(BANNERS);
  const suyosB = banners.filter(([clave]) => tienes(clave));
  const faltanB = banners.filter(([clave]) => !tienes(clave));
  reemplazar(id('vitrina-banners'), [
    el('div', { clase: 'vitrina-opciones' }, suyosB.map(opcionBanner)),
    plegable('banner', faltanB.length, [el('div', { clase: 'vitrina-opciones' }, faltanB.map(opcionBanner))]),
  ]);

  // Lemas: chips que se ajustan al texto, cada uno con su estilo.
  const opcionLema = (clave) => {
    const datos = LEMAS[clave];
    const tiene = !clave || tienes(clave);
    return el('button', {
      clase: `opcion-lema${tiene ? '' : ' bloqueada'}`,
      attrs: {
        type: 'button', role: 'radio', 'aria-checked': String(tiene && (vitrina.lema || null) === (clave || null)),
        'aria-disabled': tiene ? null : 'true', 'aria-label': tiene ? (datos?.texto || 'Sin lema') : `${datos.texto}, bloqueado`,
      },
      on: { click: () => (tiene ? elegirVitrina({ lema: clave || null }) : pista(`${datos.texto}: ${comoSeGana(clave, datos.como, configRec)}`)) },
    }, !clave ? [el('span', { texto: 'Sin lema' })]
      : tiene ? [lema(clave)]
        : [icono('candado'), el('span', { texto: datos.texto })]);
  };
  const lemas = Object.keys(LEMAS);
  reemplazar(id('vitrina-lemas'), [
    el('div', { clase: 'vitrina-chips' }, [null, ...lemas.filter((c) => tienes(c))].map(opcionLema)),
    plegable('lema', lemas.filter((c) => !tienes(c)).length, [el('div', { clase: 'vitrina-chips' }, lemas.filter((c) => !tienes(c)).map(opcionLema))]),
  ]);
}

async function elegirVitrina(cambio) {
  const antes = vitrina;
  vitrina = { ...vitrina, ...cambio };
  pintarVitrina();
  try {
    await guardarVitrina(perfil, vitrina);
    estado(id('msg-vitrina'), '');
  } catch (error) {
    console.debug('No se ha podido guardar la vitrina', error);
    vitrina = antes;
    pintarVitrina();
    estado(id('msg-vitrina'), 'No se ha podido guardar. Vuelve a intentarlo.', 'error');
  }
}

// --- Rutas ancladas --------------------------------------------------------------

/**
 * Rutas ancladas (maximo tres, como impone la regla).
 *
 * Las opciones salen de `puntosPorRuta`, que ya esta en el documento leido: los
 * tramos donde el piloto ha puntuado. Ofrecer las 600 rutas de Madrid en un
 * desplegable no es ofrecer nada.
 */
function pintarFavoritas(datos) {
  const destino = id('favoritas');
  const suyas = Object.keys(datos.puntosPorRuta || {}).sort();
  const ancladas = new Set(datos.favoritas || []);

  if (!suyas.length) {
    reemplazar(destino, el('div', { clase: 'vacio' }, [
      el('h3', { texto: 'Todavía no has puntuado en ningún tramo' }),
      el('p', { texto: 'Cuando subas tu primer trayecto verificado podrás anclar tus rutas.' }),
    ]));
    return;
  }

  const alPulsar = async (ruta, casilla) => {
    const siguiente = new Set(ancladas);

    if (siguiente.has(ruta)) siguiente.delete(ruta);
    else if (siguiente.size >= 3) {
      // La regla de Firestore rechazaria la escritura, pero decirlo antes es
      // mejor que dejar que falle y enseñar un error.
      casilla.checked = false;
      estado(id('msg-favoritas'), 'Solo puedes anclar tres rutas. Quita una antes.', 'error');
      return;
    } else siguiente.add(ruta);

    casilla.disabled = true;
    try {
      await guardarFavoritas([...siguiente]);
      perfil = { ...perfil, favoritas: [...siguiente] };
      pintarFavoritas(perfil);
      pintarMenu(perfil);
    } catch (error) {
      casilla.checked = !casilla.checked;
      casilla.disabled = false;
      estado(id('msg-favoritas'), error.message || 'No se ha podido guardar.', 'error');
    }
  };

  reemplazar(destino,
    el('div', { clase: 'lista-ajustes' }, suyas.map((ruta) => {
      const casilla = el('input', {
        clase: 'interruptor',
        attrs: { type: 'checkbox', checked: ancladas.has(ruta) ? '' : null },
      });
      casilla.addEventListener('change', () => alPulsar(ruta, casilla));
      return el('label', {}, [el('span', { clase: 'texto', texto: nombreRuta(ruta) }), casilla]);
    })),
    el('p', { clase: 'mensaje', attrs: { id: 'msg-favoritas', 'aria-live': 'polite' } }));
}

// --- Temporadas ------------------------------------------------------------------

/**
 * Identificador de la temporada donde vive el historial migrado de la v1.
 * Lo escribe `scripts/migrar-datos.js`.
 */
const TEMPORADA_V1 = 'v1';

/**
 * Clave de orden de una temporada.
 *
 * Las temporadas son meses naturales (`2026-08`), asi que ordenar por el
 * identificador basta — salvo para `v1`, que empieza por letra y en un orden
 * descendente se colaria ARRIBA del todo. Justo al reves de lo que es: el
 * historial de la v1 es lo mas antiguo que tiene nadie.
 */
function ordenTemporada(temporada) {
  return temporada === TEMPORADA_V1 ? '0000-00' : String(temporada);
}

/**
 * Como se llama una temporada en pantalla.
 *
 * `v1` es un nombre interno: fuera de este repositorio nadie sabe que hubo una
 * v1 ni por que su historial esta aparte.
 */
function nombreTemporada(temporada) {
  return temporada === TEMPORADA_V1 ? 'Historial anterior' : nombreMes(temporada);
}

async function cargarTemporadas() {
  pintarTemporadas(perfil, [], puestoGeneral);
  try {
    // Vive en una subcoleccion del propio usuario, asi que se borra con su
    // cuenta sin tener que ir a buscarlo a otro sitio.
    const snap = await getDocs(collection(db, 'usuarios', usuario.uid, 'temporadas'));
    const cerradas = snap.docs
      .map((d) => d.data())
      .sort((a, b) => ordenTemporada(b.temporada).localeCompare(ordenTemporada(a.temporada)))
      .map((t) => ({ ...t, nombre: nombreTemporada(t.temporada) }));
    pintarTemporadas(perfil, cerradas, puestoGeneral);
  } catch (error) {
    console.debug('No se han podido cargar las temporadas', error);
  }
}

// --- Historial ---------------------------------------------------------------------

/**
 * Viajes por pagina del historial.
 *
 * Antes se traia el historial ENTERO. Quien lleva un año usando esto acumula
 * cientos de viajes, y todos se pagaban en cada visita (#37). Veinte llenan mas
 * de una pantalla de movil.
 */
const POR_PAGINA = 20;

/** Ultimo documento de la pagina traida, para pedir la siguiente desde ahi. */
let ultimoVisto = null;
let quedanMas = true;
let viajes = [];
let filtro = 'todos';

// Los filtros miran lo YA cargado, sin consultas nuevas: filtrar en el servidor
// pediria un indice por estado y una lectura por cada cambio de filtro.
reemplazar(id('filtros'), FILTROS.map((f) => {
  const boton = el('button', {
    texto: f.texto,
    attrs: { type: 'button', 'aria-pressed': String(f.clave === filtro) },
  });
  boton.addEventListener('click', () => {
    filtro = f.clave;
    for (const b of id('filtros').children) b.setAttribute('aria-pressed', String(b === boton));
    pintarHistorial();
  });
  return boton;
}));

function pintarHistorial() {
  reemplazar(id('historial'), [
    ...nodosHistorial(viajes, filtro, { alAbrir: abrirViaje }),
    quedanMas ? botonVerMas() : null,
  ]);
  if (viajePedido) {
    const fila = id('historial').querySelector(`.fila-viaje[data-viaje="${CSS.escape(viajePedido)}"]`);
    if (fila) {
      viajePedido = null;
      fila.click();
      // El detalle se monta en el siguiente fotograma; su boton, con el.
      if (revisionPedida) requestAnimationFrame(() => setTimeout(() => document.querySelector('.pedir-revision')?.click(), 50));
      return;
    }
  }
  // 8n: en escritorio el detalle vive al lado; se abre el primero.
  if (anchoHistorial() && !id('detalle-historial').childElementCount) {
    id('historial').querySelector('.fila-viaje')?.click();
  }
}

const anchoHistorial = () => window.matchMedia('(min-width: 1200px)').matches;

/** 6c: el detalle de 3k / 3l a pantalla entera; 8n: en el panel de al lado. */
function abrirViaje(viaje, fila) {
  const ancho = anchoHistorial();
  for (const f of id('historial').querySelectorAll('.fila-viaje.elegida')) f.classList.remove('elegida');
  if (ancho) fila.classList.add('elegida');
  // 3m: la hoja de "Que lo mire una persona" es la de veredicto.js; al
  // enviarla, el historial se vuelve a pedir para enseñar que esta pedida.
  abrirResuelto(viaje, {
    destino: ancho ? id('detalle-historial') : null,
    alPedirRevision: () => {
      estado(id('msg-historial'), 'Revisión pedida. Verás la respuesta en el propio trayecto.', 'ok');
      reemplazar(id('detalle-historial'));
      cargarHistorial();
    },
  });
}

async function cargarHistorial({ mas = false } = {}) {
  if (!mas) {
    reemplazar(id('historial'), el('div', { clase: 'esqueleto fila' }), el('div', { clase: 'esqueleto fila' }));
    ultimoVisto = null;
    quedanMas = true;
    viajes = [];
  }

  try {
    // `startAfter` continua desde donde se quedo la pagina anterior. Es
    // paginacion de verdad: Firestore solo cobra los documentos que devuelve.
    const partes = [
      collection(db, 'tiempos_viaje'),
      where('uid', '==', usuario.uid),
      orderBy('creado', 'desc'),
      ...(ultimoVisto ? [startAfter(ultimoVisto)] : []),
      limit(POR_PAGINA),
    ];
    const snapshot = await getDocs(query(...partes));

    ultimoVisto = snapshot.docs[snapshot.docs.length - 1] || ultimoVisto;
    quedanMas = snapshot.size === POR_PAGINA;
    viajes = [...viajes, ...snapshot.docs.map((d) => ({ id: d.id, datos: d.data() }))];
    pintarHistorial();
  } catch (error) {
    estado(id('msg-historial'), `No se ha podido cargar el historial: ${error.message}`, 'error');
  }
}

function botonVerMas() {
  const boton = el('button', { clase: 'btn tonal', texto: 'Ver más trayectos', attrs: { type: 'button' } });
  boton.style.width = '100%';
  boton.addEventListener('click', async () => {
    boton.disabled = true;
    boton.textContent = 'Cargando…';
    await cargarHistorial({ mas: true });
  });
  return boton;
}

// --- Ajustes ---------------------------------------------------------------------

const TEMAS = [
  { valor: 'sistema', texto: 'Sistema', muestra: 'sistema' },
  { valor: 'light', texto: 'Claro', muestra: 'claro', icono: 'sol' },
  { valor: 'dark', texto: 'Oscuro', muestra: 'oscuro', icono: 'luna' },
];

function pintarAjustes() {
  // Tres opciones y vista previa inmediata: la vista previa es la propia pagina.
  const pintarTemas = () => {
    const elegido = temaElegido();
    reemplazar(id('temas'), TEMAS.map((t) => {
      const boton = el('button', {
        attrs: { type: 'button', 'aria-pressed': String(t.valor === elegido) },
      }, [
        el('span', { clase: `muestra ${t.muestra}`, attrs: { 'aria-hidden': 'true' } },
          t.icono ? [icono(t.icono, 'icono peq')] : []),
        el('span', { texto: t.texto }),
      ]);
      boton.addEventListener('click', () => { elegirTema(t.valor); pintarTemas(); });
      return boton;
    }));
  };
  pintarTemas();

  reemplazar(id('pie-version'),
    el('span', { texto: `v${VERSION_APP} · ` }),
    el('a', { texto: 'Cómo funciona', attrs: { href: '/info/' } }),
    el('span', { texto: ' · ' }),
    el('a', { texto: 'Privacidad', attrs: { href: '/legal/privacidad/' } }),
    el('span', { texto: ' · ' }),
    el('a', { texto: 'Términos', attrs: { href: '/legal/terminos/' } }));
}

/**
 * Interruptor de avisos por correo.
 *
 * Por defecto ACTIVADOS: los avisos son sobre los propios trayectos de quien los
 * recibe (un rechazo hay que poder arreglarlo), asi que es informacion del
 * servicio, no promocion.
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

/**
 * Los interruptores de los avisos push (#33).
 *
 * El primero es el maestro: sin suscripcion no hay a donde enviar, asi que los
 * de tipo no significan nada hasta que exista. La seccion entera se oculta si el
 * navegador no puede recibir push.
 */
/** Lo que dice la entrada Avisos del menu, segun el estado de este movil. */
const TEXTO_AVISOS = { activos: 'Activados', 'sin-claves': 'Muy pronto', activables: 'Actívalos', bloqueado: 'Bloqueados', 'ios-instalar': 'Cómo activarlos', 'no-soportado': 'No disponibles' };

async function montarAvisosPush(datos) {
  // La seccion se ve siempre: cuando aqui no se puede, lo util es explicar
  // como se consigue (instalarla en iPhone, desbloquearlos...), no esconderla.
  id('ajustes-push').classList.remove('oculto');
  const situacion = await estadoAvisos();
  marcarAvisos(TEXTO_AVISOS[situacion]);

  const guia = guiaAvisos(situacion);
  if (guia) {
    reemplazar(id('lista-avisos'), guia);
    colocarCorreo();
    return;
  }

  const suscripcion = await suscripcionActual();
  const preferencias = datos.push?.avisos || {};

  const interruptor = (etiqueta, detalle, marcado, alCambiar, deshabilitado = false) => {
    const casilla = el('input', {
      clase: 'interruptor',
      attrs: { type: 'checkbox', checked: marcado ? '' : null, disabled: deshabilitado ? '' : null },
    });
    casilla.addEventListener('change', async () => {
      casilla.disabled = true;
      try {
        await alCambiar(casilla.checked);
        estado(id('msg-push'), '');
      } catch (error) {
        casilla.checked = !casilla.checked;
        estado(id('msg-push'), `No se ha podido guardar: ${error.message}`, 'error');
      } finally {
        casilla.disabled = false;
      }
    });

    return el('label', {}, [
      el('span', { clase: 'texto' }, [
        el('span', { texto: etiqueta }),
        detalle ? el('small', { texto: detalle }) : null,
      ]),
      casilla,
    ]);
  };

  const nodos = [
    interruptor(
      'Recibir avisos en este móvil',
      suscripcion ? 'En otro dispositivo hay que activarlo aparte.' : 'Te preguntará si los permites: elige «Permitir».',
      Boolean(suscripcion),
      async (activar) => {
        if (activar) {
          const nueva = await suscribir();
          if (!nueva) {
            // Ha dicho que no (o el movil no ha preguntado): se repinta, y si
            // quedo bloqueado sale como desbloquearlo.
            await montarAvisosPush(datos);
            return;
          }
          await guardarSuscripcionPush(nueva);
        } else {
          const vieja = await desuscribir();
          await olvidarSuscripcionPush(vieja);
        }
        // Se vuelve a montar: los de tipo dependen de que exista suscripcion.
        await montarAvisosPush({ ...datos, push: { ...datos.push, suscripciones: activar ? [1] : [] } });
      }),
  ];

  // 8o: a la derecha, cuando o donde llega cada uno.
  const NOTAS = { revisionPendiente: 'solo admin', viajeResuelto: 'aceptado o no', rachaEnPeligro: '20:00', recordPerdido: '1.º puesto', adelantado: 'tus tramos', recompensa: 'eventos y logros', cambioDivision: 'lunes, cada dos semanas' };
  for (const [tipo, info] of Object.entries(TIPOS_PUSH)) {
    if (info.soloAdmin && !esAdminToken) continue;
    const fila = interruptor(
      info.etiqueta,
      null,
      preferencias[tipo] === undefined ? info.porDefecto : preferencias[tipo] === true,
      (activo) => ajustarAvisoPush(tipo, activo),
      !suscripcion);
    if (NOTAS[tipo]) fila.lastElementChild.before(el('span', { clase: 'nota-aviso', texto: NOTAS[tipo] }));
    nodos.push(fila);
  }

  if (suscripcion) {
    nodos.push(el('div', { clase: 'fila-prueba-aviso' }, [
      el('span', { clase: 'texto' }, [el('span', { texto: '¿No te llegan?' }), el('small', { texto: 'Manda uno de prueba a este móvil. Si no sale, mira el modo No molestar.' })]),
      el('button', {
        clase: 'btn secundario boton-probar', texto: 'Probar', attrs: { type: 'button' },
        on: {
          click: () => avisoDePrueba().catch(() => estado(id('msg-push'), 'El móvil no ha dejado enseñar el aviso.', 'error')),
        },
      }),
    ]));
  }

  reemplazar(id('lista-avisos'), nodos);
  colocarCorreo();
}

// El sonido va apagado salvo que se encienda a proposito: una web que suena
// sola la primera vez que la abres en el metro es una web que se cierra (#51).
id('sonido').checked = sonidoActivo();
id('sonido').addEventListener('change', (e) => {
  activarSonido(e.target.checked);
  // Al encenderlo suena una vez, que es la unica forma de saber que suena. Y
  // ademas el gesto del clic es lo que autoriza al navegador a reproducir.
  if (e.target.checked) sonar();
});

id('btn-salir').addEventListener('click', async () => {
  // Aunque los agregados sean publicos, dejar en la pestaña los datos de la
  // sesion anterior confunde a quien entre despues con otra cuenta.
  vaciarCache();
  olvidarResumenOffline();
  await signOut(auth);
  window.location.replace('/entrar/');
});

// --- Mis datos -------------------------------------------------------------------

id('btn-exportar').addEventListener('click', async () => {
  const boton = id('btn-exportar');
  boton.disabled = true;
  estado(id('msg-datos'), 'Preparando la descarga…');
  try {
    const datos = await exportarMisDatos();
    const blob = new Blob([JSON.stringify(datos, null, 2)], { type: 'application/json' });
    const enlace = document.createElement('a');
    enlace.href = URL.createObjectURL(blob);
    enlace.download = `bicifastness-mis-datos-${new Date().toISOString().slice(0, 10)}.json`;
    enlace.click();
    URL.revokeObjectURL(enlace.href);
    estado(id('msg-datos'), 'Descarga lista.', 'ok');
  } catch (error) {
    estado(id('msg-datos'), error.message, 'error');
  } finally {
    boton.disabled = false;
  }
});

/**
 * Eliminar la cuenta: una hoja que pide escribir el nombre de piloto, y el
 * boton rojo solo se activa si coincide. Escribir tu propio nombre es un gesto
 * que no se hace sin querer, y es mas humano que teclear una frase en
 * mayusculas.
 *
 * La regla de `solicitudes_borrado` sigue exigiendo su frase fija: esa la manda
 * el codigo, no la persona.
 */
id('btn-borrar').addEventListener('click', () => {
  const nombre = perfil?.username || '';
  const anterior = document.activeElement;

  const campo = el('input', {
    clase: 'confirmar',
    attrs: { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
      'aria-label': `Escribe ${nombre} para confirmar` },
  });
  const eliminar = el('button', { clase: 'btn peligro lleno', attrs: { type: 'button', disabled: '' } },
    [icono('papelera'), el('span', { texto: 'Eliminar para siempre' })]);
  const cancelar = el('button', { clase: 'btn plano', texto: 'Cancelar', attrs: { type: 'button' } });
  const mensaje = el('p', { clase: 'mensaje', attrs: { 'aria-live': 'polite' } });

  const velo = el('div', { clase: 'velo' });
  const hoja = el('div', {
    clase: 'hoja dialogo-escritorio',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'titulo-borrar' },
  }, [
    el('span', { clase: 'asa', attrs: { 'aria-hidden': 'true' } }),
    el('h2', { clase: 'peligro', texto: 'Eliminar mi cuenta', attrs: { id: 'titulo-borrar' } }),
    el('p', { texto: 'Se borra tu perfil, tu historial y tus capturas. Tus tiempos verificados se anonimizan para no dejar huecos en los rankings de los demás y dejan de estar vinculados a ti. No se puede deshacer.' }),
    el('div', { clase: 'pila confirmar-nombre', estilo: { gap: '6px' } }, [
      el('span', { clase: 'menor apagado' }, [
        el('span', { texto: 'Escribe ' }), el('strong', { texto: nombre }), el('span', { texto: ' para confirmar' }),
      ]),
      campo,
    ]),
    eliminar,
    cancelar,
    mensaje,
  ]);

  const cerrar = () => {
    velo.remove();
    hoja.remove();
    document.removeEventListener('keydown', alTeclado);
    anterior?.focus?.();
  };
  const alTeclado = (e) => { if (e.key === 'Escape') cerrar(); };

  campo.addEventListener('input', () => {
    eliminar.disabled = campo.value.trim() !== nombre;
  });
  cancelar.addEventListener('click', cerrar);
  velo.addEventListener('click', cerrar);
  document.addEventListener('keydown', alTeclado);

  eliminar.addEventListener('click', async () => {
    if (campo.value.trim() !== nombre) return;
    eliminar.disabled = true;
    cancelar.disabled = true;
    try {
      await solicitarBorradoCuenta('BORRAR MI CUENTA');
      cerrar();
      // Pantalla final y despues fuera: la cuenta la borra el worker en su
      // siguiente pasada, y hasta entonces no tiene sentido seguir dentro.
      window.location.hash = 'adios';
      vaciarCache();
      olvidarResumenOffline();
      setTimeout(async () => {
        await signOut(auth);
        window.location.replace('/');
      }, 5000);
    } catch (error) {
      eliminar.disabled = false;
      cancelar.disabled = false;
      estado(mensaje, error.message, 'error');
    }
  });

  document.body.append(velo, hoja);
  campo.focus();
});
