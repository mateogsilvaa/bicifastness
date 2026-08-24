# Diseno del juego

Como se convierte un trayecto en BiciMAD en algo a lo que apetezca volver manana.

Este documento es la fuente de la verdad de las reglas. Los numeros concretos
viven en `backend/src/config.js`; aqui esta el **por que** de cada uno. Si
cambias un umbral, cambia tambien la justificacion de aqui o el documento deja
de servir.

---

## El problema que resuelve

La v1 solo media una cosa: **el tiempo entre dos estaciones**. Eso tiene dos
consecuencias malas:

1. Solo gana quien va rapido. Quien hace 40 km tranquilos a la semana no
   aparece en ningun sitio, y se va.
2. Los records de tramo son **permanentes**. En cuanto alguien clava un tiempo
   imbatible en una ruta, esa ruta esta muerta: nadie mas la compite. El juego
   se agota solo con el tiempo.

El diseno nuevo ataca las dos: **varios modos** para que quepan perfiles
distintos, y **temporadas + divisiones** para que la clasificacion sea siempre
ganable por alguien que empieza hoy.

---

## Que mide un viaje

Cada viaje verificado produce tres magnitudes, no una:

| Magnitud | De donde sale |
|---|---|
| `duracionSegundos` | Leida de la captura y contrastada con `hora_llegada - hora_salida` |
| `distanciaMetros` | Distancia por calle entre las dos estaciones, precalculada (ver `docs/DISTANCIAS.md`) |
| `velocidadKmh` | `distanciaMetros / duracionSegundos`, con el tope fisico de 25 km/h que ya valida el antifraude |

La distancia **no** se declara: se deduce del par de estaciones. Asi no hay nada
nuevo que el usuario pueda falsear ni que tenga que escribir.

---

## Los tres modos

Tres clasificaciones independientes, cada una con su propia pagina y su propia
insignia de temporada. Nadie queda fuera.

### Sprint — velocidad
El ranking por tramo de siempre: el mejor tiempo de cada piloto en cada ruta.
Premia trayectos cortos y rapidos. Es lo unico que existia en la v1.

### Fondo — distancia
Kilometros acumulados en la temporada. Premia a quien usa la bici como
transporte de verdad, sin correr.

### Constancia — ritmo
Dias activos y racha. Premia aparecer, aunque sea un trayecto corto y lento.
Es el modo que sostiene el habito diario.

**BiciRating** sigue existiendo como numero unico y publico, pero ahora es la
suma de los puntos de los tres modos. En el perfil se ve desglosado, para que
cada quien sepa en que es bueno.

---

## Puntos por viaje

Se calculan **en el worker**, al verificar. El navegador nunca los escribe.

```
base       = 10
distancia  = round(km * 6)
velocidad  = round(max(0, kmh - 8) * 2.5)

puntos = (base + distancia + velocidad)
       * multiplicadorRacha
       * multiplicadorRuta
       * multiplicadorTerritorio
```

El `- 8` en velocidad es deliberado: por debajo de 8 km/h no se puntua por ir
rapido, pero **tampoco se resta**. Un trayecto lento sigue sumando por base y
por distancia.

Comprobacion de que las dos formas de jugar valen lo mismo:

| Perfil | Trayecto | Cuentas | Puntos |
|---|---|---|---|
| Velocista | 1,5 km a 20 km/h | 10 + 9 + 30 | **49** |
| Fondista | 6 km a 12 km/h | 10 + 36 + 10 | **56** |
| Diario | 2,5 km a 13 km/h | 10 + 15 + 13 | **38** |

Ninguno domina al otro. Esa es toda la intencion.

Siguen contando **como maximo 3 viajes al dia** (`LIMITES.VIAJES_POR_DIA`), que
es el limite antifraude que ya existia. A partir del cuarto el viaje se registra
en las estadisticas pero no puntua.

---

## Racha

- **Dia activo**: al menos un viaje verificado.
- `multiplicadorRacha = 1 + min(racha, 10) * 0,05` → llega a x1,5 a los 10 dias.

### Escudo de racha

Perder una racha de 40 dias por un dia de gripe hace que la gente **abandone**,
no que se esfuerce mas. Por eso:

- Se gana 1 escudo cada 7 dias activos, con un maximo de 2 guardados.
- Si pasa un dia sin viaje y hay escudo, se gasta solo y la racha sobrevive.
- Sin escudos, la racha vuelve a 0.

El escudo se consume automaticamente: no hay que entrar a la web a gastarlo, lo
que seria justo el problema que intenta evitar.

---

## Misiones diarias

Tres misiones al dia, **iguales para todo el mundo**, generadas por el worker a
las 00:05 en un unico documento `config/misiones/{YYYY-MM-DD}`.

Que sean iguales para todos no es pereza: es lo que permite que las lea todo el
mundo con **una lectura de Firestore cacheable** en vez de una por usuario. El
progreso individual se guarda en el propio documento del usuario, que ya se lee
de todas formas.

Familias de mision:

| Familia | Ejemplo |
|---|---|
| Distancia | "Recorre 5 km hoy" |
| Velocidad | "Manten mas de 15 km/h en un trayecto" |
| Exploracion | "Termina en una estacion que no hayas usado nunca" |
| Tramo | "Compite en la ruta del dia" |

Cada mision da puntos y progreso hacia el escudo. Siempre hay al menos una de
distancia y una de velocidad, para que ningun perfil se quede sin poder
completarlas.

---

## Ruta del dia

El worker elige cada dia un tramo con historial suficiente y le pone
`multiplicadorRuta = 2`. Su clasificacion **se muestra aparte y solo cuenta ese
dia**.

Es la pieza mas importante para que alguien abra la web hoy: un ranking que
empieza vacio cada manana es un ranking que puede ganar cualquiera, incluido
quien se registro ayer. Los records historicos del tramo siguen intactos, en su
propia tabla.

---

## Temporadas

- Duracion: **un mes natural**. Cierre automatico el dia 1 a las 00:30.
- Al cerrar: los puntos de temporada se archivan en
  `usuarios/{uid}/temporadas/{YYYY-MM}` y se ponen a cero.
- **No se resetean**: los records de tramo, los kilometros totales historicos ni
  las insignias. Lo que se logro, se queda.
- Se reparten insignias de cierre: podio global, podio de cada modo y podio de
  clanes.

Sin temporadas, quien llega en el mes seis ve una tabla que no va a alcanzar
nunca y se va. Con temporadas, cada mes es una carrera nueva.

---

## Divisiones

Dentro de la temporada, los pilotos se reparten en grupos de unos 30 por nivel:

**Hierro → Bronce → Plata → Oro → Platino → Leyenda**

- Cada semana (lunes 00:45) suben los 5 primeros de cada grupo y bajan los 5
  ultimos.
- Se compite **contra tu grupo**, no contra toda la web.

Esto es lo que hace que competir tenga sentido para alguien normal: en una tabla
unica de 400 personas, el puesto 180 no se mueve nunca y no motiva. En un grupo
de 30, subir de division esta a dos buenos trayectos de distancia.

---

## Clanes y conquista de estaciones

Cada estacion tiene un reparto de **influencia** entre clanes. La influencia ya
no depende solo de tiempos:

```
influencia(clan, estacion) =
    0,40 * presencia   (viajes del clan que tocan la estacion)
  + 0,35 * velocidad   (puntos por posicion en los tramos de la estacion)
  + 0,25 * volumen     (km del clan en tramos de la estacion)
```

Normalizada a 0-100 sobre el total de la estacion.

### Decaimiento

Cada dia, la influencia acumulada se multiplica por **0,97**.

Es la regla que hace que el mapa siga vivo. Sin ella, el primer clan que llega
pinta la ciudad de su color y ahi se queda para siempre: no hay nada que hacer
ni para el que domina ni para el que llega. Con decaimiento, mantener el
territorio exige pedalear esta semana, no la de hace tres meses.

A 0,97 diario, un clan que se para pierde la mitad de su influencia en 23 dias:
lento como para no castigar una semana mala, rapido como para que abandonar se
note.

### Asedio y control

- Un clan **controla** la estacion si supera el 50% de influencia.
- Los miembros del clan que controla ganan `multiplicadorTerritorio = 1,10` en
  los trayectos que tocan esa estacion.

Ese 10% empuja a los clanes a concentrarse en su zona y a defenderla, que es lo
que crea frentes y rivalidades en el mapa en vez de 600 estaciones sueltas.

---

## Antitrampas: que cambia

Anadir distancia y velocidad **no abre** superficie nueva de fraude, porque
ninguna de las dos las declara el usuario: se deducen del par de estaciones y
del tiempo, que son justo los datos que el pipeline de `backend/src/verificacion.js`
ya contrasta contra la captura.

Lo que si hay que revisar:

- El modo Fondo premia acumular km, asi que el incentivo pasa de "falsear un
  tiempo" a "falsear muchos viajes". El limite diario y el tope de km por dia
  son ahora tan importantes como el corte de 25 km/h.
- Las misiones de exploracion premian estaciones nuevas: hay que comprobar que
  la estacion existe de verdad en el GeoJSON y no vale cualquier numero.

---

## Resumen del bucle diario

1. Abro la web y veo **la ruta del dia** y **tres misiones**.
2. Cojo la bici, hago mi trayecto de siempre, subo la captura.
3. En unos minutos esta verificada: sumo puntos en el modo que me toque,
   **mantengo la racha** y avanzo las misiones.
4. Mi clan gana influencia en las dos estaciones que he tocado; si dejamos de
   pedalear, la perdemos.
5. El lunes veo si subo de division. El dia 1 empieza temporada nueva.

Cada paso da una razon distinta para volver manana, y ninguna de ellas exige
correr.
