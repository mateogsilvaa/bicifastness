const admin = require('firebase-admin');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const nodemailer = require('nodemailer');

admin.initializeApp();

// Configuración corregida y optimizada para Gmail
const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // Use SSL
    auth: {
        user: 'bicifastness@gmail.com',
        pass: 'rnvc jdpe mrsw vzjy' // Tu clave de aplicación
    }
});

// --- Tus funciones de generación de HTML y Text están PERFECTAS, mantenlas igual ---

function generateEmailHTML(tripData) {
    const userName = tripData.nombre_usuario || 'Usuario';
    const route = tripData.ruta || 'Ruta desconocida';
    const time = tripData.tiempo_formateado || 'Tiempo desconocido';
    const timestamp = tripData.timestamp?.toDate ? tripData.timestamp.toDate() : new Date();
    
    return `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background: #0071c3; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; font-size: 24px;">¡Nuevo viaje pendiente!</h1>
    </div>
    <div style="background: #f9f9f9; padding: 20px; border: 1px solid #ddd; border-top: none;">
        <div style="background: white; padding: 15px; border-left: 4px solid #0071c3;">
            <p><strong>Usuario:</strong> ${userName}</p>
            <p><strong>Ruta:</strong> ${route}</p>
            <p><strong>Tiempo:</strong> ${time}</p>
            <p><strong>Fecha:</strong> ${timestamp.toLocaleString('es-ES')}</p>
        </div>
        <div style="text-align: center; margin: 20px 0;">
            <a href="https://bicifastness.es/admin/" style="background: #0071c3; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold;">Revisar Viaje</a>
        </div>
    </div>
</body>
</html>`;
}

function generateEmailText(tripData) {
    const userName = tripData.nombre_usuario || 'Usuario';
    const route = tripData.ruta || 'Ruta desconocida';
    const time = tripData.tiempo_formateado || 'Tiempo desconocido';
    const timestamp = tripData.timestamp?.toDate ? tripData.timestamp.toDate() : new Date();
    return `Nuevo viaje pendiente: ${userName} en ${route} (${time}). Revisar en: https://bicifastness.es/admin/`;
}

// Trigger principal
exports.sendEmailNotification = onDocumentCreated('tiempos_viaje', async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    
    const tripData = snapshot.data();
    
    // Si ya está verificado, no molestamos
    if (tripData.verificado === true) return;
    
    try {
        const mailOptions = {
            from: '"BiciFastness" <bicifastness@gmail.com>',
            to: 'bicifastness@gmail.com',
            subject: `🚲 Nuevo viaje de ${tripData.nombre_usuario || 'Usuario'}`,
            text: generateEmailText(tripData),
            html: generateEmailHTML(tripData)
        };
        
        await transporter.sendMail(mailOptions);
        console.log('✅ Email enviado correctamente');
    } catch (error) {
        console.error('❌ Error enviando email:', error);
    }
});