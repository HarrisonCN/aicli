/**
 * End-to-end tests of the CLI entry point: spawn `src/cli.ts` through tsx with
 * an isolated config dir and working directory, and check output and exit codes.
 * None of these reach a model API.
 */
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, 'cli.ts');
const require = createRequire(import.meta.url);
const tsxCli = join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const { version } = require('../package.json') as { version: string };

let configDir: string;
let cwd: string;

function cli(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, AICLI_CONFIG_DIR: configDir, NO_COLOR: '1' };
  for (const k of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AICLI_MODEL', 'AICLI_WEB_SEARCH_PROVIDER', 'TAVILY_API_KEY', 'BRAVE_API_KEY', 'SERPAPI_API_KEY']) {
    delete env[k];
  }
  const r = spawnSync(process.execPath, [tsxCli, cliPath, ...args], { cwd, env, encoding: 'utf-8', input: '', timeout: 60_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'aicli-cli-cfg-'));
  cwd = await mkdtemp(join(tmpdir(), 'aicli-cli-cwd-'));
});
afterAll(async () => {
  await rm(configDir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe('cli', { timeout: 120_000 }, () => {
  it('prints the package version', () => {
    const r = cli('--version');
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(version);
  });

  it('shows help listing every command when run without arguments', () => {
    const r = cli();
    expect(r.code).toBe(0);
    for (const cmd of ['chat', 'run', 'config', 'tools', 'sessions']) expect(r.stdout).toContain(cmd);
  });

  it('rejects invalid option values before doing any work', () => {
    const t = cli('run', '--temperature', '3', 'hi');
    expect(t.code).not.toBe(0);
    expect(t.stderr).toMatch(/between 0 and 2/);
    const n = cli('run', '--max-iterations', '0', 'hi');
    expect(n.code).not.toBe(0);
    expect(n.stderr).toMatch(/positive integer/);
  });

  it('round-trips config values and masks secrets', async () => {
    expect(cli('config', '--set', 'maxIterations=7').code).toBe(0);
    expect(cli('config', '--get', 'maxIterations').stdout.trim()).toBe('7');
    expect(cli('config', '--set', 'apiKey=sk-test-1234567890').code).toBe(0);
    const list = cli('config', '--list');
    expect(list.stdout).toContain('****7890');
    expect(list.stdout).not.toContain('sk-test-1234567890');
    expect(JSON.parse(await readFile(join(configDir, 'config.json'), 'utf-8'))).toMatchObject({ maxIterations: 7 });
    const bad = cli('config', '--set', 'maxIterations=lots');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/must be a number/);
    expect(cli('config', '--unset', 'apiKey').code).toBe(0);
  });

  it('lists tools and reports web search as disabled without a key', () => {
    const r = cli('tools');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('read_file');
    expect(r.stdout).toContain('run_command');
    expect(r.stdout).toMatch(/web_search\s+\(disabled/);
  });

  it('handles an empty session store', () => {
    const list = cli('sessions');
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('No saved sessions.');
    const del = cli('sessions', '--delete', 'missing');
    expect(del.code).toBe(1);
    expect(del.stderr).toContain('No session matches "missing"');
  });

  it('fails cleanly when chat gets no message and empty stdin', () => {
    const r = cli('chat');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No message given');
  });
});
