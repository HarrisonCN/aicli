/**
 * `aicli doctor`: check the local setup and report what would stop aicli from
 * working (missing API key, unreachable endpoint, unknown model, bad config
 * file permissions…) with a hint for each problem.
 *
 * Every check is a plain function of its inputs so it can be unit tested;
 * the only network call is an optional `GET <baseURL>/models`.
 */

import { access, readdir, readFile, stat } from 'fs/promises';
import { constants } from 'fs';
import { dirname, join } from 'path';
import type { Config } from './types.js';
import { maskSecret } from './text.js';
import { DEFAULT_CONTEXT_WINDOW, resolveModelProfile } from './models.js';
import { resolveSearchConfig } from '../tools/web.js';
import { loadInstructions } from './instructions.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do about a warn/fail. */
  hint?: string;
}

export interface DoctorInput {
  config: Config;
  /** Warnings collected while loading config (invalid values, .env base URL…). */
  configWarnings: string[];
  configDir: string;
  configFile: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  /** Skip the network check. */
  offline?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const MIN_NODE_MAJOR = 18;

export function checkNode(version = process.versions.node): CheckResult {
  const major = Number(version.split('.')[0]);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    return { name: 'Node.js', status: 'fail', detail: `v${version}`, hint: `aicli needs Node.js ${MIN_NODE_MAJOR} or newer.` };
  }
  if (major < 20) {
    return { name: 'Node.js', status: 'warn', detail: `v${version}`, hint: 'Node.js 18 is end-of-life; upgrade to 20 or 22.' };
  }
  return { name: 'Node.js', status: 'ok', detail: `v${version}` };
}

/** Config file: present, valid JSON, private permissions. */
export async function checkConfigFile(file: string, warnings: string[], platform = process.platform): Promise<CheckResult> {
  const name = 'Config file';
  const info = await stat(file).catch(() => null);
  if (!info) return { name, status: 'ok', detail: `${file} (not created yet; using env and defaults)` };
  try {
    JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return { name, status: 'fail', detail: `${file} is not valid JSON`, hint: 'Fix or delete the file, then use `aicli config --set`.' };
  }
  const invalid = warnings.filter((w) => w.startsWith('Ignoring invalid config value'));
  if (invalid.length) {
    return {
      name,
      status: 'warn',
      detail: `${file}: ${invalid.map((w) => w.replace(/^Ignoring invalid config value: /, '')).join('; ')}`,
      hint: 'Invalid values are ignored. Fix them with `aicli config --set <key>=<value>`.',
    };
  }
  if (platform !== 'win32' && (info.mode & 0o077) !== 0) {
    return {
      name,
      status: 'warn',
      detail: `${file} is readable by other users (mode ${(info.mode & 0o777).toString(8)})`,
      hint: `It can hold your API key. Run: chmod 600 ${file}`,
    };
  }
  return { name, status: 'ok', detail: file };
}

export function checkApiKey(config: Config, env: NodeJS.ProcessEnv = process.env): CheckResult {
  const name = 'API key';
  if (!config.apiKey) {
    return {
      name,
      status: 'fail',
      detail: 'not set',
      hint: 'Set OPENAI_API_KEY, or run `aicli config --set apiKey=<key>` (local servers such as Ollama accept any value).',
    };
  }
  const source = env.OPENAI_API_KEY ? 'OPENAI_API_KEY' : 'config file';
  return { name, status: 'ok', detail: `${maskSecret(config.apiKey)} (from ${source})` };
}

function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h) || h === '0.0.0.0';
}

export function checkBaseURL(config: Config, warnings: string[]): CheckResult {
  const name = 'API endpoint';
  const raw = config.baseURL ?? DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { name, status: 'fail', detail: `"${raw}" is not a valid URL`, hint: 'Use a full URL such as http://localhost:11434/v1.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { name, status: 'fail', detail: `${raw} uses ${url.protocol}`, hint: 'The base URL must be http(s).' };
  }
  const fromDotenv = warnings.find((w) => w.includes('OPENAI_BASE_URL') && w.includes('.env'));
  if (fromDotenv) {
    return {
      name,
      status: 'warn',
      detail: `${raw} (set by ./.env)`,
      hint: 'A .env file in this directory redirects your API key to this server. Remove it from .env if you did not put it there.',
    };
  }
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    return { name, status: 'warn', detail: raw, hint: 'Plain http to a remote host sends your API key unencrypted; use https.' };
  }
  return { name, status: 'ok', detail: raw + (config.baseURL ? '' : ' (default)') };
}

export function checkModel(config: Config): CheckResult {
  const name = 'Model';
  const model = config.defaultModel ?? 'gpt-4o';
  const p = resolveModelProfile(model, config.modelSettings, config.contextWindow);
  const traits = [
    `context ${p.contextWindow.toLocaleString('en-US')} tokens`,
    p.reasoning ? 'reasoning model' : '',
    p.supportsTemperature ? '' : 'no temperature',
  ].filter(Boolean);
  const detail = `${model} (${traits.join(', ')})`;
  const configured = config.contextWindow || Object.keys(config.modelSettings ?? {}).length > 0;
  if (p.contextWindow === DEFAULT_CONTEXT_WINDOW && !configured) {
    return {
      name,
      status: 'warn',
      detail,
      hint: `Unknown model family, so a conservative ${DEFAULT_CONTEXT_WINDOW.toLocaleString('en-US')}-token context is assumed. Set its real size: aicli config --set 'modelSettings={"${model}":{"contextWindow":<tokens>}}'`,
    };
  }
  return { name, status: 'ok', detail };
}

/** fetch() rejects with "fetch failed"; the useful part (ECONNREFUSED, ENOTFOUND…) is in `cause`. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
  const extra = cause?.code ?? cause?.message;
  return extra && !err.message.includes(extra) ? `${err.message} (${extra})` : err.message;
}

/** `GET <baseURL>/models`: is the endpoint reachable, the key accepted, the model listed? */
export async function checkConnectivity(input: DoctorInput): Promise<CheckResult> {
  const name = 'API connection';
  if (input.offline) return { name, status: 'skip', detail: 'skipped (--offline)' };
  if (!input.config.apiKey) return { name, status: 'skip', detail: 'skipped (no API key)' };
  const base = (input.config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch = input.fetch ?? fetch;
  const model = input.config.defaultModel ?? 'gpt-4o';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);
  const started = Date.now();
  try {
    const res = await doFetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${input.config.apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    if (res.status === 401 || res.status === 403) {
      return { name, status: 'fail', detail: `HTTP ${res.status} from ${base}/models`, hint: 'The API key was rejected. Check that it is valid for this endpoint.' };
    }
    if (res.status === 404) {
      return {
        name,
        status: 'warn',
        detail: `${base}/models returned 404 (${ms} ms)`,
        hint: 'The server answered but has no /models route. Check the base URL (it usually ends in /v1).',
      };
    }
    if (!res.ok) {
      return { name, status: 'fail', detail: `HTTP ${res.status} from ${base}/models`, hint: 'The endpoint returned an error; try again or check the provider status.' };
    }
    const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
    const ids = Array.isArray(body?.data) ? body.data.map((m) => String(m?.id ?? '')) : [];
    if (ids.length && !ids.includes(model)) {
      const sample = ids.slice(0, 5).join(', ');
      return {
        name,
        status: 'warn',
        detail: `reachable (${ms} ms), but "${model}" is not in the ${ids.length} models listed`,
        hint: `Pick one the server offers (e.g. ${sample}) with --model or \`aicli config --set defaultModel=<name>\`.`,
      };
    }
    return { name, status: 'ok', detail: `reachable (${ms} ms)${ids.length ? `, "${model}" available` : ''}` };
  } catch (err) {
    const aborted = controller.signal.aborted;
    const msg = aborted ? `timed out after ${input.timeoutMs ?? 10_000} ms` : describeError(err);
    return { name, status: 'fail', detail: `${base}: ${msg}`, hint: 'Is the server running and the base URL correct? Use --offline to skip this check.' };
  } finally {
    clearTimeout(timer);
  }
}

export function checkWeb(config: Config, env: NodeJS.ProcessEnv = process.env): CheckResult[] {
  const search = resolveSearchConfig({ searchProvider: config.webSearchProvider, searchApiKey: config.webSearchApiKey }, env);
  const out: CheckResult[] = [];
  if (search) out.push({ name: 'Web search', status: 'ok', detail: `${search.provider} (key ${maskSecret(search.apiKey)})` });
  else if (config.webSearchProvider) {
    out.push({
      name: 'Web search',
      status: 'warn',
      detail: `provider ${config.webSearchProvider} has no API key`,
      hint: 'Run `aicli config --set webSearchApiKey=<key>` or export the provider key.',
    });
  } else out.push({ name: 'Web search', status: 'skip', detail: 'disabled (optional: set TAVILY_API_KEY, BRAVE_API_KEY or SERPAPI_API_KEY)' });
  out.push({ name: 'Web fetch', status: config.webFetch === false ? 'skip' : 'ok', detail: config.webFetch === false ? 'disabled (webFetch=false)' : 'enabled' });
  return out;
}

export async function checkInstructions(config: Config, cwd: string, configDir: string): Promise<CheckResult> {
  const name = 'Project instructions';
  if (config.projectInstructions === false) return { name, status: 'skip', detail: 'disabled (projectInstructions=false)' };
  const files = await loadInstructions(cwd, configDir).catch(() => []);
  if (!files.length) return { name, status: 'ok', detail: 'none found (optional: add an AICLI.md)' };
  return { name, status: 'ok', detail: files.map((f) => f.label).join(', ') };
}

export async function checkSessions(config: Config, configDir: string): Promise<CheckResult> {
  const name = 'Sessions';
  if (config.saveSessions === false) return { name, status: 'skip', detail: 'auto-save disabled (saveSessions=false)' };
  const dir = join(configDir, 'sessions');
  // Do not create anything: find the nearest existing directory and check it is writable.
  let probe = dir;
  while (!(await stat(probe).catch(() => null))) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    await access(probe, constants.W_OK);
  } catch {
    return { name, status: 'fail', detail: `${probe} is not writable`, hint: 'Fix the directory permissions, or set saveSessions=false.' };
  }
  const count = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).length;
  return { name, status: 'ok', detail: `${dir} (${count} saved)` };
}

/** Run every check, in display order. */
export async function runDoctor(input: DoctorInput): Promise<CheckResult[]> {
  const env = input.env ?? process.env;
  return [
    checkNode(input.nodeVersion),
    await checkConfigFile(input.configFile, input.configWarnings, input.platform),
    checkApiKey(input.config, env),
    checkBaseURL(input.config, input.configWarnings),
    checkModel(input.config),
    await checkConnectivity(input),
    ...checkWeb(input.config, env),
    await checkInstructions(input.config, input.cwd, input.configDir),
    await checkSessions(input.config, input.configDir),
  ];
}

const ICON: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '-' };

export function formatDoctorReport(results: CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length));
  const lines = results.map((r) => {
    const line = `  ${ICON[r.status]} ${r.name.padEnd(width)}  ${r.detail}`;
    return r.hint && (r.status === 'warn' || r.status === 'fail') ? `${line}\n    ${' '.repeat(width)}  → ${r.hint}` : line;
  });
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  const summary =
    fails > 0
      ? `${fails} problem${fails === 1 ? '' : 's'}${warns ? ` and ${warns} warning${warns === 1 ? '' : 's'}` : ''} found.`
      : warns > 0
        ? `Ready, with ${warns} warning${warns === 1 ? '' : 's'}.`
        : 'Everything looks good.';
  return `\naicli doctor\n\n${lines.join('\n')}\n\n${summary}\n`;
}

/** Exit code for a report: 1 when any check failed. */
export function doctorExitCode(results: CheckResult[]): number {
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}
