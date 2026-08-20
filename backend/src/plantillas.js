'use strict';

/**
 * Textos de los correos.
 *
 * Dos reglas que no son de estilo, son de seguridad y de trato:
 *
 * 1. NO se cuenta como funciona el antifraude. Nada de "riesgo 72" ni de
 *    "distancia perceptual 4": quien intenta colar una captura aprenderia
 *    exactamente que ajustar. Se dice que no se ha podido verificar y que hacer.
 *
 * 2. Todo lo que viene del usuario se escapa. El nombre de piloto lo elige la
 *    persona y acaba dentro del HTML del correo.
 *
 * Cada plantilla devuelve `{ asunto, html, texto }`. La version en texto plano
 * no es un adorno: sin ella varios clientes marcan el correo como sospechoso.
 */

const { escapar } = require('./correo');

const SITIO = 'https://bicifastness.es';

/** Envoltorio comun. `contenido` ya viene escapado. */
function envolver({ titulo, contenido, pie = '' }) {
  return `<!doctype html>
<html lang="es">
<body style="margin:0;padding:24px;background:#0d1017;font-family:system-ui,sans-serif;color:#eef2f7;">
  <div style="max-width:520px;margin:0 auto;background:#131722;border:1px solid #232a37;border-radius:14px;padding:28px;">
    <p style="margin:0 0 20px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#5a6376;">BiciFastness</p>
    <h1 style="margin:0 0 16px;font-size:22px;line-height:1.25;">${titulo}</h1>
    ${contenido}
  </div>
  <p style="max-width:520px;margin:16px auto 0;font-size:12px;color:#5a6376;line-height:1.5;">
    Proyecto independiente, sin relacion con BiciMAD, la EMT ni el Ayuntamiento de Madrid.${pie}
  </p>
</body>
</html>`;
}

const parrafo = (t) => `<p style="margin:0 0 14px;line-height:1.6;color:#c8cede;">${t}</p>`;

const boton = (texto, url) =>
  `<p style="margin:22px 0 0;"><a href="${url}" style="display:inline-block;background:#1e90ff;color:#fff;`
  + `text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">${texto}</a></p>`;

// --- Plantillas --------------------------------------------------------------

function bienvenida({ nombre }) {
  const piloto = escapar(nombre);
  return {
    asunto: 'Bienvenido a BiciFastness',
    html: envolver({
      titulo: `Hola, ${piloto}`,
      contenido:
        parrafo('Ya puedes subir tus trayectos. Solo necesitas la captura del viaje en la app de BiciMAD: nosotros sacamos de ahi las estaciones y el tiempo.')
        + parrafo('Cada trayecto suma por <strong>distancia</strong>, por <strong>velocidad</strong> y por <strong>constancia</strong>, asi que no hace falta correr para puntuar.')
        + boton('Subir mi primer trayecto', `${SITIO}/subir/`),
    }),
    texto: `Hola, ${nombre}\n\n`
      + 'Ya puedes subir tus trayectos. Solo necesitas la captura del viaje en la app de BiciMAD.\n\n'
      + `Cada trayecto suma por distancia, por velocidad y por constancia.\n\n${SITIO}/subir/\n`,
  };
}

function viajeRechazado({ nombre, ruta, motivo }) {
  const piloto = escapar(nombre);
  const tramo = escapar(ruta);
  const porQue = escapar(motivo || 'No hemos podido verificar la captura.');

  return {
    asunto: 'No hemos podido verificar tu trayecto',
    html: envolver({
      titulo: 'Tu trayecto no ha pasado la verificacion',
      contenido:
        parrafo(`Hola, ${piloto}. El trayecto <strong>${tramo}</strong> no se ha podido dar por bueno.`)
        + parrafo(`<strong>Motivo:</strong> ${porQue}`)
        + parrafo('Casi siempre se arregla volviendo a subir la captura original de la app, sin recortar y sin pasarla por ningun editor. Si la mandas por WhatsApp antes de subirla, llega recomprimida y se lee peor.')
        + parrafo('Si crees que es un error, puedes reclamarlo desde tu perfil y lo mira una persona.')
        + boton('Ver mis trayectos', `${SITIO}/profile/`),
    }),
    texto: `Hola, ${nombre}\n\nEl trayecto ${ruta} no se ha podido verificar.\n\n`
      + `Motivo: ${motivo || 'No hemos podido verificar la captura.'}\n\n`
      + 'Casi siempre se arregla volviendo a subir la captura original de la app, sin recortar '
      + 'y sin pasarla por ningun editor.\n\n'
      + `Si crees que es un error, puedes reclamarlo desde tu perfil: ${SITIO}/profile/\n`,
  };
}

function viajeAnulado({ nombre, ruta, motivo }) {
  const piloto = escapar(nombre);
  const tramo = escapar(ruta);

  return {
    asunto: 'Se ha anulado uno de tus trayectos',
    html: envolver({
      titulo: 'Un trayecto verificado se ha anulado',
      contenido:
        parrafo(`Hola, ${piloto}. El trayecto <strong>${tramo}</strong>, que estaba verificado, se ha anulado tras una revision.`)
        + parrafo(`<strong>Motivo:</strong> ${escapar(motivo || 'Revision posterior.')}`)
        + parrafo('Los puntos y los kilometros de ese trayecto se han descontado de tu marcador. El resto de tus trayectos no se toca.')
        + boton('Ver mis trayectos', `${SITIO}/profile/`),
    }),
    texto: `Hola, ${nombre}\n\nEl trayecto ${ruta}, que estaba verificado, se ha anulado tras una revision.\n\n`
      + `Motivo: ${motivo || 'Revision posterior.'}\n\n`
      + `Los puntos y los kilometros de ese trayecto se han descontado.\n\n${SITIO}/profile/\n`,
  };
}

/**
 * Aviso de viajes verificados, AGRUPADO.
 *
 * Uno por viaje se comeria el cupo diario de Resend en cuanto haya unos pocos
 * pilotos activos, y ademas cansa.
 */
function viajesVerificados({ nombre, viajes }) {
  const piloto = escapar(nombre);
  const puntos = viajes.reduce((t, v) => t + (v.puntos || 0), 0);
  const metros = viajes.reduce((t, v) => t + (v.distanciaMetros || 0), 0);

  const filas = viajes.map((v) =>
    `<li style="margin-bottom:8px;color:#c8cede;">${escapar(v.ruta)} — `
    + `<strong>${v.puntos || 0} puntos</strong></li>`).join('');

  const cuantos = viajes.length === 1 ? 'trayecto verificado' : 'trayectos verificados';

  return {
    asunto: `${viajes.length} ${cuantos}`,
    html: envolver({
      titulo: `${viajes.length} ${cuantos}`,
      contenido:
        parrafo(`Hola, ${piloto}. Esto es lo que has sumado:`)
        + `<ul style="margin:0 0 14px;padding-left:20px;">${filas}</ul>`
        + parrafo(`Total: <strong>${puntos} puntos</strong> y ${(metros / 1000).toFixed(1)} km.`)
        + boton('Ver la clasificacion', `${SITIO}/ranking/`),
    }),
    texto: `Hola, ${nombre}\n\n${viajes.length} ${cuantos}:\n`
      + viajes.map((v) => `  ${v.ruta} — ${v.puntos || 0} puntos`).join('\n')
      + `\n\nTotal: ${puntos} puntos y ${(metros / 1000).toFixed(1)} km.\n\n${SITIO}/ranking/\n`,
  };
}

function revisionLenta({ nombre, ruta }) {
  const piloto = escapar(nombre);
  return {
    asunto: 'Tu trayecto lo esta revisando una persona',
    html: envolver({
      titulo: 'Tu trayecto esta en revision',
      contenido:
        parrafo(`Hola, ${piloto}. El trayecto <strong>${escapar(ruta)}</strong> necesita que lo mire una persona antes de darlo por bueno.`)
        + parrafo('No es que hayas hecho nada mal: pasa cuando la captura no se lee del todo bien. Te avisamos en cuanto se resuelva.'),
    }),
    texto: `Hola, ${nombre}\n\nEl trayecto ${ruta} necesita revision de una persona. `
      + 'No es que hayas hecho nada mal: pasa cuando la captura no se lee del todo bien.\n',
  };
}

module.exports = {
  bienvenida,
  viajeRechazado,
  viajeAnulado,
  viajesVerificados,
  revisionLenta,
  envolver,
  SITIO,
};
