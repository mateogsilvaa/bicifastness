// Firebase Function para enviar emails
const admin = require('firebase-admin');
const functions = require('firebase-functions');

// Inicializar Firebase Admin
admin.initializeApp();

// Configuración de SendGrid (recomendado para producción)
const SENDGRID_API_KEY = functions.config().sendgrid.key;
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(SENDGRID_API_KEY);

exports.sendEmailNotification = functions.firestore
    .document('email_queue/{emailId}')
    .onCreate(async (snap, context) => {
        const emailData = snap.data();
        
        if (emailData.processed) {
            return null; // Ya procesado
        }

        try {
            const msg = {
                to: emailData.to,
                from: emailData.from,
                subject: emailData.subject,
                text: emailData.text,
                html: emailData.html,
            };

            // Enviar email con SendGrid
            await sgMail.send(msg);
            
            // Marcar como procesado
            return snap.ref.update({ processed: true, sentAt: admin.firestore.FieldValue.serverTimestamp() });
            
        } catch (error) {
            console.error('Error enviando email:', error);
            
            // Marcar como error
            return snap.ref.update({ 
                processed: true, 
                error: error.message,
                sentAt: admin.firestore.FieldValue.serverTimestamp() 
            });
        }
    });

// Alternativa: Usar Gmail SMTP (para desarrollo/testing)
const nodemailer = require('nodemailer');

const smtpTransport = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: functions.config().gmail.email,
        pass: functions.config().gmail.password
    }
});

exports.sendEmailNotificationGmail = functions.firestore
    .document('email_queue/{emailId}')
    .onCreate(async (snap, context) => {
        const emailData = snap.data();
        
        if (emailData.processed) {
            return null;
        }

        try {
            const mailOptions = {
                from: emailData.from,
                to: emailData.to,
                subject: emailData.subject,
                text: emailData.text,
                html: emailData.html
            };

            const result = await smtpTransport.sendMail(mailOptions);
            
            return snap.ref.update({ 
                processed: true, 
                sentAt: admin.firestore.FieldValue.serverTimestamp() 
            });
            
        } catch (error) {
            console.error('Error enviando email con Gmail:', error);
            
            return snap.ref.update({ 
                processed: true, 
                error: error.message,
                sentAt: admin.firestore.FieldValue.serverTimestamp() 
            });
        }
    });