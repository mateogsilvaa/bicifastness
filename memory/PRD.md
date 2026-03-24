# BiciFastness - Product Requirements Document

## Original Problem Statement
Aplicación web estática para alojar en GitHub Pages. Ranking de tiempos de BiciMAD usando Firebase (Firestore, Storage, Authentication).

## Architecture
- **Frontend**: HTML5 + CSS3 + JavaScript ES6 Modules (100% estático)
- **Backend**: Firebase (Firestore, Storage, Auth)
- **Hosting**: GitHub Pages

## User Personas
1. **Ciclista BiciMAD**: Sube sus tiempos con capturas de pantalla
2. **Administrador**: Verifica y aprueba/rechaza tiempos enviados
3. **Visitante**: Consulta el ranking público

## Core Requirements (Static)
- [x] Ranking de tiempos ordenados por tiempo_segundos (menor a mayor)
- [x] Filtro por ruta (Legazpi - Casa, Méndez Álvaro - Casa)
- [x] Formulario de subida con imagen
- [x] Panel admin con login
- [x] Solo mostrar verificado=true en ranking

## What's Been Implemented
**Date: 2026-03-24**
- index.html: Ranking público con filtro, medallas, modal para fotos
- subir.html: Formulario completo con validación, upload a Storage
- admin.html: Login con Firebase Auth, aprobar/rechazar tiempos
- README.md: Instrucciones de configuración y despliegue

## Prioritized Backlog
### P0 (Crítico - Usuario debe hacer)
- Crear índice compuesto en Firestore
- Crear usuario admin en Firebase Auth
- Configurar reglas de seguridad

### P1 (Mejoras)
- Notificaciones por email para nuevos tiempos
- Estadísticas de tiempos promedio
- Gráficos de rendimiento

### P2 (Futuro)
- PWA / offline support
- Múltiples rutas personalizables
- Sistema de comentarios

## Next Tasks
1. Despliegue en GitHub Pages
2. Pruebas con datos reales
3. Ajustar reglas de seguridad según uso
