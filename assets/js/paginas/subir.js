// Modulo de la pagina /subir/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// EL FLUJO, que es lo que cambia con el issue #8:
//
//   foto -> comprobaciones (#12) -> lectura en el navegador -> confirmar -> viaje
//
// Antes habia que escribir a mano las dos estaciones y el tiempo, que ya
// estaban en la imagen: trabajo doble, y cada errata acababa en la cola de
// revision manual. Ahora los campos vienen rellenos y solo se toca lo que este
// mal.
//
// Si la lectura no se puede hacer (navegador viejo, red mala, captura
// ilegible), no se bloquea a nadie: se enseñan los mismos campos vacios y se
// escribe a mano, como toda la vida.


import {
  auth, db, onAuthStateChanged, traducirError,
  collection, doc, getDoc, writeBatch, serverTimestamp,
} from '/assets/js/firebase.js';
import { iniciarPagina, normalizarEstacion, nombreEstacion } from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';
import { revisar } from '/assets/js/precheck.js';
import { extraer, cerrar as cerrarLector } from '/assets/js/extraccion.js';
import { seguirViaje, recordarViaje, olvidarViaje, pintarEstado } from '/assets/js/estado-viaje.js';

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
const hoy = new Date();
const campoFecha = id('fecha');
campoFecha.max = hoy.toISOString().slice(0, 10);
campoFecha.min = new Date(hoy.getTime() - 30 * 864e5).toISOString().slice(0, 10);
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

id('btn-otra-foto').addEventListener('click', () => {
  id('paso-confirmar').classList.add('oculto');
  id('paso-foto').classList.remove('oculto');
  entradaFoto.value = '';
  preparada = null;
  insistido = false;
  estado(mensaje, '');
});

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

  progreso.textContent = '';
  preparada = {
    fichero,
    dataUrl: revision.comprimida?.dataUrl || null,
    avisos: revision.avisos,
    lectura: lectura.disponible ? lectura : null,
  };

  irAConfirmar(lectura);
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

// --- Envio ---
let dejarDeSeguir = null;

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
    const ruta = `${origen}-${destino}`;

    // El viaje y su captura se escriben juntos, en un lote: si una de las dos
    // fallara, el worker se encontraria un viaje sin imagen (o al reves).
    //
    // El navegador solo puede PROPONER: las reglas obligan a que nazca en
    // estado 'pendiente' y con verificado en false. El veredicto lo pone el
    // worker, que corre en GitHub Actions con credenciales de administrador.
    const viajeRef = doc(collection(db, 'tiempos_viaje'));
    const lote = writeBatch(db);

    const datos = {
      uid: perfil.uid,
      username: perfil.username,
      ruta,
      tiempoSegundos,
      tiempoFormateado: `${String(minutos).padStart(2, '0')}m ${String(segundos).padStart(2, '0')}s`,
      fechaViaje: campoFecha.value,
      estado: 'pendiente',
      verificado: false,
      creado: serverTimestamp(),
    };

    const corregido = correcciones({ origen, destino, tiempoSegundos });
    if (corregido) datos.correcciones = corregido;

    lote.set(viajeRef, datos);

    // La imagen va en su propia coleccion, cerrada al cliente: asi el ranking
    // no arrastra megas de fotos y nadie puede rasparlas.
    lote.set(doc(db, 'capturas', viajeRef.id), {
      uid: perfil.uid,
      datos: preparada.dataUrl,
      creado: serverTimestamp(),
    });

    await lote.commit();

    seguirEste(viajeRef.id);

    // Vuelta al paso 1, listo para el siguiente.
    id('form-viaje').reset();
    id('paso-confirmar').classList.add('oculto');
    id('paso-foto').classList.remove('oculto');
    vista.style.display = 'none';
    id('texto-foto').textContent = 'Arrastra la captura o pulsa para elegirla';
    reemplazar(zonaAvisos);
    preparada = null;
    insistido = false;
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
