# Roadmap

De donde viene el proyecto, a donde va y en que orden. Los hitos y los issues
viven en GitHub; esto es el indice y, sobre todo, el **por que de cada orden**.

- Hitos: https://github.com/mateogsilvaa/bicifastness/milestones
- Issues: https://github.com/mateogsilvaa/bicifastness/issues
- Reglas del juego: [`docs/JUEGO.md`](JUEGO.md)

---

## De donde se parte

La v2 ya esta escrita: worker en GitHub Actions, verificacion automatica con
Gemini, huellas de imagen, reglas de Firestore que impiden autoverificarse y 55
tests. **El sitio esta en modo mantenimiento** y las credenciales comprometidas
de la v1 siguen sin rotar.

Lo que queda no es reescribir: es abrir con seguridad, quitarle la friccion a la
subida y convertir un ranking de tiempos en un juego al que apetezca volver.

## Que se decidio y por que

| Decision | Alternativa descartada | Motivo |
|---|---|---|
| GitHub Pages | Firebase Hosting, Vercel | Peticion explicita. Se pierden las cabeceras HTTP, que se compensan en el issue #3 |
| Seguir en Firestore | Migrar a Supabase | Migrar son semanas y no hay tiempo. El problema real no es la base de datos, es que se lee mal: se arregla con agregados (H5) |
| La captura sigue siendo la fuente | Registro por GPS | El viaje ocurre en una app de terceros a la que no tenemos acceso. Lo que se puede arreglar es el **procesado**, no el origen |

---

## Los hitos

| Hito | Que resuelve | Issues |
|---|---|---|
| **H0** Cimientos y despliegue | Abrir el sitio sin repetir el compromiso de la v1 | #1 – #7 |
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

## H0 — Cimientos y despliegue en Pages

Bloquea todo lo demas por una razon concreta: **el historial de git todavia
contiene la contrasena de Gmail en claro**, y el worker solo es gratis si el
repositorio es publico. Hacer publico el repo hoy es publicar esa contrasena.

- **#1** Rotar credenciales y purgar el historial — `P0`, bloquea a #2
- **#2** Desplegar en GitHub Pages
- **#3** Compensar las cabeceras que Pages no permite
- **#4** Autorizar el dominio en Firebase Auth y App Check
- **#5** Retirar Vercel y Firebase Hosting
- **#6** Calcular las distancias reales entre estaciones — bloquea todo el H2
- **#7** Salir de mantenimiento de forma controlada

**#6 esta aqui a proposito**, aunque parezca de juego: distancia y velocidad
cuelgan de ese dato y sin el no se puede empezar el H2.

## H1 — Subida sin friccion

Hoy el usuario transcribe a mano lo que ya esta en la imagen, y cada errata suya
acaba en la cola de revision. La captura pasa a ser el **unico** dato que aporta.

- **#8** Quitar el formulario manual: foto → extraccion → confirmar
- **#9** Normalizar Android, iOS, recortes, modo oscuro y recompresion
- **#10** OCR local primero, Gemini solo cuando haga falta
- **#11** Capturas con varios trayectos: elegir cual, descartando los ya subidos
- **#12** Avisos en el navegador antes de subir
- **#13** Estado del viaje en vivo
- **#14** Acortar el ciclo del worker
- **#15** Cola de revision resoluble en 30 segundos
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
#1 credenciales ──▶ repo publico ──▶ #2 Pages ──▶ #4 Auth ──▶ #7 abrir
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

## Prioridades

- **P0** bloquea el lanzamiento
- **P1** importante, no bloquea
- **P2** deseable

Un hito se da por cerrado cuando no le quedan issues `P0`. Los `P2` pueden
arrastrarse al siguiente sin culpa: es la valvula de escape de un proyecto que
lleva una sola persona sin tiempo.
