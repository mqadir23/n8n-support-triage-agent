// Generates workflows/support-triage.json and workflows/error-handler.json.
// The validation logic is the compiled output of src/triage.ts, embedded into Code nodes
// so the code that is unit tested is the code that runs in the workflow.
//
//   npm run build && node scripts/build-workflow.mjs [--crm-url http://mock-crm:4010]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const CRM_URL = argOf('--crm-url', 'http://mock-crm:4010');
const MODEL = argOf('--model', 'mock-triage-model');
const MAX_ATTEMPTS = 3;
const MIN_CONFIDENCE = 0.6;

// ---- embed compiled helpers -------------------------------------------------
let helpers = fs.readFileSync(path.join(root, 'dist', 'triage.js'), 'utf8');
helpers = helpers
  .replace(/"use strict";\n/, '')
  .replace(/Object\.defineProperty\(exports[^\n]*\n/, '')
  .replace(/^exports\.[\w. =]*= void 0;\n/gm, '')
  .replace(/^exports\.(\w+) = \1;\n/gm, '')
  .replace(/^exports\.(CATEGORIES|PRIORITIES|SENTIMENTS) = /gm, 'const $1 = ')
  .replace(/\bexports\.(\w+)/g, '$1')
  .replace(/^\/\/# sourceMappingURL.*$/m, '');
if (/\bexports\b/.test(helpers)) throw new Error('unprocessed exports in compiled helpers');

const RATES = { inputPerMillion: 0.59, outputPerMillion: 0.79 };

// ---- credentials (ids are referenced by the import script) -------------------
const CRED = {
  webhook: { id: 'cred-webhook-auth', name: 'Triage webhook token' },
  pg: { id: 'cred-triage-pg', name: 'Triage Postgres' },
  llm: { id: 'cred-llm-provider', name: 'LLM provider (OpenAI compatible)' },
  crm: { id: 'cred-crm-token', name: 'Mock CRM token' },
};

let nid = 0;
const node = (name, type, typeVersion, position, parameters, extra = {}) => ({
  id: `n${++nid}`.padStart(8, '0') + '-0000-4000-8000-000000000000',
  name,
  type,
  typeVersion,
  position,
  parameters,
  ...extra,
});
const pgCreds = { postgres: CRED.pg };

// ---- Code node bodies --------------------------------------------------------
const validateInput = `
const EMAIL = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
const body = $json.body || {};
const errors = [];
const email = typeof body.customer_email === 'string' ? body.customer_email.trim().toLowerCase() : '';
const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
const text = typeof body.body === 'string' ? body.body.trim() : '';
if (!EMAIL.test(email)) errors.push('customer_email must be a valid email address.');
if (subject.length < 3 || subject.length > 200) errors.push('subject must be 3 to 200 characters.');
if (text.length < 10 || text.length > 5000) errors.push('body must be 10 to 5000 characters.');
const id = 'T-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
return [{ json: { valid: errors.length === 0, errors, ticket: { id, customer_email: email, subject, body: text } } }];
`.trim();

const prepareAttempt = `
return [{ json: { ticket: $json.ticket, attempt: 1, feedback: '', startedAt: Date.now() } }];
`.trim();

const nextAttempt = `
${helpers}
const s = $json;
return [{ json: { ticket: s.ticket, attempt: s.attempt + 1, feedback: buildFeedback(s.errors), startedAt: Date.now() } }];
`.trim();

const validateOutput = `
${helpers}
const MAX_ATTEMPTS = ${MAX_ATTEMPTS};
const MIN_CONFIDENCE = ${MIN_CONFIDENCE};
const RATES = ${JSON.stringify(RATES)};
const MODEL = ${JSON.stringify(MODEL)};
const input = $('Build Prompt').item.json;
const raw = $json.output;
const parsed = extractJson(raw);
const check = validateTriage(parsed, { minConfidence: MIN_CONFIDENCE });
const errors = check.valid ? [] : (parsed === null
  ? ['The answer was not valid JSON. Return only a JSON object, with no prose and no code fences.']
  : check.errors);
const step = nextStep({ valid: check.valid, attempt: input.attempt, maxAttempts: MAX_ATTEMPTS, needsHuman: check.result ? check.result.needs_human : false });
const promptTokens = estimateTokens(input.prompt);
const outputTokens = estimateTokens(typeof raw === 'string' ? raw : JSON.stringify(raw));
return [{ json: {
  ticket: input.ticket,
  attempt: input.attempt,
  step,
  valid: check.valid,
  errors,
  result: check.result || null,
  run: {
    model: MODEL,
    latency_ms: Date.now() - input.startedAt,
    est_prompt_tokens: promptTokens,
    est_output_tokens: outputTokens,
    est_cost_usd: estimateCostUsd(promptTokens, outputTokens, RATES),
  },
} }];
`.trim();

const buildPrompt = `
const s = $json;
const t = s.ticket;
let prompt = 'Customer email: ' + t.customer_email + '\\nSubject: ' + t.subject + '\\nMessage:\\n' + t.body;
if (s.feedback) prompt += '\\n\\n' + s.feedback;
return [{ json: { ...s, prompt } }];
`.trim();

const restoreState = `return [{ json: $('Validate Output').item.json }];`;

const buildCrmRequest = `
const s = $json;
const r = s.result;
const isEscalation = s.step === 'escalate';
const payload = {
  ticket_id: s.ticket.id,
  customer_email: s.ticket.customer_email,
  subject: s.ticket.subject,
  category: r.category,
  priority: r.priority,
  summary: r.summary,
  suggested_reply: r.suggested_reply,
  confidence: r.confidence,
  reason: isEscalation ? 'Model flagged this ticket for a human agent.' : undefined,
};
return [{ json: { ...s, crm_path: isEscalation ? '/escalations' : '/cases', crm_payload: payload } }];
`.trim();

const finalResponse = `
const s = $('Finalize State').item.json;
const crm = $json || {};
return [{ json: { ticket_id: s.ticket.id, status: s.final_status, attempts: s.attempt, result: s.result, crm_case_id: crm.case_id || crm.escalation_id || null } }];
`.trim();

const finalizeState = `
const s = $json;
const status = s.step === 'give_up' ? 'failed' : s.step === 'escalate' ? 'escalated' : 'triaged';
return [{ json: { ...s, final_status: status } }];
`.trim();

const systemMessage = `You are a support ticket triage agent for a B2B hardware company.

For every ticket:
1. Call the customer lookup tool with the customer's email to get their plan and recent orders.
2. Call the knowledge base search tool with a few keywords from the ticket.
3. Optionally call the CRM tool to see whether the customer already has an open case.
4. Use only facts returned by the tools. Never invent order details or policies.

Then answer with ONE JSON object and nothing else, with exactly these keys:
- category: one of billing, technical, shipping, account, general
- priority: one of low, medium, high, urgent
- sentiment: one of negative, neutral, positive
- summary: one sentence, at most 280 characters
- suggested_reply: a polite draft reply to the customer, 20 to 1200 characters
- needs_human: true when the customer is on an enterprise plan with an urgent or technical problem, when money or legal risk is involved, or when you are unsure
- confidence: a number from 0 to 1

Do not wrap the JSON in code fences and do not add any other text.`;

// ---- main workflow -----------------------------------------------------------
const nodes = [
  node('Webhook', 'n8n-nodes-base.webhook', 2.2, [0, 300], {
    httpMethod: 'POST', path: 'triage', authentication: 'headerAuth', responseMode: 'responseNode', options: {},
  }, { webhookId: 'a1b2c3d4-0000-4000-8000-000000000001', credentials: { httpHeaderAuth: CRED.webhook } }),
  node('Validate Input', 'n8n-nodes-base.code', 2, [220, 300], { jsCode: validateInput }),
  node('Input Valid?', 'n8n-nodes-base.if', 2.2, [440, 300], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id: 'c1', leftValue: '={{ $json.valid }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    }, options: {},
  }),
  node('Reject Invalid', 'n8n-nodes-base.respondToWebhook', 1.5, [660, 520], {
    respondWith: 'json', responseBody: '={{ { error: "invalid_request", details: $json.errors } }}',
    options: { responseCode: 400 },
  }),
  node('Insert Ticket', 'n8n-nodes-base.postgres', 2.6, [660, 200], {
    operation: 'executeQuery',
    query: 'INSERT INTO tickets (id, customer_email, subject, body) VALUES ($1, $2, $3, $4) RETURNING id',
    options: { queryReplacement: '={{ [$json.ticket.id, $json.ticket.customer_email, $json.ticket.subject, $json.ticket.body] }}' },
  }, { credentials: pgCreds }),
  node('Start Triage', 'n8n-nodes-base.code', 2, [880, 200], { jsCode: `return [{ json: { ticket: $('Validate Input').item.json.ticket, attempt: 1, feedback: '', startedAt: Date.now() } }];` }),
  node('Build Prompt', 'n8n-nodes-base.code', 2, [1100, 300], { jsCode: buildPrompt }),
  node('Triage Agent', '@n8n/n8n-nodes-langchain.agent', 3.1, [1320, 300], {
    promptType: 'define', text: '={{ $json.prompt }}', hasOutputParser: false,
    options: { systemMessage, maxIterations: 6 },
  }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 6000 }),
  node('LLM Chat Model', '@n8n/n8n-nodes-langchain.lmChatOpenAi', 1.2, [1240, 560], {
    model: { __rl: true, mode: 'id', value: MODEL },
    options: { temperature: 0, maxRetries: 2, timeout: 60000 },
  }, { credentials: { openAiApi: CRED.llm } }),
  node('Lookup Customer', 'n8n-nodes-base.postgresTool', 2.6, [1380, 560], {
    descriptionType: 'manual',
    toolDescription: 'Look up a customer by email. Returns name, plan, country and their five most recent orders with status and amount.',
    operation: 'executeQuery',
    query: `SELECT c.name, c.plan, c.country, o.product, o.status AS order_status, o.amount_usd, o.ordered_at
FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
WHERE lower(c.email) = lower($1)
ORDER BY o.ordered_at DESC LIMIT 5`,
    options: { queryReplacement: "={{ $fromAI('email', 'The customer email address from the ticket', 'string') }}" },
  }, { credentials: pgCreds }),
  node('Search Knowledge Base', 'n8n-nodes-base.postgresTool', 2.6, [1520, 560], {
    descriptionType: 'manual',
    toolDescription: 'Full-text search over support knowledge base articles. Pass a few keywords. Returns the three best matching articles.',
    operation: 'executeQuery',
    query: `SELECT title, left(body, 500) AS excerpt
FROM kb_articles
WHERE tsv @@ plainto_tsquery('english', $1)
ORDER BY ts_rank(tsv, plainto_tsquery('english', $1)) DESC LIMIT 3`,
    options: { queryReplacement: "={{ $fromAI('keywords', 'Two to five keywords describing the problem', 'string') }}" },
  }, { credentials: pgCreds }),
  node('CRM Customer Record', 'n8n-nodes-base.httpRequestTool', 4.2, [1660, 560], {
    toolDescription: 'Fetch the CRM record for a customer, including account manager and open cases. Pass the customer email.',
    method: 'GET', url: `${CRM_URL}/customers/by-email`,
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendQuery: true,
    specifyQuery: 'keypair',
    queryParameters: { parameters: [{ name: 'email', value: "={{ $fromAI('email', 'Customer email address', 'string') }}" }] },
    options: {},
  }, { credentials: { httpHeaderAuth: CRED.crm } }),
  node('Validate Output', 'n8n-nodes-base.code', 2, [1560, 300], { jsCode: validateOutput }),
  node('Log LLM Run', 'n8n-nodes-base.postgres', 2.6, [1780, 300], {
    operation: 'executeQuery',
    query: `INSERT INTO llm_runs (ticket_id, model, attempt, latency_ms, valid, validation_errors, est_prompt_tokens, est_output_tokens, est_cost_usd)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    options: { queryReplacement: "={{ [$json.ticket.id, $json.run.model, $json.attempt, $json.run.latency_ms, $json.valid, $json.errors.join(' | '), $json.run.est_prompt_tokens, $json.run.est_output_tokens, $json.run.est_cost_usd] }}" },
  }, { credentials: pgCreds }),
  node('Restore State', 'n8n-nodes-base.code', 2, [2000, 300], { jsCode: restoreState }),
  node('Retry?', 'n8n-nodes-base.if', 2.2, [2220, 300], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id: 'c2', leftValue: '={{ $json.step }}', rightValue: 'retry', operator: { type: 'string', operation: 'equals' } }],
      combinator: 'and',
    }, options: {},
  }),
  node('Next Attempt', 'n8n-nodes-base.code', 2, [2440, 120], { jsCode: nextAttempt }),
  node('Finalize State', 'n8n-nodes-base.code', 2, [2440, 420], { jsCode: finalizeState }),
  node('Save Result', 'n8n-nodes-base.postgres', 2.6, [2660, 420], {
    operation: 'executeQuery',
    query: `UPDATE tickets SET status = $2, category = $3, priority = $4, sentiment = $5, summary = $6,
  suggested_reply = $7, needs_human = $8, confidence = $9, attempts = $10, updated_at = now()
WHERE id = $1 RETURNING id`,
    options: { queryReplacement: "={{ [$json.ticket.id, $json.final_status, $json.result?.category ?? null, $json.result?.priority ?? null, $json.result?.sentiment ?? null, $json.result?.summary ?? null, $json.result?.suggested_reply ?? null, $json.result?.needs_human ?? null, $json.result?.confidence ?? null, $json.attempt] }}" },
  }, { credentials: pgCreds }),
  node('Restore Final State', 'n8n-nodes-base.code', 2, [2880, 420], { jsCode: `return [{ json: $('Finalize State').item.json }];` }),
  node('Needs CRM?', 'n8n-nodes-base.if', 2.2, [3100, 420], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id: 'c3', leftValue: '={{ $json.step }}', rightValue: 'give_up', operator: { type: 'string', operation: 'notEquals' } }],
      combinator: 'and',
    }, options: {},
  }),
  node('Build CRM Request', 'n8n-nodes-base.code', 2, [3320, 320], { jsCode: buildCrmRequest }),
  node('Send To CRM', 'n8n-nodes-base.httpRequest', 4.2, [3540, 320], {
    method: 'POST',
    url: `=${CRM_URL}{{ $json.crm_path }}`,
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.crm_payload) }}',
    options: { timeout: 15000, retry: { } },
  }, { credentials: { httpHeaderAuth: CRED.crm }, retryOnFail: true, maxTries: 3, waitBetweenTries: 1000 }),
  node('Save CRM Id', 'n8n-nodes-base.postgres', 2.6, [3760, 320], {
    operation: 'executeQuery',
    query: 'UPDATE tickets SET crm_case_id = $2 WHERE id = $1 RETURNING id',
    options: { queryReplacement: "={{ [$('Build CRM Request').item.json.ticket.id, $('Send To CRM').item.json.case_id ?? $('Send To CRM').item.json.escalation_id ?? null] }}" },
  }, { credentials: pgCreds }),
  node('Respond Success', 'n8n-nodes-base.respondToWebhook', 1.5, [3980, 320], {
    respondWith: 'json',
    responseBody: "={{ { ticket_id: $('Build CRM Request').item.json.ticket.id, status: $('Build CRM Request').item.json.final_status, attempts: $('Build CRM Request').item.json.attempt, result: $('Build CRM Request').item.json.result, crm_case_id: $('Send To CRM').item.json.case_id ?? $('Send To CRM').item.json.escalation_id ?? null } }}",
    options: { responseCode: 200 },
  }),
  node('Respond Failed', 'n8n-nodes-base.respondToWebhook', 1.5, [3320, 560], {
    respondWith: 'json',
    responseBody: "={{ { ticket_id: $json.ticket.id, status: 'failed', attempts: $json.attempt, errors: $json.errors } }}",
    options: { responseCode: 422 },
  }),
];

const link = (to, type = 'main', index = 0) => ({ node: to, type, index });
const connections = {
  'Webhook': { main: [[link('Validate Input')]] },
  'Validate Input': { main: [[link('Input Valid?')]] },
  'Input Valid?': { main: [[link('Insert Ticket')], [link('Reject Invalid')]] },
  'Insert Ticket': { main: [[link('Start Triage')]] },
  'Start Triage': { main: [[link('Build Prompt')]] },
  'Build Prompt': { main: [[link('Triage Agent')]] },
  'LLM Chat Model': { ai_languageModel: [[link('Triage Agent', 'ai_languageModel')]] },
  'Lookup Customer': { ai_tool: [[link('Triage Agent', 'ai_tool')]] },
  'Search Knowledge Base': { ai_tool: [[link('Triage Agent', 'ai_tool')]] },
  'CRM Customer Record': { ai_tool: [[link('Triage Agent', 'ai_tool')]] },
  'Triage Agent': { main: [[link('Validate Output')]] },
  'Validate Output': { main: [[link('Log LLM Run')]] },
  'Log LLM Run': { main: [[link('Restore State')]] },
  'Restore State': { main: [[link('Retry?')]] },
  'Retry?': { main: [[link('Next Attempt')], [link('Finalize State')]] },
  'Next Attempt': { main: [[link('Build Prompt')]] },
  'Finalize State': { main: [[link('Save Result')]] },
  'Save Result': { main: [[link('Restore Final State')]] },
  'Restore Final State': { main: [[link('Needs CRM?')]] },
  'Needs CRM?': { main: [[link('Build CRM Request')], [link('Respond Failed')]] },
  'Build CRM Request': { main: [[link('Send To CRM')]] },
  'Send To CRM': { main: [[link('Save CRM Id')]] },
  'Save CRM Id': { main: [[link('Respond Success')]] },
};

const main = {
  id: 'triageMainWf0001',
  name: 'Support Ticket Triage Agent',
  active: true,
  nodes,
  connections,
  settings: { executionOrder: 'v1', errorWorkflow: 'triageErrorWf0001', saveManualExecutions: true },
  pinData: {},
};

// ---- error workflow ----------------------------------------------------------
nid = 100;
const errNodes = [
  node('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, [0, 0], {}),
  node('Record Error', 'n8n-nodes-base.postgres', 2.6, [240, 0], {
    operation: 'executeQuery',
    query: 'INSERT INTO workflow_errors (workflow_name, execution_id, node_name, message) VALUES ($1, $2, $3, $4) RETURNING id',
    options: { queryReplacement: "={{ [$json.workflow.name, $json.execution.id, $json.execution.lastNodeExecuted, ($json.execution.error?.message || '').slice(0, 500)] }}" },
  }, { credentials: pgCreds }),
];
const errorWf = {
  id: 'triageErrorWf0001',
  name: 'Triage Error Handler',
  active: true,
  nodes: errNodes,
  connections: { 'Error Trigger': { main: [[link('Record Error')]] } },
  settings: { executionOrder: 'v1' },
  pinData: {},
};

fs.mkdirSync(path.join(root, 'workflows'), { recursive: true });
fs.writeFileSync(path.join(root, 'workflows', 'support-triage.json'), JSON.stringify(main, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'workflows', 'error-handler.json'), JSON.stringify(errorWf, null, 2) + '\n');
console.log(`wrote workflows (CRM ${CRM_URL}, model ${MODEL})`);
