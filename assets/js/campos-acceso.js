/**
 * Piezas de los campos de acceso (01 Acceso): el ojo para ver la contraseña,
 * el borde rojo de error y el medidor de fuerza del alta.
 *
 * Van aparte porque las usan /entrar/ y /register/, y copiarlas en las dos es
 * como una acaba comportandose distinto de la otra.
 */

import { icono, reemplazar } from './dom.js';

/** El boton del ojo: muestra y oculta la contraseña. */
export function montarOjo(campo, boton) {
  boton.append(icono('ojo'));
  boton.addEventListener('click', () => {
    const visible = campo.type === 'text';
    campo.type = visible ? 'password' : 'text';
    boton.setAttribute('aria-pressed', String(!visible));
    boton.setAttribute('aria-label', visible ? 'Mostrar la contraseña' : 'Ocultar la contraseña');
    campo.focus();
  });
}

/** Borde rojo y `aria-invalid`: el color no puede ser lo unico que lo diga. */
export function marcarError(campo, conError) {
  campo.setAttribute('aria-invalid', String(Boolean(conError)));
}

// Las que abren cualquier lista de contraseñas filtradas.
const OBVIAS = ['12345678', 'password', 'contrasena', 'contraseña', 'qwertyui', 'bicimad1', '11111111'];

/**
 * Lo fuerte que es una contraseña, en cuatro rayas.
 *
 * Una raya por cada cosa: llegar al minimo de 8, llevar numeros, llevar algo que
 * no sea letra ni numero, y pasar de 14. Las obvias se quedan en una por larga
 * que sea. No es criptografia: es que quien la elige vea que "12345678" no vale
 * y que añadir un simbolo si cuenta.
 */
export function fuerzaClave(clave) {
  const c = String(clave || '');
  if (!c) return { rayas: 0, texto: '', nivel: null };
  if (OBVIAS.some((o) => c.toLowerCase().includes(o))) return { rayas: 1, texto: 'Demasiado fácil', nivel: 'mal' };
  if (c.length < 8) return { rayas: 1, texto: 'Mínimo 8 caracteres', nivel: 'mal' };

  const rayas = 1 + (/\d/.test(c) ? 1 : 0) + (/[^\p{L}\p{N}]/u.test(c) ? 1 : 0) + (c.length >= 14 ? 1 : 0);
  const textos = { 1: ['Débil', 'medio'], 2: ['Aceptable', 'medio'], 3: ['Buena', 'bien'], 4: ['Muy buena', 'bien'] };
  return { rayas, texto: textos[rayas][0], nivel: textos[rayas][1] };
}

/** Pinta el medidor: cuatro rayas y la palabra. */
export function pintarFuerza(contenedor, clave) {
  const { rayas, texto, nivel } = fuerzaClave(clave);
  contenedor.dataset.nivel = nivel || '';
  const barras = document.createElement('span');
  barras.className = 'rayas';
  for (let i = 0; i < 4; i++) {
    const raya = document.createElement('span');
    if (i < rayas) raya.className = 'llena';
    barras.append(raya);
  }
  const palabra = document.createElement('span');
  palabra.className = 'palabra';
  palabra.textContent = texto;
  reemplazar(contenedor, barras, palabra);
}
