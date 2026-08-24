# Despliegue

El sitio se sirve desde **Vercel**, conectado a la rama `main` de este repositorio.

## Por que Vercel y no GitHub Pages

Pages no permite configurar cabeceras HTTP. Eso costaba las seis cabeceras de
seguridad que el proyecto se toma en serio despues del compromiso de la v1
(CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
`Permissions-Policy`). Vercel las da gratis, sin tarjeta ni dominio propio.

El frontend es HTML y modulos ES sin paso de compilacion, y `assets/data/` esta
versionado: Vercel solo tiene que servir ficheros, sin `buildCommand`.

## `vercel.json`: la trampa de los comentarios

**El fichero no admite claves que el esquema no conozca.** Durante un tiempo
llevaba comentarios dentro con la convencion de la clave `"//"`:

```json
{
  "//": ["El sitio se sirve desde Vercel...", "..."],
  "cleanUrls": true
}
```

Es JSON perfectamente valido, asi que ni el lint ni los tests lo veian. Pero
Vercel rechaza el despliegue antes de empezar:

```
The vercel.json schema validation failed: should NOT have additional property "//"
```

Y como falla en la validacion, **ningun despliegue llega a construirse**: el
panel se llena de builds en ERROR y el sitio se queda con la ultima version que
si salio, sin que nada avise.

Por eso las explicaciones viven en este fichero y no dentro del JSON, y por eso
hay una prueba de regresion (`backend/test/regresiones.test.js`) que solo admite
las claves de una lista escrita a mano. Si alguien anade una clave nueva, tiene
que anadirla tambien a esa lista, que es el momento de comprobar si Vercel la
conoce.

## Modo mantenimiento

El bloque `redirects` manda todo a `/mantenimiento/`:

```json
"redirects": [
  { "source": "/((?!mantenimiento|images/).*)", "destination": "/mantenimiento/", "permanent": false }
]
```

Dos detalles que importan:

- En Vercel los redirects se evaluan **antes** del sistema de ficheros, asi que
  tapan tambien las paginas que existen. Sin eso, entrar a `/admin/` escribiendo
  la URL seguiria funcionando.
- `"permanent": false` es un 307, no un 308. Un 308 se cachea en el navegador y
  la gente se quedaria en la pagina de obras despues de abrir el sitio.

**Para volver a abrir la web:** borra el bloque `redirects` entero y haz push.
No hace falta tocar nada mas.

**Para volver a obras:** vuelve a ponerlo. Menos de cinco minutos, que es el
criterio de #7.

## Lo que NO se publica

`.vercelignore` deja fuera `backend/`, `scripts/`, `shared/`, `.github/`, los
`*.md`, la configuracion de Firebase y `firestore.rules`. La version anterior
desplegaba el repositorio entero, asi que el codigo del backend y los scripts de
administracion quedaban accesibles por URL.

Cuidado con la forma del patron: igual que en `.gitignore`, `scripts/` excluye el
**directorio**, y entonces una excepcion `!scripts/algo.js` no sirve de nada. Si
algun dia hace falta publicar un fichero de ahi dentro, hay que excluir el
contenido (`scripts/*`) y luego hacer la excepcion.

`data/` **si** se publica: el mapa lee `/data/emt.geojson`.

## Firebase Hosting

Sigue existiendo (`firebase.json`, `firebase.mantenimiento.json`) y el CI lo
despliega, pero la web de verdad es la de Vercel. Lo que importa de ese paso del
CI son **las reglas de Firestore**, que se despliegan siempre, tambien en modo
mantenimiento: Firestore es un servicio aparte y responde aunque la web no se
sirva. Ver #59.
