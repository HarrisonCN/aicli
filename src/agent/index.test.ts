import { describe, expect, it } from 'vitest';
import { Writable } from 'stream';
import { AgentAbortError, createAgent, estimateCost, type ChatClient } from './index.js';
import { SUMMARIZER_PROMPT, SUMMARY_PREFIX } from './history.js';

function sink() {
  let text = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += chunk.toString();
      cb();
    },
  });
  return { stream, get text() { return text; } };
}

type Reply = { content?: string; toolCalls?: { id: string; name: string; args: string }[]; usage?: { prompt_tokens: number; completion_tokens: number } };

/** Fake client that replays scripted replies, streaming or not. */
function fakeClient(replies: (Reply | Error)[], seen: unknown[] = []): ChatClient {
  let i = 0;
  return {
    chat: {
      completions: {
        async create(body, options) {
          seen.push(JSON.parse(JSON.stringify(body)));
          if (options?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          const r = replies[i++];
          if (r instanceof Error) throw r;
          if (!r) throw new Error('no more scripted replies');
          const tool_calls = r.toolCalls?.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } }));
          if (!body.stream) {
            return { choices: [{ message: { role: 'assistant', content: r.content ?? null, tool_calls } }], usage: r.usage };
          }
          return (async function* () {
            for (const ch of (r.content ?? '').match(/.{1,3}/gs) ?? []) yield { choices: [{ delta: { content: ch } }] };
            for (const [index, t] of (r.toolCalls ?? []).entries()) {
              yield { choices: [{ delta: { tool_calls: [{ index, id: t.id, function: { name: t.name, arguments: '' } }] } }] };
              for (const part of t.args.match(/.{1,4}/gs) ?? []) {
                yield { choices: [{ delta: { tool_calls: [{ index, function: { arguments: part } }] } }] };
              }
            }
            if (r.usage) yield { choices: [], usage: r.usage };
          })();
        },
      },
    },
  };
}

describe('agent', () => {
  for (const stream of [true, false]) {
    it(`returns a final answer (stream=${stream})`, async () => {
      const out = sink();
      const agent = createAgent({ client: fakeClient([{ content: 'Hello there' }]), stream, output: out.stream, log: sink().stream });
      const res = await agent.run('hi');
      expect(res).toEqual({ success: true, output: 'Hello there', iterations: 1 });
      expect(out.text).toContain('Hello there');
    });

    it(`assembles streamed tool calls and feeds results back (stream=${stream})`, async () => {
      const seen: any[] = [];
      const client = fakeClient(
        [{ toolCalls: [{ id: 'c1', name: 'nonexistent_tool', args: '{"a":1}' }] }, { content: 'done' }],
        seen
      );
      const agent = createAgent({ client, stream, output: sink().stream, log: sink().stream });
      const res = await agent.run('do it');
      expect(res.success).toBe(true);
      expect(res.iterations).toBe(2);
      const msgs = seen[1].messages;
      expect(msgs[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'nonexistent_tool', arguments: '{"a":1}' } }] });
      expect(msgs[3]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'Error: Unknown tool "nonexistent_tool"' });
    });
  }

  it('reports invalid tool-call JSON to the model instead of running with {}', async () => {
    const seen: any[] = [];
    const client = fakeClient([{ toolCalls: [{ id: 'c1', name: 'read_file', args: '{bad' }] }, { content: 'ok' }], seen);
    const agent = createAgent({ client, output: sink().stream, log: sink().stream });
    await agent.run('x');
    expect(seen[1].messages[3].content).toMatch(/could not parse tool arguments/);
  });

  it('quiet mode writes nothing to output', async () => {
    const out = sink();
    const agent = createAgent({ client: fakeClient([{ content: 'secret answer' }]), quiet: true, output: out.stream, log: sink().stream });
    await agent.run('x');
    expect(out.text).toBe('');
  });

  it('stops at maxIterations', async () => {
    const loop = { toolCalls: [{ id: 'c', name: 'nope', args: '{}' }] };
    const agent = createAgent({ client: fakeClient([loop, loop, loop]), maxIterations: 2, output: sink().stream, log: sink().stream });
    const res = await agent.run('x');
    expect(res).toMatchObject({ success: false, iterations: 2, error: 'max_iterations' });
  });

  it('rolls back history after an API error so the next turn is valid', async () => {
    const seen: any[] = [];
    const client = fakeClient([{ toolCalls: [{ id: 'c', name: 'nope', args: '{}' }] }, new Error('boom'), { content: 'fine' }], seen);
    const agent = createAgent({ client, output: sink().stream, log: sink().stream });
    await expect(agent.run('first')).rejects.toThrow('boom');
    expect(agent.history).toHaveLength(0);
    await agent.run('second');
    expect(seen[2].messages.map((m: any) => m.role)).toEqual(['system', 'user']);
  });

  it('throws AgentAbortError when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const agent = createAgent({ client: fakeClient([{ content: 'x' }]), output: sink().stream, log: sink().stream });
    await expect(agent.run('x', { signal: controller.signal })).rejects.toBeInstanceOf(AgentAbortError);
  });

  it('omits tools when disabled and passes the model/temperature', async () => {
    const seen: any[] = [];
    const agent = createAgent({ client: fakeClient([{ content: 'x' }], seen), tools: false, model: 'm1', temperature: 0.2, output: sink().stream, log: sink().stream });
    await agent.run('x');
    expect(seen[0].tools).toBeUndefined();
    expect(seen[0].model).toBe('m1');
    expect(seen[0].temperature).toBe(0.2);
  });

  it('gives a clear error when no API key is configured', () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => createAgent({})).toThrow(/No API key configured/);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});

describe('model-aware requests', () => {
  it('omits temperature for reasoning models, uses the developer role and reasoning_effort', async () => {
    const seen: any[] = [];
    const log = sink();
    const agent = createAgent({
      client: fakeClient([{ content: 'x' }], seen),
      model: 'o3-mini',
      temperature: 0.2,
      temperatureExplicit: true,
      modelSettings: { 'o3*': { reasoningEffort: 'high', maxOutputTokens: 2000 } },
      output: sink().stream,
      log: log.stream,
    });
    await agent.run('x');
    expect(seen[0].temperature).toBeUndefined();
    expect(seen[0].messages[0].role).toBe('developer');
    expect(seen[0].reasoning_effort).toBe('high');
    expect(seen[0].max_completion_tokens).toBe(2000);
    expect(seen[0].max_tokens).toBeUndefined();
    expect(log.text).toMatch(/does not accept a temperature/);
  });

  it('switches model at runtime', async () => {
    const seen: any[] = [];
    const agent = createAgent({ client: fakeClient([{ content: 'a' }, { content: 'b' }], seen), temperature: 0.5, output: sink().stream, log: sink().stream });
    await agent.run('1');
    agent.setModel('o1');
    await agent.run('2');
    expect(seen[0]).toMatchObject({ model: 'gpt-4o', temperature: 0.5 });
    expect(seen[1].model).toBe('o1');
    expect(seen[1].temperature).toBeUndefined();
    expect(() => agent.setModel(' ')).toThrow();
  });
});

describe('usage tracking', () => {
  for (const stream of [true, false]) {
    it(`accumulates token usage (stream=${stream})`, async () => {
      const seen: any[] = [];
      const usage = { prompt_tokens: 100, completion_tokens: 20 };
      const agent = createAgent({
        client: fakeClient([{ toolCalls: [{ id: 'c', name: 'nope', args: '{}' }], usage }, { content: 'ok', usage }], seen),
        stream,
        modelSettings: { 'gpt-4o': { inputPricePerMTok: 2.5, outputPricePerMTok: 10 } },
        output: sink().stream,
        log: sink().stream,
      });
      await agent.run('x');
      expect(agent.usage).toEqual({ requests: 2, promptTokens: 200, completionTokens: 40 });
      expect(estimateCost(agent.usage, agent.profile())).toBeCloseTo((200 * 2.5 + 40 * 10) / 1e6);
      if (stream) expect(seen[0].stream_options).toEqual({ include_usage: true });
      else expect(seen[0].stream_options).toBeUndefined();
    });
  }

  it('can turn off stream_options for servers that reject it', async () => {
    const seen: any[] = [];
    const agent = createAgent({ client: fakeClient([{ content: 'x' }], seen), streamUsage: false, output: sink().stream, log: sink().stream });
    await agent.run('x');
    expect(seen[0].stream_options).toBeUndefined();
    expect(estimateCost(agent.usage, agent.profile())).toBeNull();
  });
});

describe('context management', () => {
  /** Client that answers summarization requests with a summary and everything else with "ok". */
  function summarizingClient(seen: any[], failSummary = false): ChatClient {
    return {
      chat: {
        completions: {
          async create(body) {
            seen.push(JSON.parse(JSON.stringify(body)));
            const isSummary = (body.messages[0] as any).content === SUMMARIZER_PROMPT;
            if (isSummary && failSummary) throw new Error('summary failed');
            return { choices: [{ message: { role: 'assistant', content: isSummary ? 'SUMMARY TEXT' : 'ok' } }] };
          },
        },
      },
    };
  }
  const long = (i: number) => `message ${i} ` + 'lorem ipsum '.repeat(300);

  it('summarizes old turns before the context window overflows', async () => {
    const seen: any[] = [];
    const log = sink();
    const agent = createAgent({
      client: summarizingClient(seen),
      stream: false,
      tools: false,
      modelSettings: { 'gpt-4o': { contextWindow: 6000, maxOutputTokens: 500 } },
      output: sink().stream,
      log: log.stream,
    });
    for (let i = 0; i < 12; i++) await agent.run(long(i));
    const summaryCalls = seen.filter((b) => b.messages[0].content === SUMMARIZER_PROMPT);
    expect(summaryCalls.length).toBeGreaterThan(0);
    const last = seen.filter((b) => b.messages[0].content !== SUMMARIZER_PROMPT).at(-1);
    expect(last.messages[1].content).toBe(`${SUMMARY_PREFIX}\nSUMMARY TEXT`);
    expect(last.messages.at(-1).content).toBe(long(11));
    const stats = agent.contextStats();
    expect(stats.estimatedTokens).toBeLessThanOrEqual(stats.contextWindow);
    expect(log.text).toMatch(/Context compacted/);
  });

  it('falls back to dropping when summarization fails, and truncate/off strategies behave', async () => {
    const seen: any[] = [];
    const opts = { stream: false, tools: false, modelSettings: { 'gpt-4o': { contextWindow: 6000, maxOutputTokens: 500 } }, output: sink().stream, log: sink().stream } as const;
    const failing = createAgent({ ...opts, client: summarizingClient(seen, true) });
    for (let i = 0; i < 12; i++) await failing.run(long(i));
    expect(failing.history[0].content).toMatch(/earlier messages were removed/);

    const seen2: any[] = [];
    const truncating = createAgent({ ...opts, contextStrategy: 'truncate', client: summarizingClient(seen2) });
    for (let i = 0; i < 12; i++) await truncating.run(long(i));
    expect(seen2.some((b) => b.messages[0].content === SUMMARIZER_PROMPT)).toBe(false);
    expect(truncating.history.length).toBeLessThan(24);

    const off = createAgent({ ...opts, contextStrategy: 'off', client: summarizingClient([]) });
    for (let i = 0; i < 12; i++) await off.run(long(i));
    expect(off.history).toHaveLength(24);
  });

  it('/compact summarizes everything but the last turn; history can be loaded', async () => {
    const seen: any[] = [];
    const agent = createAgent({ client: summarizingClient(seen), stream: false, tools: false, output: sink().stream, log: sink().stream });
    agent.loadHistory([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
    ]);
    const r = await agent.compact();
    expect(r.droppedMessages).toBe(2);
    expect(agent.history.map((m) => m.content)).toEqual([`${SUMMARY_PREFIX}\nSUMMARY TEXT`, expect.any(String), 'c', 'd']);
  });

  it('restores history (including compaction) after a failed run', async () => {
    let calls = 0;
    const client: ChatClient = {
      chat: {
        completions: {
          async create(body) {
            calls++;
            if ((body.messages[0] as any).content === SUMMARIZER_PROMPT) return { choices: [{ message: { content: 'S' } }] };
            if (calls > 6) throw new Error('boom');
            return { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
          },
        },
      },
    };
    const agent = createAgent({ client, stream: false, tools: false, modelSettings: { 'gpt-4o': { contextWindow: 4000, maxOutputTokens: 200 } }, output: sink().stream, log: sink().stream });
    let before: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      before = agent.history.slice();
      try {
        await agent.run(long(i));
      } catch {
        break;
      }
    }
    expect(agent.history).toEqual(before);
  });
});

