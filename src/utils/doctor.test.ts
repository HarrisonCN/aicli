import { chmod, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from './types.js';
import {
  checkApiKey,
  checkBaseURL,
  checkConfigFile,
  checkConnectivity,
  checkModel,
  checkNode,
  checkSessions,
  checkWeb,
  doctorExitCode,
  formatDoctorReport,
  runDoctor,
  type DoctorInput,
} from './doctor.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aicli-doctor-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base: Config = { defaultModel: 'gpt-4o', apiKey: 'sk-test-abcdef1234' };

function fakeFetch(status: number, body: unknown, seen: { url?: string; auth?: string } = {}): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.url = String(url);
    seen.auth = (init?.headers as Record<string, string>)?.Authorization;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function input(over: Partial<DoctorInput> = {}): DoctorInput {
  return { config: base, configWarnings: [], configDir: dir, configFile: join(dir, 'config.json'), cwd: dir, env: {}, ...over };
}

describe('doctor checks', () => {
  it('checks the Node.js version', () => {
    expect(checkNode('22.3.0').status).toBe('ok');
    expect(checkNode('18.20.0').status).toBe('warn');
    expect(checkNode('16.20.0').status).toBe('fail');
  });

  it('checks the config file: missing, invalid JSON, invalid values, permissions', async () => {
    const file = join(dir, 'cfg-a.json');
    expect((await checkConfigFile(file, [])).detail).toMatch(/not created yet/);
    await writeFile(file, '{oops');
    expect((await checkConfigFile(file, [])).status).toBe('fail');
    await writeFile(file, '{"temperature":"hot"}', { mode: 0o600 });
    await chmod(file, 0o600);
    const invalid = await checkConfigFile(file, ['Ignoring invalid config value: temperature must be a number']);
    expect(invalid).toMatchObject({ status: 'warn', detail: expect.stringContaining('temperature must be a number') });
    expect((await checkConfigFile(file, [], process.platform)).status).toBe('ok');
    if (process.platform !== 'win32') {
      await chmod(file, 0o644);
      const loose = await checkConfigFile(file, [], 'linux');
      expect(loose.status).toBe('warn');
      expect(loose.hint).toContain('chmod 600');
    }
  });

  it('reports a missing API key and masks a present one', () => {
    expect(checkApiKey({}, {}).status).toBe('fail');
    const ok = checkApiKey(base, { OPENAI_API_KEY: base.apiKey });
    expect(ok.detail).toBe('****1234 (from OPENAI_API_KEY)');
    expect(checkApiKey(base, {}).detail).toContain('config file');
  });

  it('validates the base URL and flags risky ones', () => {
    expect(checkBaseURL({}, []).detail).toContain('(default)');
    expect(checkBaseURL({ baseURL: 'not a url' }, []).status).toBe('fail');
    expect(checkBaseURL({ baseURL: 'ftp://x/v1' }, []).status).toBe('fail');
    expect(checkBaseURL({ baseURL: 'http://localhost:11434/v1' }, []).status).toBe('ok');
    expect(checkBaseURL({ baseURL: 'http://127.0.0.1:8000/v1' }, []).status).toBe('ok');
    expect(checkBaseURL({ baseURL: 'http://api.example.com/v1' }, []).status).toBe('warn');
    const dotenv = checkBaseURL({ baseURL: 'https://evil.example/v1' }, ['Using OPENAI_BASE_URL=https://evil.example/v1 from ./.env']);
    expect(dotenv.status).toBe('warn');
    expect(dotenv.detail).toContain('set by ./.env');
  });

  it('warns about unknown models unless a context window is configured', () => {
    expect(checkModel({ defaultModel: 'o3-mini' }).detail).toContain('reasoning model');
    const unknown = checkModel({ defaultModel: 'my-local-llm' });
    expect(unknown.status).toBe('warn');
    expect(unknown.hint).toContain('"my-local-llm"');
    expect(checkModel({ defaultModel: 'my-local-llm', modelSettings: { 'my-*': { contextWindow: 8192 } } }).status).toBe('ok');
    expect(checkModel({ defaultModel: 'my-local-llm', contextWindow: 8192 }).status).toBe('ok');
  });

  it('checks connectivity via GET /models with the API key', async () => {
    const seen: { url?: string; auth?: string } = {};
    const ok = await checkConnectivity(
      input({ config: { ...base, baseURL: 'http://localhost:1234/v1/' }, fetch: fakeFetch(200, { data: [{ id: 'gpt-4o' }] }, seen) })
    );
    expect(ok.status).toBe('ok');
    expect(ok.detail).toContain('"gpt-4o" available');
    expect(seen.url).toBe('http://localhost:1234/v1/models');
    expect(seen.auth).toBe('Bearer sk-test-abcdef1234');

    const missing = await checkConnectivity(input({ fetch: fakeFetch(200, { data: [{ id: 'llama3' }, { id: 'qwen' }] }) }));
    expect(missing.status).toBe('warn');
    expect(missing.hint).toContain('llama3, qwen');

    expect((await checkConnectivity(input({ fetch: fakeFetch(401, {}) }))).status).toBe('fail');
    expect((await checkConnectivity(input({ fetch: fakeFetch(404, {}) }))).status).toBe('warn');
    expect((await checkConnectivity(input({ fetch: fakeFetch(500, {}) }))).status).toBe('fail');
    expect((await checkConnectivity(input({ fetch: fakeFetch(200, 'not a list') }))).status).toBe('ok');
  });

  it('reports network errors and timeouts, and skips when offline or keyless', async () => {
    const refused = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof fetch;
    const r = await checkConnectivity(input({ fetch: refused }));
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('ECONNREFUSED');

    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const t = await checkConnectivity(input({ fetch: hang, timeoutMs: 20 }));
    expect(t.detail).toContain('timed out after 20 ms');

    expect((await checkConnectivity(input({ offline: true }))).status).toBe('skip');
    expect((await checkConnectivity(input({ config: {} }))).status).toBe('skip');
  });

  it('reports web tools', () => {
    expect(checkWeb({}, {})[0].status).toBe('skip');
    expect(checkWeb({}, { BRAVE_API_KEY: 'brave-key-123456' })[0].detail).toBe('brave (key ****3456)');
    expect(checkWeb({ webSearchProvider: 'tavily' }, {})[0].status).toBe('warn');
    expect(checkWeb({ webFetch: false }, {})[1].status).toBe('skip');
  });

  it('checks the sessions directory without creating it', async () => {
    const cfgDir = join(dir, 'fresh-config');
    const r = await checkSessions({}, cfgDir);
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('(0 saved)');
    await mkdir(join(cfgDir, 'sessions'), { recursive: true });
    await writeFile(join(cfgDir, 'sessions', 'a.json'), '{}');
    expect((await checkSessions({}, cfgDir)).detail).toContain('(1 saved)');
    expect((await checkSessions({ saveSessions: false }, cfgDir)).status).toBe('skip');
  });
});

describe('runDoctor', () => {
  it('runs every check and formats a report with hints and an exit code', async () => {
    const results = await runDoctor(input({ config: { defaultModel: 'gpt-4o' }, offline: true, nodeVersion: '22.0.0' }));
    expect(results.map((r) => r.name)).toEqual([
      'Node.js',
      'Config file',
      'API key',
      'API endpoint',
      'Model',
      'API connection',
      'Web search',
      'Web fetch',
      'Project instructions',
      'Sessions',
    ]);
    expect(doctorExitCode(results)).toBe(1);
    const report = formatDoctorReport(results);
    expect(report).toContain('✗ API key');
    expect(report).toContain('→ Set OPENAI_API_KEY');
    expect(report).toContain('1 problem found.');

    const good = await runDoctor(input({ fetch: fakeFetch(200, { data: [{ id: 'gpt-4o' }] }), nodeVersion: '22.0.0' }));
    expect(doctorExitCode(good)).toBe(0);
    expect(formatDoctorReport(good)).toContain('Everything looks good.');
  });
});
