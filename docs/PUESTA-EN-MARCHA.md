# Puesta en marcha: todo lo que te toca, paso a paso

Todo lo que se podía hacer con código está hecho. Lo que queda son **pasos en
consolas** (GitHub, tu proveedor del dominio, Firebase, Google) que solo puedes
dar tú porque piden tu cuenta. Esta guía los lista **todos**, en orden, con
dónde pulsar exactamente y cómo comprobar que ha ido bien.

**Se hacen una vez.** Después la web funciona sola y tu trabajo se reduce a
unos diez minutos a la semana en `/admin/`.

- Tiempo total: **una tarde** (unas 3–4 horas la primera vez), más las esperas
  de DNS y del certificado HTTPS, que pueden llegar a un día.
- El **orden importa**: cada paso da por hecho el anterior.
- Cada paso termina con un **«Cómo sé que ha ido bien»**. No pases al
  siguiente sin comprobarlo.
- Marca las casillas `[ ]` según avances.

> **Una convención para toda la guía:** donde ponga **`tudominio.es`**, escribe
> tu dominio real (por ejemplo `bicifastness.es`), sin `https://` ni `www.`.
> Donde ponga **`www.tudominio.es`**, lo mismo con `www.` delante.

> **Datos que vas a necesitar a mano**
> - Repositorio: **`mateogsilvaa/bicifastness`** (rama `main`)
> - Repositorio viejo (a archivar): `mateogsilvaa/bicifastness-archive`
> - Proyecto de Firebase: **`bicifastness`**
> - Cuenta de correo del proyecto: **`bicifastness@gmail.com`**
> - Tu dominio: `tudominio.es`
> - Alojamiento: **GitHub Pages**, publicado por `.github/workflows/ci.yml`

---

## Índice

| # | Paso | Dónde | Tiempo | Obligatorio |
|---|---|---|---|---|
| 0 | [Antes de empezar](#0-antes-de-empezar) | Tu ordenador | 15 min | Sí |
| 1 | [Cerrar el repositorio viejo](#1-cerrar-el-repositorio-viejo) | Terminal | 5 min | Sí |
| 2 | [Fusionar el cambio a GitHub Pages](#2-fusionar-el-cambio-a-github-pages) | GitHub | 5 min | Sí |
| 3 | [Ajustes del repositorio](#3-ajustes-del-repositorio) | GitHub | 5 min | Sí |
| 4 | [Tu dominio en GitHub Pages](#4-tu-dominio-en-github-pages) | GitHub, DNS | 30 min + espera | Sí |
| 5 | [Credenciales viejas fuera](#5-credenciales-viejas-fuera) | Google, Telegram | 5 min | Sí (ya hecho) |
| 6 | [Secretos y variables de GitHub](#6-secretos-y-variables-de-github) | Firebase, GitHub | 15 min | Sí |
| 7 | [Reglas desplegadas y datos migrados](#7-reglas-desplegadas-y-datos-migrados) | Terminal | 20 min | Sí |
| 8 | [Entrar: dominios y Google](#8-entrar-dominios-y-google) | Firebase, Google Cloud | 15 min | Sí |
| 9 | [Correo desde bicifastness@gmail.com](#9-correo-desde-bicifastnessgmailcom) | Google, GitHub, Firebase | 30 min | Para correos |
| 10 | [App Check (antiabuso)](#10-app-check-antiabuso) | Google Cloud, Firebase | 15 min + 1 día | Muy recomendado |
| 11 | [Avisos push](#11-avisos-push) | Terminal, GitHub | 10 min | Para notificaciones |
| 12 | [Datos legales del responsable](#12-datos-legales-del-responsable) | Editor | 15 min | Sí, antes de abrir |
| 13 | [Encender los procesos automáticos](#13-encender-los-procesos-automáticos) | GitHub | 10 min | Sí |
| 14 | [Tu cuenta de administrador y un viaje de prueba](#14-tu-cuenta-de-administrador-y-un-viaje-de-prueba) | Web, terminal | 20 min | Sí |
| 15 | [Abrir la web](#15-abrir-la-web) | GitHub | 5 min | Sí |
| 16 | [Plan Blaze con alerta de gasto](#16-plan-blaze-con-alerta-de-gasto) | Firebase, Google Cloud | 5 min | Recomendado |
| 17 | [Estaciones al día](#17-estaciones-al-día) | Terminal | 5 min | Cuando BiciMAD abra estaciones |
| — | [Comprobación final pantalla a pantalla](#comprobación-final-pantalla-a-pantalla) | Móvil y ordenador | 20 min | Sí |
| — | [Chuleta del día a día](#chuleta-del-día-a-día) | — | — | — |
| — | [Si algo falla](#si-algo-falla) | — | — | — |

---

## 0. Antes de empezar

### 0.1 Lo que tienes que tener

- [ ] Una cuenta de **GitHub** con acceso a `mateogsilvaa/bicifastness`.
- [ ] Acceso al **panel de tu dominio** (donde lo compraste: DonDominio,
      Namecheap, GoDaddy, Cloudflare…). Vas a tocar sus registros DNS.
- [ ] La cuenta de Google **`bicifastness@gmail.com`** (para los correos).
- [ ] Tu cuenta de Google con acceso al proyecto de **Firebase** `bicifastness`
      (https://console.firebase.google.com).
- [ ] En tu ordenador: **Git**, **Node 20 o más** (https://nodejs.org) y la
      herramienta de GitHub **`gh`** (https://cli.github.com), con sesión
      iniciada (`gh auth login`).

### 0.2 El código en tu ordenador

Si ya tienes la carpeta del proyecto, apúntala al repositorio nuevo:

```bash
git remote set-url origin https://github.com/mateogsilvaa/bicifastness.git
```

```bash
git fetch origin
```

Si no, clónalo:

```bash
git clone https://github.com/mateogsilvaa/bicifastness.git
```

Y dentro de la carpeta, instala el utillaje una vez:

```bash
npm install
```

### 0.3 Mirarlo en local (opcional, pero merece la pena)

La **maqueta** enseña todas las pantallas con un Firebase de mentira: no toca tu
base de datos ni gasta cuota.

```bash
npm run maqueta
```

Abre `http://localhost:5001/`. Trucos en la consola del navegador (F12):

| Quieres ver… | Escribe | Luego |
|---|---|---|
| La portada sin sesión | `localStorage.maqueta_sesion = 'fuera'` | recarga |
| Un piloto recién llegado | `localStorage.maqueta_perfil = 'nuevo'` | recarga |
| Hoy ya salvado | `localStorage.maqueta_perfil = 'salvado'` | recarga |
| El panel de administración | `localStorage.maqueta_perfil = 'admin'` y ve a `/admin/` | recarga |
| Una bici con valoraciones | ve a `/bici/?n=2471` (o `318` con pocas, `1502` sin ninguna) | — |
| Volver a lo normal | `localStorage.clear()` | recarga |

En `/subir/`, `maquetaBillete({ bici: '2471' })` en la consola enseña el billete
y, al subir, la encuesta de la bici.

**Cómo sé que ha ido bien:** ves «Hola, laura_pedalea» con el anillo de la
racha.

---

## 1. Cerrar el repositorio viejo

El repo viejo tiene la historia completa, con la contraseña de Gmail de la v1
dentro (ya revocada). Se fusiona su último PR para que quede completo y se
archiva (solo lectura).

```bash
gh pr merge 68 --repo mateogsilvaa/bicifastness-archive --merge
```

```bash
gh repo archive mateogsilvaa/bicifastness-archive --yes
```

Y déjalo **privado**: https://github.com/mateogsilvaa/bicifastness-archive →
Settings → General → abajo del todo, Danger Zone → **Change visibility** →
Private.

- [ ] PR #68 fusionado
- [ ] Repo viejo archivado y privado

**Cómo sé que ha ido bien:** la página del repo viejo muestra el aviso amarillo
«This repository has been archived by the owner».

---

## 2. Fusionar el cambio a GitHub Pages

La web se publicaba en Vercel. El cambio a GitHub Pages está en un PR del repo
nuevo, **«Publicar la web en GitHub Pages con dominio propio»**:

1. Abre https://github.com/mateogsilvaa/bicifastness/pulls y entra en ese PR.
2. Espera a que las comprobaciones estén en verde (tests y reglas en el
   emulador; unos 3 minutos).
3. **Merge pull request** → **Confirm merge**.

Qué trae: el trabajo `web` en `ci.yml`, que monta la web con
`scripts/construir-sitio.js` y la publica en Pages **solo si pasan las
pruebas**; las rutas viejas (`/ranking/`, `/mapa/`…) como páginas que saltan a
las nuevas; el modo obras con una variable del repo; y el service worker
ajustado a la caché de Pages.

- [ ] PR fusionado

**Cómo sé que ha ido bien:** Actions → «Tests y despliegue» sobre `main` en
verde. El trabajo `web` puede fallar ahora con «Pages site not found»: es
normal, se arregla en el paso 4.4.

---

## 3. Ajustes del repositorio

En https://github.com/mateogsilvaa/bicifastness → **Settings**:

1. **General** → comprueba que es **Public** (Danger Zone → Change
   visibility). Imprescindible: en un repo público, GitHub Actions y Pages son
   gratis e ilimitados; en uno privado, el worker cada 5 minutos se come los
   2.000 minutos gratis del mes en diez días, y Pages exige plan de pago.
2. **Actions → General** → «Actions permissions»: **Allow all actions and
   reusable workflows**. Guardar.
3. **Branches** (opcional, recomendado) → Add branch ruleset → rama `main` →
   marca «Require status checks to pass» y añade `tests` y `reglas-emulador`.
   Así nada entra en `main` sin pasar las pruebas.

- [ ] Repo público
- [ ] Actions permitidas

---

## 4. Tu dominio en GitHub Pages

### 4.1 El fichero CNAME

El dominio se escribe en un fichero `CNAME` en la raíz del repo. Lo leen
GitHub Pages y **los enlaces de los correos** (por eso no hace falta
escribirlo en ningún otro sitio del código).

1. En el repo → **Add file → Create new file**.
2. Nombre: `CNAME` (en mayúsculas, sin extensión).
3. Contenido: una sola línea con tu dominio, p. ej. `tudominio.es`.
4. **Commit changes** directamente a `main`.

Decide ahora cuál es la dirección **principal**: con o sin `www.`. Esta guía usa
**sin `www.`** (`tudominio.es`) y hace que `www.tudominio.es` redirija a ella.

### 4.2 Los registros DNS

En el panel de tu dominio → zona DNS / registros DNS:

1. **Borra** los registros `A`, `AAAA` o `CNAME` que haya para `@` (la raíz) y
   para `www` (suelen venir unos de «aparcamiento» del registrador). No toques
   los `MX` ni los `TXT` que ya tengas.
2. Añade estos **cuatro `A`** para la raíz (`@` o vacío, según el panel):

   | Tipo | Nombre | Valor |
   |---|---|---|
   | A | @ | `185.199.108.153` |
   | A | @ | `185.199.109.153` |
   | A | @ | `185.199.110.153` |
   | A | @ | `185.199.111.153` |

3. Y estos **cuatro `AAAA`** (IPv6), también para la raíz:

   | Tipo | Nombre | Valor |
   |---|---|---|
   | AAAA | @ | `2606:50c0:8000::153` |
   | AAAA | @ | `2606:50c0:8001::153` |
   | AAAA | @ | `2606:50c0:8002::153` |
   | AAAA | @ | `2606:50c0:8003::153` |

4. Y un **`CNAME`** para `www`:

   | Tipo | Nombre | Valor |
   |---|---|---|
   | CNAME | www | `mateogsilvaa.github.io` |

5. Guarda. Los cambios tardan de minutos a unas horas en propagarse.

> Si tu dominio está en **Cloudflare**: pon esos registros con la nube en
> **gris** («DNS only»), no naranja. Con el proxy naranja GitHub no puede
> emitir el certificado HTTPS.

### 4.3 Verificar el dominio en GitHub (recomendado)

Impide que otra cuenta de GitHub publique una web en tu dominio si algún día
desactivas Pages.

1. Tu **perfil** (no el repo) → Settings → **Pages** → **Add a domain** →
   escribe `tudominio.es` → Add domain.
2. GitHub te da un registro **TXT** con un nombre tipo
   `_github-pages-challenge-mateogsilvaa.tudominio.es` y un valor largo.
   Añádelo en tu DNS tal cual.
3. Espera unos minutos y pulsa **Verify**.

### 4.4 Encender Pages

Repo → Settings → **Pages**:

1. **Build and deployment → Source: GitHub Actions** (no «Deploy from a
   branch»).
2. **Custom domain:** `tudominio.es` → **Save**. GitHub comprueba el DNS: tiene
   que salir «DNS check successful». Si sale en rojo, espera a que propague y
   pulsa otra vez (puede tardar hasta un día).
3. En cuanto se pueda, marca **Enforce HTTPS**. Si está gris con «Unavailable
   for your site because your domain is not properly configured» o
   «certificate is being provisioned», espera: el certificado tarda entre unos
   minutos y 24 horas.

### 4.5 El primer despliegue

Actions → **Tests y despliegue** → **Run workflow** → rama `main` → Run.

Como la variable `WEB_ABIERTA` todavía no existe, se publica **la página de
obras**, en cualquier dirección. Es a propósito: la web no se abre hasta el
paso 15.

### 4.6 Apagar Vercel

Para que no queden dos webs (una vieja y desactualizada):
https://vercel.com → proyecto `bicifastness` → Settings → abajo, **Delete
Project**. Si prefieres conservarlo un tiempo, al menos Settings → Git →
**Disconnect**.

- [ ] `CNAME` con tu dominio en `main`
- [ ] DNS: 4 `A`, 4 `AAAA` y el `CNAME` de `www`
- [ ] Dominio verificado en tu perfil
- [ ] Pages con Source «GitHub Actions», dominio guardado y **Enforce HTTPS**
- [ ] Vercel borrado o desconectado

**Cómo sé que ha ido bien:** `https://tudominio.es` enseña «Estamos ajustando
los radios» con el candado del navegador, y `https://www.tudominio.es` lleva a
la misma página.

---

## 5. Credenciales viejas fuera

Me dijiste que ya las has revocado. Repásalo con esta lista, porque **alguien
puede tener un clon del repo viejo**:

- [ ] Google → Seguridad → Contraseñas de aplicación: la de la v1, **revocada**.
- [ ] Google AI Studio: la API key de Gemini, **borrada** (ya no se usa).
- [ ] Telegram → @BotFather → `/revoke` del token del bot.
- [ ] PocketBase y el túnel de ngrok, apagados.
- [ ] Firebase → Firestore → la colección `secrets`, borrada.

---

## 6. Secretos y variables de GitHub

### 6.1 La cuenta de servicio de Firebase

Es la llave con la que el worker y el CI hablan con Firebase.

1. https://console.firebase.google.com → proyecto `bicifastness` → ⚙ (arriba a
   la izquierda) → **Configuración del proyecto** → pestaña **Cuentas de
   servicio**.
2. **Generar nueva clave privada** → Generar clave. Se descarga un `.json`.
3. Ábrelo con el Bloc de notas y copia **todo** el contenido (de la primera
   `{` a la última `}`).

**No guardes ese fichero dentro de la carpeta del proyecto** ni lo subas a
ningún sitio. Lo vas a necesitar otra vez en el paso 7 y en el 14; después,
bórralo.

### 6.2 Los secretos

Repo → Settings → **Secrets and variables → Actions** → pestaña **Secrets** →
**New repository secret**, uno por fila:

| Secreto | Qué poner | ¿Hace falta? |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | El JSON **entero** del 6.1 | **Sí** |
| `CORREO_ADMIN` | Tu correo personal. Ahí te llegan los avisos de cuota, de abuso y de cola de revisión atascada | **Sí** |
| `GMAIL_USUARIO` | `bicifastness@gmail.com` (paso 9) | Para correos |
| `GMAIL_CLAVE_APLICACION` | La contraseña de aplicación de 16 letras (paso 9.1) | Para correos |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Paso 11 | Para push |
| `CORREO_RESPUESTA` | Opcional: a dónde van las respuestas a «Escribir al piloto». Si falta, a `bicifastness@gmail.com` | No |
| `SITIO_URL` | Opcional: solo si los enlaces de los correos tienen que ir a otra dirección distinta de la del `CNAME` | No |

Los mismos secretos sirven para todos los workflows (`ci.yml`,
`verificar-viajes.yml`, `periodicas.yml`): se ponen una vez.

### 6.3 La variable que abre y cierra la web

Misma pantalla → pestaña **Variables** → **New repository variable**:

- Nombre: `WEB_ABIERTA`
- Valor: `no`

Mientras valga cualquier cosa distinta de `si` (o no exista), la web enseña
**solo la página de obras**. Se cambia a `si` en el paso 15.

- [ ] `FIREBASE_SERVICE_ACCOUNT` y `CORREO_ADMIN`
- [ ] Variable `WEB_ABIERTA` = `no`

**Cómo sé que ha ido bien:** Actions → **Verificar viajes** → Run workflow →
marca **simular** → Run. El log termina sin «Falta FIREBASE_SERVICE_ACCOUNT».

---

## 7. Reglas desplegadas y datos migrados

### 7.1 Reglas

Con el secreto puesto, Actions → **Tests y despliegue** → Run workflow en
`main`. El trabajo `reglas` despliega `firestore.rules` e índices. **Eso es lo
que cierra la fuga de correos** de la v1, no la página de obras: Firestore
responde aunque la web esté cerrada.

**Cómo sé que ha ido bien:** Firebase → Firestore Database → pestaña **Reglas**
muestra la fecha de hoy, y en **Índices** los nuevos (`valoraciones_bici`, entre
otros) pasan de «Compilando» a «Habilitado» en unos minutos.

### 7.2 Migración de los datos de la v1

Desde tu ordenador, en la carpeta del proyecto. Primero, instala las
dependencias del worker:

```bash
cd backend
```

```bash
npm ci
```

```bash
cd ..
```

Apunta a la clave de la cuenta de servicio. En **PowerShell**:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\ruta\a\la\clave.json"
```

En **Git Bash / macOS / Linux**:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/ruta/a/la/clave.json
```

Y luego, en este orden (lee la salida de cada uno antes del siguiente):

```bash
node scripts/migrar-datos.js --copia copia.json
```

```bash
node scripts/migrar-datos.js --simular
```

Si cuadra:

```bash
node scripts/migrar-datos.js --aplicar
```

```bash
node scripts/migrar-datos.js --comprobar
```

Cuando `--comprobar` diga que no queda ningún documento con `email_real` ni
`foto_url`, en `firestore.rules` (bloque `tiempos_viaje`) cambia la línea
`allow read` por la comentada justo debajo, commit y push: eso vuelve a hacer
públicas las clasificaciones de viajes verificados.

Y la de las auditorías:

```bash
node scripts/migrar-auditorias.js --aplicar
```

**Borra `copia.json`** al terminar: lleva dentro correos y capturas. El detalle
y el camino de vuelta, en [MIGRACION.md](MIGRACION.md).

- [ ] Reglas con fecha de hoy
- [ ] Migración aplicada y comprobada
- [ ] `copia.json` borrado

---

## 8. Entrar: dominios y Google

### 8.1 Dominios autorizados (sin esto no entra NADIE, ni con correo)

Firebase → **Authentication** → pestaña **Settings** → **Dominios
autorizados** → **Agregar dominio**, uno a uno:

- `tudominio.es`
- `www.tudominio.es`

Deja `localhost` (viene de serie, para probar en local). Cuando todo funcione
en tu dominio, **borra** `bicifastness-pi.vercel.app` si está.

### 8.2 Activar Google

Firebase → Authentication → **Sign-in method** → **Agregar proveedor nuevo →
Google**:

1. Habilitar.
2. Nombre público del proyecto: `BiciFastness`.
3. Correo de asistencia: `bicifastness@gmail.com`.
4. Guardar.

No hace falta crear credenciales OAuth a mano: Firebase las crea. Comprueba
también que **Correo electrónico/contraseña** está habilitado.

### 8.3 El nombre en la ventana de Google (recomendado ahora que hay dominio)

Por defecto el popup dice «para ir a bicifastness.firebaseapp.com». Para que
diga «BiciFastness»: https://console.cloud.google.com → arriba, proyecto
`bicifastness` → menú → **Google Auth Platform → Branding**:

- Nombre de la app: `BiciFastness`
- Correo de asistencia: `bicifastness@gmail.com`
- Página principal: `https://tudominio.es/`
- Política de privacidad: `https://tudominio.es/legal/privacidad/`
- Términos: `https://tudominio.es/legal/terminos/`
- Dominios autorizados: `tudominio.es`

**No subas logo** de momento: con logo Google exige verificar la app, y eso
tarda días.

**Cómo sé que ha ido bien:** después del paso 15, «Empezar con Google» con
cualquier cuenta funciona. Si ves «El acceso con Google todavía no está
activado», falta el 8.2; si ves «…en esta dirección», falta el 8.1.

- [ ] Dominios autorizados
- [ ] Google y correo/contraseña habilitados
- [ ] Branding con tu dominio

---

## 9. Correo desde bicifastness@gmail.com

Todos los correos salen de la cuenta del proyecto, en HTML (600 px, modo
oscuro y botón que funciona también en Outlook):

| Correo | Cuándo | Quién lo manda |
|---|---|---|
| Bienvenida | Al crear la cuenta | worker |
| Trayecto rechazado | Rechazo automático **o** hecho por ti en `/admin/` (con tu motivo) | worker |
| No hemos podido leer tu captura | Si el análisis falla por nuestra culpa | worker |
| Mensaje del equipo | «Escribir al piloto» en `/admin/` | worker |
| Cuenta suspendida | «Suspender al autor» en `/admin/` | worker |
| Tu contraseña ha cambiado | Al elegir contraseña nueva en `/cuenta/` | worker |
| Restablecer contraseña | «He olvidado mi contraseña» | **Firebase** (plantilla pegada) |
| Confirmar el correo | Al registrarse con correo | **Firebase** |

Los de seguridad y moderación llegan aunque la persona haya apagado los avisos;
el resto respeta la baja. Los enlaces llevan tu dominio (salen del `CNAME`).

**Nunca se usa la contraseña de la cuenta de Google.** Se usa una *contraseña
de aplicación*: solo sirve para enviar, se revoca sola sin tocar nada más y no
da acceso a la bandeja.

### 9.1 La contraseña de aplicación

1. Entra en https://myaccount.google.com con **`bicifastness@gmail.com`**.
2. **Seguridad** → **Verificación en dos pasos**: actívala si no lo está (con
   el móvil). Sin ella, Google no deja crear contraseñas de aplicación.
3. Ve a https://myaccount.google.com/apppasswords (o Seguridad → Verificación
   en dos pasos → abajo, **Contraseñas de aplicación**).
4. Nombre: `bicifastness worker` → **Crear**. Copia las 16 letras (con o sin
   espacios, da igual).
5. Secretos de GitHub (paso 6.2): `GMAIL_USUARIO` = `bicifastness@gmail.com` y
   `GMAIL_CLAVE_APLICACION` = las 16 letras.
6. Crea **otra** contraseña de aplicación con nombre `firebase` para el 9.2
   (así, si un día revocas una, la otra sigue funcionando).

Gmail deja unos 500 destinatarios al día; el worker se para en 400 y reparte por
prioridad (seguridad y moderación primero). Lo que no quepa sale al día
siguiente.

### 9.2 Los correos que manda Firebase

Firebase → **Authentication** → pestaña **Plantillas**.

**a) Que salgan de Gmail.** Arriba, ⚙ **Configuración de SMTP** → Habilitar:

| Campo | Valor |
|---|---|
| Dirección de correo del remitente | `bicifastness@gmail.com` |
| Host del servidor SMTP | `smtp.gmail.com` |
| Puerto del servidor SMTP | `465` |
| Nombre de usuario de la cuenta SMTP | `bicifastness@gmail.com` |
| Contraseña de la cuenta SMTP | la contraseña de aplicación `firebase` del 9.1 |
| Modo de seguridad SMTP | **SSL** |

Guardar.

**b) Que los enlaces abran nuestra página.** En cualquiera de las plantillas →
✏ editar → abajo, **Personalizar URL de acción** →
`https://tudominio.es/cuenta/` → Guardar. Así los enlaces abren `/cuenta/`
(nuestra, en castellano, con el medidor de fuerza) en vez de la de Firebase, y
al cambiar la contraseña se manda el aviso «Tu contraseña ha cambiado».

**c) La plantilla de restablecer.** En tu ordenador, primero trae el `CNAME`
que creaste en el paso 4.1 (los enlaces del correo salen de ahí):

```bash
git pull
```

```bash
npm run correos
```

Deja los correos de ejemplo en `docs/correos/`. Abre
`docs/correos/restablecer.html` con el Bloc de notas y copia **todo**. En
Firebase → Plantillas → **Restablecimiento de contraseña** → ✏:

- Nombre del remitente: `BiciFastness`
- De: `bicifastness@gmail.com`
- Asunto: `Elige una contraseña nueva`
- Mensaje: pega lo copiado (sustituye todo lo que hubiera).
- Guardar.

**d) La de verificación.** Plantillas → **Verificación de dirección de
correo** → ✏: nombre del remitente `BiciFastness`, asunto
`Confirma tu correo`. El texto de esta Firebase no deja cambiarlo; con el
remitente y el enlace a `/cuenta/` basta.

En `docs/correos/` están también los demás correos con datos de ejemplo:
ábrelos en el navegador para verlos sin mandar nada.

- [ ] Verificación en dos pasos y dos contraseñas de aplicación
- [ ] Secretos `GMAIL_USUARIO` y `GMAIL_CLAVE_APLICACION`
- [ ] SMTP de Firebase con Gmail
- [ ] URL de acción `https://tudominio.es/cuenta/`
- [ ] Plantilla de restablecer pegada

**Cómo sé que ha ido bien** (después del paso 15, con la web abierta):
- regístrate con un correo tuyo nuevo: en unos minutos llega la bienvenida
  desde `bicifastness@gmail.com`;
- «He olvidado mi contraseña» → el correo lleva nuestro diseño, el botón abre
  `https://tudominio.es/cuenta/…`, eliges contraseña, entras, y a los pocos
  minutos llega «Tu contraseña ha cambiado»;
- en `/admin/`, «Escribir al piloto» a tu propia cuenta de prueba.

Si no sale nada, el log de «Verificar viajes» dice por qué («Gmail rechaza la
contraseña de aplicación…» = secreto mal copiado).

---

## 10. App Check (antiabuso)

Impide que alguien use la configuración pública de Firebase desde un script
para inundar la base de datos. Las reglas ya acotan forma y tamaño de todo; App
Check acota **quién** escribe.

**EL ORDEN NO ES OPCIONAL.** Si activas el modo obligatorio antes de poner la
clave, la web entera deja de funcionar.

1. https://console.cloud.google.com → proyecto `bicifastness` → busca
   **reCAPTCHA** → **Crear clave** → tipo **puntuación** (web) → dominios:
   `tudominio.es`, `www.tudominio.es` y `localhost` → Crear.
2. Firebase → **App Check** → Apps → tu app web → **Registrar** con
   **reCAPTCHA v3** (o Enterprise, el que hayas creado) y la clave secreta del
   paso 1.
3. Pega la **clave de sitio** (la pública) en `assets/js/firebase.js`, en
   `RECAPTCHA_SITE_KEY`. Commit y push.
4. **Espera un día.** En Firebase → App Check → pestaña APIs → Cloud Firestore
   verás las peticiones «Verificadas».
5. **Solo cuando casi todas lo sean**: App Check → Cloud Firestore →
   **Aplicar**.

El worker no se ve afectado: usa el Admin SDK, que no pasa por App Check.

- [ ] Clave creada con tu dominio
- [ ] App registrada y clave de sitio en el código
- [ ] (Al día siguiente) Aplicar

---

## 11. Avisos push

Cuatro tipos: racha en peligro (20:00), trayecto resuelto, te han quitado un
récord y cambio de división. En iPhone solo funcionan con la web añadida a la
pantalla de inicio (la web lo sugiere tras el primer viaje).

En tu ordenador:

```bash
node scripts/claves-push.js
```

Imprime tres valores: van como secretos `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY` y `VAPID_SUBJECT` (paso 6.2). La **pública** además va en la
web. En Git Bash:

```bash
VAPID_PUBLIC_KEY=la_publica node scripts/build-push.js
```

En PowerShell:

```powershell
$env:VAPID_PUBLIC_KEY="la_publica"; node scripts/build-push.js
```

Commit y push de `assets/data/push-config.js`. **Se generan una sola vez**:
cambiarlas invalida todas las suscripciones.

**Cómo sé que ha ido bien:** al subir un trayecto, en «Subido» aparece «Avísame
cuando esté». Actívalo; cuando se verifique te llega el aviso.

---

## 12. Datos legales del responsable

En los cuatro documentos de `legal/` hay huecos marcados en ámbar: nombre, NIF,
domicilio y correo de contacto. **Rellénalos antes de abrir**: el RGPD (art. 13)
exige identificarte.

- `legal/privacidad/index.html`
- `legal/terminos/index.html`
- `legal/cookies/index.html`
- `legal/aviso-legal/index.html`

Aprovecha para poner tu dominio donde aparezca la dirección de la web. Si
cambias el **fondo** de un documento, sube su versión en la línea
`class="version"` y la misma cifra en `backend/src/config.js`
(`VERSION_TERMINOS`) y en `assets/js/ui.js` (`VERSION_LEGAL`): la web pedirá a
cada usuario que lo acepte de nuevo. Hay una prueba que ata las tres cifras.

- [ ] Los cuatro documentos rellenados, commit y push

---

## 13. Encender los procesos automáticos

**Primero, en seco.** En Actions, lee el log de cada uno:

- **Verificar viajes** (el worker: verifica, reparte puntos, manda correos) →
  Run workflow → marca **simular** → Run.
- **Operaciones periodicas** (divisiones de los lunes y cierre de temporada el
  día 1) → Run workflow → operación `divisiones`, **aplicar sin marcar** → Run;
  y otra vez con `temporada`. **El cierre de temporada no tiene vuelta atrás**:
  por eso se prueba sin «aplicar».

**Después, encenderlos.** En `.github/workflows/verificar-viajes.yml` quita el
`#` de estas dos líneas:

```yaml
  # schedule:
  #   - cron: '*/5 * * * *'
```

y en `.github/workflows/periodicas.yml` el de su bloque `schedule`. Commit y
push (se puede hacer desde la web de GitHub: abre el fichero → ✏ → edita →
Commit changes).

- [ ] Los dos probados en seco
- [ ] Los dos `schedule` sin `#`

**Cómo sé que ha ido bien:** a los 5–10 minutos, «Verificar viajes» aparece solo
en Actions, en verde, y se repite cada 5 minutos.

---

## 14. Tu cuenta de administrador y un viaje de prueba

La web está aún en obras, así que esto se hace **en local contra el Firebase de
verdad**:

```bash
npm run dev
```

1. Abre `http://localhost:5000/register/` y **crea tu cuenta** (la personal,
   no la del proyecto).
2. Dale el rol de administración, con la clave del paso 6.1 (ver 7.2 para
   apuntar `GOOGLE_APPLICATION_CREDENTIALS`):

   ```bash
   node scripts/set-admin.js tu@correo.com
   ```

3. **Cierra sesión y vuelve a entrar** para que tu sesión recoja el rol. Ya
   puedes abrir `http://localhost:5000/admin/`.
4. Con **otra** cuenta (normal), sube una captura real de BiciMAD y espera al
   worker (5–15 minutos). Debe acabar en «Verificado · +N pts» o en tu cola de
   `/admin/`.
5. Ya puedes **borrar el `.json`** de la cuenta de servicio de tu ordenador.

- [ ] Tu cuenta es administradora
- [ ] Un viaje de prueba verificado de principio a fin

---

## 15. Abrir la web

1. Repo → Settings → Secrets and variables → Actions → **Variables** →
   `WEB_ABIERTA` → ✏ → valor **`si`** → Update.
2. Actions → **Tests y despliegue** → **Run workflow** → rama `main` → Run.
3. Espera a que termine (unos 4 minutos).

**Para volver a cerrar** en cualquier momento: `WEB_ABIERTA` = `no` y Run
workflow. Cinco minutos, sin tocar código.

**Cómo sé que ha ido bien:** `https://tudominio.es/`, `/subir/`,
`/clasificacion/` y `/bici/` responden, y `https://tudominio.es/ranking` salta a
la clasificación.

---

## 16. Plan Blaze con alerta de gasto

El plan gratuito (Spark) da **50.000 lecturas y 20.000 escrituras al día**. Si
se agotan, Firestore deja de responder hasta las 9:00 de Madrid.

| Usuarios activos al día | Lecturas/día | De la cuota gratis |
|---|---|---|
| 6 | ~8.000 | 16 % |
| 50 | ~23.500 | 47 % |
| 200 | ~104.000 | 207 % |

El worker se protege solo: al 70 % rehace las clasificaciones cada hora en vez
de cada cuarto de hora, al 95 % solo verifica viajes, y te manda un correo al
cruzar cada umbral. Las bicis en vivo del mapa no gastan cuota (van directas a
CityBikes).

**Para olvidarte:** Firebase → Uso y facturación → plan **Blaze**. La cuota
gratuita sigue igual; solo pagas lo que pase de ella (céntimos al día con 200
personas). Ponle una **alerta de presupuesto** de 5 €/mes: Google Cloud →
Facturación → **Presupuestos y alertas**. Blaze no tiene tope duro: la alerta
avisa, no corta.

---

## 17. Estaciones al día

La web trae **685 estaciones** (las 631 oficiales + las nuevas de la lista en
vivo). Cuando BiciMAD abra más:

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

Commit y push de `data/emt.geojson`, `assets/data/estaciones.js` y
`backend/lib/estaciones.json`. Si tienes un fichero oficial más nuevo de
datos.madrid.es, pásalo con `--oficial fichero.json`: manda en todo lo que
trae. **Nunca se borra una estación.**

---

## Comprobación final pantalla a pantalla

Con la web abierta, en el móvil **y** en un ordenador (por encima de 900 px sale
la barra lateral). Marca cada línea.

**01 Acceso**
- [ ] Portada sin sesión: mapa de fondo, «Madrid es el circuito.», la ruta del
      día y «Empezar con Google».
- [ ] `/entrar/` y `/register/`; en ordenador, panel azul a la izquierda.
- [ ] Alta con Google: pide solo el nombre de piloto y las tres casillas.
- [ ] «He olvidado mi contraseña» → correo con nuestro diseño → `/cuenta/`.

**02 Hoy**
- [ ] Anillo de la semana, misiones con sus puntos, ruta del día, tu grupo.
- [ ] Tras un viaje verificado: «Hoy ya está salvado».

**03 Subir**
- [ ] El «+» abre el selector; pegar (Ctrl+V) o arrastrar una captura la lee.
- [ ] Billete con estaciones, tiempo, km y km/h; tocar cada dato lo corrige.
- [ ] En «Subido», «¿Qué tal la bici?» con el número leído de la captura (o un
      campo para escribirlo); un toque en la nota guarda.

**04 Ranking** — tu grupo, Madrid por modos, rutas con buscador, clanes.

**05 Mapa** — estaciones por clan; al tocar una, «N bicis · M huecos» en vivo;
«Buscar bici» junto al filtro.

**06 Tú** — rating, historial con estados, ajustes, mis datos.

**07 Sistema** — sin red enseña tu resumen guardado; una URL que no existe, el
404; «Cómo funciona»; legales.

**09 Admin** — cola a la izquierda y caso a la derecha; A aprueba, R rechaza,
1–9 motivo, J/K moverse; «Escribir al piloto» en cada caso y denuncia.

**10 Correos** — bienvenida, restablecer, cambio de contraseña, mensaje del
equipo (paso 9).

**11 Bicis** — `/bici/?n=` con un número que hayas valorado: nota media (con 3
o más valoraciones en 60 días), fallos y opiniones sin autor.

---

## Chuleta del día a día

| Quiero… | Hago… |
|---|---|
| Cerrar la web por obras | Variable `WEB_ABIERTA` = `no` → Actions → Tests y despliegue → Run workflow |
| Abrirla | `WEB_ABIERTA` = `si` → Run workflow |
| Publicar un cambio | Push (o merge de un PR) a `main`: se publica solo si pasan las pruebas |
| Ver si el worker va bien | Actions → Verificar viajes → la última ejecución |
| Escribir a un piloto | `/admin/` → su caso o su denuncia → «Escribir al piloto» |
| Suspender a alguien | `/admin/` → Denuncias → «Suspender al autor» (le llega un correo) |
| Añadir estaciones nuevas | Paso 17 |
| Cambiar la CSP | Edita `shared/cabeceras.json` → `npm run cabeceras` → push |
| Ver los correos sin mandarlos | `npm run correos` → abre `docs/correos/*.html` |

---

## Si algo falla

| Síntoma | Causa probable | Arreglo |
|---|---|---|
| `tudominio.es` da «404 There isn't a GitHub Pages site here» | Pages sin Source «GitHub Actions» o aún sin desplegar | Paso 4.4 y 4.5 |
| «DNS check unsuccessful» en Settings → Pages | DNS sin propagar o registros viejos | Paso 4.2: borra los de aparcamiento; espera y reintenta |
| «Enforce HTTPS» no se puede marcar | El certificado aún se está emitiendo | Espera hasta 24 h; en Cloudflare, nube gris |
| La web enseña «Estamos ajustando los radios» | `WEB_ABIERTA` no es `si` | Paso 15 |
| El trabajo `web` no aparece o se salta | Solo corre en `main`, no en PRs | Normal: se publica al fusionar |
| Nadie puede entrar | Falta el dominio autorizado | Paso 8.1 |
| «El acceso con Google todavía no está activado» | Proveedor sin activar | Paso 8.2 |
| Clasificaciones vacías con «revisa las reglas» | Reglas antiguas | Paso 7.1 |
| Los viajes se quedan «En cola» | El worker no corre | Paso 13 y el log en Actions |
| No llegan los correos del worker | Faltan o están mal `GMAIL_USUARIO` / `GMAIL_CLAVE_APLICACION` | Paso 9.1 |
| El de restablecer llega en inglés o sin diseño | Falta la plantilla o el SMTP en Firebase | Paso 9.2 |
| El enlace del correo abre una página de Firebase | Falta la URL de acción | Paso 9.2 b |
| Los enlaces de los correos van a otra dirección | `CNAME` sin tu dominio (o un `SITIO_URL` viejo) | Paso 4.1 |
| «Avísame cuando esté» no sale | Falta la clave VAPID pública en la web | Paso 11 |
| La web deja de responder tras App Check | Se aplicó antes de tiempo | App Check → Firestore → quitar «Aplicar»; repite el paso 10 en orden |
| Una estación nueva «no existe» | BiciMAD la ha abierto después | Paso 17 |
| Tras publicar, alguien ve la versión anterior | Caché de 10 min de Pages | Recargar; el service worker ya pide siempre lo último |

---

## Qué hace la web sola, sin ti

| Qué | Cuándo | Dónde |
|---|---|---|
| Publicar la web (si pasan las pruebas) | Cada push a `main` | `ci.yml` → `web` |
| Desplegar reglas e índices de Firestore | Cada push a `main` | `ci.yml` → `reglas` |
| Verificar cada viaje | Cada 5 min | `verificar-viajes.yml` |
| Puntos, racha, misiones, insignias, clasificaciones, mapa | En cada viaje aprobado | worker |
| Correos (con reintentos y cupo diario) y avisos push | Cuando toca | worker |
| Mensajes del equipo, suspensiones y avisos de contraseña | Cada pasada | worker |
| Juntar las valoraciones de bicis en su ficha pública | Cada pasada | worker |
| Revisar nombres de piloto y de clan | Al registrarse / a diario | worker |
| Borrado de cuenta (RGPD) y bajas de correo | Cada pasada | worker |
| Divisiones semanales | Lunes, 01:45 UTC | `periodicas.yml` |
| Cierre de temporada | Día 1, 01:30 UTC | `periodicas.yml` |
| Vigilar la cuota y avisarte | Cada pasada | worker |

## Lo único que queda para ti: 10 minutos a la semana

- **`/admin/`** → Revisión: los récords grandes, las lecturas dudosas, las
  fechas que no cuadran, las dos lecturas que no coinciden, la misma bici con
  dos personas y las impugnaciones. Cada caso, segundos con el teclado.
- **Denuncias**: tiempos y nombres denunciados por la comunidad.
- **Métricas**: dónde se cae la gente al subir y si vuelve.
- **Errores**: agrupados por a cuánta gente afectan.

## Antitrampas: qué hay y qué no

Cada viaje pasa por comprobaciones deterministas antes de puntuar:

- la captura se relee en el servidor (lo que diga el navegador no cuenta);
- horas de salida y llegada contra la duración;
- velocidad imposible para una BiciMAD sobre la distancia real;
- captura ya usada, byte a byte o recomprimida/recortada;
- la fecha: llegada posterior a la subida, o captura anterior al día declarado;
- **el reloj del móvil** en la barra de estado: la captura no puede estar hecha
  antes de acabar el trayecto, ni después de subirla;
- **dos lecturas** de la captura con dos preparaciones de imagen distintas: si
  no dicen lo mismo en estaciones y duración, a revisión;
- **el formato**: una imagen sin proporción de pantalla de móvil suma sospecha;
- **la misma bici a la misma hora** en trayectos de dos personas: a revisión;
- récord batido por mucho, mejora brusca, tiempo atípico, editor de imagen: a
  revisión humana;
- el cupo: tres trayectos puntúan al día; del cuarto al sexto se verifican sin
  puntos, y a partir del séptimo se rechazan.

Lo que no se puede detectar del todo: que alguien suba la captura real de un
viaje que hizo otra persona. La bici ayuda (si las dos lo suben, salta), pero
si solo lo sube una, no hay con qué cruzarlo. Por eso los récords grandes
siempre los ves tú.

## Seguridad con GitHub Pages: qué cambia

Pages no deja poner cabeceras HTTP. La política de seguridad (CSP) va dentro de
cada página y cubre lo importante: qué código se ejecuta y a dónde se conecta.
Lo que se pierde, y cómo se suple, está en `shared/cabeceras.json` →
`_sin_cabeceras`: el antiframing va por JavaScript, y HTTPS lo fuerza Pages con
«Enforce HTTPS». Si algún día quieres las cabeceras de vuelta, basta con poner
**Cloudflare** (gratis) delante de tu dominio y añadirlas en una regla; los
valores están en ese mismo fichero.
