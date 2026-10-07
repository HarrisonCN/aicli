/**
 * Configuration management for aicli
 * Reads from ~/.aicli/config.json and environment variables (env wins).
 */

import { chmod, mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { Config } from './types.js';
import { maskSecret } from './text.js';
import { validateModelSettings } from './models.js';
import { SEARCH_PROVIDERS } from '../tools/web.js';

export const CONFIG_DIR = process.env.AICLI_CONFIG_DIR ?? join(homedir(), '.aicli');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

type Kind = 'string' | 'number' | 'boolean' | 'enum' | 'json';
interface KeySpec {
  kind: Kind;
  secret?: boolean;
  min?: number;
  max?: number;
  values?: readonly string[];
  /** Validator for json values. */
  validate?: (v: unknown) => unknown;
  description: string;
}
export const CONFIG_KEYS: Record<keyof Config, KeySpec> = {
  apiKey: { kind: 'string', secret: true, description: 'OpenAI-compatible API key' },
  baseURL: { kind: 'string', description: 'API base URL' },
  defaultModel: { kind: 'string', description: 'Model used when --model is not given' },
  temperature: { kind: 'number', min: 0, max: 2, description: 'Sampling temperature (ignored by reasoning models)' },
  maxIterations: { kind: 'number', min: 1, max: 1000, description: 'Max agent loop iterations' },
  stream: { kind: 'boolean', description: 'Stream tokens as they arrive' },
  streamUsage: { kind: 'boolean', description: 'Request token usage on streamed responses' },
  contextWindow: { kind: 'number', min: 1024, max: 10_000_000, description: 'Override the context window (tokens) for all models' },
  contextStrategy: { kind: 'enum', values: ['summarize', 'truncate', 'off'], description: 'How to shrink history near the context limit' },
  modelSettings: { kind: 'json', validate: validateModelSettings, description: 'Per-model settings (JSON object)' },
  webSearchProvider: { kind: 'enum', values: SEARCH_PROVIDERS, description: 'web_search provider: tavily, brave or serpapi' },
  webSearchApiKey: { kind: 'string', secret: true, description: 'API key for the web_search provider' },
  webSearchBaseURL: { kind: 'string', description: 'Override the web_search provider endpoint' },
  webFetch: { kind: 'boolean', description: 'Enable the web_fetch tool' },
  projectInstructions: { kind: 'boolean', description: 'Load AICLI.md project instructions' },
  saveSessions: { kind: 'boolean', description: 'Auto-save chat sessions' },
};

export function isConfigKey(key: string): key is keyof Config {
  return Object.prototype.hasOwnProperty.call(CONFIG_KEYS, key);
}

/** Parse and validate a raw value for a config key. Throws on invalid input. */
export function parseConfigValue(key: keyof Config, raw: unknown): unknown {
  const spec = CONFIG_KEYS[key];
  if (spec.kind === 'json') {
    let v = raw;
    if (typeof raw === 'string') {
      try {
        v = JSON.parse(raw);
      } catch {
        throw new Error(`${key} must be valid JSON`);
      }
    }
    return spec.validate ? spec.validate(v) : v;
  }
  if (spec.kind === 'enum') {
    const s = String(raw).trim().toLowerCase();
    if (!spec.values?.includes(s)) throw new Error(`${key} must be one of: ${spec.values?.join(', ')}`);
    return s;
  }
  if (spec.kind === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (String(raw).trim() === '' || !Number.isFinite(n)) throw new Error(`${key} must be a number`);
    if (spec.min !== undefined && n < spec.min) throw new Error(`${key} must be >= ${spec.min}`);
    if (spec.max !== undefined && n > spec.max) throw new Error(`${key} must be <= ${spec.max}`);
    return n;
  }
  if (spec.kind === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
    throw new Error(`${key} must be true or false`);
  }
  return String(raw);
}

/** Drop unknown keys and coerce/validate known ones; bad values are ignored with a warning. */
function sanitize(raw: unknown, warn: (msg: string) => void): Partial<Config> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isConfigKey(key) || value === undefined || value === null || value === '') continue;
    try {
      out[key] = parseConfigValue(key, value);
    } catch (err) {
      warn(`Ignoring invalid config value: ${(err as Error).message}`);
    }
  }
  return out as Partial<Config>;
}

async function readConfigFile(warn: (msg: string) => void): Promise<Partial<Config>> {
  let raw: string;
  try {
    raw = await readFile(CONFIG_FILE, 'utf-8');
  } catch {
    return {}; // no config file yet
  }
  try {
    return sanitize(JSON.parse(raw), warn);
  } catch {
    warn(`${CONFIG_FILE} is not valid JSON; ignoring it.`);
    return {};
  }
}

const stderrWarn = (msg: string) => process.stderr.write(`⚠️  ${msg}\n`);

export async function loadConfig(warn: (msg: string) => void = stderrWarn): Promise<Config> {
  // Load .env from the current directory if present (never overrides real env vars).
  const baseUrlWasSet = process.env.OPENAI_BASE_URL !== undefined;
  try {
    const { config: dotenvConfig } = await import('dotenv');
    const result = dotenvConfig();
    if (!baseUrlWasSet && result.parsed?.OPENAI_BASE_URL) {
      // A cloned repo's .env could silently redirect your API key to another server.
      warn(`Using OPENAI_BASE_URL=${result.parsed.OPENAI_BASE_URL} from ./.env`);
    }
  } catch {
    // dotenv not available, skip
  }

  const fileConfig = await readConfigFile(warn);
  const envConfig = sanitize(
    {
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      defaultModel: process.env.AICLI_MODEL,
      webSearchProvider: process.env.AICLI_WEB_SEARCH_PROVIDER,
    },
    warn
  );

  return {
    defaultModel: 'gpt-4o',
    temperature: 0.7,
    maxIterations: 20,
    stream: true,
    streamUsage: true,
    contextStrategy: 'summarize',
    webFetch: true,
    projectInstructions: true,
    saveSessions: true,
    ...fileConfig,
    ...envConfig,
  };
}

export async function saveConfig(config: Partial<Config>): Promise<void> {
  // The file can hold an API key: keep it private to the user.
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const existing = await readConfigFile(() => {});
  const merged = { ...existing, ...config };
  await writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600).catch(() => {}); // tighten files created by older versions
}

export async function unsetConfig(key: keyof Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const existing: Record<string, unknown> = { ...(await readConfigFile(() => {})) };
  delete existing[key];
  await writeFile(CONFIG_FILE, JSON.stringify(existing, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600).catch(() => {});
}

function display(key: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '(not set)';
  if (isConfigKey(key) && CONFIG_KEYS[key].secret) return maskSecret(String(value));
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Returns a process exit code. */
export async function manageConfig(options: { set?: string; get?: string; unset?: string; list?: boolean }): Promise<number> {
  if (options.unset) {
    if (!isConfigKey(options.unset)) {
      console.error(`Unknown config key "${options.unset}". Valid keys: ${Object.keys(CONFIG_KEYS).join(', ')}`);
      return 1;
    }
    await unsetConfig(options.unset);
    console.log(`✓ Unset ${options.unset}`);
    return 0;
  }
  if (options.set) {
    const eq = options.set.indexOf('=');
    if (eq <= 0) {
      console.error('Usage: aicli config --set <key>=<value>');
      return 1;
    }
    const key = options.set.slice(0, eq).trim();
    const rawValue = options.set.slice(eq + 1);
    if (!isConfigKey(key)) {
      console.error(`Unknown config key "${key}". Valid keys: ${Object.keys(CONFIG_KEYS).join(', ')}`);
      return 1;
    }
    let value: unknown;
    try {
      value = parseConfigValue(key, rawValue);
    } catch (err) {
      console.error(`Invalid value: ${(err as Error).message}`);
      return 1;
    }
    await saveConfig({ [key]: value } as Partial<Config>);
    console.log(`✓ Set ${key} = ${display(key, value)}`);
    return 0;
  }
  if (options.get) {
    const config = await loadConfig();
    if (!isConfigKey(options.get)) {
      console.error(`Unknown config key "${options.get}". Valid keys: ${Object.keys(CONFIG_KEYS).join(', ')}`);
      return 1;
    }
    console.log(display(options.get, config[options.get]));
    return 0;
  }
  // Default (and --list): show everything
  const config = await loadConfig();
  console.log('\nCurrent configuration:\n');
  for (const key of Object.keys(CONFIG_KEYS)) {
    console.log(`  ${key.padEnd(20)} ${display(key, config[key as keyof Config])}`);
  }
  console.log(`\n  (file: ${CONFIG_FILE})\n`);
  return 0;
}
