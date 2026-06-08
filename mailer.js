const nodemailer = require('nodemailer');

const ADMIN_EMAIL = 'bullstrainingbet@gmail.com, Infobullstraining@gmail.com';

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendMail({ to, subject, text, html, attachments }) {
  if (!transporter) {
    console.log('--- [correo simulado: configura SMTP_HOST/SMTP_USER/SMTP_PASS para enviar de verdad] ---');
    console.log('Para:', to);
    console.log('Asunto:', subject);
    console.log(text);
    if (attachments && attachments.length) console.log(`Adjuntos: ${attachments.map((a) => a.filename).join(', ')}`);
    console.log('---------------------------------------------------------------------------------------');
    return;
  }
  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to, subject, text, html, attachments,
    });
    console.log(`[correo enviado via SMTP] para=${to} asunto="${subject}" messageId=${info.messageId}`);
  } catch (err) {
    console.error(`[ERROR enviando correo via SMTP] para=${to} asunto="${subject}":`, err.message);
    throw err;
  }
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
  let subject;
  let resultLine;
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

module.exports = {
  sendMail,
  notifyNewRegistration,
  notifyPredictionConfirmation,
  notifySettlementResult,
  notifyAccessGranted,
  ADMIN_EMAIL,
};
