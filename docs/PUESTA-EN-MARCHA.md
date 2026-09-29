# Puesta en marcha: lo que te toca hacer a ti

Todo lo que se podía hacer con código está hecho y en `main` del repositorio
nuevo, **`mateogsilvaa/bicifastness`**, con la historia limpia (un solo commit,
sin las credenciales de la v1). El antiguo, con toda la historia y el PR #68
fusionado, queda archivado como `mateogsilvaa/bicifastness-archive`.

Qué hay: el rediseño completo (01–11), el acceso con Google, los correos en
HTML desde `bicifastness@gmail.com`, las 685 estaciones con bicis en vivo, la
valoración de bicis (Bicirating), la verificación ultra precisa, las
optimizaciones de cuota y el worker nuevo. Lo que queda son **pasos en
consolas** (GitHub, Firebase, Google, Vercel) que solo puedes dar tú porque
piden tu cuenta.

**Se hacen una vez.** Después la web funciona sola y tu trabajo se reduce a
unos diez minutos a la semana en `/admin/`.

- Tiempo total: **una tarde** (unas 3 horas si es la primera vez).
- El **orden importa**: cada paso da por hecho el anterior.
- Cada paso termina con un **«Cómo sé que ha ido bien»**. No pases al
  siguiente sin comprobarlo.

> Datos que vas a necesitar a mano
> - Proyecto de Firebase: `bicifastness`
> - Web en Vercel: **`https://bicifastness-pi.vercel.app`**
> - Repositorio: `mateogsilvaa/bicifastness` (rama `main`)
> - Cuenta de correo del proyecto: `bicifastness@gmail.com`

---

## Índice

| # | Paso | Dónde | Tiempo | Obligatorio |
|---|---|---|---|---|
| 0 | [Mirarlo en local antes de publicar](#0-mirarlo-en-local-antes-de-publicar) | Tu ordenador | 10 min | Recomendado |
| 1 | [El repositorio nuevo y Vercel](#1-el-repositorio-nuevo-y-vercel) | GitHub, Vercel | 10 min | Sí |
| 2 | [Credenciales viejas fuera](#2-credenciales-viejas-fuera) | Google, Telegram | 10 min | Sí (ya hecho) |
| 3 | [Secretos de GitHub](#3-secretos-de-github) | GitHub | 15 min | Sí |
| 4 | [Reglas desplegadas y datos migrados](#4-reglas-desplegadas-y-datos-migrados) | Terminal | 20 min | Sí |
| 5 | [Dominios y entrar con Google](#5-dominios-y-entrar-con-google) | Firebase | 10 min | Sí |
| 6 | [App Check (antiabuso)](#6-app-check-antiabuso) | Google Cloud, Firebase | 15 min + 1 día | Muy recomendado |
| 7 | [Correo desde bicifastness@gmail.com](#7-correo-desde-bicifastnessgmailcom) | Google, GitHub, Firebase | 25 min | Para correos |
| 8 | [Avisos push](#8-avisos-push) | Terminal, GitHub | 10 min | Para notificaciones |
| 9 | [Datos legales del responsable](#9-datos-legales-del-responsable) | Editor | 15 min | Sí, antes de abrir |
| 10 | [Encender los procesos automáticos](#10-encender-los-procesos-automáticos) | GitHub | 10 min | Sí |
| 11 | [Abrir la web](#11-abrir-la-web) | Terminal, Vercel | 15 min | Sí |
| 12 | [Plan Blaze con alerta de gasto](#12-plan-blaze-con-alerta-de-gasto) | Firebase, Google Cloud | 5 min | Recomendado |
| 13 | [Estaciones al día](#13-estaciones-al-día) | Terminal | 5 min | Cuando BiciMAD abra estaciones |
| — | [Comprobación final pantalla a pantalla](#comprobación-final-pantalla-a-pantalla) | Móvil y ordenador | 20 min | Sí |
| — | [Si algo falla](#si-algo-falla) | — | — | — |

---

## 0. Mirarlo en local antes de publicar

Hay dos formas de abrir la web en tu ordenador. Necesitas **Node 20 o más** y,
la primera vez, instalar el utillaje:

```bash
npm install
```

### 0.1 La maqueta: todas las pantallas sin cuenta ni red

Es lo más cómodo para revisar el rediseño. Arranca un servidor con un
Firebase **de mentira** (`scripts/maqueta/firebase.js`): una sesión abierta,
un perfil con racha, tu grupo de división, la ruta del día, un clan y el mapa.
No toca tu base de datos real ni gasta cuota.

```bash
npm run maqueta
```

Abre `http://localhost:5001/`. Trucos en la consola del navegador (F12):

| Quieres ver… | Escribe | Luego |
|---|---|---|
| La portada sin sesión (1a/8d) | `localStorage.maqueta_sesion = 'fuera'` | recarga |
| Un piloto recién llegado (2e) | `localStorage.maqueta_perfil = 'nuevo'` | recarga |
| Hoy ya salvado (2b) | `localStorage.maqueta_perfil = 'salvado'` | recarga |
| El panel de administración (09) | `localStorage.maqueta_perfil = 'admin'` y ve a `/admin/` | recarga |
| Una bici con valoraciones (11d) | ve a `/bici/?n=2471` (o `318` con pocas, `1502` sin ninguna) | — |
| Volver a lo normal | `localStorage.clear()` | recarga |

En `/subir/` puedes elegir cualquier imagen: se lee con el OCR de verdad y, al
subirla, **a los 6 segundos se «verifica»** sola para que veas la pantalla
azul de puntos (3e). Para ver el billete sin depender del OCR:
`maquetaBillete()` o `maquetaVarios()` en la consola de `/subir/`
(`maquetaBillete({ bici: '2471' })` para ver la encuesta de la bici con el
número ya leído).

### 0.2 El sitio real contra Firebase

```bash
npm run dev
```

Abre `http://localhost:5000/`. Esta sí usa tu Firebase de verdad: para entrar
necesitas tu cuenta, y lo que hagas se escribe en la base real.

**Cómo sé que ha ido bien:** en la maqueta ves «Hola, laura_pedalea» con el
anillo de la racha, y la barra lateral azul aparece al ensanchar la ventana
por encima de 900 px.

---

## 1. El repositorio nuevo y Vercel

Esto ya está hecho:

- `mateogsilvaa/bicifastness` tiene `main` con **un solo commit** y todo el
  código. La historia vieja (con la contraseña de Gmail de la v1 dentro) no
  está: vive solo en el archivado.
- `mateogsilvaa/bicifastness-archive` tiene el PR #68 fusionado y está
  **archivado** (solo lectura). Déjalo **privado**.

Lo que te toca:

1. **Público.** Settings → General → Danger Zone → visibilidad **Public**. El
   worker corre en GitHub Actions cada 5 minutos: en un repo público es gratis
   e ilimitado; en uno privado se come los 2.000 minutos al mes del plan
   gratuito en menos de diez días.
2. **Vercel.** Proyecto → Settings → Git → **Disconnect** y **Connect** con
   `mateogsilvaa/bicifastness`, rama de producción `main`. Framework: *Other*,
   sin comando de build ni directorio de salida (la raíz es el sitio).
3. **Protege `main`** (opcional): Settings → Branches → regla para `main` que
   exija el CI en verde.

**Cómo sé que ha ido bien:** GitHub → Actions → «Tests y despliegue» en verde
sobre `main`, y Vercel → Deployments muestra un despliegue de `main` del repo
nuevo. Mientras `vercel.json` tenga el bloque `redirects`, la web enseña la
página de obras: eso se quita en el paso 11.

---

## 2. Credenciales viejas fuera

Me dijiste que ya las has revocado. Repásalo con esta lista, porque **alguien
puede tener un clon del repo viejo** aunque ya no sea público:

1. Google → Seguridad → Contraseñas de aplicación: la de la v1, **revocada**.
2. Google AI Studio: la API key de Gemini, **borrada** (ya no se usa).
3. Telegram → @BotFather → `/revoke` del token del bot.
4. PocketBase y el túnel de ngrok, apagados.
5. Firebase → Firestore → la colección `secrets`, borrada.

---

## 3. Secretos de GitHub

Repo → **Settings → Secrets and variables → Actions → New repository secret**.

| Secreto | Qué poner | ¿Hace falta? |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | El JSON **entero** de una cuenta de servicio: Firebase → ⚙ Configuración del proyecto → Cuentas de servicio → **Generar nueva clave privada** | **Sí** |
| `CORREO_ADMIN` | Tu correo. Ahí te llegan los avisos de cuota, de abuso y de cola de revisión atascada | **Sí** |
| `SITIO_URL` | `https://bicifastness-pi.vercel.app` (o tu dominio cuando lo tengas). Es la dirección que llevan los enlaces de los correos | Recomendado (si falta, se usa esa misma) |
| `GMAIL_USUARIO` | `bicifastness@gmail.com` (paso 7) | Para correos |
| `GMAIL_CLAVE_APLICACION` | La contraseña de aplicación de 16 letras (paso 7) | Para correos |
| `CORREO_RESPUESTA` | Opcional: a dónde van las respuestas a los mensajes que mandas desde el panel. Si falta, vuelven a la propia cuenta de Gmail | No |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Paso 8 | Para push |

Los mismos secretos los usan los dos workflows (`verificar-viajes.yml` cada 5
minutos y `periodicas.yml` los lunes y el día 1): se ponen una vez.

El JSON de la cuenta de servicio **no lo guardes en el repo** ni en la carpeta
del proyecto. Lo necesitas un momento más en el paso 4; después, bórralo.

**Cómo sé que ha ido bien:** Actions → «Verificar viajes» → **Run workflow** con
«simular» marcado. El log termina sin «Falta FIREBASE_SERVICE_ACCOUNT».

---

## 4. Reglas desplegadas y datos migrados

### 4.1 Reglas

Con el secreto puesto, **relanza el CI** (Actions → «Tests y despliegue» →
Re-run) o haz cualquier push a `main`: el trabajo `reglas` despliega
`firestore.rules` e índices. **Eso es lo que cierra la fuga de correos** de la
v1, no la página de obras: Firestore responde aunque la web esté cerrada.

### 4.2 Migración de los datos de la v1

Desde tu ordenador. Primero apunta a la clave de la cuenta de servicio. En
PowerShell:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\ruta\clave.json"
```

En Git Bash / macOS / Linux:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/ruta/a/la/clave.json
```

Y luego, en este orden:

```bash
node scripts/migrar-datos.js --copia copia.json
```

```bash
node scripts/migrar-datos.js --simular
```

Lee la salida. Si cuadra:

```bash
node scripts/migrar-datos.js --aplicar
```

```bash
node scripts/migrar-datos.js --comprobar
```

Cuando `--comprobar` diga que no queda ningún documento con `email_real` ni
`foto_url`, en `firestore.rules` (bloque `tiempos_viaje`) cambia la línea
`allow read` por la comentada justo debajo y haz push: eso vuelve a hacer
públicas las clasificaciones de viajes verificados.

Y la de las auditorías:

```bash
node scripts/migrar-auditorias.js --aplicar
```

**Borra `copia.json`** al terminar: lleva dentro correos y capturas. El detalle
y el camino de vuelta, en [MIGRACION.md](MIGRACION.md).

**Cómo sé que ha ido bien:** Firebase → Firestore → Reglas muestra la fecha de
hoy, y `--comprobar` no lista nada pendiente.

---

## 5. Dominios y entrar con Google

El botón «Empezar con Google» ya está en la portada, en `/entrar/` y en
`/register/`. Solo falta encenderlo.

### 5.1 Dominio autorizado (sin esto no entra NADIE, ni con correo)

Firebase → Authentication → Settings → **Dominios autorizados** → Agregar:

- `bicifastness-pi.vercel.app`
- tu dominio propio, si algún día pones uno

Deja `localhost` (viene de serie): es el que usas para probar en local.

### 5.2 Activar Google

Firebase → Authentication → Sign-in method → **Agregar proveedor → Google**:

1. Habilitar.
2. Nombre público del proyecto: `BiciFastness`.
3. Correo de asistencia: el tuyo.
4. Guardar.

No hace falta crear credenciales OAuth a mano: Firebase las crea.

### 5.3 El nombre en la ventana de Google (opcional)

Por defecto el popup dice «para ir a bicifastness.firebaseapp.com». Funciona
igual. Para que diga «BiciFastness»: Google Cloud Console → proyecto
`bicifastness` → Google Auth Platform → **Branding** → nombre de la app, correo
y los enlaces a `https://bicifastness-pi.vercel.app/legal/privacidad/` y
`https://bicifastness-pi.vercel.app/legal/terminos/`. **No subas logo** de
momento: con logo Google exige verificar la app, y eso tarda días y pide un
dominio propio.

### 5.4 Cómo funciona para quien entra

1. Pulsa «Empezar con Google» y elige su cuenta.
2. Si es nueva, un único paso: **nombre de piloto** (se comprueba libre y
   permitido mientras escribe) y las tres casillas (14+, términos,
   privacidad). Su nombre real de Google **no se publica** en ningún sitio.
3. Si ya tenía cuenta con contraseña y el mismo Gmail, Firebase las une.

**Cómo sé que ha ido bien:** pruébalo con una cuenta de Google cualquiera. Si
ves «El acceso con Google todavía no está activado», falta el 5.2; si ves
«…en esta dirección», falta el 5.1.

---

## 6. App Check (antiabuso)

Impide que alguien use la configuración pública de Firebase desde un script
para inundar la base de datos **sin cuenta** (la analítica y los errores
admiten escrituras sin sesión a propósito, para medir el registro). Las reglas
ya acotan forma y tamaño de todo; App Check acota **quién** escribe.

**EL ORDEN NO ES OPCIONAL.** Si activas el modo obligatorio antes de poner la
clave, la web entera deja de funcionar.

1. Google Cloud Console → **reCAPTCHA** → Crear clave → tipo **puntuación
   (v3)** → dominios: `bicifastness-pi.vercel.app` (y `localhost`).
2. Firebase → **App Check** → Apps → tu app web → registrar con reCAPTCHA v3 y
   la clave secreta del paso 1.
3. Pega la **clave de sitio** en `assets/js/firebase.js`, en
   `RECAPTCHA_SITE_KEY`, y haz push.
4. **Espera un día.** En Firebase → App Check → Firestore verás las peticiones
   «verificadas».
5. **Solo cuando casi todas lo sean**: App Check → Firestore → **Aplicar**.

El worker no se ve afectado: usa el Admin SDK, que no pasa por App Check.

---

## 7. Correo desde bicifastness@gmail.com

Todos los correos salen de la cuenta del proyecto, en HTML (10 · Correos:
600 px, tablas, modo oscuro y botón que funciona en Outlook):

| Correo | Cuándo | Quién lo manda |
|---|---|---|
| Bienvenida (10c) | Al crear la cuenta | worker |
| Trayecto rechazado (10a) | Rechazo automático **o** hecho por ti en `/admin/` (con tu motivo) | worker |
| No hemos podido leer tu captura (10b) | Si el análisis falla por nuestra culpa | worker |
| Mensaje del equipo (10d) | «Escribir al piloto» en `/admin/` | worker |
| Cuenta suspendida (10e) | «Suspender al autor» en `/admin/` | worker |
| Tu contraseña ha cambiado (10g) | Al elegir contraseña nueva en `/cuenta/` | worker |
| Restablecer contraseña (10f) | «He olvidado mi contraseña» | **Firebase** (plantilla pegada) |
| Confirmar el correo | Al registrarse con correo | **Firebase** |

Los de seguridad y moderación (10e, 10g y los mensajes del equipo) llegan
aunque la persona haya apagado los avisos; el resto respeta la baja.

**Nunca se usa tu contraseña de Google.** Se usa una *contraseña de
aplicación*: solo sirve para enviar, se revoca sola sin tocar nada más y no da
acceso ni a la bandeja ni al resto de la cuenta.

### 7.1 La contraseña de aplicación

1. Entra en https://myaccount.google.com con `bicifastness@gmail.com`.
2. Seguridad → **Verificación en dos pasos**: actívala si no lo está (sin ella
   Google no deja crear contraseñas de aplicación).
3. Seguridad → Verificación en dos pasos → al final, **Contraseñas de
   aplicación** (o directamente https://myaccount.google.com/apppasswords).
4. Nombre: `bicifastness worker` → **Crear**. Copia las 16 letras (con o sin
   espacios, da igual).
5. Secretos de GitHub (paso 3): `GMAIL_USUARIO` = `bicifastness@gmail.com` y
   `GMAIL_CLAVE_APLICACION` = las 16 letras.

Gmail deja unos 500 destinatarios al día; el worker se limita a 400 y reparte
por prioridad (seguridad y moderación primero). Lo que no quepa, al día
siguiente.

### 7.2 Los correos de Firebase (restablecer y confirmar)

Firebase manda los suyos por su cuenta. Para que también salgan de
`bicifastness@gmail.com` y con nuestro diseño:

1. Firebase → Authentication → **Plantillas** → ⚙ (arriba) → **Configuración
   de SMTP** → Habilitar:
   - Dirección del remitente: `bicifastness@gmail.com`
   - Host: `smtp.gmail.com` · Puerto: `465` · Seguridad: **SSL**
   - Usuario: `bicifastness@gmail.com` · Contraseña: la de aplicación del 7.1
2. En esa misma pantalla, **Personalizar URL de acción** →
   `https://bicifastness-pi.vercel.app/cuenta/` (o tu dominio). Así los
   enlaces de los correos abren nuestra página `/cuenta/` y no la de Firebase:
   se elige la contraseña con el medidor de fuerza, se entra directamente y se
   manda el aviso «Tu contraseña ha cambiado».
3. Plantilla **Restablecimiento de contraseña**:
   - Nombre del remitente: `BiciFastness`
   - Asunto: `Elige una contraseña nueva`
   - Mensaje: genera los correos de ejemplo y pega **entero** el contenido de
     `docs/correos/restablecer.html`:

     ```bash
     npm run correos
     ```

4. Plantilla **Verificación de dirección de correo**: nombre del remitente
   `BiciFastness` y asunto `Confirma tu correo`. El texto de esta Firebase no
   deja cambiarlo; con el remitente y el enlace a `/cuenta/` basta.

En `docs/correos/` quedan también los demás correos con datos de ejemplo:
ábrelos en el navegador para verlos sin mandar nada.

**Cómo sé que ha ido bien:**
- regístrate con un correo tuyo nuevo: en unos minutos llega la bienvenida
  desde `bicifastness@gmail.com`;
- «He olvidado mi contraseña» → el correo lleva nuestro diseño, el botón abre
  `/cuenta/`, eliges contraseña y a los pocos minutos llega «Tu contraseña ha
  cambiado»;
- en `/admin/`, «Escribir al piloto» a tu propia cuenta de prueba.

Si no sale nada, el log de «Verificar viajes» dice por qué («Gmail rechaza la
contraseña de aplicación…» = secreto mal copiado).

---

## 8. Avisos push

Cuatro tipos (07 · 7a), con el dato en el título:

| Aviso | Cuándo | Ejemplo |
|---|---|---|
| Racha en peligro | 20:00, solo si no has salido y tienes racha | «13 días en juego» |
| Trayecto resuelto | Al verificarse, con los puntos reales | «Verificado · +69 pts» |
| Te han quitado un récord | Cuando pasa | «rosa.pedal hizo Callao → Moncloa en 09:41. Tu 09:54 pasa a 2.º» |
| Cambio de división | Los lunes (desactivado por defecto) | «Subes a Oro» |

En iPhone solo funcionan con la web añadida a la pantalla de inicio (la web lo
sugiere tras el primer viaje, con los tres pasos de Safari).

```bash
node scripts/claves-push.js
```

Imprime tres valores: van como secretos `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY` y `VAPID_SUBJECT`. La pública además va en la web:

```bash
VAPID_PUBLIC_KEY=la_publica node scripts/build-push.js
```

y commitea `assets/data/push-config.js`. **Se generan una sola vez**:
cambiarlas invalida todas las suscripciones.

**Cómo sé que ha ido bien:** sube un trayecto y, en la pantalla «Subido»,
aparece «Avísame cuando esté». Actívalo; cuando se verifique te llega el aviso.

---

## 9. Datos legales del responsable

En los cuatro documentos de `legal/` hay huecos marcados en ámbar: nombre, NIF,
domicilio y correo de contacto del responsable. **Rellénalos y haz push antes
de abrir**: el RGPD (art. 13) exige identificarte y una política con
marcadores no cumple.

- `legal/privacidad/index.html` (versión 1.4.0)
- `legal/terminos/index.html`
- `legal/cookies/index.html`
- `legal/aviso-legal/index.html`

Cada uno tiene ya arriba su «En resumen» de tres líneas (07 · 7g). Si cambias
el fondo de un documento, **sube su versión** en la línea `class="version"` y
la misma cifra en `backend/src/config.js` (`VERSION_TERMINOS`) y en
`assets/js/ui.js` (`VERSION_LEGAL`): la web pedirá a cada usuario que lo
acepte de nuevo y, hasta entonces, no le deja subir (hay una prueba que ata las
tres cifras).

---

## 10. Encender los procesos automáticos

En `.github/workflows/verificar-viajes.yml` quita el `#` de:

```yaml
  # schedule:
  #   - cron: '*/5 * * * *'
```

y en `.github/workflows/periodicas.yml` el de su bloque `schedule` (divisiones
los lunes de madrugada, 01:45 UTC, y cierre de temporada el día 1 a las 01:30 UTC). Push.

**Antes, pruébalos en seco:** Actions → cada workflow → Run workflow → marca
**simular**. Mira que el log cuadra. **El cierre de temporada no tiene vuelta
atrás**, por eso se prueba simulado.

**Cómo sé que ha ido bien:** a los 5-10 minutos, «Verificar viajes» aparece
solo en Actions cada 5 minutos, en verde.

---

## 11. Abrir la web

1. **Tu cuenta de administrador.** Regístrate en la web y luego, con la clave
   de servicio del paso 4:

   ```bash
   node scripts/set-admin.js tu@correo.com
   ```

   Cierra sesión y vuelve a entrar para que tu sesión recoja el rol. Ya puedes
   abrir `/admin/`.
2. **Viaje de prueba** con una cuenta normal: sube una captura real de BiciMAD
   y espera al worker (5-15 minutos). Debe acabar en «Verificado · +N pts» o
   en tu cola de `/admin/`.
3. **Quita la página de obras:** borra el bloque `redirects` de `vercel.json`,
   push, y comprueba que `/`, `/subir/` y `/clasificacion/` responden.

**Para volver a cerrar** en cualquier momento: vuelve a poner el bloque
`redirects` y push. Cinco minutos ([MANTENIMIENTO.md](MANTENIMIENTO.md)).

---

## 12. Plan Blaze con alerta de gasto

El plan gratuito (Spark) da **50.000 lecturas y 20.000 escrituras al día**. Si
se agotan, Firestore deja de responder hasta las 9:00 de Madrid. El modelo del
repo (`docs/COSTE.md`, se comprueba en cada CI) dice:

| Usuarios activos al día | Lecturas/día | De la cuota gratis |
|---|---|---|
| 6 (hoy) | ~8.000 | 16 % |
| 50 | ~23.500 | 47 % |
| 200 | ~104.000 | 207 % |

El rediseño apenas añade coste: todo lo nuevo sale de documentos que ya se
leían o de agregados públicos cacheados en la pestaña. Lo único nuevo que
escribe el worker son los **grupos de división** (un documento por cada 30
pilotos + un índice, en cada reconstrucción de clasificaciones: unas 700
escrituras al día con 200 pilotos, el 3,5 % de la cuota).

El worker además se protege solo: al 70 % rehace las clasificaciones cada hora
en vez de cada cuarto de hora, al 95 % solo verifica viajes, y te manda un
correo al cruzar cada umbral.

**Para olvidarte del todo:** Firebase → Uso y facturación → plan **Blaze**. La
cuota gratuita sigue igual; solo pagas lo que pase de ella (céntimos al día con
200 personas). Ponle una **alerta de presupuesto** de 5 €/mes (Google Cloud →
Facturación → Presupuestos y alertas). Blaze no tiene tope duro: la alerta
avisa, no corta; lo que corta el abuso son las reglas y App Check.

---

## 13. Estaciones al día

BiciMAD abre estaciones más a menudo de lo que el Ayuntamiento publica el
fichero oficial. La web trae **685** (las 631 oficiales + las nuevas de la
lista en vivo). Cuando abran más:

```bash
node scripts/actualizar-estaciones.js --simular
```

Si la lista de nuevas cuadra:

```bash
node scripts/actualizar-estaciones.js
```

```bash
npm run datos
```

y commitea `data/emt.geojson`, `assets/data/estaciones.js` y
`backend/lib/estaciones.json`. Si tienes un fichero oficial más nuevo de
datos.madrid.es, pásalo con `--oficial fichero.json`: manda en todo lo que
trae. **Nunca se borra una estación**: una que hoy no sale puede estar solo
desconectada, y borrarla dejaría huérfanos los trayectos que ya la usan.

Las **bicis y huecos en vivo** de cada estación (mapa) salen de CityBikes
directamente en el navegador: no gastan cuota de Firestore ni necesitan nada.

---

## Comprobación final pantalla a pantalla

Con la web abierta, en el móvil **y** en un ordenador (por encima de 900 px sale
la barra lateral; por encima de 1200, las columnas dobles). Marca cada línea.

**01 Acceso**
- [ ] Portada sin sesión: mapa real de fondo, «Madrid es el circuito.», la ruta
      del día en vivo y «Empezar con Google». En ordenador, texto a la
      izquierda y mapa a la derecha (8d).
- [ ] `/entrar/` y `/register/`: en ordenador, panel azul a la izquierda (8e).
- [ ] Alta con Google: pide solo el nombre de piloto y las tres casillas.

**02 Hoy**
- [ ] Anillo de la semana con tu racha, «Hoy aún no has salido», misiones con
      sus puntos (+20, +15, +25), ruta del día en tarjeta oscura, tu grupo de
      división con «a N pts de subir», última marca y tu clan.
- [ ] Tras un viaje verificado: tarjeta azul «Hoy ya está salvado».
- [ ] Por la noche sin viaje: la cuenta atrás hasta medianoche.

**03 Subir**
- [ ] El «+» abre el selector (las dos primeras veces, la hoja explicativa).
- [ ] Pegar una captura (Ctrl+V) o arrastrarla a la ventana la lleva a leer.
- [ ] Desde la galería del móvil: Compartir → bicifastness (web instalada).
- [ ] Billete con estaciones, tiempo, km y km/h; tocar cada dato lo corrige.
- [ ] El 4.º trayecto del día avisa «Este ya no puntúa hoy» y se sube sin
      puntos; a partir del 7.º, no deja.

**04 Ranking** — se abre en tu grupo; Madrid por modos; rutas con buscador y
detalle; clanes con el reparto de estaciones; tocar un piloto abre su ficha.

**05 Mapa** — puntos de color (controlada), anillo (disputa), gris (libre);
la hoja sube y baja; en ordenador, panel flotante a la izquierda. Al tocar una
estación, «N bicis · M huecos» en vivo. Mi clan: asedios, plantilla, invitar y
dejar el clan.

**06 Tú** — rating por modos, historial con estados (incluido «Sin puntos ·
pasado el cupo»), ajustes, mis datos. En ordenador ancho, insignias y
temporadas al lado.

**07 Sistema** — sin red (modo avión) enseña tu resumen guardado; una URL que no
existe enseña el 404; «Cómo funciona» con la tabla de puntos; legales con su
resumen.

**09 Admin** — `/admin/` con la cola a la izquierda y el caso a la derecha;
A aprueba, R rechaza, 1-9 elige motivo, J/K se mueve. «Escribir al piloto»
en cada caso y en cada denuncia. `/admin/metricas/` y `/admin/errores/` con la
misma cabecera.

**10 Correos** — ver el paso 7 (bienvenida, restablecer, cambio de contraseña,
mensaje del equipo).

**11 Bicis** — tras subir, «¿Qué tal la bici?» con el número leído de la
captura (o un campo para escribirlo); un toque en la nota guarda. En el mapa,
«Buscar bici» abre `/bici/`: nota media (con 3 o más valoraciones en 60 días),
fallos más repetidos y las últimas opiniones, sin autor.

---

## Si algo falla

| Síntoma | Causa probable | Arreglo |
|---|---|---|
| Nadie puede entrar | Falta el dominio autorizado | Paso 5.1 |
| «El acceso con Google todavía no está activado» | Proveedor sin activar | Paso 5.2 |
| Clasificaciones vacías con error «revisa las reglas» | Reglas antiguas desplegadas | Paso 4.1 (relanza el CI) |
| Los viajes se quedan «En cola» para siempre | El worker no corre | Paso 10, y mira el log en Actions |
| No llegan correos | Faltan `GMAIL_USUARIO` / `GMAIL_CLAVE_APLICACION`, o la contraseña de aplicación está revocada | Paso 7.1 |
| El correo de restablecer llega en inglés o sin diseño | Falta pegar la plantilla o el SMTP en Firebase | Paso 7.2 |
| Una estación nueva «no existe» al subir | BiciMAD la ha abierto después | Paso 13 |
| «Avísame cuando esté» no sale | Faltan las claves VAPID en la web | Paso 8 (commitea `push-config.js`) |
| La web entera deja de responder tras App Check | Se aplicó antes de poner la clave | App Check → Firestore → desactivar «Aplicar»; repite el paso 6 en orden |
| El mapa sale sin calles | Teselas bloqueadas | El mapa usa OpenStreetMap (CARTO empezó a pedir clave). Comprueba que `img-src` de la CSP (`shared/cabeceras.json`) incluye `https://tile.openstreetmap.org` y ejecuta `npm run cabeceras` |
| Correo de «cuota en peligro» | Mucho tráfico | Mira `docs/COSTE.md` o pasa a Blaze (paso 12) |
| La cola de `/admin/` crece | Muchos casos dudosos | Normal al principio; con los atajos, diez casos son cinco minutos |

Para cambiar la cabecera de seguridad (CSP) de todas las páginas a la vez:
edita `shared/cabeceras.json` y ejecuta `npm run cabeceras`. Nunca a mano en
cada página: una prueba lo comprueba.

---

## Qué hace la web sola, sin ti

| Qué | Cuándo | Dónde |
|---|---|---|
| Verificar cada viaje (OCR, física, huellas, fechas, estadística) | Cada 5 min | `verificar-viajes.yml` |
| Puntos, racha, misiones (con sus puntos), insignias, clasificaciones, mapa | En cada viaje aprobado | worker |
| Del 4.º al 6.º viaje del día: verificados sin puntos | En cada viaje | worker |
| Grupos de división y tabla «hoy» de la ruta del día | Cada reconstrucción (≤ 15 min) | worker |
| Misiones del día y ruta del día (×2) | Cada día | worker |
| Escudos gastados y rachas perdidas (lo cuenta Hoy la mañana siguiente) | Cada noche | worker |
| Avisos push y correos (con reintentos y cupo diario) | Cuando toca | worker |
| Mensajes del equipo, suspensiones y avisos de contraseña | Cada pasada | worker |
| Juntar las valoraciones de bicis en su ficha pública | Cada pasada | worker |
| Revisar nombres de piloto y de clan nuevos | Al registrarse / a diario | worker |
| Borrado de cuenta (RGPD) y bajas de correo | Cada pasada | worker |
| Divisiones semanales (y la hoja del lunes en Hoy) | Lunes, 01:45 UTC | `periodicas.yml` |
| Cierre de temporada | Día 1, 01:30 UTC | `periodicas.yml` |
| Vigilar la cuota y avisarte | Cada pasada | worker |
| Desplegar reglas de Firestore | Cada push a `main`, tras el emulador | `ci.yml` |
| Publicar la web | Cada push a `main` | Vercel |

## Lo único que queda para ti: 10 minutos a la semana

- **`/admin/`** → Revisión: los récords que baten la marca por mucho, las
  lecturas dudosas, las fechas que no cuadran y las impugnaciones (con lo que
  ha escrito el piloto). Cada caso, segundos con el teclado. Los aprobados a
  mano suman igual que los automáticos.
- **Denuncias**: tiempos y nombres denunciados por la comunidad.
- **Métricas**: el embudo de subida (abrir → con foto → enviada → verificada)
  dice dónde se cae la gente; la retención por cohortes, si vuelven.
- **Errores**: agrupados por a cuánta gente afectan. «Resuelto» los archiva.

## Antitrampas: qué hay y qué no

Cada viaje pasa por comprobaciones deterministas antes de puntuar:

- la captura se relee en el servidor (lo que diga el navegador no cuenta);
- horas de salida y llegada contra la duración (el retoque típico cambia un
  número y deja las horas);
- velocidad imposible para una BiciMAD (25 km/h) sobre la distancia real;
- captura ya usada, byte a byte o recomprimida/recortada (huella perceptual);
- la fecha: un viaje «de hoy» cuya llegada es posterior a la subida, o una
  captura más antigua que el día declarado, va a revisión;
- récord batido por más de un 20 %, mejora brusca personal, tiempo atípico y
  editor de imagen en los metadatos: a revisión humana;
- **el reloj del móvil** en la barra de estado: la captura no puede estar
  hecha antes de acabar el trayecto, ni después de subirla;
- **dos lecturas** de la captura con dos preparaciones distintas de la imagen:
  si no dicen lo mismo en estaciones y duración, a revisión;
- **el formato**: una imagen que no tiene proporción de pantalla de móvil
  (recortada) suma sospecha;
- **la misma bici a la misma hora** en trayectos de dos personas distintas: a
  revisión;
- el cupo: tres trayectos puntúan al día; del cuarto al sexto se verifican sin
  puntos (no sirven para inflar la clasificación ni el BiciRating), y a partir
  del séptimo se rechazan.

Lo que no se puede detectar del todo: que alguien suba la captura real de un
viaje que hizo otra persona. La bici ayuda (si las dos personas lo suben, la
misma bici a la misma hora salta), pero si solo lo sube una, no hay con qué
cruzarlo. Por eso los récords grandes siempre los ves tú.

Tampoco se hace análisis de píxeles tipo ELA (buscar zonas retocadas por su
compresión): las capturas son PNG sin pérdida y el navegador las recodifica
enteras antes de subirlas, así que esa huella no sobrevive. Lo que sí
sobrevive, y se comprueba, es la **coherencia**: horas contra duración, reloj
contra llegada, dos lecturas entre sí y la bici contra las demás personas.
