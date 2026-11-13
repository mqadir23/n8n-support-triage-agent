// Writes .n8n-import/credentials.json from environment variables (see .env.example).
// n8n encrypts the credentials with N8N_ENCRYPTION_KEY when they are imported.
//   node --env-file=.env scripts/make-credentials.mjs [--pg-host postgres --pg-port 5432]
import fs from 'node:fs';
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const need = (k) => { if (!process.env[k]) throw new Error(`Missing env var ${k}`); return process.env[k]; };

const creds = [
  { id: 'cred-webhook-auth', name: 'Triage webhook token', type: 'httpHeaderAuth',
    data: { name: 'Authorization', value: `Bearer ${need('WEBHOOK_TOKEN')}` } },
  { id: 'cred-triage-pg', name: 'Triage Postgres', type: 'postgres',
    data: { host: argOf('--pg-host', 'postgres'), port: Number(argOf('--pg-port', '5432')), database: need('POSTGRES_DB'),
            user: need('POSTGRES_USER'), password: need('POSTGRES_PASSWORD'), ssl: 'disable', allowUnauthorizedCerts: false, maxConnections: 10 } },
  { id: 'cred-llm-provider', name: 'LLM provider (OpenAI compatible)', type: 'openAiApi',
    data: { apiKey: need('LLM_API_KEY'), url: need('LLM_BASE_URL'), header: false } },
  { id: 'cred-crm-token', name: 'Mock CRM token', type: 'httpHeaderAuth',
    data: { name: 'Authorization', value: `Bearer ${need('CRM_TOKEN')}` } },
];
fs.mkdirSync('.n8n-import', { recursive: true });
fs.writeFileSync('.n8n-import/credentials.json', JSON.stringify(creds, null, 2));
console.log('wrote .n8n-import/credentials.json');
