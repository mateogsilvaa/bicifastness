/**
 * La web abierta o "en construccion".
 *
 * La administracion lo decide en /admin/acceso/ (`config/acceso`). En obras,
 * solo entran quien es administrador y los correos de la lista blanca
 * (`acceso_lista/{correo}`). Estar en la lista NO da acceso a /admin/: eso
 * sigue siendo el claim `admin`, y el panel lo comprueba aparte.
 *
 * Esto es la puerta que se ve. La que manda son las reglas de Firestore: en
 * obras, nadie fuera de la lista puede subir trayectos, registrarse, valorar ni
 * tocar clanes, aunque se salte esta pantalla desde la consola.
 *
 * Coste: una lectura de `config/acceso` por pestaña (se guarda 5 minutos en la
 * sesion) y, solo en obras, otra para mirar la lista con tu correo.
 */

import { auth, db, doc, getDoc, onAuthStateChanged, signOut } from './firebase.js';

// Las que tienen que verse siempre: entrar (para que los de la lista puedan),
// los textos legales, darse de baja, la pantalla sin red y el panel.
const LIBRES = [/^\/entrar\//, /^\/register\//, /^\/legal\//, /^\/baja\//, /^\/offline\//, /^\/mantenimiento\//, /^\/admin\//];
const CLAVE = 'bf_acceso';
const VIGENCIA = 5 * 60 * 1000;

function guardado() {
  try {
    const d = JSON.parse(sessionStorage.getItem(CLAVE) || 'null');
    return d && Date.now() - d.t < VIGENCIA ? d : null;
  } catch {
    return null;
  }
}

function guardar(datos) {
  try { sessionStorage.setItem(CLAVE, JSON.stringify({ ...datos, t: Date.now() })); } catch { /* sin almacenamiento se vuelve a leer */ }
}

async function leerModo() {
  const previo = guardado();
  if (previo) return previo;
  try {
    const snap = await getDoc(doc(db, 'config', 'acceso'));
    const d = snap.exists() ? snap.data() : {};
    const datos = { modo: d.modo === 'obras' ? 'obras' : 'abierta', mensaje: String(d.mensaje || '').slice(0, 300) };
    guardar(datos);
    return datos;
  } catch {
    // Sin poder leerlo no se cierra la web a nadie: las reglas siguen
    // protegiendo lo que importa.
    return { modo: 'abierta' };
  }
}

const usuarioActual = () => new Promise((resolver) => {
  const parar = onAuthStateChanged(auth, (u) => { parar(); resolver(u); });
});

async function tienePase(usuario) {
  if (!usuario) return false;
  try {
    const token = await usuario.getIdTokenResult();
    if (token.claims?.admin === true) return true;
    // Como en las reglas: con el correo verificado (Google ya lo da hecho).
    if (!usuario.emailVerified) return false;
    const correo = String(usuario.email || '').toLowerCase();
    if (!correo) return false;
    return (await getDoc(doc(db, 'acceso_lista', correo))).exists();
  } catch {
    return false;
  }
}

/**
 * Diseño 14 · En obras. Es la misma pantalla que /mantenimiento/ (la que se
 * publica con la web cerrada): textos, medidas y movimiento salen de
 * mantenimiento/obras.css y obras.js. Si cambia una, hay que cambiar la otra.
 *
 * El titular rota cada 4,6 s y, con el, tres clanes iluminan otra zona del
 * mapa. Sin movimiento pedido: titular fijo, zonas fijas y punto al 62 %.
 */
const TITULARES = ['Ajustando los radios', 'Calibrando los cronos', 'Inflando las ruedas', 'Engrasando la cadena'];
const CADA = 4600;
const SIN_MOVIMIENTO = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ES_MOVIL = () => window.matchMedia('(max-width: 700px)').matches;

const NS = 'http://www.w3.org/2000/svg';

function svg(etiqueta, attrs = {}, hijos = []) {
  const n = document.createElementNS(NS, etiqueta);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  n.append(...hijos);
  return n;
}

function nodo(etiqueta, clase, texto) {
  const n = document.createElement(etiqueta);
  if (clase) n.className = clase;
  if (texto) n.textContent = texto;
  return n;
}

/**
 * Madrid en puntos: las estaciones de verdad, en un canvas. Tres clanes
 * iluminan cada uno la zona de una de las semillas y saltan a otra con cada
 * titular.
 *
 * Las estaciones se piden aqui (`import()`), no al cargar la puerta: solo las
 * descarga quien ve las obras. Es un canvas y no un SVG con un circulo por
 * estacion: asi `vigilar` no se despierta con cada cambio de color.
 */
const SEMILLAS = [[40.428, -3.703], [40.425, -3.682], [40.408, -3.700], [40.436, -3.716], [40.445, -3.690], [40.412, -3.676], [40.418, -3.724], [40.438, -3.668]];
const CLANES = ['#FF5A1F', '#13A89E', '#E23D8C'];

function mapaAnimado() {
  const lienzo = nodo('canvas', 'obras-mapa');
  lienzo.setAttribute('aria-hidden', 'true');
  const ctx = lienzo.getContext('2d');
  const reducido = SIN_MOVIMIENTO();
  let estaciones = [];
  let puntos = [];
  let ancho = 0;
  let alto = 0;
  let fase = 0;
  let pendiente = false;

  const pedir = () => {
    if (pendiente) return;
    pendiente = true;
    requestAnimationFrame(dibujar);
  };

  const reasignar = () => {
    const activos = [0, 1, 2].map((i) => ({ s: SEMILLAS[(fase * (i + 1) + i * 3) % 8], c: CLANES[i] }));
    for (const p of puntos) {
      p.meta = 0;
      for (const a of activos) {
        if (Math.hypot(a.s[0] - p.lat, (a.s[1] - p.lon) * 0.76) < 0.0145) { p.meta = 1; p.color = a.c; break; }
      }
      if (reducido) p.ahora = p.meta;
    }
    pedir();
  };

  function dibujar() {
    pendiente = false;
    ctx.clearRect(0, 0, ancho, alto);
    // El gris de los puntos sigue al tema de la app (claro u oscuro).
    const neutro = getComputedStyle(lienzo).getPropertyValue('--obras-neutro').trim() || '#CAC6BB';
    const r0 = ES_MOVIL() ? 2.6 : 3.3;
    let animando = false;
    for (const p of puntos) {
      if (p.ahora !== p.meta) {
        p.ahora += Math.sign(p.meta - p.ahora) * 0.04;
        if (Math.abs(p.meta - p.ahora) < 0.04) p.ahora = p.meta; else animando = true;
      }
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = neutro;
      ctx.beginPath(); ctx.arc(p.x, p.y, r0, 0, 6.2832); ctx.fill();
      if (p.ahora > 0 && p.color) {
        ctx.globalAlpha = p.ahora;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, r0 + 0.9, 0, 6.2832); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    if (animando) pedir();
  }

  const medir = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ancho = window.innerWidth; alto = window.innerHeight;
    lienzo.width = ancho * dpr; lienzo.height = alto * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const movil = ES_MOVIL();
    const escala = Math.max(ancho / 0.152, alto / 0.18) * (movil ? 1 : 0.92);
    const cx = movil ? 0.52 : 0.5;
    const cy = movil ? 0.36 : 0.5;
    puntos = estaciones
      .map((e) => ({ lat: e.lat, lon: e.lon, x: (e.lon + 3.69) * 0.76 * escala + ancho * cx, y: (40.425 - e.lat) * escala + alto * cy, ahora: 0, meta: 0, color: null }))
      .filter((p) => p.x > -6 && p.y > -6 && p.x < ancho + 6 && p.y < alto + 6);
    reasignar();
  };

  import('../data/estaciones.js').then(({ ESTACIONES }) => {
    estaciones = Object.values(ESTACIONES).filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon));
    medir();
    addEventListener('resize', medir);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', pedir);
  }).catch(() => { /* sin estaciones, la pantalla sigue igual de bien sin fondo */ });

  return { lienzo, cambiar: () => { fase += 1; reasignar(); } };
}

/** El trayecto: salida, meta y un punto que recorre la linea (todo en CSS). */
function trayecto() {
  const caja = nodo('div', 'obras-trayecto');
  caja.setAttribute('aria-hidden', 'true');
  const linea = nodo('div', 'obras-trayecto-linea');
  const carril = nodo('div', 'obras-carril');
  carril.append(nodo('span', 'obras-guion'), nodo('span', 'obras-estela'), nodo('span', 'obras-punto'));
  linea.append(nodo('span', 'obras-salida'), nodo('span', 'obras-meta'), carril);
  const rotulos = nodo('div', 'obras-trayecto-rotulos');
  rotulos.append(nodo('span', '', 'Salida'), nodo('span', '', 'Meta'));
  caja.append(linea, rotulos);
  return caja;
}

const logo = () => svg('svg', { viewBox: '0 0 24 24', width: 34, height: 34, 'aria-hidden': 'true', focusable: 'false' }, [
  svg('rect', { width: 24, height: 24, rx: 6.5 }),
  svg('path', { d: 'M12 5 A7 7 0 1 1 5.94 8.5' }),
  svg('circle', { cx: 5.94, cy: 8.5, r: 2.1 }),
]);

const flecha = () => svg('svg', {
  width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
}, [svg('path', { d: 'M5 12h14M13 6l6 6-6 6' })]);

/**
 * Se repinta solo si alguien la quita o la esconde desde la consola, y la
 * pagina de debajo queda `inert` y oculta: no hay nada que pulsar ni que leer.
 * Quitarla a mano tampoco da nada: lo que importa (subir, registrarse,
 * valorar, clanes) lo cierran las reglas de Firestore, no esta pantalla.
 */
function vigilar(capa) {
  const tapar = () => {
    for (const hijo of document.body.children) {
      if (hijo === capa) continue;
      // Solo si hace falta: tocar un atributo aunque no cambie avisa al
      // vigilante, y se llamaria a si mismo sin parar.
      if (!hijo.hasAttribute('inert')) hijo.setAttribute('inert', '');
      if (hijo.getAttribute('aria-hidden') !== 'true') hijo.setAttribute('aria-hidden', 'true');
      if (hijo.style.getPropertyValue('display') !== 'none' || hijo.style.getPropertyPriority('display') !== 'important') {
        hijo.style.setProperty('display', 'none', 'important');
      }
    }
  };
  tapar();
  new MutationObserver(() => {
    if (!capa.isConnected) document.body.append(capa);
    if (capa.hidden || capa.style.display || capa.style.visibility || capa.style.opacity) {
      capa.hidden = false;
      capa.removeAttribute('style');
    }
    if (!document.body.classList.contains('en-obras')) document.body.classList.add('en-obras');
    tapar();
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden', 'class', 'inert'] });
}


function pintarObras({ mensaje, usuario }) {
  document.documentElement.classList.remove('acceso-pendiente');
  if (document.getElementById('pantalla-obras')) return;
  const capa = nodo('div');
  capa.id = 'pantalla-obras';
  capa.setAttribute('role', 'status');
  capa.setAttribute('aria-labelledby', 'obras-titular');

  const velo = nodo('div', 'obras-velo');
  velo.setAttribute('aria-hidden', 'true');

  const cabecera = nodo('header', 'obras-cabecera');
  const marca = nodo('a', 'obras-logo');
  marca.href = '/';
  marca.setAttribute('aria-label', 'bicifastness');
  marca.append(logo(), nodo('span', '', 'bicifastness'));
  cabecera.append(marca, nodo('span', 'obras-dominio', 'bicifastness.es'));

  const centro = nodo('div', 'obras-centro');
  const titular = nodo('h1', 'obras-titular', TITULARES[0]);
  titular.id = 'obras-titular';

  // Donde contamos cuando abre.
  const boton = nodo('a', 'obras-boton');
  boton.href = 'https://instagram.com/bicifastness';
  boton.target = '_blank';
  boton.rel = 'noopener';
  boton.append(
    nodo('span', 'obras-boton-largo', 'Atentos a @bicifastness en Instagram'),
    nodo('span', 'obras-boton-corto', '@bicifastness en Instagram'),
    flecha(),
  );

  centro.append(
    nodo('span', 'obras-estado', 'En obras'),
    titular,
    trayecto(),
    nodo('p', 'obras-texto', mensaje || 'BiciFastness está en obras. Volvemos muy pronto con la clasificación, las rutas y el mapa de clanes.'),
    boton,
  );

  // Quien ya tiene sesion y no esta en la lista: se le dice, y puede salir.
  // No es una puerta: no da acceso a nada.
  if (usuario) {
    const nota = nodo('p', 'obras-nota', `Has entrado como ${usuario.email || 'una cuenta sin correo'}, que todavía no tiene acceso. `);
    const salir = nodo('button', 'obras-salir', 'Cerrar sesión');
    salir.type = 'button';
    salir.addEventListener('click', () => signOut(auth).then(() => window.location.reload()));
    nota.append(salir);
    centro.append(nota);
  }

  const pie = nodo('footer', 'obras-pie', 'Proyecto independiente. Sin relación con BiciMAD, la EMT ni el Ayuntamiento de Madrid.');

  const mapa = mapaAnimado();
  capa.append(mapa.lienzo, velo, cabecera, centro, pie);
  document.body.append(capa);
  document.body.classList.add('en-obras');

  // El titular cambia con fundido y desenfoque, y los clanes se mudan con el.
  if (SIN_MOVIMIENTO()) { vigilar(capa); return; }
  let n = 0;
  setInterval(() => {
    titular.classList.add('sale');
    setTimeout(() => {
      n = (n + 1) % TITULARES.length;
      titular.textContent = TITULARES[n];
      titular.classList.remove('sale');
      mapa.cambiar();
    }, 260);
  }, CADA);

  vigilar(capa);
}

// La ultima vez que este navegador miro, ¿estaba la web en obras? Solo
// entonces se tapa la pagina mientras se comprueba.
const CLAVE_OBRAS = 'bf_web_en_obras';
function vistaEnObras() {
  try { return localStorage.getItem(CLAVE_OBRAS) === '1'; } catch { return false; }
}
function recordarObras(si) {
  try {
    if (si) localStorage.setItem(CLAVE_OBRAS, '1');
    else localStorage.removeItem(CLAVE_OBRAS);
  } catch { /* sin almacenamiento: no se tapa, y la comprobacion sigue */ }
}

/** La llama `iniciarPagina`. No bloquea nada mientras la web este abierta. */
export async function comprobarAcceso() {
  if (LIBRES.some((r) => r.test(window.location.pathname))) return;
  // La pagina solo se tapa mientras se comprueba si la ultima vez se vio en
  // obras. Antes se tapaba siempre que no se hubiera visto abierta en las
  // ultimas 12 horas, o sea en TODA primera visita: nadie veia nada hasta
  // cargar reCAPTCHA, sacar el token de App Check y leer `config/acceso`,
  // varios segundos en un movil. Con la web abierta eso era pura espera.
  // Lo que se pierde: si se cierra la web, quien no la haya visto cerrada
  // puede ver la pagina un instante antes de las obras. Lo que protege de
  // verdad (subir, registrarse, clanes) son las reglas, no esta pantalla.
  if (guardado()?.modo === 'obras' || vistaEnObras()) document.documentElement.classList.add('acceso-pendiente');
  const { modo, mensaje } = await leerModo();
  if (modo !== 'obras') {
    recordarObras(false);
    document.documentElement.classList.remove('acceso-pendiente');
    return;
  }
  recordarObras(true);
  // En obras se tapa la pagina mientras se comprueba, para no enseñarla.
  document.documentElement.classList.add('acceso-pendiente');
  const usuario = await usuarioActual();
  const pase = guardado()?.pase === usuario?.uid && usuario ? true : await tienePase(usuario);
  if (pase) {
    guardar({ modo, mensaje, pase: usuario.uid });
    document.documentElement.classList.remove('acceso-pendiente');
    return;
  }
  pintarObras({ mensaje, usuario });
}
