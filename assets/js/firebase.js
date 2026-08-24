/**
 * Punto unico de arranque de Firebase.
 *
 * Antes la configuracion estaba copiada literalmente en 8 ficheros HTML, junto
 * con un cliente de PocketBase apuntando a un tunel de ngrok.
 *
 * Nota sobre la apiKey: en Firebase Web NO es un secreto, es un identificador
 * publico del proyecto. Lo que protege los datos son las reglas de Firestore
 * (que en este montaje SON el control de acceso, porque no hay servidor HTTP
 * delante) mas App Check.
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  initializeAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, sendPasswordResetEmail,
  sendEmailVerification, browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc,
  deleteDoc, query, where, orderBy, limit, startAfter, serverTimestamp, increment,
  arrayUnion, arrayRemove, writeBatch, Timestamp, onSnapshot, getDocsFromCache,
  getCountFromServer,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import {
  initializeAppCheck, ReCaptchaV3Provider,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check.js';

const configuracion = {
  apiKey: 'AIzaSyBG9QdjEG9Qmg27Dy05t0eVcVFMMPpSyVk',
  authDomain: 'bicifastness.firebaseapp.com',
  projectId: 'bicifastness',
  messagingSenderId: '656116731421',
  appId: '1:656116731421:web:a4154d028fe9721c5800f4',
};

/**
 * Clave de sitio de reCAPTCHA v3 para App Check.
 *
 * Aqui importa mas que en un montaje con servidor: como el cliente escribe
 * directamente en Firestore, App Check es lo que impide que alguien use la
 * apiKey desde un script suelto en vez de desde la web.
 * Se rellena desde la consola de Firebase (Compilacion > App Check).
 */
const RECAPTCHA_SITE_KEY = '__PON_AQUI_TU_CLAVE_DE_RECAPTCHA_V3__';

export const app = initializeApp(configuracion);

/**
 * `initializeAuth` y no `getAuth`, y sin resolutor de popup/redirect.
 *
 * `getAuth()` arrastra el resolutor de OAuth por defecto, y ese carga
 * `https://apis.google.com/js/api.js` para montar el iframe de los flujos con
 * proveedor externo. Aqui NO hay proveedores externos: se entra solo con correo
 * y contrasena. Consecuencias de dejarlo:
 *
 *   - la CSP lo bloquea (y con razon: es un dominio que no necesitamos), y el
 *     navegador llena la consola de errores en cada carga del login
 *   - o se mete `apis.google.com` en la CSP para nada
 *
 * Al declarar la persistencia aqui tampoco hace falta `setPersistence` despues,
 * que era una promesa suelta cuyo fallo se tragaba un `.catch(() => {})`.
 *
 * Si algun dia se anade "entrar con Google", habra que pasarle
 * `popupRedirectResolver: browserPopupRedirectResolver` y anadir el dominio.
 */
export const auth = initializeAuth(app, {
  persistence: browserLocalPersistence,
});
/**
 * Firestore con cache local persistente (#37).
 *
 * Sin esto, volver a una pantalla ya visitada vuelve a pagar todas sus lecturas.
 * Con la cache en IndexedDB, una consulta que no ha cambiado se sirve del disco
 * del propio movil y **no cuenta en la cuota diaria**, que es el limite que de
 * verdad aprieta en el plan Spark (ver docs/COSTE.md).
 *
 * `persistentMultipleTabManager` y no el de una sola pestana: con el sencillo,
 * abrir la web en dos pestanas deja a la segunda SIN cache y sin aviso. Pasa mas
 * de lo que parece, porque la app se abre desde enlaces.
 *
 * Es `initializeFirestore` y no `getFirestore` porque la cache solo se puede
 * declarar en la creacion. Y va con try: en modo privado de Safari IndexedDB
 * puede no estar disponible, y quedarse sin cache es peor que quedarse sin web.
 */
function crearFirestore() {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (error) {
    console.warn('Sin cache local de Firestore; se leera todo de red.', error);
    return initializeFirestore(app, {});
  }
}

export const db = crearFirestore();

if (RECAPTCHA_SITE_KEY && !RECAPTCHA_SITE_KEY.startsWith('__')) {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
} else {
  console.warn('App Check sin configurar: rellena RECAPTCHA_SITE_KEY en assets/js/firebase.js');
}

export {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, sendPasswordResetEmail, sendEmailVerification,
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, startAfter, serverTimestamp, increment,
  arrayUnion, arrayRemove, writeBatch, Timestamp,
  // `onSnapshot` se usa SOLO sobre documentos sueltos, nunca sobre una
  // coleccion: cada cambio escuchado es una lectura facturada (ver
  // assets/js/estado-viaje.js).
  onSnapshot,
  // Lee SOLO de la cache local, sin tocar la red ni gastar cuota. Lanza si no
  // hay nada cacheado, asi que quien lo use tiene que tener un plan B.
  getDocsFromCache,
  // Cuenta sin traerse los documentos: Firestore cobra UNA lectura por cada
  // 1.000 contados. Para poner un numero en pantalla es lo correcto; traerse la
  // coleccion para hacer `.length` cuesta una lectura por documento.
  getCountFromServer,
};

/**
 * Traduce los errores de Firestore a algo que una persona entienda.
 *
 * `permission-denied` es el caso interesante: con este modelo significa que las
 * reglas han rechazado la escritura, casi siempre por intentar mandar un campo
 * que el cliente no puede tocar.
 */
export function traducirError(error) {
  const mensajes = {
    'permission-denied': 'No tienes permiso para hacer esto.',
    unauthenticated: 'Tienes que iniciar sesion.',
    'not-found': 'No se ha encontrado.',
    'already-exists': 'Esto ya existe.',
    'resource-exhausted': 'Se ha alcanzado el limite de uso. Intentalo mas tarde.',
    'failed-precondition': 'Falta algun requisito previo.',
    'invalid-argument': 'Los datos enviados no son validos.',
    'deadline-exceeded': 'La operacion ha tardado demasiado.',
    unavailable: 'No hay conexion con el servidor. Revisa tu red.',
  };
  return mensajes[error?.code] || error?.message || 'Ha ocurrido un error.';
}

/** Errores de Firebase Auth, tambien en castellano. */
export function traducirErrorAuth(error) {
  const mensajes = {
    'auth/invalid-credential': 'Correo o contrasena incorrectos.',
    'auth/invalid-email': 'El correo no tiene un formato valido.',
    'auth/user-disabled': 'Esta cuenta esta deshabilitada.',
    'auth/email-already-in-use': 'Ese correo ya tiene cuenta.',
    'auth/weak-password': 'La contrasena es demasiado debil.',
    'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos.',
    'auth/network-request-failed': 'Sin conexion. Revisa tu red.',
    'auth/requires-recent-login': 'Por seguridad, vuelve a iniciar sesion antes de hacer esto.',
  };
  return mensajes[error?.code] || 'No se ha podido completar la operacion.';
}

/** Avatar por defecto, generado a partir del nombre de piloto. */
export function avatarPorDefecto(nombre) {
  return `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(nombre || 'Piloto')}&backgroundColor=0071c3`;
}
