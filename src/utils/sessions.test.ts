import { mkdtemp, readdir, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession, deleteSession, formatSessionList, listSessions, loadSession, saveSession, sessionsDir } from './sessions.js';

let dir: string;
const savedEnv = process.env.AICLI_CONFIG_DIR;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aicli-sess-'));
  process.env.AICLI_CONFIG_DIR = dir;
});
afterAll(async () => {
  if (savedEnv === undefined) delete process.env.AICLI_CONFIG_DIR;
  else process.env.AICLI_CONFIG_DIR = savedEnv;
  await rm(dir, { recursive: true, force: true });
});

describe('sessions', () => {
  it('saves privately, lists newest first, and loads by id, name, prefix or cwd', async () => {
    const a = createSession('/proj/a', 'gpt-4o');
    a.messages = [{ role: 'user', content: 'first question about project A' }, { role: 'assistant', content: 'ok' }];
    await saveSession(a);
    await new Promise((r) => setTimeout(r, 5));
    const b = createSession('/proj/b', 'o3-mini');
    b.name = 'feature-x';
    b.messages = [{ role: 'user', content: 'B' }];
    await saveSession(b);

    expect(sessionsDir()).toBe(join(dir, 'sessions'));
    if (process.platform !== 'win32') expect((await stat(join(sessionsDir(), `${a.id}.json`))).mode & 0o777).toBe(0o600);
    expect((await readdir(sessionsDir())).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const list = await listSessions();
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
    expect(list[1].title).toBe('first question about project A');

    expect((await loadSession(a.id))?.messages).toHaveLength(2);
    expect((await loadSession('feature-x'))?.id).toBe(b.id);
    expect((await loadSession(undefined, '/proj/a'))?.id).toBe(a.id);
    expect(await loadSession(undefined, '/proj/none')).toBeNull();
    expect(await loadSession('nope')).toBeNull();
    expect(formatSessionList(list)).toContain('[feature-x]');
  });

  it('ignores corrupt files and rejects path-like ids', async () => {
    await writeFile(join(sessionsDir(), 'broken.json'), '{nope');
    expect((await listSessions()).every((s) => s.id !== 'broken')).toBe(true);
    const s = createSession('/x');
    s.id = '../../evil';
    await expect(saveSession(s)).rejects.toThrow(/Invalid session id/);
  });

  it('deletes sessions', async () => {
    const s = createSession('/proj/del');
    s.messages = [{ role: 'user', content: 'x' }];
    await saveSession(s);
    expect(await deleteSession(s.id)).toBe(true);
    expect(await loadSession(s.id)).toBeNull();
    expect(await deleteSession(s.id)).toBe(false);
  });
});
