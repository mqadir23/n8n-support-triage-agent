/**
 * Validation and cost helpers for the triage workflow.
 *
 * This file is compiled to dist/triage.js and embedded into the n8n Code nodes
 * by scripts/build-workflow.mjs, so the exact same logic is unit tested here and
 * runs inside the workflow.
 */

export const CATEGORIES = ['billing', 'technical', 'shipping', 'account', 'general'] as const;
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export const SENTIMENTS = ['negative', 'neutral', 'positive'] as const;

export type Category = (typeof CATEGORIES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Sentiment = (typeof SENTIMENTS)[number];

export interface TriageResult {
  category: Category;
  priority: Priority;
  sentiment: Sentiment;
  summary: string;
  suggested_reply: string;
  needs_human: boolean;
  confidence: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  result?: TriageResult;
}

export interface ValidationOptions {
  /** Answers below this confidence are rejected and retried. */
  minConfidence?: number;
  maxSummaryChars?: number;
  maxReplyChars?: number;
}

/**
 * Pull a JSON object out of model text. Models often wrap JSON in markdown
 * fences or add a sentence before it, so try a few strategies in order.
 */
export function extractJson(text: unknown): unknown | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // try the next strategy
    }
  }
  return null;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/** Check a parsed model answer against the triage contract and report every problem found. */
export function validateTriage(raw: unknown, options: ValidationOptions = {}): ValidationResult {
  const minConfidence = options.minConfidence ?? 0.6;
  const maxSummaryChars = options.maxSummaryChars ?? 280;
  const maxReplyChars = options.maxReplyChars ?? 1200;
  const errors: string[] = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['The answer must be a single JSON object.'] };
  }
  const obj = raw as Record<string, unknown>;

  if (!isOneOf(obj.category, CATEGORIES)) errors.push(`category must be one of: ${CATEGORIES.join(', ')}.`);
  if (!isOneOf(obj.priority, PRIORITIES)) errors.push(`priority must be one of: ${PRIORITIES.join(', ')}.`);
  if (!isOneOf(obj.sentiment, SENTIMENTS)) errors.push(`sentiment must be one of: ${SENTIMENTS.join(', ')}.`);

  if (typeof obj.summary !== 'string' || obj.summary.trim().length === 0) {
    errors.push('summary must be a non-empty string.');
  } else if (obj.summary.length > maxSummaryChars) {
    errors.push(`summary must be at most ${maxSummaryChars} characters.`);
  }

  if (typeof obj.suggested_reply !== 'string' || obj.suggested_reply.trim().length < 20) {
    errors.push('suggested_reply must be a string of at least 20 characters.');
  } else if (obj.suggested_reply.length > maxReplyChars) {
    errors.push(`suggested_reply must be at most ${maxReplyChars} characters.`);
  }

  if (typeof obj.needs_human !== 'boolean') errors.push('needs_human must be true or false.');

  if (typeof obj.confidence !== 'number' || Number.isNaN(obj.confidence) || obj.confidence < 0 || obj.confidence > 1) {
    errors.push('confidence must be a number between 0 and 1.');
  } else if (obj.confidence < minConfidence) {
    errors.push(`confidence ${obj.confidence} is below the minimum of ${minConfidence}; re-check the customer and knowledge base data.`);
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    errors: [],
    result: {
      category: obj.category as Category,
      priority: obj.priority as Priority,
      sentiment: obj.sentiment as Sentiment,
      summary: (obj.summary as string).trim(),
      suggested_reply: (obj.suggested_reply as string).trim(),
      needs_human: obj.needs_human as boolean,
      confidence: Math.round((obj.confidence as number) * 100) / 100,
    },
  };
}

/** Turn validation errors into a feedback block that is appended to the retry prompt. */
export function buildFeedback(errors: string[]): string {
  const lines = errors.map((e, i) => `${i + 1}. ${e}`);
  return [
    'FEEDBACK: your previous answer was rejected by the validator.',
    ...lines,
    'Return only one corrected JSON object with exactly these keys: category, priority, sentiment, summary, suggested_reply, needs_human, confidence.',
  ].join('\n');
}

/** Rough token estimate (about 4 characters per token for English). Used only for monitoring. */
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

export interface CostRates {
  /** USD per one million input tokens. */
  inputPerMillion: number;
  /** USD per one million output tokens. */
  outputPerMillion: number;
}

export function estimateCostUsd(promptTokens: number, outputTokens: number, rates: CostRates): number {
  const cost = (promptTokens * rates.inputPerMillion + outputTokens * rates.outputPerMillion) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Decide what happens after a validation pass. Pure function so the loop logic is testable. */
export function nextStep(args: { valid: boolean; attempt: number; maxAttempts: number; needsHuman?: boolean }):
  | 'retry'
  | 'give_up'
  | 'escalate'
  | 'finish' {
  if (!args.valid) return args.attempt < args.maxAttempts ? 'retry' : 'give_up';
  return args.needsHuman ? 'escalate' : 'finish';
}
