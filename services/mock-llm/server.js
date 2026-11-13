// Deterministic mock of an OpenAI-compatible chat completions API with tool calling.
// It lets the workflow be tested end to end without an API key, and exercises the retry loop.
//
// Flags you can put in a ticket to trigger behaviour:
//   [force-invalid]   first attempt returns prose instead of JSON (tests JSON recovery and retry)
//   [low-confidence]  first attempt returns confidence 0.35 (tests the confidence floor)
// Both flags are ignored once the prompt contains validator FEEDBACK, so the retry succeeds.
const http = require('node:http');

const PORT = Number(process.env.PORT || 4020);
const LATENCY_MS = Number(process.env.MOCK_LATENCY_MS || 150);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p.text || '')).join(' ');
  return '';
}

function extractEmail(text) {
  const m = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return m ? m[0].toLowerCase() : '';
}

function keywords(text) {
  const stop = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'have', 'from', 'your', 'please', 'hello', 'thanks', 'ticket', 'subject', 'body', 'customer']);
  const words = (text.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !stop.has(w));
  return [...new Set(words)].slice(0, 5).join(' ');
}

function buildToolCalls(tools, ticketText) {
  const email = extractEmail(ticketText);
  const terms = keywords(ticketText);
  return tools.map((tool, i) => {
    const fn = tool.function || {};
    const props = Object.keys((fn.parameters && fn.parameters.properties) || {});
    const args = {};
    for (const p of props) {
      if (/email/i.test(p)) args[p] = email;
      else if (/search|query|term|keyword/i.test(p)) args[p] = terms;
      else args[p] = '';
    }
    return { id: `call_${i}_${Date.now()}`, type: 'function', function: { name: fn.name, arguments: JSON.stringify(args) } };
  });
}

function classify(ticketText, toolText, retried) {
  const t = ticketText.toLowerCase();
  const tools = toolText.toLowerCase();
  let category = 'general';
  if (/refund|charge|invoice|billing|payment/.test(t)) category = 'billing';
  else if (/not turn on|won't turn on|error|broken|crash|no picture|not working|red light/.test(t)) category = 'technical';
  else if (/order|ship|tracking|delivery|where is/.test(t)) category = 'shipping';
  else if (/password|login|log in|sign in|account/.test(t)) category = 'account';

  let priority = 'medium';
  if (/urgent|asap|outage|down for|immediately/.test(t)) priority = 'urgent';
  else if (/refund|not working|broken|no picture|charged twice/.test(t)) priority = 'high';
  else if (/question|wondering|how do i/.test(t)) priority = 'low';

  const sentiment = /angry|terrible|unacceptable|furious|worst|still waiting|fed up/.test(t) ? 'negative' : /thank|great|love/.test(t) ? 'positive' : 'neutral';
  const enterprise = /"plan":"enterprise"|\benterprise\b/.test(tools);
  const legal = /lawyer|legal|sue|contract/.test(t);
  const needs_human = priority === 'urgent' || enterprise || legal;

  const nameMatch = toolText.match(/"name":"([^"]+)"/);
  const greeting = nameMatch ? `Hello ${nameMatch[1].split(' ')[0]},` : 'Hello,';
  const kbHit = /refund|shipping|reset|display|onboarding/i.test(tools) ? 'Based on our knowledge base, ' : '';
  const replies = {
    billing: 'we are checking the charge on your account and will confirm the refund timeline shortly.',
    technical: 'please hold the power button for 10 seconds to reset the display; if the light stays red we will arrange a replacement.',
    shipping: 'your order status is being checked and we will send the tracking details if it has shipped.',
    account: 'you can reset your password from the sign-in page, and the email is valid for 30 minutes.',
    general: 'thanks for reaching out, a support specialist will review your message and reply soon.',
  };
  let confidence = 0.9;
  if (/\[low-confidence\]/.test(t) && !retried) confidence = 0.35;

  return {
    category,
    priority,
    sentiment,
    summary: `${category} request: ${ticketText.replace(/\s+/g, ' ').slice(0, 110).trim()}`,
    suggested_reply: `${greeting} ${kbHit}${replies[category]}`,
    needs_human,
    confidence,
  };
}

function respond(res, body, stream) {
  const msg = body.choices[0].message;
  if (!stream) {
    const data = JSON.stringify(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(data);
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const base = { id: body.id, object: 'chat.completion.chunk', created: body.created, model: body.model };
  const delta = msg.tool_calls
    ? { role: 'assistant', content: null, tool_calls: msg.tool_calls.map((c, index) => ({ index, ...c })) }
    : { role: 'assistant', content: msg.content };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: body.choices[0].finish_reason }], usage: body.usage })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-triage-model', object: 'model' }] }));
  }
  if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end('{"error":"not found"}');
  }

  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body;
    try { body = JSON.parse(raw); } catch { res.writeHead(400); return res.end('{"error":"bad json"}'); }

    const messages = body.messages || [];
    const allText = messages.map((m) => textOf(m.content)).join('\n');
    const userTexts = messages.filter((m) => m.role === 'user').map((m) => textOf(m.content));
    const ticketText = userTexts[userTexts.length - 1] || '';
    const toolText = messages.filter((m) => m.role === 'tool').map((m) => textOf(m.content)).join('\n');
    const retried = /FEEDBACK:/.test(allText);
    const tools = body.tools || [];
    const hasToolResults = messages.some((m) => m.role === 'tool');

    let message;
    let finish = 'stop';
    let completionText = '';
    if (tools.length > 0 && !hasToolResults) {
      message = { role: 'assistant', content: null, tool_calls: buildToolCalls(tools, ticketText) };
      finish = 'tool_calls';
      completionText = JSON.stringify(message.tool_calls);
    } else if (/\[force-invalid\]/i.test(ticketText) && !retried) {
      completionText = 'Sure, here is my analysis: the customer seems upset about something.';
      message = { role: 'assistant', content: completionText };
    } else {
      completionText = JSON.stringify(classify(ticketText, toolText, retried));
      message = { role: 'assistant', content: completionText };
    }

    const promptTokens = Math.ceil(allText.length / 4);
    const completionTokens = Math.ceil(completionText.length / 4);
    const payload = {
      id: `chatcmpl-mock-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model || 'mock-triage-model',
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    };
    setTimeout(() => respond(res, payload, Boolean(body.stream)), LATENCY_MS);
  });
});

server.listen(PORT, () => console.log(`mock-llm listening on :${PORT}`));
