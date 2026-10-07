import { describe, expect, it, vi } from 'vitest';
import { SUMMARY_PREFIX, compactHistory, estimateMessagesTokens, estimateTokens, renderTranscript, splitTurns } from './history.js';
import type { Message } from '../utils/types.js';

const big = (n: number) => 'x'.repeat(n);

/** A turn: user asks, assistant calls a tool, tool answers, assistant replies. */
function turn(i: number, toolChars = 100): Message[] {
  return [
    { role: 'user', content: `question ${i}` },
    { role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: `c${i}`, content: big(toolChars) },
    { role: 'assistant', content: `answer ${i}` },
  ];
}

/** Every assistant tool call must be followed by its tool results. */
function assertValidPairs(messages: Message[]) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as any;
    if (m.role === 'tool') {
      const prev = messages.slice(0, i).reverse().find((x: any) => x.role === 'assistant' && x.tool_calls);
      expect(prev, `tool message at ${i} has no preceding tool call`).toBeTruthy();
      expect((prev as any).tool_calls.some((c: any) => c.id === m.tool_call_id)).toBe(true);
    }
  }
  expect(messages[0]?.role).toBe('user');
}

describe('token estimation', () => {
  it('counts ASCII at ~4 chars/token and CJK at ~1 char/token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateMessagesTokens([{ role: 'user', content: big(400) }])).toBeGreaterThanOrEqual(100);
  });
});

describe('compactHistory', () => {
  it('leaves history alone when under budget', async () => {
    const h = [...turn(1), ...turn(2)];
    const r = await compactHistory(h, { budget: 10_000 });
    expect(r.changed).toBe(false);
    expect(r.messages).toEqual(h);
  });

  it('elides big old tool outputs first, keeping the current turn intact', async () => {
    const h = [...turn(1, 20_000), ...turn(2, 20_000), { role: 'user', content: 'now' } as Message];
    const r = await compactHistory(h, { budget: 4_000, target: 3_000 });
    expect(r.changed).toBe(true);
    expect(r.elidedToolOutputs).toBe(2);
    expect(r.droppedMessages).toBe(0);
    expect(r.after).toBeLessThanOrEqual(4_000);
    expect(r.messages.at(-1)).toEqual({ role: 'user', content: 'now' });
    expect((r.messages[2] as any).content).toMatch(/old tool output elided/);
  });

  it('drops whole oldest turns and summarizes them', async () => {
    const h: Message[] = [];
    for (let i = 0; i < 30; i++) h.push(...turn(i, 1_500));
    h.push({ role: 'user', content: 'latest' });
    const summarize = vi.fn(async (dropped: Message[]) => `summary of ${dropped.length} messages`);
    const r = await compactHistory(h, { budget: 6_000, summarize });
    expect(summarize).toHaveBeenCalledOnce();
    expect(r.summarized).toBe(true);
    expect(r.droppedMessages % 4).toBe(0); // whole turns only
    expect(r.after).toBeLessThanOrEqual(6_000);
    expect(r.messages[0].content).toBe(`${SUMMARY_PREFIX}\nsummary of ${r.droppedMessages} messages`);
    expect(r.messages[1].role).toBe('assistant');
    expect(r.messages.at(-1)).toEqual({ role: 'user', content: 'latest' });
    assertValidPairs(r.messages);
  });

  it('passes the previous summary along when compacting again', async () => {
    const first: Message[] = [];
    for (let i = 0; i < 20; i++) first.push(...turn(i, 1_500));
    first.push({ role: 'user', content: 'q' });
    const r1 = await compactHistory(first, { budget: 5_000, summarize: async () => 'S1' });
    const second = [...r1.messages, { role: 'assistant', content: 'a' } as Message];
    for (let i = 20; i < 40; i++) second.push(...turn(i, 1_500));
    second.push({ role: 'user', content: 'q2' });
    const summarize = vi.fn(async (_d: Message[], prev?: string) => `S2 after ${prev}`);
    const r2 = await compactHistory(second, { budget: 5_000, summarize });
    expect(summarize.mock.calls[0][1]).toBe('S1');
    expect(r2.messages[0].content).toContain('S2 after S1');
    expect(splitTurns(r2.messages).summary).toBe('S2 after S1');
    assertValidPairs(r2.messages);
  });

  it('falls back to a note when there is no summarizer or it fails', async () => {
    const h: Message[] = [];
    for (let i = 0; i < 20; i++) h.push(...turn(i, 1_500));
    h.push({ role: 'user', content: 'q' });
    const r = await compactHistory(h, { budget: 4_000, summarize: async () => null });
    expect(r.summarized).toBe(false);
    expect(r.messages[0].content).toMatch(/earlier messages were removed/);
    assertValidPairs(r.messages);
  });

  it('force-compacts everything but the latest turn', async () => {
    const h = [...turn(1), ...turn(2), ...turn(3)];
    const r = await compactHistory(h, { budget: 100_000, force: true, summarize: async () => 'S' });
    expect(r.droppedMessages).toBe(8);
    expect(r.messages.slice(2)).toEqual(turn(3));
  });

  it('renders a bounded transcript', () => {
    const t = renderTranscript([...turn(1, 5_000)], 10_000, 100);
    expect(t).toContain('USER: question 1');
    expect(t).toContain('[called read_file');
    expect(t).toContain('chars cut');
    expect(renderTranscript(Array.from({ length: 100 }, () => ({ role: 'user', content: big(100) }) as Message), 500)).toContain('transcript truncated');
  });
});
