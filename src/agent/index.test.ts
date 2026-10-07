import { describe, expect, it } from 'vitest';
import { Writable } from 'stream';
import { AgentAbortError, createAgent, type ChatClient } from './index.js';

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

type Reply = { content?: string; toolCalls?: { id: string; name: string; args: string }[] };

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
            return { choices: [{ message: { role: 'assistant', content: r.content ?? null, tool_calls } }] };
          }
          return (async function* () {
            for (const ch of (r.content ?? '').match(/.{1,3}/gs) ?? []) yield { choices: [{ delta: { content: ch } }] };
            for (const [index, t] of (r.toolCalls ?? []).entries()) {
              yield { choices: [{ delta: { tool_calls: [{ index, id: t.id, function: { name: t.name, arguments: '' } }] } }] };
              for (const part of t.args.match(/.{1,4}/gs) ?? []) {
                yield { choices: [{ delta: { tool_calls: [{ index, function: { arguments: part } }] } }] };
              }
            }
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
