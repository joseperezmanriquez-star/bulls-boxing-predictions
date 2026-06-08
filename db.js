const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const COMMISSION_RATE = 0.15;

// ---------------------------------------------------------------------------
// Persistencia: Upstash Redis en produccion, archivo local en desarrollo.
// Con cache en memoria para que todas las operaciones sigan siendo sincronas.
// ---------------------------------------------------------------------------
const USE_REDIS = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const REDIS_KEY = 'bulls:db';
let _redis = null;
let _cache = null;

if (USE_REDIS) {
  const { Redis } = require('@upstash/redis');
  _redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

const EMPTY_DB = () => ({ users: [], fights: [], predictions: [], nextId: 1 });

async function initCache() {
  if (USE_REDIS) {
    try {
      const raw = await _redis.get(REDIS_KEY);
      _cache = raw || EMPTY_DB();
      console.log('[db] Datos cargados desde Upstash Redis.');
    } catch (err) {
      console.error('[db] Error al cargar desde Redis, arrancando vacio:', err.message);
      _cache = EMPTY_DB();
    }
  } else {
    if (fs.existsSync(DATA_FILE)) {
      _cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } else {
      _cache = EMPTY_DB();
    }
    console.log('[db] Datos cargados desde archivo local.');
  }
}

function load() {
  if (_cache) return JSON.parse(JSON.stringify(_cache));
  // Fallback para rutas de codigo que se ejecuten antes de initCache (no deberia ocurrir)
  if (!USE_REDIS && fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  return EMPTY_DB();
}

function save(data) {
  _cache = JSON.parse(JSON.stringify(data));
  if (USE_REDIS) {
    _redis.set(REDIS_KEY, data).catch((err) =>
      console.error('[db] Error al persistir en Redis:', err.message)
    );
  } else {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  }
}

function nextId(data) {
  const id = data.nextId;
  data.nextId += 1;
  return id;
}

// ---------------------------------------------------------------------------
// API de base de datos (sincronas, usan cache en memoria)
// ---------------------------------------------------------------------------
const db = {
  initCache,

  // ---- Users ----
  createUser({ name, rut, address, email, phone, comments }) {
    const data = load();
    const user = {
      id: nextId(data),
      name, rut, address, email, phone, comments: comments || '',
      status: 'pending',
      bulls: 0,
      accessToken: null,
      createdAt: new Date().toISOString(),
    };
    data.users.push(user);
    save(data);
    return user;
  },

  getUser(id) {
    const data = load();
    return data.users.find((u) => u.id === Number(id)) || null;
  },

  getUserByToken(token) {
    if (!token) return null;
    const data = load();
    return data.users.find((u) => u.accessToken === token) || null;
  },

  listUsers() {
    return load().users;
  },

  validateUserAndAssignBulls(id, bulls) {
    const data = load();
    const user = data.users.find((u) => u.id === Number(id));
    if (!user) return null;
    user.status = 'validated';
    user.bulls = Number(bulls);
    user.accessToken = crypto.randomBytes(24).toString('hex');
    save(data);
    return user;
  },

  adjustBulls(id, delta) {
    const data = load();
    const user = data.users.find((u) => u.id === Number(id));
    if (!user) return null;
    user.bulls += delta;
    save(data);
    return user;
  },

  deleteUser(id) {
    const data = load();
    const idx = data.users.findIndex((u) => u.id === Number(id));
    if (idx === -1) return false;
    data.users.splice(idx, 1);
    data.predictions = data.predictions.filter((p) => p.userId !== Number(id));
    save(data);
    return true;
  },

  // ---- Fights ----
  createFight({ fighterA, fighterB, date }) {
    const data = load();
    const fight = {
      id: nextId(data),
      fighterA, fighterB, date,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    data.fights.push(fight);
    save(data);
    return fight;
  },

  listFights() {
    return load().fights;
  },

  getFight(id) {
    const data = load();
    return data.fights.find((f) => f.id === Number(id)) || null;
  },

  deleteFight(id) {
    const data = load();
    const idx = data.fights.findIndex((f) => f.id === Number(id));
    if (idx === -1) return false;
    data.fights.splice(idx, 1);
    data.predictions = data.predictions.filter((p) => p.fightId !== Number(id));
    save(data);
    return true;
  },

  closeFight(id) {
    const data = load();
    const fight = data.fights.find((f) => f.id === Number(id));
    if (!fight) return null;
    if (fight.status === 'open') {
      fight.status = 'closed';
      save(data);
    }
    return fight;
  },

  settleFight(id, winner) {
    const data = load();
    const fight = data.fights.find((f) => f.id === Number(id));
    if (!fight) return null;
    if (fight.status === 'settled') return fight;
    if (winner !== fight.fighterA && winner !== fight.fighterB) {
      throw new Error('Peleador invalido.');
    }

    const preds = data.predictions.filter((p) => p.fightId === fight.id);
    const totals = { [fight.fighterA]: 0, [fight.fighterB]: 0 };
    preds.forEach((p) => { totals[p.fighter] += p.bulls; });
    const totalPool = totals[fight.fighterA] + totals[fight.fighterB];
    const noContest = totals[fight.fighterA] === 0 || totals[fight.fighterB] === 0;

    let commission = 0;
    if (noContest) {
      preds.forEach((p) => {
        p.result = 'refunded';
        p.payout = p.bulls;
        const u = data.users.find((usr) => usr.id === p.userId);
        if (u) u.bulls += p.bulls;
      });
    } else {
      commission = Math.round(totalPool * COMMISSION_RATE);
      const netPool = totalPool - commission;
      const winningTotal = totals[winner];
      preds.forEach((p) => {
        if (p.fighter === winner) {
          const payout = Math.floor((p.bulls / winningTotal) * netPool);
          p.result = 'won';
          p.payout = payout;
          const u = data.users.find((usr) => usr.id === p.userId);
          if (u) u.bulls += payout;
        } else {
          p.result = 'lost';
          p.payout = 0;
        }
      });
    }

    fight.status = 'settled';
    fight.winner = winner;
    fight.noContest = noContest;
    fight.commissionRate = COMMISSION_RATE;
    fight.commission = commission;
    fight.totalPool = totalPool;
    save(data);
    return fight;
  },

  fightSettlement(id) {
    const data = load();
    const fight = data.fights.find((f) => f.id === Number(id));
    if (!fight || fight.status !== 'settled') return null;
    const preds = data.predictions
      .filter((p) => p.fightId === fight.id)
      .map((p) => ({ ...p, user: data.users.find((u) => u.id === p.userId) || null }));
    return {
      fight,
      winners: preds.filter((p) => p.result === 'won'),
      losers: preds.filter((p) => p.result === 'lost'),
      refunded: preds.filter((p) => p.result === 'refunded'),
    };
  },

  // ---- Predictions ----
  createPrediction({ userId, fightId, fighter, bulls }) {
    const data = load();
    const user = data.users.find((u) => u.id === Number(userId));
    if (!user) throw new Error('Usuario no encontrado');
    if (user.bulls < bulls) throw new Error('Saldo de Bulls insuficiente');
    user.bulls -= bulls;
    const prediction = {
      id: nextId(data),
      userId: user.id,
      fightId: Number(fightId),
      fighter,
      bulls: Number(bulls),
      createdAt: new Date().toISOString(),
    };
    data.predictions.push(prediction);
    save(data);
    return prediction;
  },

  listPredictions() {
    const data = load();
    return data.predictions.map((p) => ({
      ...p,
      user: data.users.find((u) => u.id === p.userId) || null,
      fight: data.fights.find((f) => f.id === p.fightId) || null,
    }));
  },

  predictionsForFight(fightId) {
    const data = load();
    return data.predictions.filter((p) => p.fightId === Number(fightId));
  },

  fightStats(fightId) {
    const fight = db.getFight(fightId);
    if (!fight) return null;
    const preds = db.predictionsForFight(fightId);
    const totals = { [fight.fighterA]: 0, [fight.fighterB]: 0 };
    for (const p of preds) {
      if (totals[p.fighter] !== undefined) totals[p.fighter] += p.bulls;
    }
    const total = totals[fight.fighterA] + totals[fight.fighterB];
    const pct = (n) => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);
    return {
      fight,
      totals,
      total,
      percentages: {
        [fight.fighterA]: pct(totals[fight.fighterA]),
        [fight.fighterB]: pct(totals[fight.fighterB]),
      },
    };
  },
};

module.exports = db;
