// Modulo de la pagina /
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.
//
// Una sola ruta con dos caras: sin sesion cuenta que es esto, con sesion dice
// en que punto estas. Antes eran dos pantallas, y `/home/` no era mas que un
// indice de enlaces a las demas.

import { auth, db, onAuthStateChanged, doc, getDoc } from '/assets/js/firebase.js';
import { crearPerfil, aceptarLegal, guardarSuscripcionPush, limpiarNombre } from '/assets/js/acciones.js';
import { iniciarPagina, pedirReaceptacion, nombreRuta, formatearTiempo } from '/assets/js/ui.js';
import { id, el, estado, reemplazar, icono } from '/assets/js/dom.js';
import { leerCache, guardarCache } from '/assets/js/cache.js';
import { pintarMapaFondo } from '/assets/js/mapa-fondo.js';
import { ESTACIONES } from '/assets/data/estaciones.js';
import { PALABRAS_PROHIBIDAS } from '/assets/data/palabras-prohibidas.js';
import { ofrecerInstalacion, guardarResumenOffline } from '/assets/js/instalar.js';
import { traerAgregado } from '/assets/js/agregados.js';
import { pintarHoy, miGrupo, nombreGrupo } from '/assets/js/hoy.js';
import { ofrecerAvisos } from '/assets/js/push.js';
import { anotar, volcar } from '/assets/js/metricas.js';
import { montarBotonGoogle } from '/assets/js/acceso.js';

iniciarPagina('ahora');

// En la portada sin sesion. Al volver del popup se recarga `/`, y si la cuenta
// es nueva `onAuthStateChanged` enseña el paso del nombre de piloto.
montarBotonGoogle(id('btn-google'), id('mensaje-google'));
// El mismo al final de "como funciona" (1b): quien ha bajado a leer ya ha
// decidido, y no tiene por que volver arriba.
montarBotonGoogle(id('btn-google-2'), id('mensaje-google-2'));

const landing = id('landing');
const panel = id('panel');

// --- Portada sin sesion (01 Acceso · 1a) -----------------------------------------

/**
 * `config/general` guardado en la sesion. Es publico y cambia una vez al dia
 * (la ruta del dia), asi que pedirlo en cada visita de alguien sin cuenta es
 * pagar lo mismo una y otra vez.
 */
async function configGeneral() {
  const guardado = leerCache('config-general');
  if (guardado !== undefined) return guardado;
  const snap = await getDoc(doc(db, 'config', 'general'));
  const datos = snap.exists() ? snap.data() : null;
  guardarCache('config-general', datos);
  return datos;
}

/**
 * El mapa real y la ruta del dia en vivo. Todo publico y guardado un par de
 * minutos en la pestaña (`cache.js`): como mucho tres lecturas por visita, y
 * ninguna al volver enseguida.
 *
 * Nada de esto es imprescindible: si falla, el mapa se queda con los puntos
 * neutros y la tarjeta de la ruta no sale. Nunca un error en la portada.
 */
/** En escritorio (8d) el mapa ocupa la mitad derecha, alto: otra proporcion. */
const medidaMapa = () => (window.matchMedia('(min-width: 900px)').matches ? { w: 704, h: 868 } : undefined);

async function pintarPortadaPublica() {
  id('cifra-estaciones').textContent = String(Object.keys(ESTACIONES).length);

  // Primero sin colores (cero lecturas), para que el fondo este desde el
  // primer momento; despues con el dominio de verdad.
  pintarMapaFondo(id('mapa-fondo'), null, medidaMapa());
  traerAgregado('mapa')
    .then((mapa) => { if (mapa) pintarMapaFondo(id('mapa-fondo'), mapa, medidaMapa()); })
    .catch((error) => console.debug('Sin agregado del mapa', error));

  try {
    const ruta = (await configGeneral())?.rutaDestacada;
    if (!ruta) return;

    const agregado = await traerAgregado(`ruta-${ruta}`).catch(() => null);
    const pilotos = agregado?.total ?? agregado?.filas?.length ?? 0;
    const lider = agregado?.filas?.[0] || null;
    const record = lider?.marca ?? null;
    // "N pilotos" y no "N pilotos hoy": el agregado cuenta a todos los que han
    // hecho el tramo, no solo a los de hoy, y decir otra cosa seria inventar.
    const cuantos = pilotos ? `${pilotos} ${pilotos === 1 ? 'piloto' : 'pilotos'}` : 'Aún sin tiempos';
    const marca = record !== null ? `récord ${formatearTiempo(record)}` : 'el primero se lleva el récord';
    const nombre = nombreRuta(ruta);

    // Dos composiciones del mismo dato: 1a (movil, en una fila) y 8d
    // (escritorio, tarjeta sobre el mapa con "en vivo" y de quien es el record).
    reemplazar(id('ruta-publica'), el('a', {
      clase: 'ruta-publica',
      attrs: { href: `/clasificacion/?ruta=${encodeURIComponent(ruta)}` },
    }, [
      el('span', { clase: 'rp-movil' }, [
        el('span', { clase: 'punto-vivo', attrs: { 'aria-hidden': 'true' } }),
        el('span', { clase: 'texto' }, [
          el('span', { texto: 'Ruta del día: ' }),
          el('strong', { texto: nombre }),
          el('span', { clase: 'detalle', texto: `${cuantos} · ${marca}` }),
        ]),
        el('span', { clase: 'x2', texto: '×2' }),
      ]),
      el('span', { clase: 'rp-escritorio' }, [
        el('span', { clase: 'rp-cabeza' }, [
          el('span', { clase: 'rp-etiqueta' }, [
            el('span', { clase: 'punto-vivo', attrs: { 'aria-hidden': 'true' } }),
            'Ruta del día · en vivo',
          ]),
          el('span', { clase: 'x2', texto: '×2' }),
        ]),
        el('strong', { texto: nombre }),
        el('span', { clase: 'detalle', texto: `${cuantos} · ${marca}${lider?.nombre && record !== null ? ` de ${lider.nombre}` : ''}` }),
      ]),
    ]));
  } catch (error) {
    console.debug('Sin ruta del dia en la portada', error);
  }
}

// --- Sesion ------------------------------------------------------------------

/**
 * Sin sesion (1a/1b) y en el paso del nombre (1c) no hay barra de navegacion:
 * en esas pantallas solo hay una cosa que hacer, y la barra llevaba a sitios
 * que todavia no puedes usar.
 */
const sinNavegacion = (si) => document.body.classList.toggle('sin-navegacion', si);

onAuthStateChanged(auth, async (usuario) => {
  if (!usuario) {
    sinNavegacion(true);
    landing.classList.remove('oculto');
    panel.classList.add('oculto');
    pintarPortadaPublica();
    return;
  }

  landing.classList.add('oculto');
  panel.classList.remove('oculto');

  try {
    const perfil = await getDoc(doc(db, 'usuarios', usuario.uid));

    // Si el alta se corto entre crear la cuenta en Auth y crear el perfil, la
    // sesion quedaba viva pero inservible: no se podia subir nada y no habia
    // forma de arreglarlo desde la interfaz. Es ademas el paso 2 del alta,
    // venga de Google o del correo.
    if (!perfil.exists()) {
      sinNavegacion(true);
      panel.classList.add('oculto');
      id('recuperar-perfil').classList.remove('oculto');
      document.body.classList.add('con-marca');
      usuarioActual = usuario;
      return;
    }
    sinNavegacion(false);

    const datos = perfil.data();
    pedirReaceptacion(datos, aceptarLegal);

    // Copia minima para /offline/ y para la ficha del lateral (08). Son datos
    // propios y no salen de este movil. El grupo se añade cuando se sabe.
    guardarResumenOffline(datos);

    // Solo sale si ya ha subido un viaje, si no esta instalada ya y si no dijo
    // que no antes.
    // Instalar primero: en iOS el push NO existe hasta que la web esta en la
    // pantalla de inicio, asi que ofrecer avisos antes seria ofrecer algo que
    // ahi no se puede dar (#33).
    const ofrecida = ofrecerInstalacion(id('invitacion-instalar'));
    if (!ofrecida) {
      ofrecerAvisos(id('invitacion-instalar'), {
        alAceptar: guardarSuscripcionPush,
      }).catch(() => { /* sin avisos se sigue igual */ });
    }

    await pintarHoy(usuario, datos);

    miGrupo(datos.username).then((grupo) => {
      if (grupo?.yo) guardarResumenOffline(datos, { grupo: nombreGrupo(grupo.clave), puestoGrupo: grupo.yo.pos });
    }).catch(() => { /* sin grupo, la ficha del lateral enseña solo la division */ });
  } catch (error) {
    console.debug('No se ha podido cargar el perfil', error);
    estado(id('mensaje'), 'No hemos podido cargar tu perfil. Vuelve a intentarlo.', 'error');
  }
});

// --- Nombre de piloto (01 Acceso · 1c) ---------------------------------------------
//
// Se comprueba al escribir, con 400 ms de espera: Libre / Ocupado / No
// permitido / Muy corto. Cada comprobacion de "ocupado" es una lectura de
// `nombres_usuario`, y la espera es lo que evita pagar una por tecla.
//
// Nada de esto es seguridad: la unicidad de verdad la impone el worker y los
// nombres los revisa igual (#64). Es para que nadie descubra al final, tras
// marcar las casillas, que su nombre no vale.

let usuarioActual = null;
/** 'libre' | 'ocupado' | 'prohibido' | 'corto' | 'comprobando' | null */
let estadoNombre = null;
let tocado = false;
let espera = null;

// Misma normalizacion que el servidor: lista y entrada, los dos lados.
const normalizar = (t) => String(t ?? '').toLowerCase().normalize('NFD')
  .replace(/\p{Diacritic}/gu, '').replace(/[\s\-_.]+/g, '');
const PROHIBIDAS = [...new Set(PALABRAS_PROHIBIDAS.map(normalizar))].filter(Boolean);

/**
 * Las palabras corrientes que llevan dentro una prohibida ("cassandra" lleva
 * "ass"). La MISMA lista que `backend/src/badwords.js`, y un test las ata.
 */
const EXCEPCIONES = [
  'cassandra', 'cassie', 'passenger', 'passing', 'compass', 'classic', 'assassin',
  'titan', 'titanic', 'title', 'competitivo', 'competition', 'constitucion',
  'sextante', 'sexto', 'sexta', 'essex', 'middlesex',
  'analisis', 'analitica', 'analog', 'canal', 'banal', 'analista',
  'cocktail', 'cockpit', 'peacock', 'shitake',
  'scunthorpe', 'penistone', 'lightwater',
  'pedalea', 'pedalear', 'pedaleo', 'pedaleando', 'pedaleador', 'pedaleadora', 'pedalero', 'pedalera',
].map(normalizar);

/**
 * ¿Se le dice "No permitido" en el acto?
 *
 * Palabra a palabra, y no con el nombre entero pegado como hace el servidor.
 * Pegado, "laura_pedalea" es "laurapedalea", que lleva "rape" dentro: aqui eso
 * BLOQUEA el boton, y bloquear a alguien por un nombre inocente es justo la
 * friccion que no queremos. El servidor sigue mirando el nombre pegado — pilla
 * el camuflaje tipo "p-u-t-a" — pero solo lo manda a moderacion, sin cortarle
 * el paso a nadie (#64).
 */
function nombreProhibido(nombre) {
  return String(nombre).split(/[\s\-_.]+/).map(normalizar).filter(Boolean).some((palabra) => {
    const sinExcepciones = EXCEPCIONES.reduce((t, e) => t.split(e).join(''), palabra);
    return PROHIBIDAS.some((p) => sinExcepciones.includes(p));
  });
}

const ESTADOS_NOMBRE = {
  libre: { texto: 'Libre', clase: 'libre', icono: 'check' },
  ocupado: { texto: 'Ocupado', clase: 'mal' },
  prohibido: { texto: 'No permitido', clase: 'mal' },
  corto: { texto: 'Muy corto', clase: 'mal' },
  comprobando: { texto: 'Comprobando…', clase: 'espera' },
};

function pintarEstadoNombre() {
  const nombre = limpiarNombre(id('rec-username').value, 20);
  const info = ESTADOS_NOMBRE[estadoNombre];
  reemplazar(id('rec-estado'), info
    ? el('span', { clase: info.clase }, [info.icono ? icono(info.icono, 'icono peq') : null, el('span', { texto: info.texto })])
    : null);

  // La pista gris de siempre, y la roja con el motivo si lo hay.
  reemplazar(id('rec-pistas'), [
    estadoNombre === 'ocupado' ? el('span', { clase: 'pista-mal', texto: `${nombre} · ocupado` }) : null,
    estadoNombre === 'prohibido' ? el('span', { clase: 'pista-mal', texto: 'No permitido' }) : null,
    el('span', { clase: 'pista', texto: 'Mín. 3 · máx. 20' }),
  ]);
  id('rec-username').setAttribute('aria-invalid', String(['ocupado', 'prohibido', 'corto'].includes(estadoNombre)));
  pintarBotonAlta();
}

/** Lo que falta, por orden. El boton no se activa hasta que no falte nada. */
function queFalta() {
  if (estadoNombre !== 'libre') {
    return {
      corto: 'El nombre necesita al menos 3 caracteres.',
      prohibido: 'Ese nombre no está permitido.',
      ocupado: 'Ese nombre ya está cogido. Prueba con otro.',
      comprobando: null,
    }[estadoNombre] ?? 'Elige tu nombre de piloto.';
  }
  if (!id('rec-edad').checked) return 'Debes confirmar que tienes 14 años o más.';
  if (!id('rec-terminos').checked) return 'Debes aceptar los términos de uso.';
  if (!id('rec-legal').checked) return 'Debes aceptar la política de privacidad.';
  return null;
}

function pintarBotonAlta() {
  const falta = queFalta();
  id('rec-enviar').disabled = Boolean(falta) || estadoNombre === 'comprobando';
  // El motivo solo cuando la persona ya ha empezado: recibir a alguien con un
  // error en rojo antes de que toque nada es hostil.
  id('rec-mensaje').textContent = tocado && falta ? falta : '';
}

async function comprobarNombre() {
  const nombre = limpiarNombre(id('rec-username').value, 20);

  if ([...nombre].length < 3) { estadoNombre = nombre ? 'corto' : null; pintarEstadoNombre(); return; }
  if (!/^[\p{L}\p{N}_\- ]+$/u.test(nombre) || nombreProhibido(nombre)) {
    estadoNombre = 'prohibido'; pintarEstadoNombre(); return;
  }

  estadoNombre = 'comprobando';
  pintarEstadoNombre();
  try {
    const reserva = await getDoc(doc(db, 'nombres_usuario', nombre.toLowerCase()));
    // Si mientras tanto se ha seguido escribiendo, esta respuesta ya no vale.
    if (limpiarNombre(id('rec-username').value, 20) !== nombre) return;
    estadoNombre = reserva.exists() && reserva.data().uid !== usuarioActual?.uid ? 'ocupado' : 'libre';
  } catch {
    // Sin poder mirarlo, se deja pasar: el worker lo comprueba igual.
    estadoNombre = 'libre';
  }
  pintarEstadoNombre();
}

id('rec-username').addEventListener('input', () => {
  tocado = true;
  clearTimeout(espera);
  estadoNombre = limpiarNombre(id('rec-username').value, 20) ? 'comprobando' : null;
  pintarEstadoNombre();
  espera = setTimeout(comprobarNombre, 400);
});

for (const casilla of ['rec-edad', 'rec-terminos', 'rec-legal']) {
  id(casilla).addEventListener('change', () => { tocado = true; pintarBotonAlta(); });
}

pintarEstadoNombre();

id('rec-enviar').addEventListener('click', async () => {
  const boton = id('rec-enviar');
  const mensaje = id('rec-mensaje');

  // Otra vez, aunque el boton ya no se active sin ello: el `disabled` se quita
  // desde la consola en un segundo.
  const fallo = queFalta();
  if (fallo || !id('rec-edad').checked || !id('rec-terminos').checked || !id('rec-legal').checked) {
    tocado = true;
    mensaje.textContent = fallo || 'Faltan casillas por marcar.';
    return;
  }

  boton.disabled = true;
  boton.textContent = 'Creando tu perfil…';
  try {
    await crearPerfil({ username: id('rec-username').value });
    // Aqui termina el alta de quien entra con Google: es su `registro_completado`.
    anotar('registro_completado');
    await volcar();
    window.location.reload();
  } catch (error) {
    mensaje.textContent = error.message;
    boton.textContent = 'Empezar a competir';
    boton.disabled = false;
  }
});
