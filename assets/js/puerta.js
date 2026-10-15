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

/**
 * Madrid en puntos: las estaciones de verdad, sin calles ni nombres. Cada poco
 * un barrio cambia de color, como si un clan lo conquistara, y vuelve a
 * apagarse. Abstracto y lento a proposito: es un fondo, no algo que mirar.
 *
 * Las estaciones se piden aqui (`import()`), no al cargar la puerta: solo las
 * descarga quien ve las obras.
 *
 * El color va en `data-c` y no en `class` ni `style`: `vigilar` escucha esos
 * atributos en todo el documento y se despertaria en cada cambio.
 */
const COLORES = 4;

function mapaAnimado() {
  const dibujo = svg('svg', {
    class: 'obras-mapa', 'aria-hidden': 'true', focusable: 'false', preserveAspectRatio: 'xMidYMid slice',
  });
  import('../data/estaciones.js').then(({ ESTACIONES }) => {
    const lista = Object.values(ESTACIONES).filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon));
    if (!lista.length) return;
    // Proyeccion plana: a esta escala, longitud por el coseno de la latitud.
    const lat0 = lista.reduce((t, e) => t + e.lat, 0) / lista.length;
    const k = Math.cos((lat0 * Math.PI) / 180);
    const xs = lista.map((e) => e.lon * k * 1000);
    const ys = lista.map((e) => -e.lat * 1000);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const margen = 6;
    dibujo.setAttribute('viewBox', `${minX - margen} ${minY - margen} ${maxX - minX + 2 * margen} ${maxY - minY + 2 * margen}`);
    // El mapa se recorta para llenar la pantalla (`slice`), asi que en un movil
    // estrecho se amplia mucho: el radio se calcula para que cada punto mida
    // lo mismo en pantalla, unos 3 px, sea cual sea el tamaño.
    const ancho = maxX - minX + 2 * margen;
    const alto = maxY - minY + 2 * margen;
    const ajustar = () => {
      const escala = Math.max(innerWidth / ancho, innerHeight / alto) || 1;
      dibujo.style.setProperty('--radio-punto', `${(3.4 / escala).toFixed(3)}px`);
    };
    ajustar();
    addEventListener('resize', ajustar);

    const puntos = lista.map((_, i) => {
      const punto = svg('circle', { cx: xs[i].toFixed(2), cy: ys[i].toFixed(2), r: 1.6 });
      dibujo.append(punto);
      return { punto, x: xs[i], y: ys[i] };
    });

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Sin movimiento: unos barrios ya pintados, quietos.
      for (let c = 1; c <= COLORES; c++) conquistar(puntos, c);
      return;
    }
    let turno = 0;
    const paso = () => {
      turno += 1;
      conquistar(puntos, (turno % COLORES) + 1);
    };
    for (let i = 0; i < 3; i++) paso();
    setInterval(paso, 1800);
  }).catch(() => { /* sin estaciones, la pantalla sigue igual de bien sin fondo */ });
  return dibujo;
}

/** Un barrio (la estacion elegida y sus vecinas) pasa a un color, y luego se apaga. */
function conquistar(puntos, color) {
  const centro = puntos[Math.floor(Math.random() * puntos.length)];
  const vecinas = puntos
    .map((p) => ({ p, d: (p.x - centro.x) ** 2 + (p.y - centro.y) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 14 + Math.floor(Math.random() * 18));
  vecinas.forEach(({ p }, i) => {
    // Desde el centro hacia fuera, como una mancha que se extiende.
    setTimeout(() => p.punto.setAttribute('data-c', String(color)), i * 45);
  });
  setTimeout(() => {
    for (const { p } of vecinas) if (p.punto.getAttribute('data-c') === String(color)) p.punto.removeAttribute('data-c');
  }, 9000 + Math.random() * 4000);
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
  titulo.append(tarea);

  const texto = document.createElement('p');
  texto.textContent = mensaje || 'BiciFastness todavía está en construcción. Volvemos muy pronto.';

  const barra = document.createElement('div');
  barra.className = 'obras-barra';
  barra.setAttribute('aria-hidden', 'true');
  barra.append(document.createElement('span'));

  // Donde contamos cuando abre.
  const redes = document.createElement('a');
  redes.className = 'obras-redes';
  redes.href = 'https://www.instagram.com/bicifastness/';
  redes.target = '_blank';
  redes.rel = 'noopener';
  const arroba = document.createElement('strong');
  arroba.textContent = '@bicifastness';
  redes.append('Atentos a ', arroba, ' en Instagram');

  caja.append(chip, titulo, barra, texto, redes);

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

  capa.append(mapaAnimado(), caja);
  document.body.append(capa);
  document.body.classList.add('en-obras');

  // La tarea cambia despacio, con un fundido: cada 2,8 s y saltando mareaba.
  // Sin movimiento pedido, se queda la primera.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { vigilar(capa); return; }
  let n = 0;
  setInterval(() => {
    tarea.classList.add('sale');
    setTimeout(() => {
      n = (n + 1) % TAREAS.length;
      tarea.textContent = TAREAS[n];
      tarea.classList.remove('sale');
    }, 700);
  }, 6000);

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
