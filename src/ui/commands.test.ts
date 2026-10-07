import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgent, type ChatClient } from '../agent/index.js';
import { createSession, loadSession } from '../utils/sessions.js';
import { handleCommand, type CommandContext } from './commands.js';

let dir: string;
const savedEnv = process.env.AICLI_CONFIG_DIR;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aicli-cmd-'));
  process.env.AICLI_CONFIG_DIR = dir;
});
afterAll(async () => {
  if (savedEnv === undefined) delete process.env.AICLI_CONFIG_DIR;
  else process.env.AICLI_CONFIG_DIR = savedEnv;
  await rm(dir, { recursive: true, force: true });
});

const client: ChatClient = {
  chat: {
    completions: {
      async create() {
        return { choices: [{ message: { role: 'assistant', content: 'reply' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
      },
    },
  },
};

function setup() {
  let out = '';
  const agent = createAgent({ client, stream: false, tools: false, output: { write: () => true } as any, log: { write: () => true } as any });
  const ctx: CommandContext = { agent, session: createSession('/proj', 'gpt-4o'), saveSessions: true, write: (t) => (out += t) };
  return { agent, ctx, out: () => out, clear: () => (out = '') };
}

describe('slash commands', () => {
  it('ignores non-commands and paths', async () => {
    const { ctx } = setup();
    expect(await handleCommand('hello', ctx)).toBeNull();
    expect(await handleCommand('/etc/hosts — what is this file?', ctx)).toBeNull();
  });

  it('/help lists commands; unknown commands are reported', async () => {
    const t = setup();
    await handleCommand('/help', t.ctx);
    for (const c of ['/model', '/cost', '/save', '/load', '/sessions', '/compact', '/clear']) expect(t.out()).toContain(c);
    t.clear();
    expect(await handleCommand('/bogus', t.ctx)).toEqual({});
    expect(t.out()).toMatch(/Unknown command \/bogus/);
  });

  it('/model shows and switches the model', async () => {
    const t = setup();
    await handleCommand('/model', t.ctx);
    expect(t.out()).toContain('Model: gpt-4o');
    await handleCommand('/model o3-mini', t.ctx);
    expect(t.agent.getModel()).toBe('o3-mini');
    expect(t.out()).toMatch(/Switched to o3-mini .*no temperature/);
  });

  it('/cost reports usage and context', async () => {
    const t = setup();
    await t.agent.run('hi');
    await handleCommand('/usage', t.ctx);
    expect(t.out()).toContain('Requests:  1');
    expect(t.out()).toContain('10 in / 5 out');
    expect(t.out()).toMatch(/Context: +~\d+ \/ 128,000 tokens/);
  });

  it('/save, /sessions, /clear and /load round-trip a session', async () => {
    const t = setup();
    await t.agent.run('remember the number 42');
    await handleCommand('/save my-session', t.ctx);
    expect(t.out()).toMatch(/Saved session .* \[my-session\]/);
    const saved = await loadSession('my-session');
    expect(saved?.messages).toHaveLength(2);
    expect(saved?.usage?.requests).toBe(1);

    await handleCommand('/sessions', t.ctx);
    expect(t.out()).toContain('[my-session]');

    const oldId = t.ctx.session.id;
    await handleCommand('/clear', t.ctx);
    expect(t.agent.history).toHaveLength(0);
    expect(t.ctx.session.id).not.toBe(oldId);

    await handleCommand('/load my-session', t.ctx);
    expect(t.agent.history).toHaveLength(2);
    expect(t.ctx.session.id).toBe(oldId);
    t.clear();
    await handleCommand('/load nothing-here', t.ctx);
    expect(t.out()).toMatch(/No session matches/);
    t.clear();
    await handleCommand('/save bad/name', t.ctx);
    expect(t.out()).toMatch(/may only use/);
  });

  it('/compact and /exit', async () => {
    const t = setup();
    await handleCommand('/compact', t.ctx);
    expect(t.out()).toMatch(/Nothing to compact/);
    expect(await handleCommand('/quit', t.ctx)).toEqual({ exit: true });
  });

  it('/export writes the conversation to a file and will not overwrite it', async () => {
    const { agent, ctx, out, clear } = setup();
    await handleCommand('/export', ctx);
    expect(out()).toContain('Nothing to export yet.');
    await agent.run('hello there');
    const file = join(dir, 'chat.md');
    clear();
    await handleCommand(`/export ${file}`, ctx);
    expect(out()).toContain(`Exported 2 messages to ${file}.`);
    const md = await readFile(file, 'utf-8');
    expect(md).toContain('### 🧑 User\n\nhello there');
    expect(md).toContain('reply');
    clear();
    await handleCommand(`/export ${file}`, ctx);
    expect(out()).toMatch(/already exists\. Choose another file name\./);
    const jsonFile = join(dir, 'chat.json');
    await handleCommand(`/export ${jsonFile}`, ctx);
    expect(JSON.parse(await readFile(jsonFile, 'utf-8')).messages).toHaveLength(2);
  });
});
