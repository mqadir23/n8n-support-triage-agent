import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeedback,
  estimateCostUsd,
  estimateTokens,
  extractJson,
  nextStep,
  validateTriage,
} from './triage';

const good = {
  category: 'shipping',
  priority: 'medium',
  sentiment: 'neutral',
  summary: 'Customer asks where an order is.',
  suggested_reply: 'Hello, your order has shipped and a tracking link was emailed to you.',
  needs_human: false,
  confidence: 0.86,
};

test('extractJson reads plain, fenced and chatty JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here you go: {"a":1} Hope that helps.'), { a: 1 });
});

test('extractJson rejects non-objects and garbage', () => {
  assert.equal(extractJson('[1,2,3]'), null);
  assert.equal(extractJson('not json'), null);
  assert.equal(extractJson(42), null);
  assert.equal(extractJson(undefined), null);
});

test('validateTriage accepts a good answer and rounds confidence', () => {
  const out = validateTriage({ ...good, confidence: 0.8567 });
  assert.equal(out.valid, true);
  assert.equal(out.result?.confidence, 0.86);
});

test('validateTriage reports every problem at once', () => {
  const out = validateTriage({ category: 'sales', priority: 'meh', sentiment: 5, summary: '', suggested_reply: 'short', needs_human: 'no', confidence: 2 });
  assert.equal(out.valid, false);
  assert.equal(out.errors.length, 7);
});

test('validateTriage rejects low confidence so the loop can retry', () => {
  const out = validateTriage({ ...good, confidence: 0.3 });
  assert.equal(out.valid, false);
  assert.match(out.errors[0], /below the minimum/);
});

test('validateTriage honours a custom confidence floor', () => {
  assert.equal(validateTriage({ ...good, confidence: 0.7 }, { minConfidence: 0.8 }).valid, false);
  assert.equal(validateTriage({ ...good, confidence: 0.7 }, { minConfidence: 0.5 }).valid, true);
});

test('validateTriage rejects non-objects', () => {
  assert.equal(validateTriage(null).valid, false);
  assert.equal(validateTriage([good]).valid, false);
});

test('buildFeedback numbers the errors and restates the contract', () => {
  const text = buildFeedback(['category is wrong.', 'confidence is low.']);
  assert.match(text, /^FEEDBACK:/);
  assert.match(text, /1\. category is wrong\./);
  assert.match(text, /2\. confidence is low\./);
  assert.match(text, /exactly these keys/);
});

test('token and cost estimates', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateCostUsd(1000, 500, { inputPerMillion: 0.59, outputPerMillion: 0.79 }), 0.000985);
});

test('nextStep drives the retry loop', () => {
  assert.equal(nextStep({ valid: false, attempt: 1, maxAttempts: 3 }), 'retry');
  assert.equal(nextStep({ valid: false, attempt: 3, maxAttempts: 3 }), 'give_up');
  assert.equal(nextStep({ valid: true, attempt: 1, maxAttempts: 3, needsHuman: true }), 'escalate');
  assert.equal(nextStep({ valid: true, attempt: 2, maxAttempts: 3, needsHuman: false }), 'finish');
});
