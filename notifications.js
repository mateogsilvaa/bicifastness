// Sistema de notificaciones push para viajes pendientes
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore, collection, query, where, getDocs, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyBG9QdjEG9Qmg27Dy05t0eVcVFMMPpSyVk",
    authDomain: "bicifastness.firebaseapp.com",
    projectId: "bicifastness",
    messagingSenderId: "656116731421",
    appId: "1:656116731421:web:a4154d028fe9721c5800f4"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Función para registrar notificaciones push
export async function registerForNotifications() {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
        try {
            // Registrar service worker
            const registration = await navigator.serviceWorker.register('/sw.js');
            
            // Solicitar permiso
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                console.log('Permiso de notificación denegado');
                return false;
            }

            // Suscribirse a notificaciones push
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: 'TU_VAPID_PUBLIC_KEY' // Necesitarás generar esto
            });

            // Guardar suscripción en Firestore
            await saveSubscription(subscription);
            return true;
        } catch (error) {
            console.error('Error registrando notificaciones:', error);
            return false;
        }
    }
    return false;
}

// Guardar suscripción del usuario
async function saveSubscription(subscription) {
    const subscriptionData = {
        endpoint: subscription.endpoint,
        keys: {
            p256dh: subscription.keys.p256dh,
            auth: subscription.keys.auth
        },
        timestamp: new Date()
    };

    // Guardar en una colección de suscripciones
    await setDoc(doc(db, "notification_subscriptions", subscription.endpoint), subscriptionData);
}

// Escuchar nuevos viajes pendientes
export function listenForNewTrips(callback) {
    const q = query(
        collection(db, "tiempos_viaje"),
        where("verificado", "==", false)
    );

    return onSnapshot(q, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
                const newTrip = change.doc.data();
                callback(newTrip, change.doc.id);
            }
        });
    });
}

// Enviar notificación local
export function showLocalNotification(title, body, url = null) {
    if ('Notification' in window && Notification.permission === 'granted') {
        const options = {
            body: body,
            icon: '/images/logo.png',
            badge: '/images/logo.png',
            vibrate: [200, 100, 200],
            data: { url: url }
        };

        const notification = new Notification(title, options);
        
        if (url) {
            notification.onclick = () => {
                window.open(url, '_blank');
                notification.close();
            };
        }

        // Auto-cerrar después de 5 segundos
        setTimeout(() => notification.close(), 5000);
    }
}

// Notificación de sonido (opcional)
export function playNotificationSound() {
    const audio = new Audio('/sounds/notification.mp3');
    audio.volume = 0.3;
    audio.play().catch(e => console.log('No se pudo reproducir sonido:', e));
}
