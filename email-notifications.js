// Sistema de notificaciones por email para viajes pendientes
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore, collection, query, where, getDocs, onSnapshot, doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyBG9QdjEG9Qmg27Dy05t0eVcVFMMPpSyVk",
    authDomain: "bicifastness.firebaseapp.com",
    projectId: "bicifastness",
    messagingSenderId: "656116731421",
    appId: "1:656116731421:web:a4154d028fe9721c5800f4"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Configuración de email automática
const EMAIL_CONFIG = {
    adminEmail: 'bicifastness@gmail.com', // Email del admin
    subject: 'Nuevo Viaje Pendiente - BiciFastness',
    fromEmail: 'bicifastness@gmail.com' // Email desde el que se envía
};

// Función para activar automáticamente notificaciones por email
export async function registerEmailNotification() {
    try {
        await setDoc(doc(db, "email_notifications", "admin"), {
            email: EMAIL_CONFIG.adminEmail,
            enabled: true,
            lastSent: null,
            createdAt: serverTimestamp()
        });
        console.log('Notificaciones por email activadas automáticamente para:', EMAIL_CONFIG.adminEmail);
        return true;
    } catch (error) {
        console.error('Error activando email automático:', error);
        return false;
    }
}

// Escuchar NUEVOS viajes pendientes y enviar email (solo cuando se crean)
export function listenForNewTripsWithEmail() {
    const q = query(
        collection(db, "tiempos_viaje"),
        where("verificado", "==", false)
    );

    return onSnapshot(q, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            // Solo enviar email para documentos NUEVOS (no al cargar la página)
            if (change.type === 'added') {
                const newTrip = change.doc.data();
                const tripId = change.doc.id;
                
                // Verificar que es un viaje realmente nuevo (creado en los últimos 10 segundos)
                const tripTime = newTrip.timestamp?.toDate ? newTrip.timestamp.toDate() : new Date(newTrip.timestamp);
                const now = new Date();
                const timeDiff = (now - tripTime) / 1000; // diferencia en segundos
                
                if (timeDiff < 10) { // Solo si se creó hace menos de 10 segundos
                    console.log('Nuevo viaje detectado, enviando email:', newTrip.ruta);
                    sendEmailNotification(newTrip, tripId);
                }
            }
        });
    });
}

// Enviar notificación por email automáticamente
async function sendEmailNotification(tripData, tripId) {
    try {
        // Usar configuración automática
        const adminEmail = EMAIL_CONFIG.adminEmail;
        
        // Evitar spam: no enviar más de un email cada 5 minutos
        const emailConfig = await getDoc(doc(db, "email_notifications", "admin"));
        const lastSent = emailConfig.exists() ? emailConfig.data().lastSent?.toDate() : null;
        const now = new Date();
        if (lastSent && (now - lastSent) < 5 * 60 * 1000) {
            console.log('Email enviado recientemente, esperando...');
            return;
        }

        // Crear documento para enviar email (Firebase Functions lo procesará)
        const emailData = {
            to: adminEmail,
            from: EMAIL_CONFIG.fromEmail,
            subject: EMAIL_CONFIG.subject,
            text: generateEmailText(tripData),
            html: generateEmailHTML(tripData),
            createdAt: serverTimestamp(),
            tripId: tripId,
            processed: false
        };

        await setDoc(doc(db, "email_queue", `${Date.now()}_${tripId}`), emailData);
        
        // Actualizar último envío
        await setDoc(doc(db, "email_notifications", "admin"), {
            email: adminEmail,
            enabled: true,
            lastSent: serverTimestamp()
        }, { merge: true });

        console.log('Email en cola para envío automático:', adminEmail);
        
    } catch (error) {
        console.error('Error enviando email automático:', error);
    }
}

// Generar texto del email
function generateEmailText(tripData) {
    const userName = tripData.nombre_usuario || 'Usuario';
    const route = tripData.ruta;
    const time = tripData.tiempo_formateado || 'Tiempo desconocido';
    const timestamp = tripData.timestamp?.toDate?.() || new Date();
    
    return `
Nuevo viaje pendiente en BiciFastness

Usuario: ${userName}
Ruta: ${route}
Tiempo: ${time}
Fecha: ${timestamp.toLocaleString('es-ES')}

Para revisar este viaje, entra al panel de administración:
https://bicifastness.es/admin/

--
BiciFastness - Sistema de Notificaciones
    `;
}

// Generar HTML del email
function generateEmailHTML(tripData) {
    const userName = tripData.nombre_usuario || 'Usuario';
    const route = tripData.ruta;
    const time = tripData.tiempo_formateado || 'Tiempo desconocido';
    const timestamp = tripData.timestamp?.toDate?.() || new Date();
    const tripImage = tripData.imagen || null;
    
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #0071c3; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background: #f9f9f9; padding: 20px; border: 1px solid #ddd; border-top: none; }
        .trip-info { background: white; padding: 15px; margin: 15px 0; border-radius: 5px; border-left: 4px solid #0071c3; }
        .btn { display: inline-block; background: #0071c3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        .footer { text-align: center; color: #666; font-size: 12px; margin-top: 20px; }
        .trip-image { max-width: 100%; border-radius: 5px; margin-top: 10px; }
    </style>
</head>
<body>
    <div class="header">
        <h1>¡Nuevo viaje pendiente! </h1>
        <p>Alguien ha subido un viaje que necesita tu revisión</p>
    </div>
    
    <div class="content">
        <div class="trip-info">
            <h3>Detalles del Viaje:</h3>
            <p><strong>Usuario:</strong> ${userName}</p>
            <p><strong>Ruta:</strong> ${route}</p>
            <p><strong>Tiempo:</strong> ${time}</p>
            <p><strong>Fecha:</strong> ${timestamp.toLocaleString('es-ES')}</p>
            ${tripImage ? `<img src="${tripImage}" alt="Imagen del viaje" class="trip-image">` : ''}
        </div>
        
        <a href="https://bicifastness.es/admin/" class="btn">Revisar Viaje Ahora</a>
        
        <p style="color: #666; font-size: 14px;">Este email se envió automáticamente porque hay un viaje pendiente de revisión.</p>
    </div>
    
    <div class="footer">
        <p>BiciFastness - Sistema de Notificaciones</p>
        <p>Si no quieres recibir estos emails, desactiva las notificaciones en el panel de administración.</p>
    </div>
</body>
</html>
    `;
}

// Función para activar/desactivar notificaciones por email
export async function toggleEmailNotifications(enabled, adminEmail) {
    try {
        await setDoc(doc(db, "email_notifications", "admin"), {
            email: adminEmail,
            enabled: enabled,
            updatedAt: serverTimestamp()
        }, { merge: true });
        
        return true;
    } catch (error) {
        console.error('Error cambiando estado de notificaciones:', error);
        return false;
    }
}

// Obtener estado actual de notificaciones por email
export async function getEmailNotificationStatus() {
    try {
        const docSnap = await getDoc(doc(db, "email_notifications", "admin"));
        return docSnap.exists() ? docSnap.data() : { enabled: false, email: null };
    } catch (error) {
        console.error('Error obteniendo estado:', error);
        return { enabled: false, email: null };
    }
}
