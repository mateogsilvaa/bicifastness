// Modulo de la pagina /subir/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// EL FLUJO, que es lo que cambia con los issues #8 y #11:
//
//   foto -> comprobaciones (#12) -> lectura en el navegador (#8)
//        -> un trayecto:    "esto es lo que veo" -> confirmar
//        -> varios (#11):   "cuales de estos" -> subir los elegidos
//
// Antes habia que escribir a mano las dos estaciones y el tiempo, que ya
// estaban en la imagen: trabajo doble, y cada errata acababa en la cola de
// revision manual. Y si la captura llevaba dos o tres viajes — que es lo normal
// en el historial de la app — solo se leia el primero.
//
// Si la lectura no se puede hacer (navegador viejo, red mala, captura
// ilegible), no se bloquea a nadie: se enseñan los mismos campos vacios y se
// escribe a mano, como toda la vida.


import {
  auth, db, onAuthStateChanged, traducirError,
  collection, doc, getDoc, getDocs, query, where, orderBy, limit,
  writeBatch, serverTimestamp,
} from '/assets/js/firebase.js';
import {
  iniciarPagina, normalizarEstacion, nombreEstacion, nombreRuta, formatearTiempo,
} from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';
import { diaMadrid, diaMadridHace } from '/assets/js/dia.js';
import { revisar, LIMITES_CLIENTE } from '/assets/js/precheck.js';
import { leerExif } from '/assets/js/exif.js';
import { extraer, cerrar as cerrarLector } from '/assets/js/extraccion.js';
import { seguirViaje, recordarViaje, olvidarViaje, pintarEstado } from '/assets/js/estado-viaje.js';
import { marcarPrimerViaje } from '/assets/js/instalar.js';

iniciarPagina('subir');

const mensaje = id('mensaje');
const boton = id('btn-enviar');
const resultado = id('resultado');
const zonaAvisos = id('avisos-foto');
const progreso = id('progreso-lectura');
let perfil = null;

onAuthStateChanged(auth, async (usuario) => {
  if (!usuario) { window.location.replace('/entrar/'); return; }
  const snap = await getDoc(doc(db, 'usuarios', usuario.uid));
  if (!snap.exists()) {
    estado(mensaje, 'Termina de crear tu perfil antes de subir viajes.', 'aviso');
    boton.disabled = true;
    return;
  }
  perfil = { uid: usuario.uid, ...snap.data() };
  if (perfil.suspendido) {
    estado(mensaje, 'Tu cuenta esta suspendida.', 'error');
    boton.disabled = true;
  }
});

// La fecha no puede ser futura ni de hace mas de 30 dias: el mismo limite que
// aplica el servidor, aqui solo para que el selector no ofrezca imposibles.
// En dias de MADRID, no del reloj UTC. Con el dia UTC, entre medianoche y las
// 02:00 el tope del selector era AYER: quien volvia de un trayecto nocturno no
// podia elegir hoy, que es justo la fecha que queria poner.
const campoFecha = id('fecha');
campoFecha.max = diaMadrid();
campoFecha.min = diaMadridHace(30);
campoFecha.value = campoFecha.max;

// --- Estaciones ---
function pintarEstacion(campo) {
  const entrada = id(campo);
  const etiqueta = id(`${campo}-nombre`);
  const valor = normalizarEstacion(entrada.value);
  if (valor) entrada.value = valor;

  const nombre = nombreEstacion(valor);
  if (!valor) { etiqueta.textContent = ''; etiqueta.className = 'estacion'; return true; }
  etiqueta.textContent = nombre ? `📍 ${nombre}` : 'Esa estacion no existe';
  etiqueta.className = `estacion ${nombre ? 'ok' : 'mal'}`;
  entrada.setAttribute('aria-invalid', nombre ? 'false' : 'true');
  return Boolean(nombre);
}
for (const campo of ['origen', 'destino']) {
  id(campo).addEventListener('blur', () => pintarEstacion(campo));
}

// --- Captura ---
const zona = id('zona-foto');
const entradaFoto = id('foto');
const vista = id('vista-previa');

/**
 * La captura ya mirada, comprimida y leida.
 *
 * `lectura` es lo que se propuso al usuario; con eso y con lo que acabe
 * enviando se sabe QUE ha corregido, que es el unico dato que dice si el lector
 * mejora o empeora con gente de verdad.
 */
let preparada = null;
let insistido = false;

/** Los trayectos que se estan ofreciendo ahora mismo, en el mismo orden. */
let candidatosActuales = [];

['dragenter', 'dragover'].forEach((ev) => zona.addEventListener(ev, (e) => {
  e.preventDefault(); zona.classList.add('encima');
}));
['dragleave', 'drop'].forEach((ev) => zona.addEventListener(ev, (e) => {
  e.preventDefault(); zona.classList.remove('encima');
}));
zona.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) { entradaFoto.files = e.dataTransfer.files; elegirFoto(); }
});
entradaFoto.addEventListener('change', elegirFoto);

for (const botonVolver of ['btn-otra-foto', 'btn-otra-foto-varios']) {
  id(botonVolver).addEventListener('click', () => {
    volverAlPasoUno();
    entradaFoto.value = '';
    vista.style.display = 'none';
    id('texto-foto').textContent = 'Arrastra la captura o pulsa para elegirla';
    reemplazar(zonaAvisos);
  });
}

function volverAlPasoUno() {
  id('paso-confirmar').classList.add('oculto');
  id('paso-varios').classList.add('oculto');
  id('paso-foto').classList.remove('oculto');
  preparada = null;
  insistido = false;
  candidatosActuales = [];
  estado(mensaje, '');
}

async function elegirFoto() {
  const fichero = entradaFoto.files[0];
  if (!fichero) return;

  id('texto-foto').textContent = fichero.name;
  vista.src = URL.createObjectURL(fichero);
  vista.style.display = 'block';

  preparada = null;
  insistido = false;
  boton.textContent = 'Confirmar y subir';
  estado(mensaje, '');

  // 1. Comprobaciones que no cuestan nada, para avisar antes de nada (#12).
  reemplazar(zonaAvisos, el('p', { clase: 'menor apagado', texto: 'Comprobando la captura...' }));

  let revision;
  try {
    revision = await revisar(fichero);
  } catch (error) {
    revision = { avisos: [{ codigo: 'no_es_imagen', gravedad: 'alta', texto: error.message }], comprimida: null };
  }
  if (entradaFoto.files[0] !== fichero) return; // han elegido otra por el camino

  pintarAvisos(revision.avisos);

  // 2. La lectura, que es lo que cuesta. Se hace igual aunque haya avisos: si
  //    la foto esta regular pero se lee, mejor tenerlo leido.
  progreso.textContent = 'Leyendo la captura...';
  const lectura = await extraer(vista, (estadoOcr, avance) => {
    // La primera vez incluye bajarse el motor, que son unos megas.
    const porcentaje = Math.round(avance * 100);
    progreso.textContent = estadoOcr === 'recognizing text'
      ? `Leyendo la captura... ${porcentaje}%`
      : `Preparando el lector (solo la primera vez)... ${porcentaje}%`;
  });
  if (entradaFoto.files[0] !== fichero) return;

  // El EXIF, del fichero ORIGINAL. Tiene que ser aqui: lo que se sube ya ha
  // pasado por el lienzo, y un lienzo solo guarda pixeles — el EXIF entero
  // desaparece al recodificar. Por eso la señal de "editada con Photoshop" del
  // antifraude no habia saltado nunca (#66).
  //
  // Solo salen `software` y `marca`. Nunca las de posicion: el EXIF de una foto
  // lleva donde se hizo, y las capturas se guardan en Firestore.
  let metadatos = {};
  try {
    metadatos = leerExif(await fichero.slice(0, 65536).arrayBuffer());
  } catch {
    // Un fichero que no se puede leer aqui tampoco cambia nada: el antifraude
    // funciona igual sin esta pista, que es justo donde estabamos antes.
  }

  progreso.textContent = '';
  preparada = {
    fichero,
    dataUrl: revision.comprimida?.dataUrl || null,
    avisos: revision.avisos,
    lectura: lectura.disponible ? lectura : null,
    metadatos,
  };

  await decidirPaso(lectura);
}

function pintarAvisos(avisos) {
  if (!avisos.length) {
    reemplazar(zonaAvisos, el('p', { clase: 'menor apagado', texto: 'La captura tiene buena pinta.' }));
    return;
  }

  reemplazar(zonaAvisos, avisos.map((aviso) => el('div', {
    clase: `aviso ${aviso.gravedad === 'alta' ? 'atencion' : ''}`,
    estilo: { marginBottom: 'var(--e2)' },
  }, [el('p', { texto: aviso.texto })])));
}

// --- Varios trayectos en una captura (#11) -----------------------------------

/**
 * Huella logica de un viaje: mismo piloto, misma ruta, mismo tiempo y mismo
 * dia. Es lo que convierte "subir otra vez la captura de ayer" en "esto ya lo
 * tienes" sin depender de la imagen.
 */
function huellaLogica(ruta, tiempoSegundos, fechaViaje) {
  return `${ruta}|${tiempoSegundos}|${fechaViaje}`;
}

/**
 * Los viajes que esta persona ya tiene, para no ofrecerle lo que ya subio.
 *
 * Cuesta UNA consulta acotada, y solo se hace cuando la captura trae mas de un
 * trayecto: en el caso normal (una captura, un viaje) no se gasta ni una
 * lectura. De paso sale cuantos lleva hoy, que es lo que limita cuantos puede
 * elegir.
 */
async function misViajesRecientes() {
  const yaSubidos = new Set();
  let subidosHoy = 0;

  try {
    const snapshot = await getDocs(query(
      collection(db, 'tiempos_viaje'),
      where('uid', '==', perfil.uid),
      orderBy('creado', 'desc'),
      limit(60)
    ));

    // El cupo diario lo cuenta el servidor por dias de Madrid
    // (`inicioDelDiaMadrid`). Contarlo aqui por dias UTC hacia que las dos
    // cuentas no coincidieran durante las dos primeras horas del dia: la
    // pantalla decia que quedaba sitio y el servidor rechazaba, o al reves.
    const dia = diaMadrid();
    for (const d of snapshot.docs) {
      const v = d.data();
      yaSubidos.add(huellaLogica(v.ruta, v.tiempoSegundos, v.fechaViaje));
      // `creado` puede no estar resuelto todavia en el documento local.
      const creado = v.creado?.toDate?.();
      if (creado && diaMadrid(creado) === dia) subidosHoy++;
    }
  } catch (error) {
    // Sin esta consulta se puede seguir: se ofrecen todos y ya dira el servidor.
    console.debug('No se ha podido mirar el historial', error);
  }

  return { yaSubidos, subidosHoy };
}

/** Un trayecto leido, convertido a lo que se sube (o null si no vale). */
function aViaje(trayecto) {
  const origen = normalizarEstacion(trayecto.origen);
  const destino = normalizarEstacion(trayecto.destino);

  if (!nombreEstacion(origen) || !nombreEstacion(destino)) return null;
  if (!trayecto.segundosDuracion) return null;
  if (origen === destino) return null;

  return { origen, destino, ruta: `${origen}-${destino}`, tiempoSegundos: trayecto.segundosDuracion };
}

/** Decide que pantalla toca segun cuantos trayectos utiles haya. */
async function decidirPaso(lectura) {
  const candidatos = (lectura.trayectos || []).map(aViaje).filter(Boolean);

  // Lo de siempre: una captura, un viaje. Ni consulta ni pantalla de eleccion.
  if (candidatos.length <= 1) { irAConfirmar(lectura); return; }

  const { yaSubidos, subidosHoy } = await misViajesRecientes();
  irAElegir(candidatos, yaSubidos, subidosHoy);
}

/**
 * La lista para elegir. Lo que ya esta subido sale marcado y no se puede
 * elegir: ofrecerlo seria mandar a la cola un duplicado que el worker va a
 * rechazar, gastandole ademas cupo a la persona.
 */
function irAElegir(candidatos, yaSubidos, subidosHoy) {
  candidatosActuales = candidatos;

  const fecha = id('fecha-varios');
  fecha.max = campoFecha.max;
  fecha.min = campoFecha.min;
  fecha.value = campoFecha.max;

  const restantes = Math.max(0, LIMITES_CLIENTE.VIAJES_POR_DIA - subidosHoy);

  const pintarLista = () => {
    const dia = fecha.value;
    let nuevos = 0;

    reemplazar(id('lista-trayectos'), candidatos.map((candidato, indice) => {
      const repetido = yaSubidos.has(huellaLogica(candidato.ruta, candidato.tiempoSegundos, dia));
      if (!repetido) nuevos++;

      const casilla = el('input', {
        attrs: {
          type: 'checkbox',
          id: `tr-${indice}`,
          'data-indice': String(indice),
          // Se marcan solos los nuevos que caben en el cupo de hoy.
          checked: !repetido && nuevos <= restantes ? '' : null,
          disabled: repetido ? '' : null,
        },
      });

      return el('label', {
        clase: 'bloque fila separada',
        attrs: { for: `tr-${indice}` },
        estilo: { cursor: repetido ? 'default' : 'pointer' },
      }, [
        el('div', { clase: 'fila', estilo: { gap: 'var(--e3)' } }, [
          casilla,
          el('div', {}, [
            el('div', { clase: 'nombre', texto: nombreRuta(candidato.ruta) }),
            el('div', { clase: 'clan', texto: repetido ? 'Ya lo tienes subido' : 'Nuevo' }),
          ]),
        ]),
        el('span', { clase: 'marca', texto: formatearTiempo(candidato.tiempoSegundos) }),
      ]);
    }));

    const resumen = id('resumen-varios');
    if (!nuevos) {
      reemplazar(resumen,
        el('p', { clase: 'etiqueta', texto: 'Nada nuevo por aqui' }),
        el('p', { texto: 'Todos los trayectos de esta captura los tienes ya subidos.' }));
    } else {
      reemplazar(resumen,
        el('p', { clase: 'etiqueta', texto: `He visto ${candidatos.length} trayectos en la captura` }),
        el('p', {
          texto: `Elige cuales quieres subir. Hoy te quedan ${restantes} de ${LIMITES_CLIENTE.VIAJES_POR_DIA}. `
            + 'Si alguno no cuadra con lo que hiciste, subelo solo y podras corregirlo.',
        }));
    }

    id('btn-subir-varios').disabled = !nuevos || !restantes;
  };

  fecha.addEventListener('change', pintarLista);
  pintarLista();

  id('paso-foto').classList.add('oculto');
  id('paso-varios').classList.remove('oculto');
}

id('btn-subir-varios').addEventListener('click', subirVarios);

/** Sube de golpe los trayectos elegidos, todos apuntando a la MISMA captura. */
async function subirVarios() {
  const aviso = id('mensaje-varios');
  const botonVarios = id('btn-subir-varios');

  const elegidos = [...document.querySelectorAll('#lista-trayectos input:checked')]
    .map((casilla) => candidatosActuales[Number(casilla.dataset.indice)])
    .filter(Boolean);

  if (!elegidos.length) { estado(aviso, 'No has elegido ninguno.', 'aviso'); return; }
  if (!perfil) { estado(aviso, 'Todavia se esta cargando tu perfil.', 'aviso'); return; }
  if (!preparada?.dataUrl) { estado(aviso, 'No hemos podido preparar la captura.', 'error'); return; }

  botonVarios.disabled = true;
  botonVarios.textContent = 'Enviando...';
  estado(aviso, '');

  try {
    const ids = await crearViajes(elegidos, id('fecha-varios').value);
    volverAlPasoUno();
    entradaFoto.value = '';
    vista.style.display = 'none';
    id('texto-foto').textContent = 'Arrastra la captura o pulsa para elegirla';
    reemplazar(zonaAvisos);
    // Se sigue el primero: los demas van en la misma tanda del worker.
    seguirEste(ids[0]);
  } catch (error) {
    estado(aviso, traducirError(error), 'error');
  } finally {
    botonVarios.disabled = false;
    botonVarios.textContent = 'Subir los elegidos';
  }
}

// --- Un solo trayecto: confirmar lo leido (#8) --------------------------------

/** Rellena el formulario con lo leido y enseña el paso de confirmacion. */
function irAConfirmar(lectura) {
  const resumen = id('resumen-lectura');

  if (lectura.disponible && lectura.esBicimad) {
    const origen = normalizarEstacion(lectura.origen);
    const destino = normalizarEstacion(lectura.destino);

    if (nombreEstacion(origen)) id('origen').value = origen;
    if (nombreEstacion(destino)) id('destino').value = destino;

    if (lectura.segundosDuracion) {
      id('min').value = Math.floor(lectura.segundosDuracion / 60);
      id('sec').value = lectura.segundosDuracion % 60;
    }

    const leido = [
      nombreEstacion(origen) && nombreEstacion(destino) ? 'las dos estaciones' : null,
      lectura.segundosDuracion ? 'el tiempo' : null,
    ].filter(Boolean);

    reemplazar(resumen,
      el('p', { clase: 'etiqueta', texto: 'Esto es lo que veo en la captura' }),
      el('p', {
        texto: leido.length
          ? `He sacado ${leido.join(' y ')}. Comprueba que esta bien y confirma; si algo no cuadra, corrigelo.`
          : 'No he podido sacar los datos de la captura. Rellenalos a mano y los comprobamos igual.',
      }));
  } else {
    reemplazar(resumen,
      el('p', { clase: 'etiqueta', texto: 'No he podido leer la captura' }),
      el('p', {
        texto: lectura.disponible
          ? 'La imagen no parece la pantalla de resumen de un viaje de BiciMAD. Puedes subirla igual, pero rellena los datos a mano.'
          : 'Rellena los datos a mano y los comprobamos igual. La captura se sube tal cual.',
      }));
  }

  pintarEstacion('origen');
  pintarEstacion('destino');

  id('paso-foto').classList.add('oculto');
  id('paso-confirmar').classList.remove('oculto');
  id('origen').focus();
}

/**
 * Que ha corregido la persona sobre lo que se leyo.
 *
 * Esto NO es una señal de fraude, y conviene tenerlo claro: quien quiera
 * engañar corrige lo que le de la gana y no manda ninguna marca. Contra eso
 * esta el worker, que vuelve a leer la captura por su cuenta y compara con lo
 * declarado, y esa comparacion no se puede falsear desde aqui.
 *
 * Esto es para MEDIR: cuanto acierta el lector con capturas de verdad, que es
 * justo lo que no se puede saber con un banco de imagenes propias (#10).
 */
function correcciones(enviado) {
  const lectura = preparada?.lectura;
  if (!lectura) return null;

  const leido = {
    origen: normalizarEstacion(lectura.origen),
    destino: normalizarEstacion(lectura.destino),
    tiempoSegundos: lectura.segundosDuracion,
  };

  return {
    confianza: lectura.confianza,
    origen: leido.origen !== enviado.origen,
    destino: leido.destino !== enviado.destino,
    tiempoSegundos: leido.tiempoSegundos !== enviado.tiempoSegundos,
    // Cuanto se equivoco en el tiempo, en segundos. Un desfase de dos segundos
    // y uno de dos minutos no dicen lo mismo del lector.
    desfaseSegundos: Number.isFinite(leido.tiempoSegundos)
      ? Math.abs(leido.tiempoSegundos - enviado.tiempoSegundos)
      : null,
  };
}

// --- Escritura ----------------------------------------------------------------

/**
 * El cupo de esta cuenta hoy, y por donde van sus contadores (#62).
 *
 * El navegador lleva su propio contador en `cupos/{uid}` y lo escribe en el
 * MISMO lote que el viaje. No es una comprobacion de cortesia: las reglas miran
 * como queda ese documento despues del lote y exigen que el ID del viaje sea el
 * numero nuevo, asi que un lote no cabe mas que un viaje y una captura. Es lo
 * unico que frena a una cuenta ANTES de escribir; el worker llega despues.
 *
 * El dia es UTC porque es lo unico que las reglas saben mirar. Por eso el tope
 * es holgado y NO es el cupo del juego: ese lo sigue poniendo el worker, en hora
 * de Madrid. Ver firestore.rules.
 */
const diaUTC = () => Math.floor(Date.now() / 86400000);

async function leerCupo() {
  const dia = diaUTC();
  const snap = await getDoc(doc(db, 'cupos', perfil.uid));
  const previo = snap.exists() ? snap.data() : null;

  // Un cupo de ayer no se arrastra: se reinicia al escribir el dia nuevo.
  if (!previo || previo.dia !== dia) return { dia, viajes: 0, capturas: 0 };
  return { dia, viajes: previo.viajes || 0, capturas: previo.capturas || 0 };
}

/**
 * Escribe los viajes elegidos y su captura.
 *
 * UN LOTE POR VIAJE, y no todos juntos como antes: el freno de #62 solo deja un
 * viaje por lote, porque el id tiene que ser el numero que marca el contador y
 * dos viajes del mismo lote pedirian el mismo. Se paga un lote de mas por cada
 * trayecto extra de la misma captura, que son como mucho dos.
 *
 * La captura se guarda UNA vez aunque haya varios viajes: son tres trayectos de
 * la misma imagen, y triplicarla serian megas de cuota para nada. Cada viaje
 * apunta a ella con `capturaId`, y el worker sabe que una huella compartida no
 * es una captura reutilizada (#11).
 *
 * El navegador solo puede PROPONER: las reglas obligan a que el viaje nazca en
 * estado 'pendiente' y sin verificar. El veredicto lo pone el worker, que corre
 * en GitHub Actions con credenciales de administrador.
 *
 * @returns {Promise<string[]>} los ids de los viajes creados
 */
async function crearViajes(viajes, fechaViaje, correccionesDe = null) {
  const cupo = await leerCupo();
  const cupoRef = doc(db, 'cupos', perfil.uid);

  const capturaId = `${perfil.uid}_${cupo.dia}_c${cupo.capturas + 1}`;
  let escritas = cupo.capturas;
  let contados = cupo.viajes;

  const ids = [];

  for (const viaje of viajes) {
    contados += 1;
    const viajeId = `${perfil.uid}_${cupo.dia}_${contados}`;

    const minutos = Math.floor(viaje.tiempoSegundos / 60);
    const segundos = viaje.tiempoSegundos % 60;

    const datos = {
      uid: perfil.uid,
      username: perfil.username,
      ruta: viaje.ruta,
      tiempoSegundos: viaje.tiempoSegundos,
      tiempoFormateado: `${String(minutos).padStart(2, '0')}m ${String(segundos).padStart(2, '0')}s`,
      fechaViaje,
      estado: 'pendiente',
      verificado: false,
      capturaId,
      creado: serverTimestamp(),
    };

    const corregido = correccionesDe ? correccionesDe(viaje) : null;
    if (corregido) datos.correcciones = corregido;

    // Solo si hay algo. Un documento con `metadatos: {}` ocupa por nada, y las
    // capturas de pantalla limpias —que son la mayoria— no traen EXIF.
    if (preparada?.metadatos && Object.keys(preparada.metadatos).length) {
      datos.metadatos = preparada.metadatos;
    }

    const lote = writeBatch(db);

    // La captura va con el primer viaje, no en un lote suyo: si fuera aparte y
    // fallara el viaje, quedaria una captura de 700 KB sin dueño que nadie
    // borra nunca.
    if (escritas === cupo.capturas) {
      escritas += 1;
      lote.set(doc(db, 'capturas', capturaId), {
        uid: perfil.uid,
        datos: preparada.dataUrl,
        creado: serverTimestamp(),
      });
    }

    lote.set(cupoRef, { dia: cupo.dia, viajes: contados, capturas: escritas });
    lote.set(doc(db, 'tiempos_viaje', viajeId), datos);

    await lote.commit();
    ids.push(viajeId);
  }

  return ids;
}

id('form-viaje').addEventListener('submit', async (evento) => {
  evento.preventDefault();

  const origenOk = pintarEstacion('origen');
  const destinoOk = pintarEstacion('destino');
  const fichero = entradaFoto.files[0];

  if (!origenOk || !destinoOk) { estado(mensaje, 'Revisa las estaciones.', 'error'); return; }
  if (!fichero) { estado(mensaje, 'Falta la captura de verificacion.', 'error'); return; }
  if (!perfil) { estado(mensaje, 'Todavia se esta cargando tu perfil.', 'aviso'); return; }

  const minutos = Number(id('min').value) || 0;
  const segundos = Number(id('sec').value) || 0;
  const tiempoSegundos = minutos * 60 + segundos;

  if (tiempoSegundos < 30 || tiempoSegundos > 7200) {
    estado(mensaje, 'El tiempo debe estar entre 30 segundos y 2 horas.', 'error');
    return;
  }

  if (!preparada || preparada.fichero !== fichero) {
    estado(mensaje, 'Espera un segundo, estamos mirando la captura.', 'aviso');
    return;
  }

  // Los avisos serios frenan UNA vez. Si la persona vuelve a pulsar, sube: son
  // avisos, no barreras, y quien conoce su foto puede tener razon.
  const serios = preparada.avisos.filter((a) => a.gravedad === 'alta');
  if (serios.length && !insistido) {
    insistido = true;
    estado(mensaje, 'Lee el aviso de la captura. Si aun asi quieres subirla, pulsa otra vez.', 'aviso');
    boton.textContent = 'Subir de todas formas';
    return;
  }

  boton.disabled = true;
  boton.textContent = 'Enviando...';
  estado(mensaje, '');
  pintarEstado(resultado, { estado: 'extrayendo' }, { conEnlace: false });
  resultado.style.display = 'block';

  try {
    if (!preparada.dataUrl) throw new Error('No hemos podido preparar la captura. Prueba con otra imagen.');

    const origen = normalizarEstacion(id('origen').value);
    const destino = normalizarEstacion(id('destino').value);

    const [viajeId] = await crearViajes(
      [{ origen, destino, ruta: `${origen}-${destino}`, tiempoSegundos }],
      campoFecha.value,
      (viaje) => correcciones({ origen: viaje.origen, destino: viaje.destino, tiempoSegundos: viaje.tiempoSegundos })
    );

    seguirEste(viajeId);

    // A partir de aqui tiene sentido invitarle a instalar la app: ya sabe para
    // que sirve. La invitacion sale en la portada, no aqui, para no meter ruido
    // justo en el momento de la confirmacion (#52).
    marcarPrimerViaje();

    // Vuelta al paso 1, listo para el siguiente.
    id('form-viaje').reset();
    volverAlPasoUno();
    vista.style.display = 'none';
    id('texto-foto').textContent = 'Arrastra la captura o pulsa para elegirla';
    reemplazar(zonaAvisos);
    for (const c of ['origen', 'destino']) id(`${c}-nombre`).textContent = '';
    campoFecha.value = campoFecha.max;
  } catch (error) {
    resultado.style.display = 'none';
    estado(mensaje, traducirError(error), 'error');
  } finally {
    boton.disabled = false;
    boton.textContent = 'Confirmar y subir';
  }
});

/**
 * Sigue el viaje recien subido hasta que el worker lo resuelva.
 * `estado-viaje.js` corta la escucha sola en cuanto hay veredicto y al salir de
 * la pagina.
 */
let dejarDeSeguir = null;

function seguirEste(viajeId) {
  if (dejarDeSeguir) dejarDeSeguir();

  recordarViaje(viajeId);
  pintarEstado(resultado, { estado: 'pendiente' });
  resultado.style.display = 'block';

  dejarDeSeguir = seguirViaje(viajeId, (viaje) => {
    if (!viaje) return;
    pintarEstado(resultado, viaje);
    if (viaje.estado !== 'pendiente') olvidarViaje();
  });
}

// El lector ocupa varios megas de memoria. Al irse de la pagina, fuera.
window.addEventListener('pagehide', () => { cerrarLector(); });
