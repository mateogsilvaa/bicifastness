/**
 * El navegador de dentro de Instagram, TikTok, Facebook y compañia.
 *
 * Google NO deja iniciar sesion desde ahi (lo bloquea a proposito: no puede
 * fiarse de una ventana que controla otra app), y Firebase lo cuenta como
 * "ventana emergente bloqueada". Decirle a alguien que "permita las ventanas
 * emergentes" cuando no hay ningun ajuste que tocar solo asusta. Aqui se
 * detecta ese navegador y se explica lo unico que funciona: abrir la web en
 * el navegador del movil, o entrar con correo.
 */

import { el, abrirHoja, avisar } from './dom.js';

const UA = () => navigator.userAgent || '';

/** ¿Estamos dentro de la app de otra red social? */
export function esNavegadorIntegrado() {
  return /Instagram|FBAN|FBAV|FB_IAB|FBIOS|TikTok|musical_ly|BytedanceWebview|Twitter|LinkedInApp|Snapchat|Pinterest|Line\//i.test(UA())
    // Android WebView generica (la de muchas apps)
    || (/Android/i.test(UA()) && /; wv\)/.test(UA()));
}

const esAndroid = () => /Android/i.test(UA());
const nombreApp = () => (/Instagram/i.test(UA()) ? 'Instagram' : /TikTok|musical_ly|Bytedance/i.test(UA()) ? 'TikTok'
  : /FBAN|FBAV|FB_IAB|FBIOS/i.test(UA()) ? 'Facebook' : 'esta app');

/**
 * La explicacion, en una hoja. En Android hay un enlace que abre la web
 * directamente en Chrome; en iPhone no existe, asi que se explican los dos
 * toques y se ofrece copiar el enlace.
 */
export function explicarNavegadorIntegrado() {
  const url = window.location.href;
  const app = nombreApp();
  const copiar = el('button', {
    clase: 'btn secundario', texto: 'Copiar el enlace', attrs: { type: 'button' },
    on: {
      click: async () => {
        try { await navigator.clipboard.writeText(url); avisar('Enlace copiado: pégalo en Safari o Chrome.'); } catch { avisar(url); }
      },
    },
  });
  const sinEsquema = url.replace(/^https?:\/\//, '');
  abrirHoja([
    el('h2', { texto: `Ábrelo en tu navegador para entrar con Google` }),
    el('p', { texto: `Estás dentro de ${app}, y Google no deja iniciar sesión desde aquí. No es un problema de tu móvil: pasa con todas las webs.` }),
    esAndroid()
      ? el('a', { clase: 'btn', texto: 'Abrir en Chrome', attrs: { href: `intent://${sinEsquema}#Intent;scheme=https;package=com.android.chrome;end` } })
      : el('ol', { clase: 'pasos-integrado' }, [
        el('li', { texto: 'Toca ··· (arriba a la derecha).' }),
        el('li', { texto: 'Elige «Abrir en el navegador» (o «Abrir en Safari»).' }),
        el('li', { texto: 'Allí pulsa otra vez «Continuar con Google».' }),
      ]),
    copiar,
    el('p', { clase: 'menor apagado', texto: 'O entra con tu correo y contraseña: eso sí funciona aquí, y luego puedes unir Google a la misma cuenta.' }),
  ], { etiqueta: 'Abrir en el navegador' });
}
