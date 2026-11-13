# n8n Support Ticket Triage Agent

An n8n workflow that receives a support ticket over a webhook, lets an LLM agent look up the customer and the knowledge base, and returns a validated triage result (category, priority, sentiment, summary, draft reply, escalation flag). Invalid model output is caught, fed back to the model as specific feedback, and retried. Every attempt is logged with latency and an estimated cost.

The point of the project is the reliability layer around the LLM, not the classification itself.

## How it works

```
POST /webhook/triage  (Bearer token)
  -> Validate Input         400 with details if the ticket is malformed
  -> Insert Ticket          Postgres
  -> Build Prompt  <-----------------------------+
  -> Triage Agent (LLM + 3 tools)                |
       Lookup Customer      Postgres query       |
       Search Knowledge Base  Postgres full-text |
       CRM Customer Record  HTTP, Bearer auth    |
  -> Validate Output        parse JSON, check schema and confidence floor
  -> Log LLM Run            latency, estimated tokens and cost per attempt
  -> Retry?  --yes--> Next Attempt (adds the validator's errors to the prompt)
       |
       no
  -> Save Result -> Send To CRM (case, or escalation if needs_human) -> Respond
```

- **Validation** (`src/triage.ts`): extracts JSON even when wrapped in prose or code fences, checks every field against the contract, and rejects answers below a 0.6 confidence. The compiled code is embedded into the workflow's Code nodes by `scripts/build-workflow.mjs`, so the unit-tested code is the code that runs.
- **State-aware retry**: a retry does not repeat the same prompt. It appends the exact validation errors, up to 3 attempts. After that the ticket is saved as `failed` and the caller gets HTTP 422.
- **Escalation**: tickets the model flags with `needs_human` go to the CRM `/escalations` endpoint instead of `/cases`.
- **Error workflow** (`workflows/error-handler.json`): any node failure after retries (for example the CRM being down) is written to `workflow_errors` and the caller gets a 500.
- **Webhook auth**: header auth credential; requests without the token get 403.
- **Provider switching**: the chat model uses n8n's OpenAI node pointed at a configurable base URL, so Groq, Gemini (OpenAI-compatible endpoint), OpenAI or the bundled mock all work by changing `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` in `.env`.

## Data

`db/init.sql` creates `customers`, `orders`, `kb_articles` (generated `tsvector` column with a GIN index), `tickets`, `llm_runs` and `workflow_errors`, with fictional seed data. Example monitoring query:

```sql
SELECT attempt, count(*) AS runs, round(avg(latency_ms)) AS avg_ms,
       sum(est_cost_usd) AS est_cost, count(*) FILTER (WHERE NOT valid) AS rejected
FROM llm_runs GROUP BY attempt ORDER BY attempt;
```

## Run it

```bash
cp .env.example .env            # then edit the secrets
npm install && npm run build && npm test
npm run build:workflow          # regenerates workflows/*.json
npm run credentials             # writes .n8n-import/credentials.json (git-ignored)
docker compose --profile mock up -d
npm run samples                 # sends test-data/tickets.json to the webhook
```

For a real model, set `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` in `.env`, rerun `npm run credentials`, and start without the `mock` profile. Free-tier options: Groq (`https://api.groq.com/openai/v1`) or Gemini (`https://generativelanguage.googleapis.com/v1beta/openai/`).

Note: the model name inside `workflows/support-triage.json` is set at build time (`node scripts/build-workflow.mjs --model <name>`), and the cost rates in `scripts/build-workflow.mjs` are placeholders for the estimate only.

## Testing notes (what was and was not verified)

- Unit tests: `npm test` (10 tests for JSON extraction, validation, feedback and loop logic).
- End to end: the full workflow was imported into n8n 2.47.4 with Postgres 16 and the two mock services, and `test-data/tickets.json` was run through the webhook. Verified: shipping and billing tickets, an enterprise escalation to the CRM, a retry after non-JSON output, a retry after a low-confidence answer, rejection of a malformed ticket before the LLM, 403 without the token, and the error workflow recording a CRM outage.
- The mock LLM is rule-based. It proves the plumbing, the tool calling and the retry loop, not the quality of a real model's classification.
- Not verified: runs against a real provider (Groq, Gemini, OpenAI), and `docker-compose.yml` itself (the test environment had no Docker daemon, so n8n was run directly with Node and Postgres).
- Token counts in `llm_runs` are estimates (about 4 characters per token) of the ticket prompt only. They do not include the system prompt or tool results, so treat the cost column as a trend indicator, not billing data.
- Fictional data only. Do not put real customer data or real keys in this repo.

## Layout

```
db/init.sql               schema and seed data
src/triage.ts             validation, feedback, cost helpers (tested)
scripts/                  workflow generator, credential file writer, sample runner
services/mock-crm         tiny CRM with Bearer auth
services/mock-llm         OpenAI-compatible mock with tool calling
workflows/                generated n8n workflow JSON
test-data/tickets.json    sample tickets covering each path
docker-compose.yml        Postgres, n8n, mock CRM, optional mock LLM
```
