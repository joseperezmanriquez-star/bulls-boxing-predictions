require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');

const db = require('./db');
const mailer = require('./mailer');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'bulls-admin';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// Formats Bulls amounts with thousands separators (e.g. 100000 -> "100.000")
app.locals.fmt = (n) => Number(n || 0).toLocaleString('es-CL');

// ---------------------------------------------------------------------------
// Generador de trafico (mantiene el servicio despierto en planes con sleep)
// ---------------------------------------------------------------------------
const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000;
let keepAliveTimer = null;

function selfPing() {
  const target = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const client = target.startsWith('https') ? https : http;
  client.get(target, (res) => res.resume()).on('error', () => {});
}

function startKeepAlive() {
  if (keepAliveTimer) return;
  selfPing();
  keepAliveTimer = setInterval(selfPing, KEEPALIVE_INTERVAL_MS);
}

function stopKeepAlive() {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

// ---------------------------------------------------------------------------
// Registro publico (sin cuenta)
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.render('registro', { error: null });
});

app.post('/registro', async (req, res) => {
  const { name, rut, address, email, phone, comments } = req.body;
  if (!name || !rut || !address || !email || !phone) {
    return res.render('registro', { error: 'Por favor completa todos los campos obligatorios.' });
  }
  const user = db.createUser({ name, rut, address, email, phone, comments });
  mailer.notifyNewRegistration({ user }).catch((err) =>
    console.error('[mailer] Error al notificar registro:', err.message)
  );
  res.redirect('/espera/' + user.id);
});

app.get('/espera/:id', (req, res) => {
  const user = db.getUser(req.params.id);
  if (!user) return res.status(404).send('Usuario no encontrado');
  if (user.status === 'validated' && user.accessToken) {
    return res.redirect('/apostar/' + user.accessToken);
  }
  res.render('espera', { user });
});

// ---------------------------------------------------------------------------
// Acceso personal para pronosticar (link unico enviado por correo)
// ---------------------------------------------------------------------------
app.get('/apostar/:token', (req, res) => {
  const user = db.getUserByToken(req.params.token);
  if (!user) return res.status(404).send('Link invalido o expirado.');
  res.render('apostar', {
    user, token: req.params.token, fights: db.listFights(), message: null, error: null,
  });
});

app.post('/apostar/:token', async (req, res) => {
  const user = db.getUserByToken(req.params.token);
  if (!user) return res.status(404).send('Link invalido o expirado.');

  const { fightId, fighter, bulls } = req.body;
  const fight = db.getFight(fightId);
  const amount = parseInt(bulls, 10);

  const renderWith = (error, message) => res.render('apostar', {
    user: db.getUser(user.id), token: req.params.token, fights: db.listFights(), message, error,
  });

  if (!fight) return renderWith('Pelea no encontrada.', null);
  if (fight.status !== 'open') return renderWith('Esta pelea ya no acepta pronosticos.', null);
  if (fighter !== fight.fighterA && fighter !== fight.fighterB) {
    return renderWith('Peleador invalido.', null);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return renderWith('Ingresa una cantidad valida de Bulls.', null);
  }

  let prediction;
  try {
    prediction = db.createPrediction({ userId: user.id, fightId: fight.id, fighter, bulls: amount });
  } catch (err) {
    return renderWith(err.message, null);
  }

  mailer.notifyPredictionConfirmation({ user: db.getUser(user.id), fight, fighter, bulls: amount })
    .catch((err) => console.error('[mailer] Error al notificar pronostico:', err.message));
  broadcastFightStats(fight.id);

  return res.redirect('/monitor');
});

// ---------------------------------------------------------------------------
// Administracion
// ---------------------------------------------------------------------------
const adminSessions = new Set();

function adminAuth(req, res, next) {
  const sid = req.headers.cookie && req.headers.cookie.split('; ').find((c) => c.startsWith('admin_sid='));
  const token = sid ? sid.split('=')[1] : null;
  if (token && adminSessions.has(token)) return next();
  return res.redirect('/admin/login');
}

app.get('/admin/login', (req, res) => {
  res.render('admin/login', { error: null });
});

app.post('/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) {
    return res.render('admin/login', { error: 'Clave incorrecta.' });
  }
  const token = require('crypto').randomBytes(16).toString('hex');
  adminSessions.add(token);
  res.setHeader('Set-Cookie', `admin_sid=${token}; HttpOnly; Path=/; SameSite=Lax`);
  res.redirect('/admin');
});

app.get('/admin/logout', (req, res) => {
  const sid = req.headers.cookie && req.headers.cookie.split('; ').find((c) => c.startsWith('admin_sid='));
  if (sid) adminSessions.delete(sid.split('=')[1]);
  res.setHeader('Set-Cookie', 'admin_sid=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/admin/login');
});

app.get('/admin', adminAuth, (req, res) => {
  const fights = db.listFights();
  const users = db.listUsers();
  const predictions = db.listPredictions().slice().reverse();
  const stats = {};
  const settlements = {};
  fights.forEach((f) => {
    stats[f.id] = db.fightStats(f.id);
    if (f.status === 'settled') settlements[f.id] = db.fightSettlement(f.id);
  });

  const fightRows = fights.map((f) => {
    const s = stats[f.id];
    const betsCount = predictions.filter((p) => p.fightId === f.id).length;
    const commission = f.status === 'settled' ? f.commission : Math.round(s.total * 0.15);
    return {
      fight: f,
      fighterA: f.fighterA,
      fighterB: f.fighterB,
      totalA: s.totals[f.fighterA],
      totalB: s.totals[f.fighterB],
      totalPool: s.total,
      betsCount,
      commission,
    };
  });

  const summary = {
    totalUsers: users.length,
    validatedUsers: users.filter((u) => u.status === 'validated').length,
    pendingUsers: users.filter((u) => u.status === 'pending').length,
    bullsInPlay: users.reduce((acc, u) => acc + u.bulls, 0),
    totalBets: predictions.length,
    totalWagered: fightRows.reduce((acc, r) => acc + r.totalPool, 0),
    commissionEarned: fightRows
      .filter((r) => r.fight.status === 'settled')
      .reduce((acc, r) => acc + r.commission, 0),
    openFights: fights.filter((f) => f.status === 'open').length,
    closedFights: fights.filter((f) => f.status === 'closed').length,
    settledFights: fights.filter((f) => f.status === 'settled').length,
  };

  res.render('admin/dashboard', {
    fights,
    users,
    predictions,
    stats,
    settlements,
    fightRows,
    summary,
    trafficActive: !!keepAliveTimer,
    message: req.query.message || null,
    error: req.query.error || null,
  });
});

app.post('/admin/trafico/iniciar', adminAuth, (req, res) => {
  startKeepAlive();
  res.redirect('/admin?message=' + encodeURIComponent('Generador de trafico activado.'));
});

app.post('/admin/trafico/detener', adminAuth, (req, res) => {
  stopKeepAlive();
  res.redirect('/admin?message=' + encodeURIComponent('Generador de trafico detenido.'));
});

app.post('/admin/peleas', adminAuth, (req, res) => {
  const { fighterA, fighterB, date } = req.body;
  if (!fighterA || !fighterB || !date) {
    return res.redirect('/admin?error=' + encodeURIComponent('Completa peleador A, B y fecha.'));
  }
  const fight = db.createFight({ fighterA, fighterB, date });
  broadcastFightsList();
  broadcastFightStats(fight.id);
  res.redirect('/admin?message=' + encodeURIComponent('Pelea agregada correctamente.'));
});

app.post('/admin/usuarios/:id/validar', adminAuth, async (req, res) => {
  const bulls = parseInt(req.body.bulls, 10);
  if (!Number.isFinite(bulls) || bulls < 0) {
    return res.redirect('/admin?error=' + encodeURIComponent('Cantidad de Bulls invalida.'));
  }
  const user = db.validateUserAndAssignBulls(req.params.id, bulls);
  if (!user) return res.redirect('/admin?error=' + encodeURIComponent('Usuario no encontrado.'));

  const link = `${req.protocol}://${req.get('host')}/apostar/${user.accessToken}`;
  mailer.notifyAccessGranted({ user, link })
    .catch((err) => console.error('[mailer] Error al enviar link de acceso:', err.message));

  res.redirect('/admin?message=' + encodeURIComponent(`Usuario ${user.name} validado, se le asignaron ${bulls} Bulls y se envio el link de acceso a su correo.`));
});

app.post('/admin/usuarios/:id/ajustar', adminAuth, (req, res) => {
  const delta = parseInt(req.body.delta, 10);
  if (!Number.isFinite(delta)) {
    return res.redirect('/admin?error=' + encodeURIComponent('Ajuste invalido.'));
  }
  const user = db.adjustBulls(req.params.id, delta);
  if (!user) return res.redirect('/admin?error=' + encodeURIComponent('Usuario no encontrado.'));
  res.redirect('/admin?message=' + encodeURIComponent(`Saldo de ${user.name} ajustado. Nuevo saldo: ${user.bulls} Bulls.`));
});

app.post('/admin/usuarios/:id/eliminar', adminAuth, (req, res) => {
  const user = db.getUser(req.params.id);
  if (!user) return res.redirect('/admin?error=' + encodeURIComponent('Usuario no encontrado.'));
  db.deleteUser(req.params.id);
  res.redirect('/admin?message=' + encodeURIComponent(`Se elimino a ${user.name} y sus pronosticos asociados.`));
});

app.post('/admin/peleas/:id/eliminar', adminAuth, (req, res) => {
  const fight = db.getFight(req.params.id);
  if (!fight) return res.redirect('/admin?error=' + encodeURIComponent('Pelea no encontrada.'));
  db.deleteFight(req.params.id);
  broadcastFightsList();
  res.redirect('/admin?message=' + encodeURIComponent(`Se elimino la pelea ${fight.fighterA} vs ${fight.fighterB} y sus pronosticos asociados.`));
});

app.post('/admin/peleas/:id/cerrar', adminAuth, (req, res) => {
  const fight = db.closeFight(req.params.id);
  if (!fight) return res.redirect('/admin?error=' + encodeURIComponent('Pelea no encontrada.'));
  broadcastFightsList();
  res.redirect('/admin?message=' + encodeURIComponent(`Apuestas cerradas para ${fight.fighterA} vs ${fight.fighterB}. Ya no se aceptan nuevos pronosticos.`));
});

app.post('/admin/peleas/:id/finalizar', adminAuth, async (req, res) => {
  const { winner } = req.body;
  let fight;
  try {
    fight = db.settleFight(req.params.id, winner);
  } catch (err) {
    return res.redirect('/admin?error=' + encodeURIComponent(err.message));
  }
  if (!fight) return res.redirect('/admin?error=' + encodeURIComponent('Pelea no encontrada.'));
  broadcastFightsList();
  broadcastFightStats(fight.id);

  const settlement = db.fightSettlement(fight.id);
  const allPreds = [...settlement.winners, ...settlement.losers, ...settlement.refunded];
  for (const p of allPreds) {
    if (!p.user) continue;
    mailer.notifySettlementResult({
      user: p.user, fight, fighter: p.fighter, bulls: p.bulls, result: p.result, payout: p.payout,
    }).catch((err) => console.error('[mailer] Error al notificar resultado:', err.message));
  }

  const msg = fight.noContest
    ? `Pelea finalizada como sin contrincante: se devolvieron los Bulls a todos los participantes.`
    : `Pelea finalizada. Gano ${winner}. Comision (15%): ${fight.commission} Bulls. Pozo neto repartido entre los aciertos.`;
  res.redirect('/admin?message=' + encodeURIComponent(msg));
});

// ---------------------------------------------------------------------------
// Monitor en tiempo real
// ---------------------------------------------------------------------------
app.get('/monitor', (req, res) => {
  res.render('monitor');
});

function broadcastFightsList() {
  io.emit('fights', db.listFights());
}

function broadcastFightStats(fightId) {
  const stats = db.fightStats(fightId);
  if (stats) io.emit('stats', stats);
}

io.on('connection', (socket) => {
  socket.on('requestFights', () => {
    socket.emit('fights', db.listFights());
  });
  socket.on('subscribe', (fightId) => {
    const stats = db.fightStats(fightId);
    if (stats) socket.emit('stats', stats);
  });
});

db.initCache().then(() => {
  server.listen(PORT, () => {
    console.log(`Bulls Boxing corriendo en http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin (clave: ${ADMIN_PASSWORD})`);
    console.log(`Monitor: http://localhost:${PORT}/monitor`);
  });
}).catch((err) => {
  console.error('Error iniciando DB, el servidor no puede arrancar:', err);
  process.exit(1);
});
