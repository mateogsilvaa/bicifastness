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

/**
 * Envoltorio comun. `contenido` ya viene escapado.
 *
 * Si se pasa `tokenBaja`, se anade el enlace de baja. Va en TODOS los correos,
 * tambien en los transaccionales: el RGPD solo lo exige para los promocionales,
 * pero quien no encuentra como darse de baja marca el correo como spam, y eso
 * hunde la reputacion del dominio para todo el mundo.
 */
function envolver({ titulo, contenido, tokenBaja = null }) {
  const pie = tokenBaja
    ? `<br><a href="${SITIO}/baja/?t=${encodeURIComponent(tokenBaja)}" style="color:#8b94a7;">Dejar de recibir estos avisos</a>`
    : '';
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

/**
 * Pie de la version en texto plano. Sin el, la baja solo estaria en el HTML y
 * quien lee el correo en texto no la encontraria.
 */
const pieTexto = (tokenBaja) => (tokenBaja
  ? `
---
Dejar de recibir estos avisos: ${SITIO}/baja/?t=${encodeURIComponent(tokenBaja)}
`
  : '');

const parrafo = (t) => `<p style="margin:0 0 14px;line-height:1.6;color:#c8cede;">${t}</p>`;

const boton = (texto, url) =>
  `<p style="margin:22px 0 0;"><a href="${url}" style="display:inline-block;background:#1e90ff;color:#fff;`
  + `text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">${texto}</a></p>`;

// --- Plantillas --------------------------------------------------------------

function bienvenida({ tokenBaja = null, nombre }) {
  const piloto = escapar(nombre);
  return {
    asunto: 'Bienvenido a BiciFastness',
    html: envolver({
      tokenBaja,
      titulo: `Hola, ${piloto}`,
      contenido:
        parrafo('Ya puedes subir tus trayectos. Solo necesitas la captura del viaje en la app de BiciMAD: nosotros sacamos de ahi las estaciones y el tiempo.')
        + parrafo('Cada trayecto suma por <strong>distancia</strong>, por <strong>velocidad</strong> y por <strong>constancia</strong>, asi que no hace falta correr para puntuar.')
        + boton('Subir mi primer trayecto', `${SITIO}/subir/`),
    }),
    texto: `Hola, ${nombre}\n\n`
      + 'Ya puedes subir tus trayectos. Solo necesitas la captura del viaje en la app de BiciMAD.\n\n'
      + `Cada trayecto suma por distancia, por velocidad y por constancia.\n\n${SITIO}/subir/\n` + pieTexto(tokenBaja),
  };
}

function viajeRechazado({ tokenBaja = null, nombre, ruta, motivo }) {
  const piloto = escapar(nombre);
  const tramo = escapar(ruta);
  const porQue = escapar(motivo || 'No hemos podido verificar la captura.');

  return {
    asunto: 'No hemos podido verificar tu trayecto',
    html: envolver({
      tokenBaja,
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
      + `Si crees que es un error, puedes reclamarlo desde tu perfil: ${SITIO}/profile/\n` + pieTexto(tokenBaja),
  };
}

function viajeAnulado({ tokenBaja = null, nombre, ruta, motivo }) {
  const piloto = escapar(nombre);
  const tramo = escapar(ruta);

  return {
    asunto: 'Se ha anulado uno de tus trayectos',
    html: envolver({
      tokenBaja,
      titulo: 'Un trayecto verificado se ha anulado',
      contenido:
        parrafo(`Hola, ${piloto}. El trayecto <strong>${tramo}</strong>, que estaba verificado, se ha anulado tras una revision.`)
        + parrafo(`<strong>Motivo:</strong> ${escapar(motivo || 'Revision posterior.')}`)
        + parrafo('Los puntos y los kilometros de ese trayecto se han descontado de tu marcador. El resto de tus trayectos no se toca.')
        + boton('Ver mis trayectos', `${SITIO}/profile/`),
    }),
    texto: `Hola, ${nombre}\n\nEl trayecto ${ruta}, que estaba verificado, se ha anulado tras una revision.\n\n`
      + `Motivo: ${motivo || 'Revision posterior.'}\n\n`
      + `Los puntos y los kilometros de ese trayecto se han descontado.\n\n${SITIO}/profile/\n` + pieTexto(tokenBaja),
  };
}

/**
 * Aviso de viajes verificados, AGRUPADO.
 *
 * Uno por viaje se comeria el cupo diario de Resend en cuanto haya unos pocos
 * pilotos activos, y ademas cansa.
 */
function viajesVerificados({ tokenBaja = null, nombre, viajes }) {
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
      tokenBaja,
      titulo: `${viajes.length} ${cuantos}`,
      contenido:
        parrafo(`Hola, ${piloto}. Esto es lo que has sumado:`)
        + `<ul style="margin:0 0 14px;padding-left:20px;">${filas}</ul>`
        + parrafo(`Total: <strong>${puntos} puntos</strong> y ${(metros / 1000).toFixed(1)} km.`)
        + boton('Ver la clasificacion', `${SITIO}/ranking/`),
    }),
    texto: `Hola, ${nombre}\n\n${viajes.length} ${cuantos}:\n`
      + viajes.map((v) => `  ${v.ruta} — ${v.puntos || 0} puntos`).join('\n')
      + `\n\nTotal: ${puntos} puntos y ${(metros / 1000).toFixed(1)} km.\n\n${SITIO}/ranking/\n` + pieTexto(tokenBaja),
  };
}

function revisionLenta({ tokenBaja = null, nombre, ruta }) {
  const piloto = escapar(nombre);
  return {
    asunto: 'Tu trayecto lo esta revisando una persona',
    html: envolver({
      tokenBaja,
      titulo: 'Tu trayecto esta en revision',
      contenido:
        parrafo(`Hola, ${piloto}. El trayecto <strong>${escapar(ruta)}</strong> necesita que lo mire una persona antes de darlo por bueno.`)
        + parrafo('No es que hayas hecho nada mal: pasa cuando la captura no se lee del todo bien. Te avisamos en cuanto se resuelva.'),
    }),
    texto: `Hola, ${nombre}\n\nEl trayecto ${ruta} necesita revision de una persona. `
      + 'No es que hayas hecho nada mal: pasa cuando la captura no se lee del todo bien.\n' + pieTexto(tokenBaja),
  };
}

/**
 * Aviso a la administracion de que la cuota se esta agotando (#38).
 *
 * NO lleva enlace de baja: no es un correo de producto, es el unico aviso de
 * que la web va a dejar de funcionar dentro de unas horas. Darse de baja de
 * esto es quedarse sin enterarse.
 */
function cuotaEnPeligro({ nivel, porcentaje, consumido, proyeccion, limites }) {
  const pct = Math.round(porcentaje);

  const titulos = {
    atencion: `Cuota al ${pct}%`,
    alerta: `Cuota al ${pct}%: quedan pocas horas`,
    degradado: `Cuota al ${pct}%: modo degradado`,
  };

  const explicaciones = {
    atencion: 'Da tiempo a mirar que lo esta gastando. Si sigue este ritmo, no llega a medianoche.',
    alerta: 'A este ritmo la web deja de funcionar antes de que acabe el dia.',
    degradado: 'Se ha desactivado lo que mas lee. La web sigue en pie, pero con menos datos frescos.',
  };

  const linea = (que, valor, limite) =>
    `  ${que}: ${valor.toLocaleString('es-ES')} de ${limite.toLocaleString('es-ES')}`;

  const proyectado = proyeccion
    ? `\n\nProyeccion para hoy:\n${linea('lecturas', proyeccion.lecturas, limites.LECTURAS)}`
      + `\n${linea('escrituras', proyeccion.escrituras, limites.ESCRITURAS)}`
    : '';

  return {
    asunto: `BiciFastness — ${titulos[nivel] || titulos.atencion}`,
    html: envolver({
      titulo: titulos[nivel] || titulos.atencion,
      contenido:
        parrafo(escapar(explicaciones[nivel] || explicaciones.atencion))
        + parrafo('Consumido hasta ahora, <strong>solo por el worker</strong>:')
        + '<ul style="margin:0 0 14px;padding-left:20px;">'
        + `<li>Lecturas: ${consumido.lecturas.toLocaleString('es-ES')} de ${limites.LECTURAS.toLocaleString('es-ES')}</li>`
        + `<li>Escrituras: ${consumido.escrituras.toLocaleString('es-ES')} de ${limites.ESCRITURAS.toLocaleString('es-ES')}</li>`
        + '</ul>'
        // Lo que lee el navegador no pasa por el worker y no hay forma de
        // contarlo desde aqui. Decirlo evita que alguien lea estas cifras como
        // el total y se confie.
        + parrafo('Lo que leen los navegadores NO esta contado aqui: el total real es mayor. '
          + 'La cifra exacta esta en la consola de Firebase, en Uso.')
        + boton('Ver el consumo', `${SITIO}/admin/metricas/`),
    }),
    texto: `${titulos[nivel] || titulos.atencion}\n\n${explicaciones[nivel] || explicaciones.atencion}`
      + `\n\nConsumido hasta ahora, solo por el worker:\n`
      + `${linea('lecturas', consumido.lecturas, limites.LECTURAS)}\n`
      + `${linea('escrituras', consumido.escrituras, limites.ESCRITURAS)}`
      + proyectado
      + '\n\nLo que leen los navegadores no esta contado: el total real es mayor.\n'
      + `${SITIO}/admin/metricas/\n`,
  };
}

module.exports = {
  bienvenida,
  cuotaEnPeligro,
  viajeRechazado,
  viajeAnulado,
  viajesVerificados,
  revisionLenta,
  envolver,
  SITIO,
};
