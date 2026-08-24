# Migrar los datos de la v1

Los datos de produccion siguen siendo los de la v1. Este documento es el guion
para pasarlos al modelo v2 sin perder nada y sin dejar la fuga abierta a medias.

Lo ejecuta `scripts/migrar-datos.js`. Aqui esta el **orden**, el **porque** y el
**camino de vuelta**.

## Que cambia

| v1 | v2 | Por que |
|---|---|---|
| `usuarios` indexado por email | indexado por uid | El id era adivinable: cualquiera podia escribir el documento de otro. Fue una de las causas de la escalada de privilegios |
| `email_real` dentro del viaje | nada; el correo vive en Firebase Auth | Un viaje verificado es publico. Con el correo dentro, publico significaba publicar 1.022 direcciones (#59) |
| `foto_url` con la captura en base64 | coleccion `capturas`, solo administracion | Igual: la captura de un trayecto es un dato personal, y ademas hacia que cada lectura del ranking arrastrase megas |
| `tiempo_segundos`, `nombre_usuario`… | camelCase | Coherencia con el resto del modelo |
| sin distancia | `distanciaMetros`, `velocidadKmh`, `distanciaEstimada` | Sin esto el modo Fondo arranca como si nadie hubiera pedaleado nunca (#6, #17) |
| `biciRating` de la v1 | temporada archivada `v1` | Ni se suma ni se tira. Ver abajo |

## Los puntos de la v1

**No se suman a la temporada en curso y no se tiran.** Se archivan como una
temporada mas, con identificador `v1`, en `usuarios/{uid}/temporadas/v1`.

Las tres opciones y por que esta:

- **Sumarlos** daria ventaja de salida a quien ya estaba, y medida con otras
  reglas: la v1 solo puntuaba ir rapido, la v2 puntua tres modos.
- **Tirarlos** es decirle a alguien con dos años de viajes que no cuentan.
- **Archivarlos** los deja visibles en el perfil, junto a las temporadas
  mensuales que vengan despues, sin que valgan para la clasificacion de hoy.

El identificador es `v1` a proposito, y no un mes: las temporadas de la v2 son
meses naturales (`2026-08`), asi que uno que no puede colisionar con ninguno
real deja claro de un vistazo que esos puntos vienen de otro juego.

Va en la subcoleccion del propio usuario, igual que hace `backend/src/temporadas.js`
al cerrar un mes: asi el historial se borra con su cuenta y no hay que ir a
buscarlo a otro sitio cuando alguien ejerce el derecho de supresion.

## La distancia de los viajes historicos

`distancias.resolver()` — el mismo modulo que usa el worker — devuelve la
distancia de la tabla precalculada (#6) cuando el par de estaciones esta, y cae
a la estimacion de linea recta por el factor de trama urbana cuando no.

Los viajes resueltos por estimacion quedan marcados con `distanciaEstimada:
true`. Que quede marcado importa: es la diferencia entre un kilometraje medido y
uno deducido, y quien mire su perfil tiene derecho a saber cual esta viendo.

La salida de `--simular` dice cuantos caen de cada lado. Si el reparto sale muy
escorado hacia la estimacion, merece la pena correr `scripts/build-distancias.js`
sobre los pares que aparecen en viajes reales **antes** de aplicar.

## El orden

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/ruta/serviceAccountKey.json

# 1. Copia de seguridad. No es opcional: ver "camino de vuelta".
node scripts/migrar-datos.js --copia copia-$(date +%F).json

# 2. Ensayo en seco. No escribe nada.
node scripts/migrar-datos.js --simular

# 3. Solo si la salida del ensayo cuadra.
node scripts/migrar-datos.js --aplicar

# 4. Comprobar que no queda nada sucio.
node scripts/migrar-datos.js --comprobar
```

El paso 4 es el que dice si ya se puede restaurar la lectura publica de
`tiempos_viaje`. Devuelve codigo de salida 0 solo si esta todo limpio, asi que
sirve tal cual en un script.

## Camino de vuelta

**`migrarViajes` hace `set` sin `merge`**, o sea que reemplaza el documento
entero. Es precisamente lo que hace desaparecer `email_real` y `foto_url` — con
`merge` se quedarian ahi y la fuga con ellos — y tambien lo que significa que
**no hay vuelta atras sin la copia**.

Si algo sale mal:

1. Para el worker (`vars.MANTENIMIENTO` a `true` y el workflow desactivado), para
   que no siga escribiendo encima.
2. Restaura desde `copia-AAAA-MM-DD.json`, que lleva las dos colecciones enteras
   con sus ids.
3. **No** restaures a la vez la regla de lectura publica: los documentos
   restaurados vuelven a llevar los datos personales dentro.

## El fichero de copia lleva la brecha dentro

Ese JSON contiene los 1.022 correos y las capturas en base64. Es exactamente el
material del incidente, en un fichero suelto y sin ninguna regla que lo proteja.

- Cifralo.
- Guardalo fuera del repositorio.
- Borralo en cuanto la migracion se de por buena.
- No lo dejes en Descargas.

El script se niega a sobrescribir una copia que ya exista (`flag: 'wx'`):
perderla por lanzar el comando dos veces seria la forma tonta de quedarse sin
red debajo.

## Avisar a los usuarios de la v1

Cuando la migracion este dada por buena, hay que decirselo. No es cortesia: la
gente que subio viajes en la v1 no sabe que ha pasado con ellos, y la primera
vez que entren van a ver una clasificacion en la que no aparecen.

Lo que tiene que decir el correo:

- Su historial **sigue ahi**, archivado como temporada `v1`, visible en su
  perfil.
- La temporada en curso empieza a cero **para todo el mundo**, tambien para
  quien llevaba dos años.
- Sus kilometros historicos ya estan calculados, y cuales son estimados.
- Si hubo brecha de datos y se les notifico (#59), esto **no** la sustituye: son
  dos comunicaciones distintas y con obligaciones distintas.

El envio va por el worker, con `backend/src/correo.js` y una plantilla en
`backend/src/plantillas.js`, para que respete las preferencias de correo y la
baja (#47). **No lo mandes desde un cliente de correo a mano**: eso se salta la
baja de quien ya la haya pedido.
