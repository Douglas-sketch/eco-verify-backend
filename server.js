// backend/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Se estiver em Node < 18, descomente e rode "npm i node-fetch"
// const fetch = require('node-fetch');

const app = express();

// Lidos apenas no backend (NUNCA enviados para o front)
const FONE_BASE_URL = process.env.FONE_BASE_URL;
const FONE_SDK_KEY  = process.env.FONE_SDK_KEY;

// Apenas normaliza barra final
function normBase(u) {
  return (u || '').replace(/\/+$/, '');
}

// Garantir que o backend está configurado
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
    // Importante: não logar SDK nem URL aqui, só código/erro genérico
    const msg = data.error || res.statusText || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// ----- Middlewares -----
app.use(cors());           // se quiser, pode restringir origin
app.use(express.json());

// (Opcional) servir front estático se quiser:
// const path = require('path');
// app.use(express.static(path.join(__dirname, '..')));

// ----- HEALTH CHECK -----
app.get('/api/health', (req, res) => {
  const configured = !!(FONE_BASE_URL && FONE_SDK_KEY);
  res.json({
    ok: true,
    configured,
    message: configured
      ? 'Eco-Verify backend is running and Fone config is set'
      : 'Eco-Verify backend is running, but FONE_BASE_URL / FONE_SDK_KEY are missing'
  });
});

// ============= FONE API PROXY =============

// Criar carteira
app.post('/api/fone/wallet/create', async (req, res) => {
  try {
    const data = await callFone('/v1/wallet/create', 'POST');
    res.json(data);
  } catch (err) {
    console.error('POST /api/fone/wallet/create', err.message);
    res.status(500).json({ error: 'Fone API error (create wallet)' });
  }
});

// Importar carteira
app.post('/api/fone/wallet/import', async (req, res) => {
  const { privateKey } = req.body || {};
  if (!privateKey) {
    return res.status(400).json({ error: 'privateKey required' });
  }
  try {
    const data = await callFone('/v1/wallet/import', 'POST', { privateKey });
    res.json(data);
  } catch (err) {
    console.error('POST /api/fone/wallet/import', err.message);
    res.status(500).json({ error: 'Fone API error (import wallet)' });
  }
});

// Saldo (não está sendo usado no front agora, mas deixei)
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

// Transações + dados da carteira
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

// Envio de FONE
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

// ----- START -----
const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log('Eco-Verify backend running on port', port);
});