// Modulo de la pagina /admin/acceso/: abrir o cerrar la web y la lista blanca.
//
// Lo que se decide aqui lo aplican dos sitios: la puerta del navegador
// (assets/js/puerta.js), que enseña la pantalla de obras, y las reglas de
// Firestore (`puedeUsarLaWeb`), que son las que de verdad impiden escribir.

import {
  auth, db, doc, getDoc, getDocs, setDoc, deleteDoc, collection, serverTimestamp,
} from '/assets/js/firebase.js';
import { iniciarPagina } from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';
import { montarCabeceraAdmin, exigirAdmin } from '/assets/js/admin-cabecera.js';

iniciarPagina('admin');
montarCabeceraAdmin('acceso');

const CORREO = /^[^@/\s]+@[^@/\s]+\.[^@/\s]+$/;

async function pintarModo() {
  const snap = await getDoc(doc(db, 'config', 'acceso'));
  const datos = snap.exists() ? snap.data() : {};
  const modo = datos.modo === 'obras' ? 'obras' : 'abierta';
  for (const r of document.querySelectorAll('input[name="modo"]')) r.checked = r.value === modo;
  id('acceso-mensaje').value = datos.mensaje || '';
}

async function guardarModo() {
  const modo = document.querySelector('input[name="modo"]:checked')?.value || 'abierta';
  const mensaje = id('acceso-mensaje').value.trim().slice(0, 300);
  await setDoc(doc(db, 'config', 'acceso'), {
    modo, mensaje, por: auth.currentUser.uid, actualizado: serverTimestamp(),
  });
  // La puerta guarda el modo 5 min en la sesion: en esta pestaña, se olvida ya.
  try { sessionStorage.removeItem('bf_acceso'); } catch { /* sin almacenamiento no hay nada que olvidar */ }
  estado(id('mensaje'), modo === 'obras'
    ? 'La web está en construcción: solo entra la lista blanca.'
    : 'La web está abierta para todo el mundo.', 'exito');
}

async function pintarLista() {
  const snap = await getDocs(collection(db, 'acceso_lista'));
  const filas = snap.docs
    .map((d) => ({ correo: d.id, ...d.data() }))
    .sort((a, b) => a.correo.localeCompare(b.correo));
  reemplazar(id('lista-acceso'), filas.length
    ? filas.map((f) => el('div', { clase: 'adm-estado-fila acceso-fila' }, [
      el('span', {}, [el('strong', { texto: f.correo }), f.nota ? el('small', { texto: ` · ${f.nota}` }) : null]),
      el('button', {
        clase: 'btn secundario', texto: 'Quitar', attrs: { type: 'button', 'aria-label': `Quitar ${f.correo}` },
        on: {
          click: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await deleteDoc(doc(db, 'acceso_lista', f.correo));
              await pintarLista();
            } catch (error) {
              estado(id('mensaje'), `No se ha podido quitar: ${error.message}`, 'error');
            }
          },
        },
      }),
    ]))
    : [el('p', { clase: 'menor apagado', texto: 'Nadie en la lista todavía.' })]);
}

async function anadir() {
  const correo = id('acceso-correo').value.trim().toLowerCase();
  const nota = id('acceso-nota').value.trim().slice(0, 80);
  if (!CORREO.test(correo)) {
    estado(id('mensaje'), 'Ese correo no parece válido.', 'error');
    return;
  }
  await setDoc(doc(db, 'acceso_lista', correo), {
    ...(nota ? { nota } : {}), por: auth.currentUser.uid, creado: serverTimestamp(),
  });
  id('acceso-correo').value = '';
  id('acceso-nota').value = '';
  estado(id('mensaje'), `${correo} ya puede entrar.`, 'exito');
  await pintarLista();
}

id('btn-guardar-modo').addEventListener('click', () => guardarModo()
  .catch((error) => estado(id('mensaje'), `No se ha podido guardar: ${error.message}`, 'error')));
id('btn-anadir').addEventListener('click', () => anadir()
  .catch((error) => estado(id('mensaje'), `No se ha podido añadir: ${error.message}`, 'error')));
id('acceso-correo').addEventListener('keydown', (e) => { if (e.key === 'Enter') id('btn-anadir').click(); });

exigirAdmin('acceso').then(() => Promise.all([pintarModo(), pintarLista()])).catch((error) => {
  estado(id('mensaje'), `No se ha podido cargar: ${error.message}`, 'error');
});
