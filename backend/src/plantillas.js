'use strict';

/**
 * Textos de los correos (10 · Correos).
 *
 * Todos comparten un envoltorio pensado para que se vean igual en Gmail,
 * Outlook y Apple Mail: 600 px, tablas y estilos en linea, Arial, modo oscuro
 * por media query (donde el cliente la respeta), un preheader oculto y botones
 * con su version VML para Outlook.
 *
 * Dos reglas que no son de estilo, son de seguridad y de trato:
 *
 * 1. NO se cuenta como funciona el antifraude. Nada de "riesgo 72" ni de
 *    "distancia perceptual 4": quien intenta colar una captura aprenderia
 *    exactamente que ajustar. Se dice que no se ha podido verificar y que hacer.
 *
 * 2. Todo lo que viene del usuario se escapa. El nombre de piloto lo elige la
 *    persona y acaba dentro del HTML del correo; el texto de un mensaje del
 *    equipo, tambien.
 *
 * Cada plantilla devuelve `{ asunto, html, texto }`. La version en texto plano
 * no es un adorno: sin ella varios clientes marcan el correo como sospechoso.
 */

const { escapar } = require('./correo');

/**
 * La direccion publica del sitio, para los enlaces de los correos. Se puede
 * cambiar sin tocar codigo con el secreto SITIO_URL (docs/PUESTA-EN-MARCHA.md).
 */
const SITIO = String(process.env.SITIO_URL || 'https://bicifastness-pi.vercel.app').replace(/\/+$/, '');

const C = {
  papel: '#F3F1EC', blanco: '#FFFFFF', tinta: '#111110', tinta2: '#55534D', tinta3: '#6E6C66',
  azul: '#1B80E5', azulTexto: '#1466C2', linea: '#E0DDD5',
};

/** Colores del chip de estado. Los mismos del sistema, en claro. */
const CHIPS = {
  verificado: { texto: 'Verificado', color: '#1C7A42', fondo: '#E3F1E8' },
  revision: { texto: 'Lo mira una persona', color: '#9A5B00', fondo: '#F6ECDC' },
  rechazado: { texto: 'No cuenta', color: '#C8322A', fondo: '#F8E3E1' },
  error: { texto: 'No hemos podido leerla', color: '#9A5B00', fondo: '#F6ECDC' },
  suspendida: { texto: 'Cuenta suspendida', color: '#111110', fondo: '#ECEAE4' },
  seguridad: { texto: 'Seguridad', color: '#111110', fondo: '#ECEAE4' },
  equipo: { texto: 'Mensaje del equipo', color: '#1466C2', fondo: '#E3EFFC' },
};

const FUENTE = "Arial, 'Helvetica Neue', Helvetica, sans-serif";

/**
 * Envoltorio comun. `contenido` ya viene escapado.
 *
 * Si se pasa `tokenBaja`, se anade el enlace de baja. Va en los correos de
 * producto; los de seguridad y moderacion (contraseña cambiada, suspension) no
 * lo llevan: darse de baja de eso seria quedarse sin enterarse.
 */
function envolver({ titulo, contenido, tokenBaja = null, chip = null, subtitulo = null, preheader = '' }) {
  const pie = tokenBaja
    ? `Recibes esto porque tienes activados los avisos por correo. <a href="${SITIO}/baja/?t=${encodeURIComponent(tokenBaja)}" style="color:${C.tinta3};text-decoration:underline;">Darme de baja</a><br>`
    : '';
  const estado = chip && CHIPS[chip]
    ? `<tr><td style="padding:0 0 18px;"><span class="chip" style="display:inline-block;padding:5px 10px;border-radius:999px;background:${CHIPS[chip].fondo};color:${CHIPS[chip].color};font-family:${FUENTE};font-size:13px;font-weight:bold;">&#9679;&nbsp;${CHIPS[chip].texto}</span></td></tr>`
    : '';
  return `<!doctype html>
<html lang="es" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${titulo}</title>
<!--[if mso]><style>table,td{font-family:Arial,sans-serif!important}</style><![endif]-->
<style>
  @media (prefers-color-scheme: dark) {
    .fondo { background:#0E0F10 !important; }
    .tarjeta { background:#18191B !important; }
    .texto { color:#F2F1EE !important; }
    .suave { color:#B3B2AE !important; }
    .recuadro { background:#222326 !important; }
    .pie { color:#8B8A87 !important; }
  }
  @media (max-width: 620px) {
    .contenedor { width:100% !important; }
    .relleno { padding:24px !important; }
    h1 { font-size:24px !important; }
  }
</style>
</head>
<body class="fondo" style="margin:0;padding:0;background:${C.papel};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapar(preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" class="fondo" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.papel};">
  <tr><td align="center" style="padding:32px 12px;">
    <table role="presentation" class="contenedor" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
      <tr><td class="tarjeta relleno" style="background:${C.blanco};border-radius:20px;padding:36px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="padding:0 0 26px;">
            <img src="${SITIO}/images/icono/icono-192.png" width="28" height="28" alt="" style="vertical-align:middle;border:0;border-radius:7px;">
            <span class="texto" style="vertical-align:middle;font-family:${FUENTE};font-size:17px;font-weight:bold;letter-spacing:-0.5px;color:${C.tinta};">&nbsp;bicifastness</span>
          </td></tr>
          ${estado}
          <tr><td style="padding:0 0 10px;"><h1 class="texto" style="margin:0;font-family:${FUENTE};font-size:28px;line-height:1.15;font-weight:bold;letter-spacing:-0.6px;color:${C.tinta};">${titulo}</h1></td></tr>
          ${subtitulo ? `<tr><td class="suave" style="padding:0 0 20px;font-family:${FUENTE};font-size:16px;line-height:1.4;color:${C.tinta2};">${subtitulo}</td></tr>` : ''}
          <tr><td>${contenido}</td></tr>
        </table>
      </td></tr>
      <tr><td class="pie" style="padding:18px 12px 0;font-family:${FUENTE};font-size:12px;line-height:1.5;color:${C.tinta3};">
        ${pie}Proyecto independiente, sin relación con BiciMAD ni la EMT.
      </td></tr>
    </table>
  </td></tr>
</table>
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
Proyecto independiente, sin relacion con BiciMAD ni la EMT.
`
  : '\n---\nProyecto independiente, sin relacion con BiciMAD ni la EMT.\n');

const parrafo = (t) => `<p class="suave" style="margin:0 0 14px;font-family:${FUENTE};font-size:15px;line-height:1.55;color:${C.tinta2};">${t}</p>`;

/** El bloque del motivo: etiqueta pequeña, lo que ha pasado en negrita y que hacer. */
function recuadro(fuerte, suave = '', { etiqueta = null, etiquetaSuave = null } = {}) {
  const e = (t) => `<span class="suave" style="display:block;font-size:13px;color:${C.tinta3};padding:0 0 4px;">${t}</span>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr>`
    + `<td class="recuadro" style="background:${C.papel};border-radius:14px;padding:16px 18px;font-family:${FUENTE};font-size:15px;line-height:1.5;">`
    + (etiqueta ? e(etiqueta) : '')
    + `<strong class="texto" style="color:${C.tinta};">${fuerte}</strong>`
    + (suave ? `<span style="display:block;height:10px;line-height:10px;">&nbsp;</span>${etiquetaSuave ? e(etiquetaSuave) : ''}<span class="suave" style="color:${C.tinta2};">${suave}</span>` : '')
    + '</td></tr></table>';
}

/** Filas de dato: "Cuándo · martes 29 a las 18:02". */
function datos(filas) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;font-family:${FUENTE};font-size:14px;">`
    + filas.filter(Boolean).map(([k, v]) => `<tr><td class="suave" style="padding:8px 0;border-bottom:1px solid ${C.linea};color:${C.tinta3};width:40%;">${k}</td>`
      + `<td class="texto" style="padding:8px 0;border-bottom:1px solid ${C.linea};color:${C.tinta};font-weight:bold;">${v}</td></tr>`).join('')
    + '</table>';
}

/** Boton "a prueba de Outlook": VML para Outlook de escritorio, enlace para el resto. */
function boton(texto, url, { color = C.azul } = {}) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 20px;"><tr><td>
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${url}" style="height:48px;v-text-anchor:middle;width:260px;" arcsize="25%" stroke="f" fillcolor="${color}"><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${texto}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a href="${url}" style="display:inline-block;background:${color};color:#ffffff;font-family:${FUENTE};font-size:16px;font-weight:bold;line-height:48px;padding:0 26px;border-radius:12px;text-decoration:none;">${texto}</a><!--<![endif]-->
</td></tr></table>`;
}

/** El enlace tambien en texto, para clientes que bloquean botones. */
const enlaceSuelto = (url) => parrafo(`Si el botón no funciona, copia este enlace en el navegador:<br><a href="${url}" style="color:${C.azulTexto};word-break:break-all;">${url}</a>`);

/** "Metro Bilbao → Ferraz" a partir de "124-115", si el llamante no lo trae ya. */
function nombreTramo(ruta) {
  const r = String(ruta || '');
  if (!/^\w+-\w+$/.test(r)) return r;
  try {
    const { buscarEstacion } = require('./util');
    const [a, b] = r.split('-');
    const n = (id) => buscarEstacion(id)?.nombre || id;
    return `${n(a)} → ${n(b)}`;
  } catch {
    return r;
  }
}

const mmss = (s) => (Number.isFinite(s) ? `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : null);

// --- Plantillas --------------------------------------------------------------

/**
 * 10c · Bienvenida. Si la cuenta es de correo y no esta verificada, el mismo
 * correo lleva el enlace para verificarla: un correo en vez de dos.
 */
function bienvenida({ tokenBaja = null, nombre, enlaceVerificacion = null }) {
  const piloto = escapar(nombre);
  return {
    asunto: `Bienvenida a bicifastness, ${String(nombre ?? '').replace(/[<>"&]/g, '')}`,
    html: envolver({
      tokenBaja,
      preheader: 'Tu primer trayecto, en tres pasos.',
      titulo: `Hola, ${piloto}`,
      subtitulo: 'Ya tienes tu nombre de piloto. Esto es lo que viene ahora.',
      contenido:
        (enlaceVerificacion
          ? recuadro('Confirma tu correo', 'Así podremos avisarte de tus trayectos y recuperar tu cuenta si olvidas la contraseña.')
            + boton('Confirmar mi correo', enlaceVerificacion)
          : '')
        + datos([
          ['1', 'Haz tu trayecto de siempre en BiciMAD.'],
          ['2', 'Al terminar, captura la pantalla del viaje en la app.'],
          ['3', 'Súbela: leemos las estaciones y el tiempo por ti.'],
        ])
        + parrafo('Cada trayecto suma por <strong>distancia</strong>, por <strong>ritmo</strong> y por <strong>constancia</strong>: no hace falta correr. Respeta semáforos y pasos de peatones: ningún puesto vale un susto.')
        + boton('Subir mi primer trayecto', `${SITIO}/subir/`),
    }),
    texto: `Hola, ${nombre}\n\n`
      + (enlaceVerificacion ? `Confirma tu correo: ${enlaceVerificacion}\n\n` : '')
      + '1. Haz tu trayecto de siempre en BiciMAD.\n2. Al terminar, captura la pantalla del viaje en la app.\n'
      + '3. Subela: leemos las estaciones y el tiempo por ti.\n\n'
      + `Cada trayecto suma por distancia, por ritmo y por constancia.\n\n${SITIO}/subir/\n` + pieTexto(tokenBaja),
  };
}

/**
 * 10a · Trayecto rechazado. El motivo y que hacer salen de los mismos textos
 * que la app. Si lo escribio una persona, se dice. La revision humana solo se
 * ofrece si el rechazo fue automatico.
 */
function viajeRechazado({
  tokenBaja = null, nombre, ruta, motivo, queHacer = null, tiempoSegundos = null, fecha = null,
  dePersona = false, puedePedirRevision = true,
}) {
  const piloto = escapar(nombre);
  const tramo = escapar(nombreTramo(ruta));
  const porQue = escapar(motivo || 'No hemos podido verificar la captura.');
  const hacer = escapar(queHacer || 'Casi siempre se arregla volviendo a subir la captura original de la app, sin recortar y sin pasarla por ningún editor.');
  const linea = [tramo, mmss(tiempoSegundos), fecha ? escapar(fecha) : null].filter(Boolean).join(' · ');

  return {
    asunto: `Tu trayecto ${String(nombreTramo(ruta)).replace(/[<>"&]/g, '')} no cuenta`,
    html: envolver({
      tokenBaja,
      chip: 'rechazado',
      preheader: String(motivo || 'No hemos podido verificar la captura.').slice(0, 90),
      titulo: 'No hemos podido dar por bueno tu trayecto',
      subtitulo: linea,
      contenido:
        parrafo(`Hola, ${piloto}:`)
        + recuadro(porQue, hacer, {
          etiqueta: dePersona ? 'Lo que dice quien lo ha revisado' : 'Motivo',
          etiquetaSuave: 'Qué hacer',
        })
        + parrafo('Tu racha no se ha tocado: si hoy subes otro trayecto que sí cuente, sigue viva. Si la mandas por WhatsApp antes de subirla, la captura llega recomprimida y se lee peor: volviendo a subir la original suele bastar.')
        + boton('Ver mi trayecto', `${SITIO}/yo/#historial`)
        + (puedePedirRevision && !dePersona
          ? parrafo('Si crees que es un error, puedes reclamarlo desde el propio trayecto y lo mira una persona.')
          : parrafo('Si tienes dudas, responde a este correo.')),
    }),
    texto: `Hola, ${nombre}\n\nEl trayecto ${nombreTramo(ruta)} no se ha podido verificar.\n\n`
      + `${dePersona ? 'Lo que dice quien lo ha revisado' : 'Motivo'}: ${motivo || 'No hemos podido verificar la captura.'}\n`
      + `Que hacer: ${queHacer || 'volviendo a subir la captura original de la app, sin recortar, suele bastar.'}\n\n`
      + (puedePedirRevision && !dePersona ? `Si crees que es un error, puedes reclamarlo desde el trayecto: ${SITIO}/yo/#historial\n` : '')
      + pieTexto(tokenBaja),
  };
}

/**
 * 10b · Error al procesar. Fallo nuestro (lectura, almacenamiento, worker), no
 * un rechazo: ambar, y sin que parezca que la persona ha hecho algo mal.
 */
function errorAlProcesar({ tokenBaja = null, nombre, ruta }) {
  const piloto = escapar(nombre);
  return {
    asunto: 'No hemos podido leer tu captura',
    html: envolver({
      tokenBaja,
      chip: 'error',
      preheader: 'No es cosa tuya. Lo va a mirar una persona.',
      titulo: 'No hemos podido leer tu captura',
      subtitulo: escapar(nombreTramo(ruta)),
      contenido:
        recuadro('No es cosa tuya.', 'Algo ha fallado de nuestro lado al leer la imagen. El trayecto no se pierde: pasa a que lo mire una persona y te avisamos en cuanto se resuelva.')
        + parrafo(`Hola, ${piloto}: no hace falta que lo vuelvas a subir. Si en un par de días sigue sin resolverse, responde a este correo.`)
        + boton('Ver mi trayecto', `${SITIO}/yo/#historial`),
    }),
    texto: `Hola, ${nombre}\n\nNo hemos podido leer la captura del trayecto ${nombreTramo(ruta)}. No es cosa tuya: `
      + 'lo va a mirar una persona y te avisamos en cuanto se resuelva. No hace falta volver a subirlo.\n\n'
      + `${SITIO}/yo/#historial\n` + pieTexto(tokenBaja),
  };
}

/**
 * 10d · Mensaje del equipo. Texto libre de un administrador, firmado. El bloque
 * "Sobre" (un trayecto, un clan o el nombre de piloto) es opcional. Se contesta
 * al buzon del equipo (Reply-To lo pone el worker).
 */
function mensajeEquipo({ tokenBaja = null, nombre, asunto, texto, firma = 'El equipo de bicifastness', sobre = null }) {
  const piloto = escapar(nombre);
  const cuerpo = escapar(texto || '').split(/\n{2,}/).map((p) => parrafo(p.replace(/\n/g, '<br>'))).join('');
  return {
    asunto: `${String(asunto || 'Un mensaje del equipo').replace(/[<>"&]/g, '').slice(0, 90)} · bicifastness`,
    html: envolver({
      tokenBaja,
      chip: 'equipo',
      preheader: String(texto || '').slice(0, 90),
      titulo: escapar(asunto || 'Un mensaje del equipo'),
      contenido:
        parrafo(`Hola, ${piloto}:`)
        + cuerpo
        + (sobre ? recuadro(escapar(sobre), '', { etiqueta: 'Sobre' }) : '')
        + parrafo(`— ${escapar(firma)}`)
        + parrafo('Puedes responder directamente a este correo.'),
    }),
    texto: `Hola, ${nombre}:\n\n${texto || ''}\n\n${sobre ? `Sobre: ${sobre}\n\n` : ''}— ${firma}\n\n`
      + 'Puedes responder directamente a este correo.\n' + pieTexto(tokenBaja),
  };
}

/**
 * 10e · Cuenta suspendida. Tono sobrio, sin azul: motivo, fechas, que implica y
 * como recurrir. Sin enlace de baja: no es un correo de producto.
 */
function cuentaSuspendida({ nombre, motivo, desde = null, hasta = null }) {
  const piloto = escapar(nombre);
  const fin = hasta ? escapar(hasta) : 'Sin fecha de fin';
  return {
    asunto: 'Tu cuenta de bicifastness está suspendida',
    html: envolver({
      chip: 'suspendida',
      preheader: 'Qué significa y cómo recurrir.',
      titulo: 'Tu cuenta está suspendida',
      subtitulo: `Hola, ${piloto}.`,
      contenido:
        recuadro(escapar(motivo || 'Incumplimiento de los términos de uso.'), '', { etiqueta: 'Motivo' })
        + datos([
          ['Desde', escapar(desde || 'hoy')],
          ['Hasta', fin],
        ])
        + parrafo('Mientras dure no puedes subir trayectos ni aparecer en las clasificaciones. Tus datos no se borran y puedes seguir entrando para verlos o descargarlos.')
        + parrafo('Si crees que es un error, responde a este correo en los próximos 30 días contando lo que ha pasado. Lo revisa una persona distinta de quien tomó la decisión.'),
    }),
    texto: `Hola, ${nombre}.\n\nTu cuenta de bicifastness esta suspendida.\n\nMotivo: ${motivo || 'Incumplimiento de los terminos de uso.'}\n`
      + `Desde: ${desde || 'hoy'}\nHasta: ${hasta || 'Sin fecha de fin'}\n\n`
      + 'Mientras dure no puedes subir trayectos ni aparecer en las clasificaciones. Tus datos no se borran.\n\n'
      + 'Si crees que es un error, responde a este correo en los proximos 30 dias.\n' + pieTexto(null),
  };
}

/**
 * 10g · Contraseña cambiada. Aviso de seguridad, siempre (sin baja). Datos del
 * dispositivo desde el user agent; la ciudad no se sabe y no se inventa.
 */
function contrasenaCambiada({ nombre, cuando = null, dispositivo = null }) {
  const piloto = escapar(nombre);
  return {
    asunto: 'Tu contraseña ha cambiado',
    html: envolver({
      chip: 'seguridad',
      preheader: 'Si no has sido tú, cámbiala ahora.',
      titulo: 'Tu contraseña ha cambiado',
      subtitulo: `Hola, ${piloto}. Te lo contamos por si no has sido tú.`,
      contenido:
        datos([
          ['Cuándo', escapar(cuando || 'hace un momento')],
          dispositivo ? ['Desde', escapar(dispositivo)] : null,
        ])
        + parrafo('Si has sido tú, no tienes que hacer nada.')
        + recuadro('¿No has sido tú?', 'Cambia la contraseña ahora desde «¿Has olvidado la contraseña?» y responde a este correo para que revisemos tu cuenta.')
        + boton('Cambiar la contraseña', `${SITIO}/entrar/#recuperar`),
    }),
    texto: `Hola, ${nombre}.\n\nTu contraseña de bicifastness ha cambiado${cuando ? ` (${cuando})` : ''}`
      + `${dispositivo ? ` desde ${dispositivo}` : ''}.\n\nSi has sido tu, no tienes que hacer nada. `
      + `Si no, cambiala ahora: ${SITIO}/entrar/#recuperar y responde a este correo.\n` + pieTexto(null),
  };
}

/**
 * 10f · Restablecer contraseña, para PEGAR en Firebase Auth (Authentication →
 * Plantillas → Restablecimiento de contraseña → Mensaje). Firebase sustituye
 * %LINK% y %EMAIL% al enviarla. Va como texto, no como funcion: la envia
 * Firebase, no el worker (`npm run correos` la deja en correos/).
 */
const PLANTILLA_FIREBASE_RESTABLECER = envolver({
  preheader: 'El enlace caduca en una hora.',
  titulo: 'Elige una contraseña nueva',
  subtitulo: 'Alguien (seguramente tú) ha pedido cambiar la contraseña de %EMAIL%.',
  contenido:
    boton('Elegir contraseña nueva', '%LINK%')
    + parrafo('El enlace caduca en una hora y solo sirve una vez. Si no lo has pedido tú, ignora este correo: tu contraseña no cambia.')
    + enlaceSuelto('%LINK%'),
});

function viajeAnulado({ tokenBaja = null, nombre, ruta, motivo }) {
  const piloto = escapar(nombre);
  const tramo = escapar(ruta);

  return {
    asunto: 'Se ha anulado uno de tus trayectos',
    html: envolver({
      tokenBaja,
      chip: 'rechazado',
      titulo: 'Un trayecto verificado se ha anulado',
      subtitulo: tramo,
      contenido:
        recuadro(escapar(motivo || 'Revisión posterior.'), 'Los puntos y los kilómetros de ese trayecto se han descontado. El resto de tus trayectos no se toca.')
        + parrafo(`Hola, ${piloto}: la decisión la ha tomado una persona tras revisar la captura.`)
        + boton('Ver mis trayectos', `${SITIO}/yo/#historial`),
    }),
    texto: `Hola, ${nombre}\n\nEl trayecto ${ruta}, que estaba verificado, se ha anulado tras una revision.\n\n`
      + `Motivo: ${motivo || 'Revision posterior.'}\n\n`
      + `Los puntos y los kilometros de ese trayecto se han descontado.\n\n${SITIO}/yo/#historial\n` + pieTexto(tokenBaja),
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
    `<li style="margin-bottom:8px;color:#55534D;">${escapar(v.ruta)} — `
    + `<strong>${v.puntos || 0} puntos</strong></li>`).join('');

  const cuantos = viajes.length === 1 ? 'trayecto verificado' : 'trayectos verificados';

  return {
    asunto: `${viajes.length} ${cuantos}`,
    html: envolver({
      tokenBaja,
      chip: 'verificado',
      titulo: `${viajes.length} ${cuantos}`,
      contenido:
        parrafo(`Hola, ${piloto}. Esto es lo que has sumado:`)
        + `<ul style="margin:0 0 14px;padding-left:20px;">${filas}</ul>`
        + parrafo(`Total: <strong>${puntos} puntos</strong> y ${(metros / 1000).toFixed(1)} km.`)
        + boton('Ver la clasificacion', `${SITIO}/clasificacion/`),
    }),
    texto: `Hola, ${nombre}\n\n${viajes.length} ${cuantos}:\n`
      + viajes.map((v) => `  ${v.ruta} — ${v.puntos || 0} puntos`).join('\n')
      + `\n\nTotal: ${puntos} puntos y ${(metros / 1000).toFixed(1)} km.\n\n${SITIO}/clasificacion/\n` + pieTexto(tokenBaja),
  };
}

function revisionLenta({ tokenBaja = null, nombre, ruta }) {
  const piloto = escapar(nombre);
  return {
    asunto: 'Tu trayecto lo esta revisando una persona',
    html: envolver({
      tokenBaja,
      chip: 'revision',
      titulo: 'Tu trayecto lo mira una persona',
      subtitulo: escapar(ruta),
      contenido:
        parrafo(`Hola, ${piloto}. El trayecto <strong>${escapar(ruta)}</strong> necesita que lo mire una persona antes de darlo por bueno.`)
        + parrafo('No es que hayas hecho nada mal: pasa cuando la captura no se lee del todo bien. Te avisamos en cuanto se resuelva.'),
    }),
    texto: `Hola, ${nombre}\n\nEl trayecto ${ruta} necesita revision de una persona. `
      + 'No es que hayas hecho nada mal: pasa cuando la captura no se lee del todo bien.\n' + pieTexto(tokenBaja),
  };
}

/**
 * Aviso a quien ya tenia cuenta en la v1, despues de migrar sus datos (#54).
 *
 * Existe por una razon concreta: la primera vez que entren van a ver una
 * clasificacion en la que no aparecen, y sin este correo la lectura obvia es
 * "me han borrado los viajes". No es cortesia, es evitar que la gente se vaya
 * por un malentendido.
 *
 * Lo que NO hace este correo: sustituir la notificacion de brecha del art. 34,
 * si es que hubo que mandarla (#59). Son dos comunicaciones distintas, con
 * obligaciones distintas, y mezclarlas seria enterrar la segunda.
 */
function historialMigrado({ tokenBaja = null, nombre, viajes = 0, puntos = 0, kilometros = 0, estimados = 0 }) {
  const piloto = escapar(nombre);
  const km = kilometros.toLocaleString('es-ES', { maximumFractionDigits: 0 });

  // Si parte del kilometraje es deducido y no medido, se dice. Quien mira sus
  // numeros tiene derecho a saber cuales son de ruta real.
  const aviso = estimados > 0
    ? `De esos, ${estimados.toLocaleString('es-ES')} ${estimados === 1 ? 'viaje tiene' : 'viajes tienen'} `
      + 'la distancia estimada, porque todavia no esta calculada la ruta ciclable de ese par de estaciones. '
      + 'Aparecen marcados en tu perfil.'
    : null;

  return {
    asunto: 'Tus viajes de BiciFastness siguen ahi',
    html: envolver({
      tokenBaja,
      titulo: `Hola, ${piloto}`,
      contenido:
        parrafo('BiciFastness ha cambiado por dentro. Te escribo para que no te lleves una sorpresa: '
          + '<strong>tus viajes no se han perdido</strong>.')
        + parrafo(`Tus ${viajes.toLocaleString('es-ES')} viajes y tus ${puntos.toLocaleString('es-ES')} puntos `
          + 'estan archivados en tu perfil como una temporada mas, la temporada <strong>v1</strong>. '
          + `Ademas ahora llevan los kilometros calculados: ${km} km en total, que antes no se guardaban.`)
        + (aviso ? parrafo(escapar(aviso)) : '')
        + parrafo('Lo que si empieza a cero, <strong>para todo el mundo</strong>, es la temporada en curso. '
          + 'El juego nuevo puntua por distancia, por velocidad y por constancia, no solo por ir rapido, '
          + 'asi que arrastrar los puntos antiguos habria sido darte una ventaja medida con otras reglas.')
        + boton('Ver mi perfil', `${SITIO}/yo/`),
    }),
    texto: `Hola, ${nombre}\n\n`
      + 'BiciFastness ha cambiado por dentro. Te escribo para que no te lleves una sorpresa: '
      + 'tus viajes no se han perdido.\n\n'
      + `Tus ${viajes} viajes y tus ${puntos} puntos estan archivados en tu perfil como una `
      + `temporada mas, la temporada v1. Ademas ahora llevan los kilometros calculados: ${km} km en total.\n\n`
      + (aviso ? `${aviso}\n\n` : '')
      + 'Lo que si empieza a cero, para todo el mundo, es la temporada en curso. El juego nuevo '
      + 'puntua por distancia, por velocidad y por constancia, no solo por ir rapido.\n\n'
      + `${SITIO}/yo/\n` + pieTexto(tokenBaja),
  };
}

/**
 * Aviso suelto a la administracion.
 *
 * Para lo que hay que contar una vez y no tiene plantilla propia: una cuenta
 * inundando la cola, por ejemplo. NO lleva enlace de baja, igual que el aviso de
 * cuota: no es un correo de producto, es la unica via de enterarse de algo que
 * esta pasando ahora.
 */
function avisoAdmin({ asunto, cuerpo, enlace = null }) {
  return {
    asunto: `BiciFastness — ${asunto}`,
    html: envolver({
      titulo: escapar(asunto),
      contenido: parrafo(escapar(cuerpo))
        + (enlace ? boton('Ver en el panel', enlace) : ''),
    }),
    texto: `${asunto}\n\n${cuerpo}\n${enlace ? `\n${enlace}\n` : ''}`,
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

/**
 * Las plantillas que se le mandan a un USUARIO, por su nombre de tipo.
 *
 * Existe por la cola de reintentos (#65). Un correo encolado no puede guardar
 * el mensaje ya montado —dentro va el nombre de la persona, y el destinatario
 * habria que guardarlo tambien, que es la clase de dato que salio de Firestore
 * en #59 y #60—. Lo que se guarda es el TIPO, y el mensaje se vuelve a montar
 * en el momento de enviarlo, con la direccion recien pedida a Firebase Auth.
 *
 * Los nombres son los mismos que las claves de `correo.PRIORIDAD`, que decide
 * que se cae primero cuando se acaba el cupo del dia. Una prueba ata las dos
 * listas: si divergen, un correo encolado tendria prioridad 9 (la de "no se
 * quien eres") y adelantaria o se retrasaria sin que nadie lo hubiera decidido.
 *
 * Los de administracion NO estan aqui a proposito: van a una direccion fija,
 * por otro canal, y no se encolan.
 */
const POR_TIPO = {
  bienvenida,
  viaje_rechazado: viajeRechazado,
  error_procesar: errorAlProcesar,
  viaje_anulado: viajeAnulado,
  revision_lenta: revisionLenta,
  mensaje_equipo: mensajeEquipo,
  cuenta_suspendida: cuentaSuspendida,
  clave_cambiada: contrasenaCambiada,
};

/**
 * `viajesVerificados` NO esta arriba, y no es un olvido.
 *
 * Es el aviso de "se te han aprobado estos viajes", y **no lo manda nadie**.
 * Aparecio al montar este registro: la comprobacion que habia solo miraba tres
 * plantillas por su nombre y esta se le escapaba.
 *
 * No se puede encolar lo que nunca se envia, asi que no entra aqui. Y no lo
 * enchufo de paso porque no es un reintento, es una funcion nueva con una
 * decision dentro: el comentario del worker dice que estos avisos "van
 * agrupados, o se come el cupo diario de Resend", y agrupar exige decidir cada
 * cuanto y con que ventana. Una pasada son cinco minutos, asi que un resumen
 * por pasada no es un resumen.
 */

module.exports = {
  POR_TIPO,
  PLANTILLA_FIREBASE_RESTABLECER,
  avisoAdmin,
  bienvenida,
  errorAlProcesar,
  mensajeEquipo,
  cuentaSuspendida,
  contrasenaCambiada,
  cuotaEnPeligro,
  historialMigrado,
  viajeRechazado,
  viajeAnulado,
  viajesVerificados,
  revisionLenta,
  envolver,
  SITIO,
};
