# BiciFastness

Plataforma web para competir con tiempos de trayectos de bicicleta publica en Madrid:
subida de tiempos con verificacion automatica, rankings por ruta, rating global de
pilotos y clanes, y mapa de dominio territorial por estacion.

> **Proyecto independiente.** Sin relacion, patrocinio ni respaldo de BiciMAD, de la
> EMT de Madrid ni del Ayuntamiento de Madrid.

---

## LEE ESTO PRIMERO: credenciales comprometidas

Esta version corrige un compromiso de seguridad. **Las siguientes credenciales
estuvieron expuestas y hay que rotarlas TODAS antes de desplegar**, aunque el codigo
ya no las use:

| Credencial | Donde estaba | Quien podia verla | Accion |
|---|---|---|---|
| Contrasena de aplicacion de Gmail | `functions/index.js`, en claro y commiteada | Cualquiera con acceso al repositorio, y sigue en el historial de git | Revocar en la cuenta de Google y generar otra |
| API key de Gemini | Coleccion `secrets` de Firestore | **Cualquier usuario registrado**: `subir/index.html` la leia en el navegador de cada usuario | Borrar la clave en Google AI Studio. El proyecto ya no usa Gemini. |
| Token del bot de Telegram | Coleccion `secrets` de Firestore | **Cualquier usuario registrado** | `/revoke` en @BotFather y generar otro |
| Contrasenas de la instancia de PocketBase | Enviadas al tunel de ngrok desde el login | Quien controlase ese tunel | Apagar la instancia; forzar cambio de contrasena |

Rotarlas no es opcional: han sido legibles para cualquiera que se registrase.

**Recomendado ademas:** avisar a las personas usuarias de que restablezcan su
contrasena, porque el login antiguo enviaba la contrasena en claro a un servidor de
terceros accesible por un tunel de ngrok gratuito.

---

## Arquitectura

```
Navegador ──lectura──▶ Firestore
    │                     ▲
    └──escritura──────────┘   (SOLO propuestas: viaje "pendiente", nunca "verificado")
                          │
   GitHub Actions ────────┘   worker cada 5 min: analiza, decide y recalcula
   (Node + sharp + OCR)        — es el unico con credenciales de administrador
```

**Regla invariable: el navegador puede PROPONER, nunca DECIDIR.** Puede crear un
viaje en estado `pendiente`, pero las reglas de Firestore le impiden marcarlo como
verificado, darse puntos o concederse el rol de administrador. Quien decide es el
worker, que corre en GitHub Actions con credenciales de servicio.

**Por que asi:** desplegar Cloud Functions y usar Cloud Storage exigen el plan
Blaze (tarjeta). GitHub Actions es gratis e ilimitado en repositorios publicos, asi
que el "servidor de confianza" vive ahi. Lo unico que se pierde es la inmediatez:
un viaje tarda unos minutos en resolverse en vez de segundos.

### Stack

- Frontend: HTML + CSS + JavaScript con modulos ES. Sin framework ni build. Mobile-first.
- Alojamiento: Vercel, conectado a la rama `main`. El sitio es estatico y habla con Firestore desde el navegador.
- Datos: Firebase Auth + Firestore, en el plan Spark (gratis, sin tarjeta).
- Worker: Node 20 en GitHub Actions, con `sharp` y OCR local (`tesseract.js`). **Sin IA ni servicios externos.**
- Mapa: Leaflet + GeoJSON de estaciones.

### Lo que cuesta el plan gratuito

| Limite de Spark | Consecuencia |
|---|---|
| Sin Cloud Functions | El worker vive en GitHub Actions y la verificacion tarda minutos, no segundos. |
| Sin Cloud Storage | Las capturas van en Firestore, en una coleccion que solo lee la administracion. Por eso tambien se ha quitado la subida de avatar: el ranking trae todos los perfiles y arrastrar imagenes lo encarecia. |
| 50.000 lecturas/dia | El recalculo de clasificaciones lo hace el worker por lotes, no el navegador. |

---

## Puesta en marcha

### 1. Requisitos

```bash
npm install -g firebase-tools
```

```bash
firebase login
```

### 2. Dependencias y datos generados

```bash
node scripts/build-estaciones.js && cd backend && npm install
```

`build-estaciones.js` genera, a partir de `data/emt.geojson` y
`shared/palabras-prohibidas.json`, las copias que usan el frontend
(`assets/data/`) y el worker (`backend/lib/`). Vuelve a lanzarlo si tocas
cualquiera de esos dos ficheros fuente.

### 3. Secretos en GitHub

En el repositorio: **Settings → Secrets and variables → Actions → New repository secret**

| Secreto | De donde sale |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Firebase → Configuracion del proyecto → **SDK de Firebase Admin** → *Generar nueva clave privada*. Pega el JSON entero. |

Es el **unico** secreto que hace falta. No lo confundas con **Secretos de la base
de datos**, que esta en esa misma pantalla: son los tokens heredados de Realtime
Database, estan obsoletos y no sirven para esto.

Nunca en el codigo ni en Firestore: ahi es donde estaban cuando robaron las claves.

### 4. App Check

1. Consola de Firebase: **Compilacion → App Check → reCAPTCHA v3**.
2. Copia la clave de sitio en `RECAPTCHA_SITE_KEY`, dentro de `assets/js/firebase.js`.

Aqui importa mas que en un montaje con servidor: como el cliente escribe
directamente en Firestore, App Check es lo que impide usar la apiKey desde un
script suelto en vez de desde la web.

### 5. Desplegar

Dos caminos, cada uno con lo suyo, y los dos solos en cada push a `main`:

| Quien | Que despliega |
|---|---|
| Vercel | El sitio, por su integracion con Git. Lo gobierna `vercel.json` |
| `ci.yml` | Las reglas y los indices de Firestore |

Las reglas van aparte a proposito: **no son estaticas**. Son el control de acceso
del proyecto, porque no hay servidor delante, y Vercel no las toca.

A mano, solo las reglas:

```bash
firebase deploy --only firestore:rules,firestore:indexes --project bicifastness
```

### 5.1. Por que Vercel y no GitHub Pages

Por una sola razon, pero decisiva: **Pages no permite configurar cabeceras
HTTP**. Serviria el sitio igual de bien, pero se perderian seis cabeceras de
seguridad que no tienen equivalente en `<meta>`:

`frame-ancestors` · `Strict-Transport-Security` · `X-Frame-Options` ·
`X-Content-Type-Options` · `Permissions-Policy` · `Cross-Origin-Opener-Policy`

Vercel las da gratis, sin tarjeta y sin dominio propio.

Las cabeceras salen de **`shared/cabeceras.json`**, que es la fuente unica. El
script las vuelca en dos sitios:

```bash
npm run cabeceras
```

1. `vercel.json`, como cabeceras HTTP de verdad
2. cada pagina, la CSP tambien como `<meta>`, por si el HTML se sirve desde otro
   sitio (en local, un mirror, un despliegue de prueba) donde no habria cabecera

`npm run validar` falla si alguno de los dos se queda atras. **No edites el
bloque `headers` de `vercel.json` a mano.**

**Consecuencia practica:** la CSP declara `script-src 'self'` sin
`'unsafe-inline'`, asi que **el JavaScript de las paginas no puede ir incrustado
en el HTML**. Vive en `assets/js/paginas/`, un modulo por pagina. Hay un test
que falla si alguien lo vuelve a meter en linea.

> Esto no era una precaucion teorica: la CSP ya declaraba `script-src 'self'`
> mientras las 17 paginas llevaban su codigo incrustado, o sea que **la politica
> bloqueaba todo el JavaScript del sitio**. No se noto porque la unica pagina
> publicada, la de obras, es la unica sin scripts.

### 6. Crear el primer administrador

El rol es un custom claim de Firebase Auth y solo lo puede escribir el Admin SDK,
que nunca debe llegar al navegador. Se concede desde tu ordenador:

```bash
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json node scripts/set-admin.js tu@correo.com
```

Esa persona debe cerrar sesion y volver a entrar para que su token recoja el rol.

### 7. Migrar los datos antiguos

```bash
GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json node scripts/migrar-datos.js --simular
```

Revisa la salida y, si cuadra, repite con `--aplicar`.

---

## Modo mantenimiento

Para dejar el sitio en obras (util mientras se rota lo comprometido, o ante
cualquier incidente):

Anade el bloque `redirects` a `vercel.json` y haz push. Para volver a abrir la
web, **borra ese bloque entero**. No hace falta tocar nada mas.

Lo hace el bloque `redirects` de `vercel.json`, que manda todo a la pagina de
obras. En Vercel los redirects se evaluan **antes** del sistema de ficheros, asi
que tapan tambien las paginas que existen: sin eso, entrar a `/admin/`
escribiendo la URL seguiria funcionando.

La pagina de obras es autocontenida a proposito: sin scripts, sin depender de
`app.css` ni de ningun modulo. Si algo del sitio se rompe, tiene que seguir en pie.

---

## Rutas

| Ruta | Que es |
|---|---|
| `/` | Landing publica: que es esto, como funciona y por que no se puede hacer trampa |
| `/entrar/` | Iniciar sesion |
| `/register/` | Crear cuenta |
| `/home/` | Panel del piloto (accesible tambien sin cuenta) |
| `/ranking/`, `/bicirating/`, `/mapa/`, `/clanes/` | Competicion |
| `/subir/`, `/profile/` | Requieren sesion |
| `/admin/` | Requiere el custom claim de administrador |
| `/legal/*` | Aviso legal, privacidad, terminos y cookies |
| `/mantenimiento/` | Pagina de obras |

---

## Desarrollo local

```bash
firebase emulators:start --only auth,firestore,hosting
```

Comprobacion completa (datos generados, analisis estatico, enlaces y 55 tests):

```bash
npm test
```

Por partes:

```bash
npm run lint
```

```bash
npm run validar
```

`npm run lint` extrae el JavaScript incrustado en las paginas y lo pasa por
ESLint: ese codigo vive dentro del HTML, asi que sin esto no lo miraba nada.
`npm run validar` comprueba imports y recursos rotos, que es el fallo mas facil
de colar al mover ficheros (el HTML sigue siendo valido y los tests pasan).

`test/regresiones.test.js` verifica sobre las REGLAS de Firestore que ninguna de
las puertas del hackeo siga abierta: que nadie pueda autoverificarse un viaje,
concederse el rol de admin, tocar su propia puntuacion ni leer las capturas de
otros. Como las reglas son aqui el control de acceso, probarlas es probar la
seguridad.

### Al cambiar los textos legales

Sube **a la vez** `LEGAL.VERSION_TERMINOS` en `backend/src/config.js` y
`VERSION_LEGAL` en `assets/js/ui.js`. Hay un test que falla si divergen.

---

## Verificacion automatica de viajes

Sustituye a la aprobacion manual de cada tiempo. Cada captura pasa por este pipeline
en el worker (`backend/src/verificacion.js`):

| Comprobacion | Que detecta |
|---|---|
| Plausibilidad fisica | Distancia real entre estaciones frente al tiempo declarado. Por encima de 25 km/h de media (el corte de asistencia de una bicicleta electrica) el trayecto es imposible. |
| Coherencia interna de la captura | `hora_llegada − hora_salida` debe coincidir con la duracion mostrada. Delata retocar solo el numero grande. |
| Coincidencia con lo declarado | Estaciones y tiempo leidos en la imagen frente a lo escrito en el formulario. |
| Metadatos EXIF | Rastros de Photoshop, Snapseed, Picsart y similares. Una captura autentica no pasa por un editor. |
| Huella exacta (SHA-256) | Reenvio literal del mismo fichero. |
| Huella perceptual (dHash) | La misma imagen recomprimida, recortada o reescalada. Sobrevive a los intentos de "disimularla". |
| Duplicado logico | Mismo piloto, ruta, tiempo y fecha. |
| Contexto competitivo | Records batidos por mucho margen y saltos bruscos sobre la marca propia. |

Las señales suman riesgo. Menos de 20 → aprobado solo. 70 o mas → rechazado solo. En
medio → cola de revision manual. Algunas señales son concluyentes por si mismas y
deciden sin pasar por la suma.

### Por que no hay IA

La verificacion no depende de ningun modelo externo. Eso quita una clave que
rotar, una cuota que agotar, un servicio que puede caerse y una llamada de red
de hasta 45 s por viaje.

Lo que se pierde con ello, dicho claro: **la deteccion de retoque visual**
(tipografia que no encaja, restos de clonado) no tiene sustituto directo sin IA.

Lo que la cubre, y son comprobaciones deterministas, o sea que no opinan ni
fallan distinto cada vez:

- **Coherencia interna.** `llegada - salida` tiene que dar la duracion del
  recuadro. Quien retoca una captura cambia el numero grande y se deja las
  horas: esa resta lo delata, y es mas fiable que un juicio visual.
- **Plausibilidad fisica.** La geografia no negocia.
- **Huellas exacta y perceptual.** Reenvios, recortes y recompresiones.
- **EXIF.** Rastros de Photoshop, Snapseed y compania.

Y la regla que lo sostiene: **lo que no se lee con claridad no se aprueba solo**,
va a la cola de revision humana.

**Ajustar la sensibilidad:** todos los umbrales estan en `backend/src/config.js`.
Si entra demasiado a la cola manual, sube `RIESGO.UMBRAL_APROBACION`; si se cuela
algo, bajalo.

---

## Que cambio en esta version

### Vulnerabilidades corregidas

| # | Problema | Como se explotaba | Solucion |
|---|---|---|---|
| 1 | Escalada a administrador | `usuarios` admitia escritura de cualquier autenticado y el id del documento era el email: `setDoc(doc(db,'usuarios','tu@email'),{isAdmin:true},{merge:true})` | El rol es un custom claim firmado dentro del token de Auth, que solo escribe el Admin SDK. Las reglas prohiben cualquier campo de rol en el alta. |
| 2 | API keys publicas | `secrets` era legible por cualquier autenticado, y `subir/` la leia en el navegador de cada usuario | GitHub Secrets, que solo ve el worker. La coleccion `secrets` queda cerrada y se borra. |
| 3 | Auto-verificacion de tiempos | `tiempos_viaje` admitia escritura: `verificado:true`, `tiempoSegundos:1`, o borrar records ajenos | Las reglas obligan a que un viaje nazca `pendiente` y `verificado: false`, y no dejan al dueno tocar esos campos. Quien decide es el worker. |
| 4 | XSS almacenado en el panel de admin | `email_real` y `foto_url` interpolados con `innerHTML` y dentro de atributos `onclick`. Se ejecutaba JS en la sesion del admin y se robaba la key de Gemini | Construccion del DOM con `textContent` y `addEventListener`. Cero concatenacion de HTML. |
| 5 | Toma de control de cuenta en el login | Si el usuario no existia en PocketBase, se le CREABA con la contrasena introducida | PocketBase eliminado. Firebase Auth como unica identidad. |
| 6 | Credenciales en el repositorio | Contrasena de Gmail en claro en `functions/index.js` | GitHub Secrets. |
| 7 | Limites solo en el cliente | "3 viajes al dia" se comprobaba en JS: se saltaba desde la consola | El cupo diario lo cuenta el worker sobre Firestore, no el navegador. |
| 8 | Inyeccion en filtros de PocketBase | `filter: email_real = "${email}"` sin escapar | No aplica: PocketBase eliminado. |
| 9 | Escrituras libres en clanes y mapa | `clanes` y `estaciones_stats` admitian escritura de cualquier autenticado | Reglas que comprueban liderazgo y pertenencia, y que no dejan tocar puntuacion ni insignias. |
| 10 | Sin CSP ni cabeceras de seguridad | — | CSP, HSTS, `X-Frame-Options`, `Permissions-Policy` y demas en `firebase.json`. |
| 11 | Service worker cacheando datos | Cache-first sobre TODAS las peticiones, incluidas las autenticadas | Solo se cachean estaticos del propio origen. |
| 12 | Filtro de palabras roto | Se normalizaba la entrada pero no la lista: **169 de 555 entradas (30%) no coincidian nunca** | Normalizacion en ambos lados, mas excepciones para no bloquear "Cassandra" o "Titan". |

### Otras mejoras

- **Documentos legales completos**: aviso legal, privacidad (RGPD/LOPDGDD), terminos
  y cookies, con registro de consentimiento versionado y export/borrado de datos
  desde el propio perfil.
- **Sin PocketBase**: se elimina la escritura duplicada a dos bases de datos y el
  tunel de ngrok.
- **Fuente unica de datos**: la lista de estaciones estaba pegada como un string de
  ~15 KB en tres paginas y sin coordenadas. Ahora se genera desde el GeoJSON, con
  lat/lon, y la comparten frontend y backend.
- **CSS y navegacion compartidos**: eran ~40 lineas duplicadas en cada una de las 11 paginas.
- **Accesibilidad**: contraste corregido a AA en modo claro, foco visible, enlaces de
  salto al contenido, objetivos tactiles de 44 px, `aria-live` en los mensajes de
  estado y respeto a `prefers-reduced-motion`.
- **Errores en castellano** en lugar de codigos de Firebase.

---

## Estructura

```
assets/
  css/app.css, legal.css    estilos comunes, mobile-first
  js/firebase.js            arranque unico de Firebase
  js/acciones.js            todas las escrituras, una por regla de Firestore
  js/dom.js                 construccion segura de interfaz (sin innerHTML)
  js/ui.js                  tema, navegacion, estaciones, aviso de cookies
  js/precheck.js            avisos sobre la captura antes de subirla, y compresion
  js/estado-viaje.js        el viaje recien subido, en vivo (un solo documento)
  js/motivos.js             del veredicto del worker al castellano
  data/                     GENERADO: estaciones y palabras prohibidas
backend/
  worker.js                 el que decide: corre en GitHub Actions
  src/config.js             todos los umbrales de negocio y antifraude
  src/verificacion.js       motor de decision
  src/imagen.js             huellas y limpieza de EXIF
  src/ocr.js                lectura de la captura, sin IA
  src/normalizar.js         deja toda captura en la misma forma antes de leerla
  test/banco/               GENERADO: capturas sinteticas y su verdad (#16)
  src/puntuacion.js         BiciRating y dominio de estaciones
  test/                     pruebas de regresion y del motor de decision
.github/workflows/
  verificar-viajes.yml      worker cada 5 minutos (cron apagado hasta el lanzamiento)
  periodicas.yml            cierre de temporada y divisiones (cron apagado)
  ci.yml                    tests y despliegue de reglas de Firestore
vercel.json                 despliegue del sitio y cabeceras de seguridad
docs/
  ROADMAP.md                hitos, issues y en que orden
  JUEGO.md                  las reglas del juego y por que son esas
firestore.rules             EL control de acceso: no hay servidor delante
legal/                      aviso-legal, privacidad, terminos, cookies
shared/cabeceras.json       fuente unica de las cabeceras de seguridad
scripts/                    build-estaciones, build-capturas, aplicar-cabeceras, build-distancias, set-admin
```

En `assets/js/paginas/` hay un modulo por pagina. No estan incrustados en el HTML
porque la CSP los bloquearia: ver el apartado 5.1.

---

## Modelo de datos

| Coleccion | Clave | Lectura publica | Escritura del cliente |
|---|---|---|---|
| `usuarios` | uid | si | no |
| `tiempos_viaje` | auto | solo los verificados | no |
| `clanes` | slug del nombre | si | no |
| `estaciones_stats` | numero de estacion | si | no |
| `config/general` | fijo | si | no |
| `reportes` | auto | solo admin | no |
| `huellas_captura` | sha256 | no | no |
| `auditoria_admin` | auto | solo admin | no |
| `rate_limits` | uid_accion | no | no |
| `nombres_usuario` | nombre en minusculas | no | no |

---

## Que viene ahora

El plan completo esta en [`docs/ROADMAP.md`](docs/ROADMAP.md), repartido en
hitos e issues. Las reglas del juego que se esta construyendo, en
[`docs/JUEGO.md`](docs/JUEGO.md).

### Tareas pendientes antes de publicar

**El orden importa.** El historial de git todavia contiene la contrasena de
Gmail en claro, y el worker solo es gratis e ilimitado si el repositorio es
publico: hacerlo publico antes de purgar el historial es publicar esa
contrasena.

1. - [ ] Rotar **todas** las credenciales de la tabla del principio (issue #1)
2. - [ ] Purgar el historial de git (`git filter-repo`) o dar el repositorio por comprometido
3. - [ ] Borrar la coleccion `secrets` de Firestore
4. - [ ] Apagar la instancia de PocketBase y el tunel de ngrok
5. - [ ] **Solo entonces**: hacer publico el repositorio
6. - [ ] Crear el secreto de GitHub `FIREBASE_SERVICE_ACCOUNT`
7. - [ ] Comprobar que el proyecto de Vercel apunta a `main` (issue #2)
8. - [ ] Autorizar el dominio de Vercel en Firebase Auth y en reCAPTCHA (issue #4)
9. - [ ] Poner `RECAPTCHA_SITE_KEY` en `assets/js/firebase.js`
10. - [ ] Rellenar los datos del responsable en los cuatro documentos legales (issue #55)
11. - [ ] Crear el primer administrador con `scripts/set-admin.js`
12. - [ ] Ejecutar la migracion de datos, primero con `--simular` (issue #54)
13. - [ ] **Reactivar los cron**, que estan comentados a proposito: `verificar-viajes.yml` y `periodicas.yml`
14. - [ ] Ensayar `periodicas.yml` a mano con `simular: true` ANTES de la primera vez de verdad
15. - [ ] Borrar el bloque `redirects` de `vercel.json` (issue #7)

El cron del worker esta apagado a proposito: sin credenciales no puede hacer
nada, y cada despertar mandaba un correo de fallo y gastaba un minuto de Actions
(se factura por minuto empezado, asi que eran ~288 minutos al dia contra el
limite de 2.000 al mes).
