// Modulo de la pagina /subir/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.


import {
  auth, db, onAuthStateChanged, traducirError,
  collection, doc, getDoc, writeBatch, serverTimestamp,
} from '/assets/js/firebase.js';
import { iniciarPagina, normalizarEstacion, nombreEstacion } from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';
import { revisar } from '/assets/js/precheck.js';
import { seguirViaje, recordarViaje, olvidarViaje, pintarEstado } from '/assets/js/estado-viaje.js';

iniciarPagina('subir');

const mensaje = id('mensaje');
const boton = id('btn-enviar');
const resultado = id('resultado');
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
const zonaAvisos = id('avisos-foto');

/**
 * La captura ya mirada y comprimida.
 *
 * Se guarda porque la comprobacion previa YA la comprime (para saber si cabe
 * hay que comprimirla), y volver a hacerlo al enviar seria repetir el unico
 * trabajo caro de la pantalla.
 *
 * `insistido` es la respuesta a "son avisos, no barreras": con un aviso serio
 * el primer envio no sube nada, lo explica y espera. El segundo sube igual.
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
  if (e.dataTransfer.files.length) { entradaFoto.files = e.dataTransfer.files; mostrarFoto(); }
});
entradaFoto.addEventListener('change', mostrarFoto);

function mostrarFoto() {
  const fichero = entradaFoto.files[0];
  if (!fichero) return;

  id('texto-foto').textContent = fichero.name;
  vista.src = URL.createObjectURL(fichero);
  vista.style.display = 'block';

  // Otra foto, otra oportunidad: el boton vuelve a su texto normal y hay que
  // volver a insistir si esta tambien trae avisos.
  preparada = null;
  insistido = false;
  boton.textContent = 'Subir trayecto';
  estado(mensaje, '');
  comprobarFoto(fichero);
}

/**
 * Mira la captura antes de que nadie espere diez minutos por ella.
 *
 * Nada de lo que sale de aqui decide: el worker lo vuelve a comprobar todo. Es
 * para no gastarle a nadie una espera larga por una foto movida.
 */
async function comprobarFoto(fichero) {
  reemplazar(zonaAvisos, el('p', { clase: 'menor apagado', texto: 'Comprobando la captura...' }));

  try {
    const { avisos, comprimida } = await revisar(fichero);
    // Otra foto elegida mientras esta se miraba: lo de ahora manda.
    if (entradaFoto.files[0] !== fichero) return;

    preparada = { fichero, dataUrl: comprimida?.dataUrl || null, avisos };
    pintarAvisos(avisos);
  } catch (error) {
    if (entradaFoto.files[0] !== fichero) return;
    preparada = { fichero, dataUrl: null, avisos: [{ codigo: 'no_es_imagen', gravedad: 'alta', texto: error.message }] };
    pintarAvisos(preparada.avisos);
  }
}

function pintarAvisos(avisos) {
  if (!avisos.length) {
    reemplazar(zonaAvisos, el('p', { clase: 'menor apagado', texto: 'La captura tiene buena pinta.' }));
    return;
  }

  reemplazar(zonaAvisos, avisos.map((aviso) => el('div', {
    clase: `aviso ${aviso.gravedad === 'alta' ? 'atencion' : ''}`,
    estilo: { marginBottom: 'var(--e2)' },
  }, [
    el('p', { texto: aviso.texto }),
  ])));
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

  // Todavia comprobando: la captura no esta lista, pero tampoco hay que
  // rechazar el envio por eso.
  if (!preparada || preparada.fichero !== fichero) {
    estado(mensaje, 'Espera un segundo, estamos mirando la captura.', 'aviso');
    return;
  }

  // Los avisos serios frenan UNA vez. Si la persona vuelve a pulsar, sube: son
  // avisos, no barreras, y quien conoce su foto puede tener razon.
  const serios = preparada.avisos.filter((a) => a.gravedad === 'alta');
  if (serios.length && !insistido) {
    insistido = true;
    estado(mensaje, 'Lee el aviso de arriba. Si aun asi quieres subirla, pulsa otra vez.', 'aviso');
    boton.textContent = 'Subir de todas formas';
    return;
  }

  boton.disabled = true;
  boton.textContent = 'Enviando...';
  estado(mensaje, '');
  pintarEstado(resultado, { estado: 'extrayendo' }, { conEnlace: false });
  resultado.style.display = 'block';

  try {
    // Si la compresion no llego a producir nada (fichero ilegible), que falle
    // aqui y no con un `permission-denied` sin explicacion desde las reglas.
    if (!preparada.dataUrl) throw new Error('No hemos podido preparar la captura. Prueba con otra imagen.');

    // El viaje y su captura se escriben juntos, en un lote: si una de las dos
    // fallara, el worker se encontraria un viaje sin imagen (o al reves).
    //
    // El navegador solo puede PROPONER: las reglas obligan a que nazca en
    // estado 'pendiente' y con verificado en false. El veredicto lo pone el
    // worker, que corre en GitHub Actions con credenciales de administrador.
    const ruta = `${normalizarEstacion(id('origen').value)}-${normalizarEstacion(id('destino').value)}`;
    const viajeRef = doc(collection(db, 'tiempos_viaje'));
    const lote = writeBatch(db);

    lote.set(viajeRef, {
      uid: perfil.uid,
      username: perfil.username,
      ruta,
      tiempoSegundos,
      tiempoFormateado: `${String(minutos).padStart(2, '0')}m ${String(segundos).padStart(2, '0')}s`,
      fechaViaje: campoFecha.value,
      estado: 'pendiente',
      verificado: false,
      creado: serverTimestamp(),
    });

    // La imagen va en su propia coleccion, cerrada al cliente: asi el ranking
    // no arrastra megas de fotos y nadie puede rasparlas.
    lote.set(doc(db, 'capturas', viajeRef.id), {
      uid: perfil.uid,
      datos: preparada.dataUrl,
      creado: serverTimestamp(),
    });

    await lote.commit();

    seguirEste(viajeRef.id);

    id('form-viaje').reset();
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
    boton.textContent = 'Subir trayecto';
  }
});

/**
 * Sigue el viaje recien subido hasta que el worker lo resuelva.
 *
 * Es lo que convierte la espera en algo que se puede mirar: antes la pantalla
 * decia "puedes seguir el estado en tu perfil" y no volvia a decir nada.
 * `estado-viaje.js` corta la escucha sola en cuanto hay veredicto y al salir de
 * la pagina.
 */
function seguirEste(viajeId) {
  if (dejarDeSeguir) dejarDeSeguir();

  // Para que la portada lo siga tambien si la persona se va de aqui.
  recordarViaje(viajeId);
  pintarEstado(resultado, { estado: 'pendiente' });
  resultado.style.display = 'block';

  dejarDeSeguir = seguirViaje(viajeId, (viaje) => {
    if (!viaje) return;
    pintarEstado(resultado, viaje);
    // Ya resuelto: la portada no tiene que volver a contarlo.
    if (viaje.estado !== 'pendiente') olvidarViaje();
  });
}
