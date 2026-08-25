# Roadmap

De donde viene el proyecto, a donde va y en que orden. Los hitos y los issues
viven en GitHub; esto es el indice y, sobre todo, el **por que de cada orden**.

- Hitos: https://github.com/mateogsilvaa/bicifastness/milestones
- Issues: https://github.com/mateogsilvaa/bicifastness/issues
- Reglas del juego: [`docs/JUEGO.md`](JUEGO.md)

---

## De donde se parte

La v2 ya esta escrita: worker en GitHub Actions, verificacion automatica con
OCR local, huellas de imagen y reglas de Firestore que impiden autoverificarse. **El sitio esta en modo mantenimiento** y las credenciales comprometidas
de la v1 siguen sin rotar.

Lo que queda no es reescribir: es abrir con seguridad, quitarle la friccion a la
subida y convertir un ranking de tiempos en un juego al que apetezca volver.

## Que se decidio y por que

| Decision | Alternativa descartada | Motivo |
|---|---|---|
| Vercel | GitHub Pages, Firebase Hosting | Se empezo por Pages (peticion explicita), pero Pages no permite cabeceras HTTP y eso costaba seis de seguridad. Vercel las da gratis y ya estaba conectado. Ver #3 |
| Seguir en Firestore | Migrar a Supabase | Migrar son semanas y no hay tiempo. El problema real no es la base de datos, es que se lee mal: se arregla con agregados (H5) |
| La captura sigue siendo la fuente | Registro por GPS | El viaje ocurre en una app de terceros a la que no tenemos acceso. Lo que se puede arreglar es el **procesado**, no el origen |
| OCR local, sin IA | Gemini u otro modelo | Quita una clave que rotar, una cuota que agotar y un servicio que puede caerse. Se pierde la deteccion de retoque visual; lo cubren las comprobaciones deterministas. Ver #10 |

---

## Los hitos

| Hito | Que resuelve | Issues |
|---|---|---|
| **H0** Cimientos y despliegue | Abrir el sitio sin repetir el compromiso de la v1 | #1 – #7, #58 |
| **H1** Subida sin friccion | El cuello de botella: subir un viaje | #8 – #16 |
| **H2** Motor de juego multimodo | Que no solo puntue ir rapido | #17 – #24 |
| **H3** Clanes y conquista | Territorio que se gana y se pierde | #25 – #29 |
| **H4** Retencion diaria | Una razon para volver manana | #30 – #33 |
| **H5** Datos, coste y rendimiento | Que la cuota gratuita aguante | #34 – #39 |
| **H6** Observabilidad | Enterarse de los fallos sin vigilar | #40 – #44 |
| **H7** Correo transaccional | Avisar de lo que le pasa a cada viaje | #45 – #48 |
| **H8** Identidad visual y UX | Que se reconozca sin leer el nombre | #49 – #53 |
| **H9** Lanzamiento | Abrir con red debajo | #54 – #57 |

---

## H0 — Cimientos y despliegue

Bloquea todo lo demas por una razon concreta: **el historial de git todavia
contiene la contrasena de Gmail en claro**, y el worker solo es gratis si el
repositorio es publico. Hacer publico el repo hoy es publicar esa contrasena.

- **#1** Rotar credenciales y purgar el historial — `P0`, bloquea a #2
- **#2** Desplegar el sitio desde Vercel
- **#3** Cabeceras de seguridad con fuente unica
- **#4** Autorizar el dominio en Firebase Auth y App Check
- **#5** Retirar Firebase Hosting y GitHub Pages
- **#58** El worker fallaba en cada ejecucion del cron sin credenciales
- **#6** Calcular las distancias reales entre estaciones — bloquea todo el H2
- **#7** Salir de mantenimiento de forma controlada

**#6 esta aqui a proposito**, aunque parezca de juego: distancia y velocidad
cuelgan de ese dato y sin el no se puede empezar el H2.

## H1 — Subida sin friccion

Hoy el usuario transcribe a mano lo que ya esta en la imagen, y cada errata suya
acaba en la cola de revision. La captura pasa a ser el **unico** dato que aporta.

- **#8** Quitar el formulario manual: foto → extraccion → confirmar. La lectura
  va en el NAVEGADOR: hecha en el worker, la pantalla de confirmacion llegaria
  minutos despues, que es justo lo que se queria quitar
- **#9** Normalizar Android, iOS, recortes, modo oscuro y recompresion
- **#10** Afinar el OCR local sobre capturas reales
- **#11** Capturas con varios trayectos: elegir cual, descartando los ya subidos.
  Ojo con la huella de imagen: varios viajes comparten captura, asi que dejo de
  ser 1:1 con el viaje
- **#12** Avisos en el navegador antes de subir — cortesia, no seguridad: el
  worker lo vuelve a comprobar todo
- **#13** Estado del viaje en vivo — y los motivos de rechazo en castellano,
  sin enseñar los umbrales del antifraude
- **#14** Acortar el ciclo del worker — pasadas dentro de una misma ejecucion,
  porque el cron de GitHub no baja de 5 minutos y encima se retrasa
- **#15** Cola de revision resoluble en 30 segundos — con el rastro de cada
  decision en `auditoria_admin`, que no se puede reescribir
- **#16** Banco de capturas de prueba — sin esto, el resto se ajusta a ciegas

## H2 — Motor de juego multimodo

Tres modos para que quepan perfiles distintos: **Sprint**, **Fondo** y
**Constancia**. Las reglas y las formulas estan en [`docs/JUEGO.md`](JUEGO.md).

- **#17** Distancia, velocidad y duracion en cada viaje
- **#18** Puntuacion multivariable
- **#19** Rachas con escudo
- **#20** Rankings por modo
- **#21** Perfil por modo
- **#22** Temporadas mensuales
- **#23** Divisiones semanales
- **#24** Insignias para los tres modos

## H3 — Clanes y conquista

La influencia sobre una estacion deja de depender solo de tiempos, y **decae**
si el clan no pedalea.

- **#25** Influencia multivariable
- **#26** Decaimiento diario
- **#27** Rediseno del mapa
- **#28** Bonus por territorio propio
- **#29** Gestion de clanes

## H4 — Retencion diaria

- **#30** Misiones diarias
- **#31** Ruta del dia
- **#32** Un inicio que responde a "que hago hoy"
- **#33** Avisos push

## H5 — Datos, coste y rendimiento

El plan Spark da **50.000 lecturas al dia**, y hay operaciones que ya se lo comen
solas: `recalcularEstacion()` lee todos los viajes y todos los usuarios **en cada
viaje aprobado**.

- **#34** Medir primero — `spike`
- **#35** Documentos agregados
- **#36** Dejar de recalcularlo todo en cada viaje
- **#37** Cache y paginacion
- **#38** Vigilar la cuota
- **#39** Revisar indices y reglas

## H6 — Observabilidad

- **#40** Recoger errores de todos los usuarios
- **#41** Pagina de errores con CSV
- **#42** Analitica propia, sin cookies
- **#43** Panel de metricas
- **#44** Embudo y cohortes

## H7 — Correo transaccional

- **#45** Resend desde el worker
- **#46** Plantillas
- **#47** Preferencias y baja
- **#48** Reintentos y entregas

## H8 — Identidad visual y UX

- **#49** Sistema de diseno
- **#50** Aplicarlo a las pantallas
- **#51** Microinteracciones
- **#52** PWA instalable
- **#53** Accesibilidad

## H9 — Lanzamiento

- **#54** Migrar datos de la v1
- **#55** Repaso legal
- **#56** Ensayo general
- **#57** Checklist y guia de mantenimiento

---

## Dependencias que importan

```
#1 credenciales ──▶ repo publico ──▶ #2 Vercel ──▶ #4 Auth ──▶ #7 abrir
                                        │
#6 distancias ──────────────────────────┴──▶ #17 ──▶ #18 ──▶ #19 ──▶ #22
                                                     │
#34 medir ──▶ #35 agregados ──▶ #20 rankings, #27 mapa, #43 panel
                                                     │
#42 analitica ──────────────────────────────────────▶ #43 ──▶ #44
#45 Resend ────────────────────────────────────────▶ #38 avisos de cuota
#52 PWA ───────────────────────────────────────────▶ #33 push en iOS
```

Tres reglas de orden que conviene no saltarse:

1. **#35 antes que #20, #27 y #43.** Si esas pantallas se escriben leyendo
   colecciones, hay que reescribirlas enteras despues.
2. **#16 antes de tocar el extractor.** Sin banco de pruebas no se sabe si un
   cambio mejora o empeora.
3. **#34 antes de optimizar nada.** Optimizar a ojo es como se llega a
   `recalcularTrasCambio()`.

---

## Estado

Lo hecho hasta ahora vive en una cadena de ramas que **no esta fusionada con
`main`**. La punta, hoy:

```
main
 └── roadmap-y-migracion-a-pages
      └── claude/resolve-issues-z7pyxi
           └── claude/repo-issues-milestones-z9sb8s   <- aqui
```

**Ojo con esto**, que ya ha costado trabajo duplicado dos veces: `main` esta a
mas de cincuenta commits por detras, y ademas con la estructura de ficheros
vieja (`ranking/`, `bicirating/`, `mapa/`, `clanes/`, `profile/`, que ahora son
`clasificacion/`, `territorio/` y `yo/`). Partir de `main` no es empezar de
cero: es empezar en otro sitio.

Antes de tocar nada: `git fetch origin --no-tags 'refs/heads/*:refs/remotes/origin/*'`
y mirar `git branch -a`. Un clon superficial puede no traer las ramas, y
entonces `main` parece la unica que hay.

| Issue | Estado |
|---|---|
| #2 Vercel | Configuracion lista y despliegues en READY. Falta que produccion apunte a esto |
| #3 Cabeceras | **Hecho.** Fuente unica y tests que impiden que divergan |
| #5 Un solo destino | **Hecho.** Falta desconectar lo que sobre |
| #6 Distancias | Modulo y generador listos. Falta ejecutarlo contra OSRM |
| #17 Medir el viaje | **Hecho.** El worker guarda distancia, velocidad y puntos |
| #18 Puntuacion | **Hecho**, con el test de equilibrio entre perfiles |
| #19 Rachas | **Hecho.** Ojo: durante un tiempo no se rompian nunca y los escudos no se gastaban jamas, porque `cerrarDiasPerdidos` no la llamaba nadie. Hay pasada diaria desde entonces |
| #9 Normalizar capturas | **Hecho.** Android, iOS, recortes y modo oscuro a una sola forma |
| #12 Avisos antes de subir | **Hecho.** Avisan, no bloquean; y la captura se sube al ancho que lee el worker |
| #13 Estado en vivo | **Hecho.** Un `onSnapshot` a un solo documento, que se corta solo |
| #16 Banco de capturas | **Hecho** con capturas SINTETICAS y medicion en CI. Las reales siguen midiendose con `medir-ocr.js`, que no las saca de Firestore |
| #14 Ciclo del worker | **Hecho** lo que no toca al cron: pasadas dentro de la misma ejecucion, un solo worker de OCR por tanda y cache de idioma y dependencias |
| #10 Afinar el OCR | **A medias.** Tres fallos corregidos (ver abajo). Lo que falta necesita capturas reales |
| #15 Cola de revision | **Hecho.** Un caso cada vez, captura junto al cotejo, motivo sugerido y atajos de teclado |
| #8 La captura como unico dato | **Hecho.** La lectura corre en el navegador y solo se confirma. Cuesta ~6 MB la primera subida de cada navegador |
| #11 Varios trayectos | **Hecho.** Se lee la lista entera, se descarta lo ya subido y se eligen cuales subir; todos comparten una sola captura |
| #58 Runs en rojo | **Hecho.** Cron apagado hasta el lanzamiento |
| #6 Distancias | **Hecho** el modulo, el generador y el bucle con el worker. Falta ejecutarlo contra OSRM: la tabla se commitea vacia |
| #34 Coste por pantalla | **Hecho.** Modelo ejecutable en `scripts/auditar-lecturas.js` y `docs/COSTE.md`. De paso, arreglado lo que se llevaba el 95% de las lecturas |
| #37 Cache y paginacion | **Hecho.** Persistencia local, agregados en sesion, historial paginado y las dos consultas sin techo, cerradas |
| #52 PWA | **Hecho.** Manifiesto, iconos maskable, pantalla offline util e invitacion tras el primer viaje |
| #55 Repaso legal | **Hecho** lo que depende del codigo. Faltan los datos del responsable, que no puedo rellenar yo |
| #56 Ensayo general | **Hecho.** Las periodicas corren sobre 200 usuarios y 5.000 viajes en el CI, contando lecturas |
| #57 y #7 Documentacion | **Hecho.** `LANZAMIENTO.md`, `MANTENIMIENTO.md`, `ENSAYO.md` y `COSTE.md` |
| #54 Migrar la v1 | **Hecho.** Distancia y velocidad de los viajes historicos, puntos de la v1 archivados como temporada `v1`, copia de seguridad con `--copia` y aviso por correo. Falta ejecutarla: `docs/MIGRACION.md` |
| #29 Clanes | **Hecho**, incluida la pantalla, que era lo que faltaba: las doce acciones existian sin nada que las llamara |
| #59 y #60 Fuga de correos | Codigo hecho. **Falta desplegar las reglas**, que es lo unico que corta la fuga |

### Documentacion que manda hacer lo imposible

La tercera familia, y la mas incomoda de las tres: **la guia dice una cosa y el
codigo hace otra**. No se descubre revisando, se descubre el dia que hace falta,
con prisa.

| Donde | Que decia |
|---|---|
| `LANZAMIENTO.md` | `migrar-datos.js --verificar`, que no existe. Es `--comprobar` |
| `MANTENIMIENTO.md` | Vigilar `distancias_pendientes`, una coleccion que no ha existido nunca, y lanzar `--pendientes`, que el script no reconocia |
| `COSTE.md` | "la web deja de funcionar hasta medianoche", sin decir cual. Es la del Pacifico: entre las 09:00 y las 10:00 de aqui |
| `DISTANCIAS.md` | Una cache en `distancias/{ruta}` que costaba una lectura por viaje y **que no llenaba nadie** |
| `ci.yml` | "Comprobar que los datos generados estan al dia", regenerando uno de los tres |
| `build-push.js` | Explicaba con detalle que el CI corre `npm run datos` antes de comparar. El CI no lo hacia |

Los dos ultimos son los que mas dicen: no era documentacion desactualizada, era
**documentacion que describia la intencion correcta y codigo que no la
cumplia**. Cuando eso pasa, casi siempre tiene razon la documentacion.

Hay dos pruebas que lo sujetan:

- una recorre las ocho guias, saca cada `node scripts/…` con sus banderas y
  comprueba que el script existe y las conoce
- otra exige que el CI regenere **todo** lo que despues compara, con una lista de
  excepciones **con motivo escrito** para lo que no puede entrar

### Los dias, y por que hay una regla

**El juego cuenta los dias en Madrid.** La unica excepcion es la cuota diaria de
Firestore, que se reinicia a medianoche del Pacifico porque eso no lo decidimos
nosotros (`backend/src/cuota.js`).

Parece intendencia y es la segunda familia de fallos mas numerosa que salio al
revisar la rama. Todos comparten la misma forma: **dos puntas del sistema
calculando "hoy" de maneras distintas**, y por eso ninguno se reproduce cuando
vas a mirarlo. Fallan una o dos horas al dia, o una vez al mes.

| Donde | Que pasaba |
|---|---|
| Misiones | El worker publicaba con el dia UTC y la portada pedia con el local: entre las 22:00 y las 00:00 la seccion desaparecia |
| `subir/` | El tope del selector de fecha era el dia UTC: entre medianoche y las 02:00 no dejaba elegir HOY |
| Cupo diario | La pantalla contaba en UTC y el servidor en Madrid: decia que quedaba sitio y el servidor rechazaba |
| Sesiones | El navegador escribia el dia del dispositivo y el panel agrupaba por dia UTC |
| Cuota (#38) | Contaba por dias UTC y se ponia a cero siete horas antes que la cuota real: ni aviso ni modo degradado en el tramo mas peligroso del dia |
| Temporadas (#22) | El mes en UTC: lanzar el cierre a mano a las 00:30 del dia 1 archivaba un mes ya cerrado y contestaba "ya cerrada" |
| `ultimoDiaActivo` | Guardado en milisegundos y comparado como `'YYYY-MM-DD'` en dos sitios: el push de racha se lo llevaba todo el mundo y ningun clan sin lider se rescataba |
| Cohortes (#34) | `lunesDe` preguntaba el dia de la semana al calendario UTC y contestaba en el de Madrid: las altas de madrugada abrian una semana fantasma, y el corte entre cohortes vivas y congeladas retrocedia una semana entera |

Hay dos piezas y dos pruebas que lo sostienen:

- `backend/src/util.js` — `diaMadrid`, `diaEnZona`, `minutosDelDiaEnZona`, `lunesDe`
- `assets/js/dia.js` — su pareja en el navegador
- una prueba por lado, que falla si alguien vuelve a calcular un dia o un mes en
  UTC, o a mano con la hora del dispositivo

Si hace falta un dia en otra zona, se pide con `diaEnZona` y se explica por que,
como hace `cuota.js`.

**Toda la aritmetica de dias vive en esos dos ficheros, no solo el "que dia es
hoy".** El de las cohortes es el caso que lo dejo claro: `lunesDe` estaba en
`metricas.js` porque era quien lo usaba, y ahi nadie lo miro con la regla en la
mano. Restaba dias sobre el calendario UTC y devolvia el resultado en el de
Madrid; entre las 00:00 y las 02:00 esos dos calendarios no van por el mismo
dia, asi que restaba una semana de mas y devolvia martes donde ponia "lunes".
Fallaba en 576 de las 8.784 horas del año.

Como probar esto sin esperar a las 00:30: la comprobacion buena no es un caso,
es **la propiedad**. `lunesDe` tiene que devolver un lunes SIEMPRE, asi que la
prueba barre un año entero hora a hora — cambios de horario incluidos — y no
depende de cuando se ejecute.

### Funciones escritas, probadas y sin llamar

Un patron que aparecio seis veces al revisar la rama, y que cuesta ver porque
**todo esta en verde**: la funcion existe, tiene sus pruebas, y no la ejecuta
nadie. Una funcion probada que no llama nadie da la misma sensacion de seguridad
que una que funciona.

| Que | Consecuencia |
|---|---|
| `rachas.cerrarDiasPerdidos` | Ninguna racha se rompia nunca, ningun escudo se gastaba jamas |
| `misiones.progreso` | Las tres misiones del dia ponian "Pendiente" para siempre |
| `clanes.aplicarInvitacion` | Un enlace de invitacion acababa siendo una solicitud a mano |
| `clanes.elegirSucesor` | Un clan sin lider quedaba bloqueado para siempre, con gente dentro |
| `plantillas.bienvenida`, `viajeAnulado`, `revisionLenta` | Nadie recibia el correo de registro, ni sabia por que le habian bajado los puntos |
| Las doce acciones de clan y `guardarFavoritas` | Escritas, con reglas, y sin una sola pantalla desde la que ejecutarlas |
| `reportarViaje` y `suspenderUsuario` | La moderacion tenia cola, reglas y panel, y ninguna forma de crear una denuncia (#61) |
| `limites.js` entero | No hay limitacion de frecuencia en ningun sitio (#62) |

`reportarViaje` y `suspenderUsuario` eran el septimo y el octavo, y ya tienen
pantalla (#61). Costo mas que los demas porque denunciar necesitaba saber a
quien se señala, y publicar los uid en las clasificaciones es justo lo que no se
hace desde #60: se resolvio denunciando el VIAJE y dejando que el worker
averigüe el dueño.

Queda uno, y es de otra clase:

- **#62** `limites.js`. No es que no se ejecute, es que **no se puede ejecutar
  donde hace falta**. Usa el Admin SDK, o sea que corre en el worker, y para
  entonces la escritura ya ha ocurrido. Mientras siga ahi sin llamar es peor que
  no tenerlo: quien lo lea dara por hecho que hay limitacion de frecuencia, y no
  la hay. El worker ya despeja la cola cuando una cuenta la inunda, pero eso es
  un parachoques: la escritura sigue ocurriendo.

Merece la pena, al acabar algo, comprobar **quien lo llama**. `grep -rn` sobre
el nombre de la funcion, fuera de su propio fichero y de los tests.

### Lo que encontro el banco de capturas

Los tres son fallos de capturas normales, de gente normal, y ninguno se veia
leyendo el codigo:

1. **Modo oscuro ilegible.** `negate()` de sharp invierte tambien el canal
   alfa, asi que la captura salia del normalizador transparente entera y
   tesseract leia una imagen en blanco. Con capturas JPEG (las que manda hoy el
   navegador) no se disparaba, pero las reglas admiten PNG y WEBP.
2. **El reloj de la barra de estado pasaba por hora de salida.** Se cogian las
   dos primeras horas del texto, y en Android sin recortar la primera es el
   reloj del sistema. La resta llegada - salida dejaba de cuadrar con la
   duracion y el antifraude marcaba viajes legitimos.
3. **La duracion se perdia** cuando la captura la muestra grande y aislada, por
   no fijar el modo de segmentacion de pagina de tesseract.

De propina, dos cosas que ralentizaban el worker: se creaba un worker de
tesseract por captura (ahora uno por tanda) y el temporizador de la carrera
contra el OCR nunca se cancelaba, dejando un `setTimeout` de un minuto vivo por
cada lectura.

### Lo que destapo medir en vez de suponer

Tres cosas que nadie habria encontrado leyendo el codigo, y que solo salieron al
escribir algo que las midiera:

1. **`metricas.resumir` se llevaba el 95% de todas las lecturas del proyecto.**
   Corria en cada pasada del worker — 288 veces al dia — leyendo `usuarios` y
   `tiempos_viaje` enteros, hubiera pasado algo o no. Con los datos de hoy son
   402.000 lecturas diarias, ocho veces la cuota, con seis personas usando la
   web. El sintoma habria sido la web cayendose todas las tardes sin
   explicacion. Ver [COSTE.md](COSTE.md).
2. **El derecho de supresion no lo ejecutaba nadie.** La politica lo prometia,
   el perfil dejaba pedirlo, las reglas admitian la solicitud y
   `solicitudes_borrado` se llenaba sin que la procesara nada.
3. **La portada leia una ruta entera en cada visita.** Sin `limit`: una ruta
   popular con 3.000 marcas costaba 3.000 lecturas por visita a la pantalla que
   mas se abre.

### Lo que queda pendiente y no cuelga de ningun issue

Queda una migracion por ejecutar contra produccion, no por escribir:
`scripts/migrar-auditorias.js`. Saca el objeto `auditoria` del documento del
viaje — donde su dueño lo leia entero, con los umbrales del antifraude dentro — y
lo lleva a `auditorias/{viajeId}`, que solo lee la administracion. Los viajes
nuevos ya nacen asi; los que hay en produccion siguen llevandolo dentro hasta que
se lance. Mientras tanto no se rompe nada: el panel y `motivos.js` saben leer las
dos formas. Lo que no se cierra hasta el final es la fuga.

Lo de coste que este documento daba por pendiente ya no lo esta:
`recalcularTrasCambio` no lee ninguna coleccion entera y `/territorio/` lee un
solo agregado. Ninguna operacion del worker lee ya `tiempos_viaje` completa. Los
numeros y lo que queda estan en docs/COSTE.md.

Lo que no puedo hacer yo: rotar credenciales (#1), purgar el historial, tocar la
consola de Firebase (#4), rellenar los datos del responsable en los documentos
legales (#55), ejecutar el generador de distancias contra OSRM y conseguir
capturas reales de BiciMAD para el banco (#16 y #10).

## Prioridades

- **P0** bloquea el lanzamiento
- **P1** importante, no bloquea
- **P2** deseable

Un hito se da por cerrado cuando no le quedan issues `P0`. Los `P2` pueden
arrastrarse al siguiente sin culpa: es la valvula de escape de un proyecto que
lleva una sola persona sin tiempo.
