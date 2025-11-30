// backend/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg'); // <-- Postgres

const app = express();

// --------- FONE NODE CONFIG (from .env in Render) ----------
const FONE_BASE_URL = process.env.FONE_BASE_URL;
const FONE_SDK_KEY  = process.env.FONE_SDK_KEY;

function normBase(u) {
  return (u || '').replace(/\/+$/, '');
}

function assertFoneConfigured() {
  if (!FONE_BASE_URL || !FONE_SDK_KEY) {
    throw new Error('Fone API not configured (FONE_BASE_URL / FONE_SDK_KEY missing)');
  }
}

// Chamada genérica para o node FONE
async function callFone(path, method = 'GET', body) {
  assertFoneConfigured();

  const url = normBase(FONE_BASE_URL) + path;
  const headers = {
    'api-key': FONE_SDK_KEY,
    'Accept': 'application/json'
  };
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const txt = await res.text();
  let data;
  try { data = txt ? JSON.parse(txt) : {}; }
  catch { data = { raw: txt }; }

  if (!res.ok) {
    const msg = data.error || res.statusText || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// --------- POSTGRES CONFIG ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true'
    ? { rejectUnauthorized: false }
    : false
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

// Criação das tabelas básicas, se ainda não existirem
async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS wallets (
      addr        TEXT PRIMARY KEY,
      created_at  TIMESTAMP DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS user_state (
      addr        TEXT PRIMARY KEY REFERENCES wallets(addr) ON DELETE CASCADE,
      credits     NUMERIC(32,8) DEFAULT 0,
      reputation  INTEGER       DEFAULT 0,
      updated_at  TIMESTAMP     DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS mission_completion (
      id          SERIAL PRIMARY KEY,
      addr        TEXT REFERENCES wallets(addr) ON DELETE CASCADE,
      mission_id  TEXT NOT NULL,
      report      TEXT,
      reward      NUMERIC(32,8),
      reputation  INTEGER,
      created_at  TIMESTAMP DEFAULT now()
    );
  `);
}

// Helpers de estado de usuário
async function ensureWalletRow(addr) {
  if (!addr) return;
  await query(`
    INSERT INTO wallets (addr)
    VALUES ($1)
    ON CONFLICT (addr) DO NOTHING
  `, [addr]);

  await query(`
    INSERT INTO user_state (addr)
    VALUES ($1)
    ON CONFLICT (addr) DO NOTHING
  `, [addr]);
}

async function addCreditsAndReputation(addr, creditsDelta, repDelta) {
  await ensureWalletRow(addr);
  await query(`
    UPDATE user_state
    SET
      credits    = COALESCE(credits, 0) + $2,
      reputation = COALESCE(reputation, 0) + $3,
      updated_at = now()
    WHERE addr = $1
  `, [addr, creditsDelta, repDelta]);
}

// --------- MIDDLEWARES ----------
app.use(cors());
app.use(express.json());

// --------- HEALTH CHECK ----------
app.get('/api/health', async (req, res) => {
  const foneConfigured = !!(FONE_BASE_URL && FONE_SDK_KEY);
  const dbConfigured   = !!process.env.DATABASE_URL;

  let dbOk = false;
  try {
    if (dbConfigured) {
      await query('SELECT 1');
      dbOk = true;
    }
  } catch (e) {
    dbOk = false;
  }

  res.json({
    ok: true,
    foneConfigured,
    dbConfigured,
    dbOk,
    message: 'Eco-Verify backend is running'
  });
});

// ============= FONE API PROXY =================

// Create wallet
app.post('/api/fone/wallet/create', async (req, res) => {
  try {
    const data = await callFone('/v1/wallet/create', 'POST');

    const addr = data.address;
    if (addr) {
      await ensureWalletRow(addr);
    }

    res.json(data);
  } catch (err) {
    console.error('POST /api/fone/wallet/create', err.message);
    res.status(500).json({ error: 'Fone API error (create wallet)' });
  }
});

// Import wallet
app.post('/api/fone/wallet/import', async (req, res) => {
  const { privateKey } = req.body || {};
  if (!privateKey) {
    return res.status(400).json({ error: 'privateKey required' });
  }
  try {
    const data = await callFone('/v1/wallet/import', 'POST', { privateKey });

    const addr = data.address;
    if (addr) {
      await ensureWalletRow(addr);
    }

    res.json(data);
  } catch (err) {
    console.error('POST /api/fone/wallet/import', err.message);
    res.status(500).json({ error: 'Fone API error (import wallet)' });
  }
});

// Balance (não está sendo usado diretamente no front, mas mantido)
app.get('/api/fone/wallet/:addr/balance', async (req, res) => {
  const addr = req.params.addr;
  try {
    const data = await callFone(
      `/v1/wallet/${encodeURIComponent(addr)}/balance`,
      'GET'
    );
    res.json(data);
  } catch (err) {
    console.error('GET /api/fone/wallet/:addr/balance', err.message);
    res.status(500).json({ error: 'Fone API error (balance)' });
  }
});

// Transactions + addressData
app.get('/api/fone/wallet/:addr/transactions', async (req, res) => {
  const addr = req.params.addr;
  try {
    const data = await callFone(
      `/v1/wallet/${encodeURIComponent(addr)}/transactions`,
      'GET'
    );
    res.json(data);
  } catch (err) {
    console.error('GET /api/fone/wallet/:addr/transactions', err.message);
    res.status(500).json({ error: 'Fone API error (transactions)' });
  }
});

// Send FONE
app.post('/api/fone/transaction/send', async (req, res) => {
  const { privateKey, recipient, amount, message } = req.body || {};
  if (!privateKey || !recipient || !amount) {
    return res.status(400).json({ error: 'privateKey, recipient and amount are required' });
  }
  try {
    const payload = { privateKey, recipient, amount: Number(amount) };
    if (message) payload.message = message;
    const data = await callFone('/v1/transaction/send', 'POST', payload);
    res.json(data);
  } catch (err) {
    console.error('POST /api/fone/transaction/send', err.message);
    res.status(500).json({ error: 'Fone API error (send)' });
  }
});

// ============= APP STATE (credits, reputation, missions) =============

// Get user state (credits + reputation)
app.get('/api/app/user/:addr/state', async (req, res) => {
  const addr = req.params.addr;
  if (!addr) return res.status(400).json({ error: 'addr required' });

  try {
    const r = await query(
      'SELECT credits, reputation FROM user_state WHERE addr = $1',
      [addr]
    );
    if (!r.rows.length) {
      return res.json({ addr, credits: 0, reputation: 0 });
    }
    const row = r.rows[0];
    res.json({
      addr,
      credits: Number(row.credits || 0),
      reputation: Number(row.reputation || 0)
    });
  } catch (err) {
    console.error('GET /api/app/user/:addr/state', err.message);
    res.status(500).json({ error: 'DB error (user state)' });
  }
});

// Register completed mission and update credits + reputation
// body: { addr, missionId, reward, reputation, report }
app.post('/api/app/mission/completed', async (req, res) => {
  const { addr, missionId, reward, reputation, report } = req.body || {};
  if (!addr || !missionId) {
    return res.status(400).json({ error: 'addr and missionId are required' });
  }

  const rewardNum = Number(reward || 0);
  const repNum    = Number(reputation || 0);

  try {
    await ensureWalletRow(addr);

    await query(`
      INSERT INTO mission_completion (addr, mission_id, report, reward, reputation)
      VALUES ($1, $2, $3, $4, $5)
    `, [addr, missionId, report || '', rewardNum, repNum]);

    await addCreditsAndReputation(addr, rewardNum, repNum);

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/app/mission/completed', err.message);
    res.status(500).json({ error: 'DB error (mission complete)' });
  }
});

// (Opcional) simples root
app.get('/', (req, res) => {
  res.send('Eco-Verify backend is running. Use /api/health for status.');
});

// --------- STARTUP ----------
const port = process.env.PORT || 4000;

initDb()
  .then(() => {
    console.log('Database initialized.');
    app.listen(port, () => {
      console.log('Eco-Verify backend running on port', port);
    });
  })
  .catch((err) => {
    console.error('Error initializing database:', err);
    process.exit(1);
  });
