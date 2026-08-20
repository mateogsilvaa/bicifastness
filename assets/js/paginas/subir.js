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
}

/**
 * Comprime la captura antes de enviarla.
 * Se sube a 900 px de ancho (antes eran 500) porque el analisis forense del
 * servidor necesita ver el renderizado del texto para detectar retoques; a
 * 500 px se perdia justo la informacion que delata la manipulacion.
 */
function comprimir(fichero) {
  return new Promise((resolver, rechazar) => {
    const lector = new FileReader();
    lector.onerror = () => rechazar(new Error('No se ha podido leer el fichero.'));
    lector.onload = (e) => {
      const img = new Image();
      img.onerror = () => rechazar(new Error('El fichero no es una imagen valida.'));
      img.onload = () => {
        const anchoMax = 900;
        const escala = Math.min(1, anchoMax / img.width);
        const lienzo = document.createElement('canvas');
        lienzo.width = Math.round(img.width * escala);
        lienzo.height = Math.round(img.height * escala);
        const ctx = lienzo.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, lienzo.width, lienzo.height);
        ctx.drawImage(img, 0, 0, lienzo.width, lienzo.height);
        resolver(lienzo.toDataURL('image/jpeg', 0.85));
      };
      img.src = e.target.result;
    };
    lector.readAsDataURL(fichero);
  });
}

// --- Envio ---
id('form-viaje').addEventListener('submit', async (evento) => {
  evento.preventDefault();
  resultado.style.display = 'none';

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

  boton.disabled = true;
  boton.textContent = 'Enviando...';
  estado(mensaje, 'Subiendo la captura...');

  try {
    const captura = await comprimir(fichero);

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
      datos: captura,
      creado: serverTimestamp(),
    });

    await lote.commit();

    estado(mensaje, '');
    mostrarEnCola();

    id('form-viaje').reset();
    vista.style.display = 'none';
    id('texto-foto').textContent = 'Arrastra la captura o haz clic';
    for (const c of ['origen', 'destino']) id(`${c}-nombre`).textContent = '';
    campoFecha.value = campoFecha.max;
  } catch (error) {
    estado(mensaje, traducirError(error), 'error');
  } finally {
    boton.disabled = false;
    boton.textContent = 'Enviar';
  }
});

/**
 * El analisis no es instantaneo: lo hace un proceso programado que se
 * despierta cada pocos minutos. Conviene decirlo claro para que nadie
 * reenvie el mismo viaje pensando que no se ha guardado.
 */
function mostrarEnCola() {
  reemplazar(resultado,
    el('h3', { texto: 'Viaje recibido' }),
    el('p', {
      texto: 'Se esta analizando: comprobamos que las estaciones y el tiempo cuadren con la '
        + 'captura, que el trayecto sea posible y que la imagen no este retocada.',
      estilo: { margin: '0 0 8px', fontSize: '.9rem', lineHeight: '1.5' },
    }),
    el('p', {
      texto: 'Suele tardar unos minutos. Puedes seguir el estado en tu perfil.',
      estilo: { margin: '0 0 12px', fontSize: '.85rem', color: 'var(--text-muted)' },
    }),
    el('a', {
      texto: 'Ver mi historial',
      attrs: { href: '/profile/' },
      estilo: {
        display: 'inline-block', background: 'var(--primary)', color: '#fff',
        padding: '12px 20px', borderRadius: '10px', textDecoration: 'none', fontWeight: '700',
      },
    }));

  resultado.className = 'resultado revision';
  resultado.style.display = 'block';
  resultado.focus();
}
