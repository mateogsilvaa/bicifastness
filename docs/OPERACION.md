# Operacion de BiciFastness

Plataforma web para competir con tiempos de trayectos de bicicleta publica en Madrid:
subida de tiempos con verificacion automatica, rankings por ruta, rating global de
pilotos y clanes, y mapa de dominio territorial por estacion.

> **Proyecto independiente.** Sin relacion, patrocinio ni respaldo de BiciMAD, de la
> EMT de Madrid ni del Ayuntamiento de Madrid.

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
- Alojamiento: GitHub Pages con dominio propio, publicado por `ci.yml` desde `main`. El sitio es estatico y habla con Firestore desde el navegador.
- Datos: Firebase Auth + Firestore, en el plan Spark (gratis, sin tarjeta).
- Worker: Node 20 en GitHub Actions, con `sharp` y OCR local (`tesseract.js`).
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

Nunca en el codigo ni en Firestore.

### 4. App Check

1. Consola de Firebase: **Compilacion → App Check → reCAPTCHA v3**.
2. Copia la clave de sitio en `RECAPTCHA_SITE_KEY`, dentro de `assets/js/firebase.js`.

Aqui importa mas que en un montaje con servidor: como el cliente escribe
directamente en Firestore, App Check es lo que impide usar la apiKey desde un
script suelto en vez de desde la web.

### 5. Desplegar

Todo lo despliega `ci.yml`, solo, en cada push a `main` y **solo si pasan las
pruebas y las reglas en el emulador**:

| Trabajo | Que despliega |
|---|---|
| `web` | El sitio, en GitHub Pages (`scripts/construir-sitio.js` monta `_site/`) |
| `reglas` | Las reglas y los indices de Firestore |

Las reglas van aparte a proposito: **no son estaticas**. Son el control de acceso
del proyecto, porque no hay servidor delante.

A mano, solo las reglas:

```bash
firebase deploy --only firestore:rules,firestore:indexes --project bicifastness
```

Para ver en local exactamente lo que se publica:

```bash
node scripts/construir-sitio.js --abierta
```

### 5.1. GitHub Pages y las cabeceras

Pages **no permite cabeceras HTTP**. La politica de seguridad (CSP y referrer)
va por eso en cada pagina como `<meta>`, generada desde
**`shared/cabeceras.json`**, que es la fuente unica:

```bash
npm run cabeceras
```

`npm run validar` falla si alguna pagina se queda atras.

Lo que solo existe como cabecera y se pierde (`frame-ancestors`, HSTS,
`X-Content-Type-Options`, `Permissions-Policy`) esta explicado en
`_sin_cabeceras` de ese mismo fichero, con como se suple: el antiframing va en
`assets/js/ui.js`, y si algun dia hacen falta las demas, se pone Cloudflare
gratis delante del dominio.

Tampoco deja cambiar la cache (diez minutos para todo). Por eso el service
worker pide el codigo y el HTML con `cache: 'no-cache'` y se registra con
`updateViaCache: 'none'`: tras un despliegue nadie mezcla modulos nuevos y
viejos.

**Consecuencia practica de la CSP:** declara `script-src 'self'` sin
`'unsafe-inline'`, asi que **el JavaScript de las paginas no puede ir incrustado
en el HTML**. Vive en `assets/js/paginas/`, un modulo por pagina. Hay un test
que falla si alguien lo vuelve a meter en linea.

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

La web esta **en obras mientras la variable del repositorio `WEB_ABIERTA` no
valga `si`** (Settings → Secrets and variables → Actions → **Variables**).

- **Abrir:** `WEB_ABIERTA` = `si` y Actions → «Tests y despliegue» → **Run
  workflow** en `main`.
- **Cerrar:** cambia la variable a `no` (o bórrala) y otra vez Run workflow.

Con la web cerrada, `scripts/construir-sitio.js` publica SOLO la pagina de
obras, como portada y como 404: cualquier URL, exista o no, la enseña, asi que
tampoco se entra a `/admin/` escribiendo la direccion. Sin la variable, cerrada:
es el lado seguro.

Las rutas viejas del redisenio — `/home/`, `/ranking/`, `/bicirating/`,
`/mapa/`, `/clanes/` y `/profile/` — estan enlazadas desde fuera: con la web
abierta, el mismo script publica una pagina minima en cada una que salta a la
nueva.

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

**Ajustar la sensibilidad:** todos los umbrales estan en `backend/src/config.js`.
Si entra demasiado a la cola manual, sube `RIESGO.UMBRAL_APROBACION`; si se cuela
algo, bajalo.

---

## Estructura

```
assets/
  css/app.css               estilos comunes, mobile-first
  js/firebase.js            arranque unico de Firebase
  js/acciones.js            todas las escrituras, una por regla de Firestore
  js/dom.js                 construccion segura de interfaz (sin innerHTML)
  js/ui.js                  tema, navegacion, estaciones, aviso de cookies
  js/precheck.js            avisos sobre la captura antes de subirla, y compresion
  js/extraccion.js          lee la captura EN EL NAVEGADOR, para confirmar al momento
  ocr/                      GENERADO: motor y modelo del OCR del navegador (~6 MB)
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
  verificar-viajes.yml      worker: cada ejecucion vigila 9 min y lanza la siguiente (el cron de GitHub no se cumple); cron cada 5 min como red
  periodicas.yml            cierre de temporada y divisiones (cron apagado)
  ci.yml                    tests, reglas de Firestore y la web en GitHub Pages
CNAME                       el dominio de la web (lo leen Pages y los correos)
docs/
  ROADMAP.md                hitos, issues y en que orden
  JUEGO.md                  las reglas del juego y por que son esas
firestore.rules             EL control de acceso: no hay servidor delante
legal/                      aviso-legal, privacidad, terminos, cookies
shared/cabeceras.json       fuente unica de las cabeceras de seguridad
scripts/                    build-estaciones, build-capturas, build-ocr, aplicar-cabeceras, build-distancias, set-admin
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

El plan completo esta en [`docs/ROADMAP.md`](ROADMAP.md), repartido en
hitos e issues. Las reglas del juego que se esta construyendo, en
[`docs/JUEGO.md`](JUEGO.md).
