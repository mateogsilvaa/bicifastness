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

function pintarObras({ mensaje, usuario }) {
  document.documentElement.classList.remove('acceso-pendiente');
  if (document.getElementById('pantalla-obras')) return;
  const capa = document.createElement('div');
  capa.id = 'pantalla-obras';
  capa.setAttribute('role', 'dialog');
  capa.setAttribute('aria-modal', 'true');
  capa.setAttribute('aria-labelledby', 'obras-titulo');
  const caja = document.createElement('div');
  caja.className = 'obras-caja';
  const titulo = document.createElement('h1');
  titulo.id = 'obras-titulo';
  titulo.textContent = 'Estamos ajustando los radios';
  const texto = document.createElement('p');
  texto.textContent = mensaje || 'BiciFastness está en construcción. Volvemos muy pronto.';
  caja.append(titulo, texto);
  if (usuario) {
    const nota = document.createElement('p');
    nota.className = 'obras-nota';
    nota.textContent = usuario.emailVerified
      ? `Tu cuenta (${usuario.email || 'sin correo'}) todavía no tiene acceso.`
      : `Si tu correo (${usuario.email || 'sin correo'}) está en la lista, verifícalo primero desde el enlace que te enviamos.`;
    const salir = document.createElement('button');
    salir.type = 'button';
    salir.className = 'btn secundario';
    salir.textContent = 'Salir';
    salir.addEventListener('click', () => signOut(auth).then(() => window.location.reload()));
    caja.append(nota, salir);
  } else {
    const entrar = document.createElement('a');
    entrar.className = 'btn';
    entrar.href = '/entrar/';
    entrar.textContent = 'Tengo acceso: entrar';
    caja.append(entrar);
  }
  capa.append(caja);
  document.body.append(capa);
  document.body.classList.add('en-obras');
}

/** La llama `iniciarPagina`. No bloquea nada mientras la web este abierta. */
export async function comprobarAcceso() {
  if (LIBRES.some((r) => r.test(window.location.pathname))) return;
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
