const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const COMMISSION_RATE = 0.15;

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    return { users: [], fights: [], predictions: [], nextId: 1 };
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function save(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function nextId(data) {
  const id = data.nextId;
  data.nextId += 1;
  return id;
}

const db = {
  // ---- Users ----
  createUser({ name, rut, address, email, phone, comments }) {
    const data = load();
    const user = {
      id: nextId(data),
      name, rut, address, email, phone, comments: comments || '',
      status: 'pending', // pending | validated
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

  // Removes a user and all of their predictions (cleanup, e.g. duplicates/test entries)
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
      status: 'open', // open | closed
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

  // Removes a fight and all of its associated predictions (cleanup, e.g. old/finished fights)
  deleteFight(id) {
    const data = load();
    const idx = data.fights.findIndex((f) => f.id === Number(id));
    if (idx === -1) return false;
    data.fights.splice(idx, 1);
    data.predictions = data.predictions.filter((p) => p.fightId !== Number(id));
    save(data);
    return true;
  },

  // Stops accepting new predictions for a fight (fight finished, awaiting official result)
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

  // Declares the winner, charges the commission and pays out winners proportionally.
  // If nobody bet on one of the two fighters, it's a no-contest: everyone gets refunded.
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

  // Detailed breakdown of a settled fight: pool, commission, winners/losers/refunded with payouts
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

  // Aggregated Bulls per fighter for a given fight
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
