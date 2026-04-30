# BiciFastness

Plataforma web estatica para competir con tiempos de trayectos de BiciMAD en Madrid.  
Permite registrar viajes con captura, validarlos en panel admin, consultar rankings por ruta, ver rating global de pilotos y clanes, y visualizar dominio territorial de estaciones en mapa.

## Que es exactamente esta web

BiciFastness combina una app social + competitiva con Firebase como backend:

- **Acceso**: login y registro con Firebase Auth.
- **Perfil de piloto**: avatar, historial de viajes, insignias y tarjeta para compartir resultados.
- **Subida de tiempos**: formulario de envio con evidencia visual.
- **Ranking por rutas**: top por tiempo verificado, perfiles publicos y sistema de reporte.
- **BiciRating**: clasificacion global de pilotos y clanes.
- **Clanes**: creacion, solicitudes, membresias y territorio conquistado.
- **Mapa**: estaciones BiciMAD coloreadas por clan dominante usando `estaciones_stats`.
- **Panel admin**: moderacion de tiempos, reportes, insignias, ruta destacada y auditoria asistida por IA (Gemini).

## Estructura actual de rutas (clean URLs)

El proyecto usa metodo por carpetas para Pages:

- `/` -> `index.html` (login)
- `/register/` -> `register/index.html`
- `/home/` -> `home/index.html`
- `/ranking/` -> `ranking/index.html`
- `/bicirating/` -> `bicirating/index.html`
- `/mapa/` -> `mapa/index.html`
- `/clanes/` -> `clanes/index.html`
- `/subir/` -> `subir/index.html`
- `/profile/` -> `profile/index.html`
- `/info/` -> `info/index.html`
- `/admin/` -> `admin/index.html`

Todos los enlaces internos, favicon e imports locales ya estan adaptados para esta estructura.

## Stack tecnico

- HTML + CSS + Vanilla JavaScript (ES Modules)
- Firebase Web SDK 10.8.1
  - Authentication
  - Cloud Firestore
- Leaflet (mapa)
- html2canvas (exportacion visual de tarjeta en perfil)
- Tesseract.js + Gemini API (flujo admin de auditoria)

## Datos principales en Firestore

Colecciones usadas por la app:

- `usuarios`
- `tiempos_viaje`
- `clanes`
- `estaciones_stats`
- `config`
- `reportes`
- `secrets` (API keys para admin)

Ejemplo simplificado de `tiempos_viaje`:

```json
{
  "email_real": "piloto@correo.com",
  "ruta": "080-110",
  "tiempo_segundos": 145,
  "tiempo_formateado": "02m. 25s.",
  "foto_url": "data:image/jpeg;base64,... o URL",
  "verificado": false,
  "fecha": "Timestamp"
}
```

## Configuracion minima recomendada en Firebase

1. Crear proyecto Firebase y habilitar Authentication + Firestore.
2. Cargar las colecciones base usadas por la web.
3. Crear usuario administrador en `usuarios` con `isAdmin: true`.
4. Revisar reglas de seguridad de Firestore para:
   - limitar escrituras de `tiempos_viaje`,
   - proteger `secrets`,
   - restringir operaciones admin.
5. Crear indices que Firestore solicite para consultas por `verificado`, `ruta`, `tiempo_segundos` y `email_real`.

## Seguridad aplicada en frontend

- Validaciones de login/registro endurecidas (formato de email, longitudes, normalizacion).
- Sanitizacion de salidas dinamicas en zonas criticas para reducir riesgo XSS.
- Correccion del filtro de palabras prohibidas (`badwords.js`).
- Flujo de fetch admin con controles de timeout y respuestas invalidas.

Importante: la proteccion real depende de reglas de Firestore/Auth bien configuradas.

## Despliegue (GitHub/GitLab Pages)

Este repositorio es compatible con Pages de proyecto (subruta) gracias a rutas relativas entre secciones.

Pasos basicos:

1. Publicar el repo.
2. Activar Pages desde la rama principal y carpeta raiz.
3. Abrir la URL del proyecto y navegar por `/home/`, `/ranking/`, `/mapa/`, etc.
