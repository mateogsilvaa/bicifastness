/**
 * La parte de la foto de perfil que no toca la red: la copia local de la tuya y
 * pintarla en un avatar. Va aparte de `foto-perfil.js` para que la barra
 * lateral y Hoy no carguen Firebase solo por esto.
 */

const CLAVE = 'bf_foto_propia';

export function guardarPropia(img) {
  try {
    if (img) localStorage.setItem(CLAVE, img);
    else localStorage.removeItem(CLAVE);
  } catch { /* sin almacenamiento: se vera la inicial hasta la proxima lectura */ }
}

/** La copia local de la foto propia, sin tocar la red. */
export function fotoPropiaLocal() {
  try { return localStorage.getItem(CLAVE); } catch { return null; }
}

/** Pone la foto en un avatar de inicial (o la quita si `img` es null). */
export function ponerFoto(avatar, img) {
  if (!avatar) return;
  const valida = typeof img === 'string' && /^data:image\/(webp|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(img);
  avatar.classList.toggle('con-foto', valida);
  avatar.style.backgroundImage = valida ? `url("${img}")` : '';
}
