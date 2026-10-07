import { mkdtemp, rm, stat, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
let mod: typeof import('./config.js');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aicli-cfg-'));
  process.env.AICLI_CONFIG_DIR = dir;
  mod = await import('./config.js');
});
afterAll(async () => {
  delete process.env.AICLI_CONFIG_DIR;
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.AICLI_MODEL;
});

describe('config', () => {
  it('validates and coerces values', () => {
    expect(mod.parseConfigValue('temperature', '0.3')).toBe(0.3);
    expect(mod.parseConfigValue('maxIterations', '20')).toBe(20);
    expect(mod.parseConfigValue('stream', 'false')).toBe(false);
    expect(() => mod.parseConfigValue('temperature', 'hot')).toThrow();
    expect(() => mod.parseConfigValue('temperature', '5')).toThrow();
  });

  it('rejects unknown keys on --set', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await mod.manageConfig({ set: 'apikey=x' })).toBe(1);
    expect(await mod.manageConfig({ set: 'noequals' })).toBe(1);
    err.mockRestore();
  });

  it('saves typed values with private permissions, keeps "=" in values, and masks the key', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await mod.manageConfig({ set: 'apiKey=sk-abc=def123456789' })).toBe(0);
    expect(await mod.manageConfig({ set: 'maxIterations=5' })).toBe(0);
    const saved = JSON.parse(await readFile(mod.CONFIG_FILE, 'utf-8'));
    expect(saved).toEqual({ apiKey: 'sk-abc=def123456789', maxIterations: 5 });
    if (process.platform !== 'win32') expect((await stat(mod.CONFIG_FILE)).mode & 0o777).toBe(0o600);
    const printed = log.mock.calls.flat().join('\n');
    expect(printed).not.toContain('sk-abc=def123456789');
    expect(printed).toContain('****6789');
    log.mockRestore();
  });

  it('env overrides file; bad file values are ignored with a warning', async () => {
    await writeFile(mod.CONFIG_FILE, JSON.stringify({ defaultModel: 'file-model', temperature: 'hot', maxIterations: '7' }));
    process.env.AICLI_MODEL = 'env-model';
    const warn = vi.fn();
    const cfg = await mod.loadConfig(warn);
    expect(cfg.defaultModel).toBe('env-model');
    expect(cfg.temperature).toBe(0.7);
    expect(cfg.maxIterations).toBe(7);
    expect(warn).toHaveBeenCalled();
  });

  it('warns on invalid JSON instead of silently ignoring it', async () => {
    await writeFile(mod.CONFIG_FILE, '{not json');
    const warn = vi.fn();
    await mod.loadConfig(warn);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/not valid JSON/);
  });

  it('validates enum and JSON keys, and can unset keys', async () => {
    expect(mod.parseConfigValue('contextStrategy', 'Truncate')).toBe('truncate');
    expect(() => mod.parseConfigValue('contextStrategy', 'magic')).toThrow(/one of/);
    expect(mod.parseConfigValue('webSearchProvider', 'brave')).toBe('brave');
    expect(mod.parseConfigValue('modelSettings', '{"o3*":{"reasoningEffort":"low"}}')).toEqual({ 'o3*': { reasoningEffort: 'low' } });
    expect(() => mod.parseConfigValue('modelSettings', '{bad')).toThrow(/valid JSON/);
    expect(() => mod.parseConfigValue('modelSettings', '{"x":{"temperature":9}}')).toThrow();

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await writeFile(mod.CONFIG_FILE, '{}');
    expect(await mod.manageConfig({ set: 'webSearchApiKey=tvly-secret-123456' })).toBe(0);
    expect(await mod.manageConfig({ set: 'modelSettings={"gpt-4o":{"contextWindow":64000}}' })).toBe(0);
    const cfg = await mod.loadConfig(() => {});
    expect(cfg.modelSettings).toEqual({ 'gpt-4o': { contextWindow: 64000 } });
    expect(cfg.contextStrategy).toBe('summarize');
    await mod.manageConfig({ list: true });
    const printed = log.mock.calls.flat().join('\n');
    expect(printed).not.toContain('tvly-secret-123456');
    expect(printed).toContain('{"gpt-4o":{"contextWindow":64000}}');
    expect(await mod.manageConfig({ unset: 'webSearchApiKey' })).toBe(0);
    expect(JSON.parse(await readFile(mod.CONFIG_FILE, 'utf-8')).webSearchApiKey).toBeUndefined();
    log.mockRestore();
  });
});

