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

const NS = 'http://www.w3.org/2000/svg';

function svg(etiqueta, attrs = {}) {
  const nodo = document.createElementNS(NS, etiqueta);
  for (const [k, v] of Object.entries(attrs)) nodo.setAttribute(k, String(v));
  return nodo;
}

/** Una bici de lineas: dos ruedas con radios que giran y el cuadro quieto. */
function biciAnimada() {
  const dibujo = svg('svg', { viewBox: '0 0 220 120', class: 'obras-bici', 'aria-hidden': 'true', focusable: 'false' });
  const rueda = (cx) => {
    const g = svg('g', { class: 'obras-rueda', style: `transform-origin: ${cx}px 84px` });
    g.append(svg('circle', { cx, cy: 84, r: 30 }));
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 6;
      g.append(svg('line', {
        x1: cx - 30 * Math.cos(a), y1: 84 - 30 * Math.sin(a), x2: cx + 30 * Math.cos(a), y2: 84 + 30 * Math.sin(a),
      }));
    }
    return g;
  };
  const cuadro = svg('path', { class: 'obras-cuadro', d: 'M50 84 L88 40 L150 40 L170 84 M88 40 L112 84 L150 40 M112 84 L50 84 M82 30 L98 30 M150 40 L146 26 L160 26' });
  dibujo.append(rueda(50), rueda(170), cuadro, svg('line', { class: 'obras-suelo', x1: 0, y1: 116, x2: 220, y2: 116 }));
  return dibujo;
}

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
  const puntos = document.createElement('span');
  puntos.className = 'obras-puntos';
  puntos.setAttribute('aria-hidden', 'true');
  puntos.textContent = '...';
  titulo.append(tarea, puntos);

  const texto = document.createElement('p');
  texto.textContent = mensaje || 'BiciFastness todavía está en construcción. Volvemos muy pronto.';

  const barra = document.createElement('div');
  barra.className = 'obras-barra';
  barra.setAttribute('aria-hidden', 'true');
  barra.append(document.createElement('span'));

  caja.append(biciAnimada(), chip, titulo, barra, texto);

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

  capa.append(caja);
  document.body.append(capa);
  document.body.classList.add('en-obras');

  // La tarea cambia cada pocos segundos (sin movimiento si se ha pedido asi).
  let n = 0;
  setInterval(() => {
    n = (n + 1) % TAREAS.length;
    tarea.classList.remove('entra');
    void tarea.offsetWidth;
    tarea.textContent = TAREAS[n];
    tarea.classList.add('entra');
  }, 2800);

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
