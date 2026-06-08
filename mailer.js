const nodemailer = require('nodemailer');
const https = require('https');

const ADMIN_EMAIL = 'bullstrainingbet@gmail.com, Infobullstraining@gmail.com';

// ---------------------------------------------------------------------------
// Brevo HTTP API (puerto 443, funciona en Render free tier)
// ---------------------------------------------------------------------------
function sendViaBrevoAPI({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    const recipients = to.split(',').map((e) => ({ email: e.trim() }));
    const body = Buffer.from(JSON.stringify({
      sender: {
        name: process.env.BREVO_SENDER_NAME || 'Bulls Training',
        email: process.env.BREVO_SENDER_EMAIL || process.env.SMTP_FROM || process.env.SMTP_USER,
      },
      to: recipients,
      subject,
      textContent: text,
    }));

    const req = https.request({
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[correo enviado via Brevo API] para=${to} asunto="${subject}"`);
          resolve();
        } else {
          reject(new Error(`Brevo API ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// SMTP fallback (para desarrollo local)
// ---------------------------------------------------------------------------
let transporter = null;
if (!process.env.BREVO_API_KEY && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendMail({ to, subject, text }) {
  if (process.env.BREVO_API_KEY) {
    return sendViaBrevoAPI({ to, subject, text });
  }

  if (transporter) {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to, subject, text,
    });
    console.log(`[correo enviado via SMTP] para=${to} asunto="${subject}" messageId=${info.messageId}`);
    return;
  }

  console.log('--- [correo simulado: agrega BREVO_API_KEY en Render para enviar de verdad] ---');
  console.log('Para:', to);
  console.log('Asunto:', subject);
  console.log(text);
  console.log('--------------------------------------------------------------------------------');
}

function notifyNewRegistration({ user }) {
  const subject = `Nuevo registro pendiente de validacion: ${user.name}`;
  const text = [
    `Se registro una nueva persona y esta a la espera de validacion.`,
    ``,
    `Datos del usuario:`,
    `Nombre: ${user.name}`,
    `RUT: ${user.rut}`,
    `Direccion: ${user.address}`,
    `Correo: ${user.email}`,
    `Telefono: ${user.phone}`,
    `Comentarios: ${user.comments || '(sin comentarios)'}`,
    ``,
    `Ingresa al panel de administracion para validarlo y asignarle Bulls.`,
  ].join('\n');
  return sendMail({ to: ADMIN_EMAIL, subject, text });
}

function notifyAccessGranted({ user, link }) {
  const subject = `Tu acceso para pronosticar ya esta disponible`;
  const text = [
    `Hola ${user.name},`,
    ``,
    `Tus datos fueron validados y se te asignaron ${user.bulls} Bulls para pronosticar.`,
    `Ingresa con tu link personal para ver las peleas disponibles y registrar tu pronostico:`,
    ``,
    link,
    ``,
    `Este link es personal e intransferible.`,
  ].join('\n');
  return sendMail({ to: user.email, subject, text });
}

function notifyPredictionConfirmation({ user, fight, fighter, bulls }) {
  const subject = `Confirmacion de tu pronostico: ${fight.fighterA} vs ${fight.fighterB}`;
  const text = [
    `Hola ${user.name},`,
    ``,
    `Registramos tu pronostico correctamente.`,
    ``,
    `Pelea: ${fight.fighterA} vs ${fight.fighterB} (${fight.date})`,
    `Tu pronostico: ${fighter}`,
    `Bulls arriesgados: ${bulls}`,
    `Saldo restante: ${user.bulls} Bulls`,
    ``,
    `Te avisaremos por correo cuando la pelea finalice con el resultado.`,
  ].join('\n');
  return sendMail({ to: user.email, subject, text });
}

function notifySettlementResult({ user, fight, fighter, bulls, result, payout }) {
  let subject, resultLine;
  if (result === 'won') {
    subject = `Ganaste tu pronostico: ${fight.fighterA} vs ${fight.fighterB}`;
    resultLine = `Acertaste tu pronostico por ${fighter} y ganaste ${payout} Bulls.`;
  } else if (result === 'refunded') {
    subject = `Pelea sin contrincante: se reembolsaron tus Bulls`;
    resultLine = `Nadie aposto por el peleador contrario, asi que se te reembolsaron tus ${payout} Bulls.`;
  } else {
    subject = `Resultado de tu pronostico: ${fight.fighterA} vs ${fight.fighterB}`;
    resultLine = `Esta vez no acertaste tu pronostico por ${fighter}.`;
  }
  const text = [
    `Hola ${user.name},`,
    ``,
    `La pelea ${fight.fighterA} vs ${fight.fighterB} (${fight.date}) ya finalizo.`,
    `Gano: ${fight.noContest ? 'sin contrincante (reembolso a todos)' : fight.winner}`,
    ``,
    resultLine,
    `Tu pronostico: ${fighter} (${bulls} Bulls)`,
    `Tu saldo actual: ${user.bulls} Bulls`,
  ].join('\n');
  return sendMail({ to: user.email, subject, text });
}

module.exports = {
  sendMail,
  notifyNewRegistration,
  notifyAccessGranted,
  notifyPredictionConfirmation,
  notifySettlementResult,
  ADMIN_EMAIL,
};
