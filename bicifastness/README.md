# BiciFastness - Ranking de Tiempos BiciMAD

Aplicación web estática para gestionar un ranking de tiempos de BiciMAD usando Firebase.

## Archivos

- `index.html` - **Ranking público**: Muestra los tiempos verificados ordenados de menor a mayor
- `subir.html` - **Formulario de envío**: Para que los usuarios suban sus tiempos con captura de pantalla
- `admin.html` - **Panel de administración**: Login con Firebase Auth para aprobar/rechazar tiempos

## Configuración en Firebase

### 1. Crear índice en Firestore (OBLIGATORIO)

Ve a la consola de Firebase → Firestore Database → Índices y crea el siguiente índice compuesto:

| Colección | Campos | Estado |
|-----------|--------|--------|
| `tiempos_viaje` | `verificado` Ascendente, `tiempo_segundos` Ascendente | Habilitado |
| `tiempos_viaje` | `verificado` Ascendente, `ruta` Ascendente, `tiempo_segundos` Ascendente | Habilitado |

**Alternativa**: La primera vez que cargues la página, verás un error en la consola del navegador con un link directo para crear el índice.

### 2. Crear usuario administrador

En Firebase Console → Authentication → Users:
1. Clic en "Add user"
2. Introduce tu email (ej: `mateogonsilva@gmail.com`) y contraseña
3. Ya podrás usar esas credenciales en `admin.html`

### 3. Reglas de Firestore (recomendado)

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /tiempos_viaje/{document} {
      // Cualquiera puede leer tiempos verificados
      allow read: if resource.data.verificado == true;
      
      // Cualquiera puede crear (con verificado = false)
      allow create: if request.resource.data.verificado == false;
      
      // Solo admin puede actualizar o borrar
      allow update, delete: if request.auth != null;
    }
  }
}
```

### 4. Reglas de Storage (recomendado)

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /capturas/{allPaths=**} {
      // Cualquiera puede subir imágenes
      allow write: if request.resource.size < 10 * 1024 * 1024; // Max 10MB
      
      // Cualquiera puede leer
      allow read: if true;
      
      // Solo admin puede borrar
      allow delete: if request.auth != null;
    }
  }
}
```

## Despliegue en GitHub Pages

1. Crea un repositorio en GitHub
2. Sube los 3 archivos HTML (index.html, subir.html, admin.html)
3. Ve a Settings → Pages
4. En "Source" selecciona "Deploy from a branch"
5. Selecciona la rama `main` y carpeta `/ (root)`
6. Tu sitio estará en `https://tu-usuario.github.io/tu-repo/`

## Estructura de datos en Firestore

Colección: `tiempos_viaje`

```json
{
  "usuario": "MadridSpeedster",
  "ruta": "Legazpi - Casa",
  "tiempo_segundos": 140,
  "tiempo_formateado": "02m. 20s.",
  "foto_url": "https://firebasestorage.googleapis.com/...",
  "verificado": false,
  "fecha": Timestamp
}
```

## Tecnologías

- HTML5 + CSS3 + JavaScript ES6 Modules
- Firebase SDK v10.7.1 (Firestore, Storage, Authentication)
- Google Fonts (Exo 2, Space Grotesk)
- 100% estático, sin servidor backend necesario
