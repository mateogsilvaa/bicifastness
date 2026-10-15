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
 * Lo que va diciendo la pantalla de obras, uno cada pocos segundos. Es lo que
 * la hace "viva": no hay nada que pulsar, pero se ve que alguien esta en ello.
 */
const TAREAS = [
  'Ajustando los radios',
  'Engrasando la cadena',
  'Inflando las ruedas',
  'Calibrando los cronos',
  'Repasando los rankings',
  'Pintando los carriles bici',
  'Apretando los frenos',
  'Poniendo a punto las estaciones',
];

// Diseño 14 · En obras: el titular cambia cada 3,4 s y, con el, los clanes
// cambian de zona. Sin movimiento, titular fijo y punto del trayecto al 62 %.
const CADA = 3400;
const SIN_MOVIMIENTO = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Madrid en puntos: las estaciones de verdad, sin calles ni nombres, en un
 * canvas. Tres clanes iluminan cada uno una zona y saltan a otra con cada
 * titular. Abstracto y lento a proposito: es un fondo, no algo que mirar.
 *
 * Las estaciones se piden aqui (`import()`), no al cargar la puerta: solo las
 * descarga quien ve las obras. Es un canvas y no un SVG con un circulo por
 * estacion: asi `vigilar` no se despierta con cada cambio de color.
 */
const CLANES = ['#FF5A1F', '#13A89E', '#8B5CF6'];

function mapaAnimado() {
  const lienzo = document.createElement('canvas');
  lienzo.className = 'obras-mapa';
  lienzo.setAttribute('aria-hidden', 'true');
  const mapa = { lienzo, cambiar: () => {} };

  import('../data/estaciones.js').then(({ ESTACIONES }) => {
    const lista = Object.values(ESTACIONES).filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon));
    if (!lista.length) return;
    // Proyeccion plana: a esta escala, longitud por el coseno de la latitud.
    const lat0 = lista.reduce((t, e) => t + e.lat, 0) / lista.length;
    const k = Math.cos((lat0 * Math.PI) / 180);
    const puntos = lista.map((e) => ({ x: e.lon * k, y: -e.lat, clan: -1, luz: 0 }));
    const xs = puntos.map((p) => p.x);
    const ys = puntos.map((p) => p.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const ctx = lienzo.getContext('2d');
    let base = '#D6D2C8';
    let colocar = () => {};

    // Ocupa toda la pantalla recortando lo que sobre, como `cover`.
    const medir = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = lienzo.clientWidth || innerWidth;
      const h = lienzo.clientHeight || innerHeight;
      lienzo.width = Math.round(w * dpr);
      lienzo.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const margen = 0.04;
      const escala = Math.max(w / ((maxX - minX) * (1 + margen)), h / ((maxY - minY) * (1 + margen)));
      const ox = (w - (maxX - minX) * escala) / 2;
      const oy = (h - (maxY - minY) * escala) / 2;
      colocar = (p) => [ox + (p.x - minX) * escala, oy + (p.y - minY) * escala];
      base = getComputedStyle(lienzo).getPropertyValue('--punto').trim() || base;
    };

    const pintar = () => {
      const w = lienzo.clientWidth || innerWidth;
      const h = lienzo.clientHeight || innerHeight;
      ctx.clearRect(0, 0, w, h);
      for (const p of puntos) {
        const [x, y] = colocar(p);
        ctx.beginPath();
        ctx.arc(x, y, 1.8 + p.luz * 2, 0, Math.PI * 2);
        ctx.fillStyle = base;
        ctx.globalAlpha = 1;
        ctx.fill();
        if (p.luz > 0.01 && p.clan >= 0) {
          ctx.fillStyle = CLANES[p.clan];
          ctx.globalAlpha = p.luz;
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    };

    // Cada clan, en una estacion al azar y sus vecinas. Lejos de los otros dos.
    const repartir = () => {
      const centros = [];
      for (let c = 0; c < CLANES.length; c++) {
        let centro;
        for (let intento = 0; intento < 12; intento++) {
          centro = puntos[Math.floor(Math.random() * puntos.length)];
          const lejos = centros.every((o) => (o.x - centro.x) ** 2 + (o.y - centro.y) ** 2 > ((maxX - minX) / 4) ** 2);
          if (lejos) break;
        }
        centros.push(centro);
      }
      for (const p of puntos) p.objetivo = -1;
      centros.forEach((centro, c) => {
        puntos
          .map((p) => ({ p, d: (p.x - centro.x) ** 2 + (p.y - centro.y) ** 2 }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 18 + Math.floor(Math.random() * 16))
          .forEach(({ p }) => { if (p.objetivo === -1) p.objetivo = c; });
      });
    };

    // La luz sube (0,9 s) y baja (0,5 s) por tiempo, no por fotograma; un punto
    // que cambia de clan se apaga antes de encenderse en el nuevo.
    let animando = false;
    let antes = 0;
    const avanzar = (ahora) => {
      const dt = Math.min(0.5, (ahora - (antes || ahora)) / 1000);
      antes = ahora;
      let quieto = true;
      for (const p of puntos) {
        if (p.clan !== p.objetivo) {
          p.luz = Math.max(0, p.luz - dt / 0.5);
          if (p.luz === 0) p.clan = p.objetivo;
          quieto = false;
        } else if (p.clan >= 0 && p.luz < 1) {
          p.luz = Math.min(1, p.luz + dt / 0.9);
          quieto = false;
        }
      }
      pintar();
      animando = !quieto;
      if (animando) requestAnimationFrame(avanzar);
    };
    const mover = () => { if (!animando) { animando = true; antes = 0; requestAnimationFrame(avanzar); } };

    medir();
    repartir();
    if (SIN_MOVIMIENTO()) {
      for (const p of puntos) { p.clan = p.objetivo; p.luz = p.clan >= 0 ? 1 : 0; }
      pintar();
    } else {
      mover();
      mapa.cambiar = () => { repartir(); mover(); };
    }
    addEventListener('resize', () => { medir(); pintar(); });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { medir(); pintar(); });
  }).catch(() => { /* sin estaciones, la pantalla sigue igual de bien sin fondo */ });
  return mapa;
}

/** La barra de progreso es un trayecto: salida, meta y un punto que la recorre. */
function trayecto() {
  const caja = document.createElement('div');
  caja.className = 'obras-trayecto';
  caja.setAttribute('aria-hidden', 'true');
  const linea = document.createElement('div');
  linea.className = 'obras-linea';
  for (const clase of ['obras-hecho', 'obras-salida', 'obras-meta', 'obras-punto']) {
    const parte = document.createElement('span');
    parte.className = clase;
    linea.append(parte);
  }
  const rotulos = document.createElement('div');
  rotulos.className = 'obras-rotulos';
  const salida = document.createElement('span');
  salida.textContent = 'Salida';
  const meta = document.createElement('span');
  meta.textContent = 'Meta';
  rotulos.append(salida, meta);
  caja.append(linea, rotulos);
  return caja;
}

const LOGO = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false"><rect width="24" height="24" rx="6.5" fill="#1B80E5"></rect><path d="M12 5 A7 7 0 1 1 5.94 8.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"></path><circle cx="5.94" cy="8.5" r="2.1" fill="#fff"></circle></svg>';
const INSTAGRAM = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"></rect><circle cx="12" cy="12" r="4"></circle><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"></circle></svg>';

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
  const capa = document.createElement('div');
  capa.id = 'pantalla-obras';
  capa.setAttribute('role', 'status');
  capa.setAttribute('aria-labelledby', 'obras-titulo');

  const cabecera = document.createElement('header');
  cabecera.className = 'obras-cabecera';
  const logo = document.createElement('span');
  logo.className = 'obras-logo';
  logo.innerHTML = `${LOGO}<span>bicifastness</span>`;
  cabecera.append(logo);

  const caja = document.createElement('div');
  caja.className = 'obras-caja';

  const chip = document.createElement('span');
  chip.className = 'obras-chip';
  chip.textContent = 'En construcción';

  const titulo = document.createElement('h1');
  titulo.id = 'obras-titulo';
  const tarea = document.createElement('span');
  tarea.className = 'obras-tarea';
  tarea.textContent = TAREAS[0];
  titulo.append(tarea);

  const texto = document.createElement('p');
  texto.className = 'obras-texto';
  texto.textContent = mensaje || 'BiciFastness todavía está en construcción. Volvemos muy pronto.';

  // Donde contamos cuando abre.
  const redes = document.createElement('a');
  redes.className = 'obras-redes';
  redes.href = 'https://www.instagram.com/bicifastness/';
  redes.target = '_blank';
  redes.rel = 'noopener';
  redes.innerHTML = INSTAGRAM;
  const arroba = document.createElement('span');
  arroba.textContent = 'Síguenos en @bicifastness';
  redes.append(arroba);

  caja.append(chip, titulo, trayecto(), texto, redes);

  // Quien ya tiene sesion y no esta en la lista: se le dice, y puede salir.
  // No es una puerta: no da acceso a nada.
  if (usuario) {
    const nota = document.createElement('p');
    nota.className = 'obras-nota';
    nota.textContent = `Has entrado como ${usuario.email || 'una cuenta sin correo'}, que todavía no tiene acceso.`;
    const salir = document.createElement('button');
    salir.type = 'button';
    salir.className = 'obras-salir';
    salir.textContent = 'Cerrar sesión';
    salir.addEventListener('click', () => signOut(auth).then(() => window.location.reload()));
    caja.append(nota, salir);
  }

  const mapa = mapaAnimado();
  const velo = document.createElement('div');
  velo.className = 'obras-velo';
  capa.append(mapa.lienzo, velo, cabecera, caja);
  document.body.append(capa);
  document.body.classList.add('en-obras');

  // La tarea cambia con fundido y desenfoque, y los clanes se mudan con ella.
  // Sin movimiento pedido, se queda la primera.
  if (SIN_MOVIMIENTO()) { vigilar(capa); return; }
  let n = 0;
  setInterval(() => {
    tarea.classList.add('sale');
    setTimeout(() => {
      n = (n + 1) % TAREAS.length;
      tarea.textContent = TAREAS[n];
      tarea.classList.remove('sale');
      mapa.cambiar();
    }, 450);
  }, CADA);

  vigilar(capa);
}

/** La llama `iniciarPagina`. No bloquea nada mientras la web este abierta. */
export async function comprobarAcceso() {
  if (LIBRES.some((r) => r.test(window.location.pathname))) return;
  // Sin saber aun si la web esta en obras (o sabiendo que si), la pagina se
  // tapa YA: si no, se ve un instante antes de que llegue la respuesta. Solo
  // se enseña sin esperar cuando hace poco se ha visto abierta.
  if (guardado()?.modo !== 'abierta') document.documentElement.classList.add('acceso-pendiente');
  const { modo, mensaje } = await leerModo();
  if (modo !== 'obras') {
    document.documentElement.classList.remove('acceso-pendiente');
    return;
  }
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
