# Mantenimiento

El objetivo del proyecto es mantenimiento casi nulo. Eso no sale solo: sale de
tener escrito que se mira, cada cuanto, y que hacer cuando algo falla.

Si vuelves al proyecto dentro de seis meses, con esto y con
[ROADMAP.md](ROADMAP.md) sabes en diez minutos como esta.

## Cada semana: cinco minutos

1. **La cola de revision.** `/admin/`. Un viaje que lleva dias en `revision` es
   una persona esperando. Si la cola crece sola, algo se rompio en el worker.
2. **El worker.** Actions → "Verificar viajes". Debe haber ejecuciones cada 5-15
   minutos y en verde. Varias rojas seguidas: mira la seccion de fallos.
3. **La cuota.** Firebase Console → Uso. Si las lecturas del dia van por encima
   de la mitad a media tarde, no llega a medianoche. Ver [COSTE.md](COSTE.md).
4. **Errores nuevos.** `/admin/errores/`. Ordenados por a cuanta gente le pasa,
   que es lo que decide que arreglar primero.
5. **El embudo.** `/admin/metricas/`. Si las subidas empezadas suben y las
   enviadas no, hay algo roto en medio.

## Cada mes

1. **Distancias pendientes.** Si `distancias_pendientes` tiene documentos, hay
   rutas puntuando con distancia estimada:
   ```bash
   node scripts/build-distancias.js --pendientes
   ```
   Commitea `backend/lib/distancias.json` despues. Ver
   [DISTANCIAS.md](DISTANCIAS.md).
2. **La precision del OCR.** El workflow `medir-ocr.yml` mide sobre capturas
   reales. Si baja, hay que mirar si la app de BiciMAD ha cambiado de aspecto.
3. **Equilibrio del juego.** Mira si una ruta concentra a todo el mundo o si hay
   insignias que no tiene nadie.
4. **Vuelve a correr las dos auditorias**, que el codigo habra cambiado:
   ```bash
   node scripts/auditar-lecturas.js
   cd backend && node --test test/ensayo.test.js
   ```

## Las operaciones periodicas

Corren solas desde `periodicas.yml`: cierre de temporada el dia 1, divisiones
los lunes.

**Antes de la primera vez de verdad**, y despues de cualquier cambio en
`temporadas.js` o `divisiones.js`: lanzarlo a mano con `simular: true` y leer la
salida. El cierre de temporada no tiene vuelta atras.

El ensayo de [ENSAYO.md](ENSAYO.md) corre esas mismas operaciones sobre 200
usuarios y 5.000 viajes sin tocar nada, y esta en el CI.

## Cuando algo falla

### El worker no se ejecuta

GitHub retrasa las ejecuciones programadas cuando hay carga: un retraso de 5 a
15 minutos es **normal**, no es un fallo.

Si lleva horas sin correr:

- GitHub desactiva `schedule` en repositorios **sin actividad durante 60 dias**.
  Se reactiva desde la pestaña Actions, y un commit cualquiera lo evita.
- Si el repositorio dejo de ser publico, se acaban los minutos de Actions.

Mientras tanto, los viajes se quedan en `pendiente`. No se pierde nada: al
volver, el worker procesa la cola por orden.

Para lanzarlo a mano: Actions → "Verificar viajes" → Run workflow.

### El worker falla siempre

Mira el log. Los sospechosos habituales:

- `FIREBASE_SERVICE_ACCOUNT` caducado o mal pegado. Es el fallo mas comun tras
  rotar credenciales.
- La cuota de Firestore agotada: el worker lee, asi que tambien se para.
- Un indice que falta. Firestore no avisa al escribir el codigo, **falla en
  ejecucion**, y el mensaje trae un enlace para crearlo. Anadelo tambien a
  `firestore.indexes.json` y a la lista del test que ata cada consulta
  compuesta a su indice, o volvera a pasar.

Un viaje que hace fallar al worker **no atasca la cola**: se le pone `revision`
y se sigue. Ese es el estado seguro.

### El OCR no lee nada

El motor y el modelo se sirven desde `/assets/ocr/`. Si el navegador no los
puede descargar, la subida no puede leer la captura.

Comprueba que existen en el despliegue y que la CSP sigue permitiendo
`'wasm-unsafe-eval'` y `worker-src blob:`. Sin esas dos, tesseract no arranca y
no da un error que se entienda.

### La cuota se agota

Sintoma: la web deja de cargar datos y la consola llena de
`resource-exhausted`. **Se recupera sola a medianoche** (hora del Pacifico, que
no es medianoche aqui).

Para el rato:

1. Modo mantenimiento (abajo). Corta las lecturas de las pantallas caras.
2. Desactiva el worker: Actions → "Verificar viajes" → Disable workflow.

Para que no vuelva a pasar: [COSTE.md](COSTE.md). Los dos culpables conocidos
son `recalcularTrasCambio`, que lee las dos colecciones enteras por cada viaje
aprobado, y `/territorio/`, que lee un documento por estacion.

### Alguien esta raspando datos

Firebase Console → Firestore → Uso. Un pico de lecturas de una coleccion que
nadie deberia estar leyendo entera.

Lo unico que corta una fuga es **desplegar reglas**, y se hace en un minuto
pegando `firestore.rules` en Firebase Console → Firestore → Reglas. Ni el modo
mantenimiento ni parar el despliegue protegen nada: **Firestore es un servicio
aparte y responde aunque la web no se sirva.**

Si hay datos personales de por medio, el RGPD da **72 horas** desde que se tiene
constancia para notificar a la AEPD (art. 33), y obliga a avisar a las personas
afectadas si el riesgo es alto (art. 34).

### Los correos no llegan

Resend, en `/admin/`. El worker registra cada entrega y reintenta las que
fallan. Si fallan todas, mira si la clave sigue viva y si el dominio sigue
verificado.

Que fallen los correos no para la verificacion de viajes: esta a proposito en su
propio try.

## Volver a modo mantenimiento

**Anade el bloque `redirects` a `vercel.json` y haz push.** Tarda lo que tarde
el despliegue, alrededor de un minuto.

```json
"redirects": [
  { "source": "/((?!mantenimiento|images/).*)", "destination": "/mantenimiento/", "permanent": false }
]
```

Para abrir otra vez: borra ese bloque y haz push.

En Vercel los redirects se evaluan **antes** que el sistema de ficheros, asi que
tapan tambien las paginas que existen: sin eso, entrar a `/admin/` escribiendo
la URL seguiria funcionando. Y `permanent: false` es un 307 a proposito: un 301
se queda cacheado en los navegadores de la gente y los seguiria mandando a la
pagina de obras despues de abrir.

Ojo: **esto tapa la web, no los datos.** Si el problema es una fuga, lo que hay
que desplegar son las reglas.

El checklist de reapertura esta en [LANZAMIENTO.md](LANZAMIENTO.md).

## Ficheros generados

No se editan a mano. El CI los regenera y compara, asi que una edicion manual
hace fallar el build:

| Fichero | Lo genera | Cuando |
|---|---|---|
| `assets/data/estaciones.js` | `scripts/build-estaciones.js` | en cada CI |
| `backend/lib/estaciones.json` | `scripts/build-estaciones.js` | en cada CI |
| `assets/data/version.js` | `scripts/build-version.js` | en cada despliegue |
| Las CSP de cada pagina | `scripts/aplicar-cabeceras.js` | a mano, desde `shared/cabeceras.json` |
| `backend/lib/distancias.json` | `scripts/build-distancias.js` | a mano, necesita red |
| `backend/test/banco/*.png` | `scripts/build-capturas.js` | a mano |

Las dos ultimas son la excepcion: necesitan red o tiempo, y un CI que dependa de
una instancia de cortesia ajena se cae el dia que esa instancia tenga un mal
dia.

## Antes de tocar nada

```bash
npm test
```

Corre lo que corre el CI: regenera los datos, analisis estatico, validacion de
paginas y los tests del backend. Si esto pasa, el CI pasa.

`backend/test/banco.test.js` descarga los datos de idioma de tesseract la
primera vez: si estas sin red, ese es el unico que se queda colgado.
