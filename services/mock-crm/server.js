// Tiny mock CRM used by the demo and the tests. Requires a Bearer token, like a real CRM API would.
// Endpoints: GET /health, GET /customers/by-email?email=, POST /cases, POST /escalations, GET /cases
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 4010);
const TOKEN = process.env.CRM_TOKEN || 'demo-crm-token';

const cases = [];
const escalations = [];
const customers = {
  'amina.khan@example.com': { crm_id: 'C-1001', name: 'Amina Khan', tier: 'gold', open_cases: 0 },
  'luca.bianchi@example.com': { crm_id: 'C-1002', name: 'Luca Bianchi', tier: 'standard', open_cases: 1 },
  'priya.nair@example.com': { crm_id: 'C-1003', name: 'Priya Nair', tier: 'platinum', open_cases: 2 },
  'omar.saeed@example.com': { crm_id: 'C-1004', name: 'Omar Saeed', tier: 'gold', open_cases: 0 },
};

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/health') return send(res, 200, { ok: true });

  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(res, 401, { error: 'invalid or missing bearer token' });
  }

  try {
    if (req.method === 'GET' && url.pathname === '/customers/by-email') {
      const email = (url.searchParams.get('email') || '').toLowerCase();
      const found = customers[email];
      return found ? send(res, 200, found) : send(res, 404, { error: 'customer not found' });
    }
    if (req.method === 'POST' && url.pathname === '/cases') {
      const body = await readJson(req);
      if (!body.ticket_id || !body.customer_email) return send(res, 422, { error: 'ticket_id and customer_email are required' });
      const record = { case_id: `CASE-${crypto.randomInt(10000, 99999)}`, ...body, created_at: new Date().toISOString() };
      cases.push(record);
      return send(res, 201, record);
    }
    if (req.method === 'POST' && url.pathname === '/escalations') {
      const body = await readJson(req);
      const record = { escalation_id: `ESC-${crypto.randomInt(1000, 9999)}`, ...body, created_at: new Date().toISOString() };
      escalations.push(record);
      return send(res, 201, record);
    }
    if (req.method === 'GET' && url.pathname === '/cases') return send(res, 200, { cases, escalations });
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 400, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => console.log(`mock-crm listening on :${PORT}`));
