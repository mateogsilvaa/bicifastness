// Modulo de la pagina /admin/atajo/: el atajo de iPhone "Subir a BiciFastness",
// de momento solo para la administracion. El fichero lo compila y firma el
// workflow atajo-ios.yml (atajos/subir-a-bicifastness.cherri).

import { iniciarPagina } from '/assets/js/ui.js';
import { id, estado } from '/assets/js/dom.js';
import { montarCabeceraAdmin, exigirAdmin } from '/assets/js/admin-cabecera.js';

iniciarPagina('admin');
montarCabeceraAdmin('atajo');

const ATAJO = '/assets/atajos/subir-a-bicifastness.shortcut';

async function comprobar() {
  // Si aun no se ha generado (el workflow no ha corrido), se dice en vez de
  // dejar un enlace que da error.
  try {
    const r = await fetch(ATAJO, { method: 'HEAD', cache: 'no-cache' });
    if (!r.ok) throw new Error(String(r.status));
    id('btn-atajo').href = ATAJO;
    id('estado-atajo').textContent = 'Firmado y listo.';
  } catch {
    id('btn-atajo').setAttribute('aria-disabled', 'true');
    id('btn-atajo').classList.add('apagado');
    estado(id('mensaje'), 'El atajo todavía no está generado: hay que lanzar el workflow «Atajo de iOS» en GitHub Actions.', 'info');
  }
}

exigirAdmin('atajo').then(comprobar).catch((error) => {
  estado(id('mensaje'), `No se ha podido abrir: ${error.message}`, 'error');
});
