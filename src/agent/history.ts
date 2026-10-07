/**
 * Conversation context management.
 *
 * Estimates how many tokens the conversation uses and, when it would overflow
 * the model's context window, compacts it:
 *   1. elide large tool outputs from older turns,
 *   2. drop the oldest turns (summarizing them with the model when a
 *      summarizer is given, otherwise leaving a short note),
 *   3. as a last resort, elide large tool outputs in the current turn.
 *
 * A "turn" starts at a user message and runs until the next one, so an
 * assistant tool call is never separated from its tool results (the API
 * rejects a history that has one without the other).
 */

import type { Message } from '../utils/types.js';

export const SUMMARY_PREFIX = '[Summary of earlier conversation]';
const SUMMARY_ACK = 'Understood. I will continue from this summary.';
const ELIDE_OVER_CHARS = 2_000;
const ELIDE_KEEP_CHARS = 800;
/** Rough allowance for the summary block when planning how much to drop. */
const SUMMARY_RESERVE_TOKENS = 600;

// ─── Estimation ───────────────────────────────────────────────────────────────

/**
 * Estimate tokens in a string without a tokenizer: ~4 ASCII characters per
 * token, and ~1 token per non-ASCII character (CJK text is token-dense).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: { type?: string; text?: string }) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  return '';
}

export function estimateMessageTokens(m: Message): number {
  let n = 4 + estimateTokens(contentText((m as { content?: unknown }).content));
  const calls = (m as { tool_calls?: { function: { name: string; arguments: string } }[] }).tool_calls;
  for (const c of calls ?? []) n += 8 + estimateTokens(c.function.name) + estimateTokens(c.function.arguments);
  return n;
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
  let n = 3;
  for (const m of messages) n += estimateMessageTokens(m);
  return n;
}

export function estimateJsonTokens(value: unknown): number {
  return value === undefined ? 0 : estimateTokens(JSON.stringify(value));
}

// ─── Compaction ───────────────────────────────────────────────────────────────

export interface CompactOptions {
  /** Tokens available for the conversation history. */
  budget: number;
  /** Tokens to aim for after compacting (default: 60% of budget). */
  target?: number;
  /**
   * Summarize dropped messages. Resolve null on failure to fall back to a
   * plain note. Omit to only drop (truncate strategy).
   */
  summarize?: (dropped: Message[], previousSummary: string | undefined) => Promise<string | null>;
  /** Compact even when under budget (the `/compact` command). */
  force?: boolean;
}

export interface CompactResult {
  messages: Message[];
  changed: boolean;
  before: number;
  after: number;
  droppedMessages: number;
  elidedToolOutputs: number;
  summarized: boolean;
}

function isSummaryMessage(m: Message | undefined): boolean {
  return !!m && m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX);
}

/** Split off a leading summary block and return the turns after it. */
export function splitTurns(history: readonly Message[]): { summary?: string; turns: Message[][] } {
  let rest = history.slice();
  let summary: string | undefined;
  if (isSummaryMessage(rest[0])) {
    summary = (rest[0].content as string).slice(SUMMARY_PREFIX.length).trim();
    rest = rest.slice(rest[1]?.role === 'assistant' ? 2 : 1);
  }
  const turns: Message[][] = [];
  for (const m of rest) {
    if (m.role === 'user' || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1].push(m);
  }
  return { summary, turns };
}

function summaryBlock(text: string): Message[] {
  return [
    { role: 'user', content: `${SUMMARY_PREFIX}\n${text}` },
    { role: 'assistant', content: SUMMARY_ACK },
  ];
}

/** Elide long tool outputs in place (on copies). Returns how many were elided. */
function elideToolOutputs(messages: Message[], skipLast = 0): number {
  let count = 0;
  const limit = messages.length - skipLast;
  for (let i = 0; i < limit; i++) {
    const m = messages[i];
    if (m.role !== 'tool' || typeof m.content !== 'string' || m.content.length <= ELIDE_OVER_CHARS) continue;
    const dropped = m.content.length - ELIDE_KEEP_CHARS;
    messages[i] = {
      ...m,
      content: `${m.content.slice(0, ELIDE_KEEP_CHARS)}\n… [old tool output elided: ${dropped} characters; re-run the tool if needed]`,
    };
    count++;
  }
  return count;
}

export async function compactHistory(history: readonly Message[], opts: CompactOptions): Promise<CompactResult> {
  const before = estimateMessagesTokens(history);
  const budget = Math.max(256, Math.floor(opts.budget));
  const target = Math.max(128, Math.floor(opts.target ?? budget * 0.6));
  const unchanged: CompactResult = {
    messages: history.slice(),
    changed: false,
    before,
    after: before,
    droppedMessages: 0,
    elidedToolOutputs: 0,
    summarized: false,
  };
  if (!opts.force && before <= budget) return unchanged;

  const { summary: previousSummary, turns } = splitTurns(history);
  if (turns.length === 0) return unchanged;
  const current = turns[turns.length - 1].slice();
  let older = turns.slice(0, -1).map((t) => t.slice());

  const prefixTokens = () => (previousSummary !== undefined ? estimateMessagesTokens(summaryBlock(previousSummary)) : 0);
  const total = () => prefixTokens() + estimateMessagesTokens([...older.flat(), ...current]);

  // 1. Elide big tool outputs in older turns.
  let elided = 0;
  for (const t of older) elided += elideToolOutputs(t);

  // 2. Drop oldest turns.
  const dropped: Message[] = [];
  if (opts.force) {
    for (const t of older) dropped.push(...t);
    older = [];
  } else if (total() > target) {
    while (older.length > 0 && total() + SUMMARY_RESERVE_TOKENS > target) {
      dropped.push(...(older.shift() as Message[]));
    }
  }

  let prefix: Message[] = previousSummary !== undefined ? summaryBlock(previousSummary) : [];
  let summarized = false;
  if (dropped.length > 0) {
    let text: string | null = null;
    if (opts.summarize) text = await opts.summarize(dropped, previousSummary);
    if (text && text.trim()) {
      summarized = true;
      prefix = summaryBlock(text.trim());
    } else {
      const note = `(${dropped.length} earlier messages were removed to fit the context window.)`;
      prefix = summaryBlock(previousSummary ? `${previousSummary}\n${note}` : note);
    }
  }

  let messages = [...prefix, ...older.flat(), ...current];

  // 3. Still too big: elide tool outputs in the current turn, keeping the newest one whole.
  if (estimateMessagesTokens(messages) > budget) {
    const cur = messages.slice(messages.length - current.length);
    elided += elideToolOutputs(cur, 1);
    messages = [...messages.slice(0, messages.length - current.length), ...cur];
  }

  const after = estimateMessagesTokens(messages);
  return {
    messages,
    changed: dropped.length > 0 || elided > 0,
    before,
    after,
    droppedMessages: dropped.length,
    elidedToolOutputs: elided,
    summarized,
  };
}

/** Render messages as a plain transcript for the summarizer, capped in size. */
export function renderTranscript(messages: readonly Message[], maxChars = 120_000, perMessage = 2_000): string {
  const lines: string[] = [];
  let size = 0;
  for (const m of messages) {
    let text = contentText((m as { content?: unknown }).content);
    const calls = (m as { tool_calls?: { function: { name: string; arguments: string } }[] }).tool_calls;
    if (calls?.length) text += calls.map((c) => `\n[called ${c.function.name}(${c.function.arguments})]`).join('');
    if (text.length > perMessage) text = `${text.slice(0, perMessage)} … [${text.length - perMessage} chars cut]`;
    const line = `${m.role.toUpperCase()}: ${text}`;
    if (size + line.length > maxChars) {
      lines.push('… [transcript truncated]');
      break;
    }
    lines.push(line);
    size += line.length;
  }
  return lines.join('\n\n');
}

export const SUMMARIZER_PROMPT = `You compress a coding-agent conversation so it can continue in a smaller context.
Write a concise summary (at most ~400 words) that keeps everything needed to continue the work:
the user's goals and constraints, decisions made, files read or changed (with paths), commands run and their outcomes,
errors still open, and pending next steps. Use terse bullet points. Do not invent details.`;
