// Sends every ticket in test-data/tickets.json to the webhook and prints the outcome.
//   node --env-file=.env scripts/run-samples.mjs [http://localhost:5678/webhook/triage]
import fs from 'node:fs';
const url = process.argv[2] || 'http://localhost:5678/webhook/triage';
const token = process.env.WEBHOOK_TOKEN;
if (!token) throw new Error('WEBHOOK_TOKEN is not set');
const samples = JSON.parse(fs.readFileSync(new URL('../test-data/tickets.json', import.meta.url), 'utf8'));
let failures = 0;
// Free LLM tiers have tokens-per-minute limits, so pause between tickets (set SAMPLE_DELAY_MS=0 for the mock).
const delay = Number(process.env.SAMPLE_DELAY_MS ?? 15000);
for (const s of samples) {
  if (delay > 0 && s !== samples[0]) await new Promise((r) => setTimeout(r, delay));
  const t0 = Date.now();
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(s.ticket) });
  const body = await res.json().catch(() => ({}));
  const r = body.result || {};
  console.log(`\n# ${s.name}\n  HTTP ${res.status} in ${Date.now() - t0} ms | status=${body.status ?? body.error} attempts=${body.attempts ?? '-'} category=${r.category ?? '-'} priority=${r.priority ?? '-'} needs_human=${r.needs_human ?? '-'} confidence=${r.confidence ?? '-'} crm=${body.crm_case_id ?? '-'}`);
  if (body.details) console.log('  details:', body.details.join(' '));
  if (!res.ok && res.status !== 400) failures++;
}
const noAuth = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
console.log(`\n# Missing auth header\n  HTTP ${noAuth.status} (expected 403)`);
process.exit(failures ? 1 : 0);
