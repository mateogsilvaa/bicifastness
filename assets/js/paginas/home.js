// Modulo de la pagina /home/
//
// Vive en un fichero propio y no incrustado en el HTML porque la CSP
// declara `script-src 'self'`: un <script> en linea quedaria bloqueado.


import { auth, db, onAuthStateChanged, doc, getDoc } from '/assets/js/firebase.js';
import { crearPerfil, aceptarLegal } from '/assets/js/acciones.js';
import { iniciarPagina, pedirReaceptacion } from '/assets/js/ui.js';
import { id, el, estado, reemplazar } from '/assets/js/dom.js';

iniciarPagina('home');


onAuthStateChanged(auth, async (usuario) => {
  if (!usuario) return; // modo invitado: se queda el titulo por defecto

  try {
    const perfil = await getDoc(doc(db, 'usuarios', usuario.uid));

    // Si el alta se corto entre crear la cuenta en Auth y crear el perfil, la
    // sesion quedaba viva pero inservible: no se podia subir nada y no habia
    // forma de arreglarlo desde la interfaz. Aqui se ofrece terminarlo.
    if (!perfil.exists()) {
      id('recuperar-perfil').classList.remove('oculto');
      return;
    }

    // Si los textos legales han cambiado, se pide aceptarlos de nuevo aqui,
    // que es la primera pantalla tras entrar.
    pedirReaceptacion(perfil.data(), aceptarLegal);

    const nombre = perfil.data().username;
    if (!nombre) return;

    // Con nodos de texto, no con innerHTML: el nombre lo elige el usuario.
    reemplazar(id('titulo'),
      el('span', { clase: 'lleno', texto: 'Hola,' }),
      el('span', { clase: 'hueco', texto: nombre.toUpperCase() }));
  } catch (error) {
    console.debug('No se ha podido cargar el perfil', error);
  }
});

id('rec-enviar').addEventListener('click', async () => {
  const boton = id('rec-enviar');
  const mensaje = id('rec-mensaje');

  if (!id('rec-legal').checked) {
    estado(mensaje, 'Debes aceptar los terminos y la politica de privacidad.', 'error');
    return;
  }

  boton.disabled = true;
  try {
    await crearPerfil({ username: id('rec-username').value, email: auth.currentUser.email });
    window.location.reload();
  } catch (error) {
    estado(mensaje, error.message, 'error');
    boton.disabled = false;
  }
});
