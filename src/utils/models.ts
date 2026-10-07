/**
 * Model-aware request parameters.
 *
 * Different model families accept different request parameters: OpenAI's
 * reasoning models (o1, o3, o4-mini, gpt-5…) reject `temperature`, want
 * `max_completion_tokens` instead of `max_tokens`, accept `reasoning_effort`,
 * and prefer a `developer` message over `system`. This module resolves a
 * profile for a model from built-in defaults plus the user's `modelSettings`
 * config, and turns it into request parameters.
 */

export type SystemRole = 'system' | 'developer' | 'user';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

/** Per-model settings a user can set under `modelSettings` in config. */
export interface ModelSettings {
  /** Whether the model accepts `temperature` (false for reasoning models). */
  supportsTemperature?: boolean;
  /** Temperature to use for this model (overrides the global temperature). */
  temperature?: number;
  /** Which parameter caps output length. */
  tokenParam?: 'max_tokens' | 'max_completion_tokens';
  /** Max output tokens per response (not sent when unset). */
  maxOutputTokens?: number;
  /** Total context window in tokens, used for history trimming. */
  contextWindow?: number;
  /** `reasoning_effort` for reasoning models. */
  reasoningEffort?: ReasoningEffort;
  /** Role used for the system prompt. */
  systemRole?: SystemRole;
  /** USD per 1M input tokens, for `/cost` (no built-in prices). */
  inputPricePerMTok?: number;
  /** USD per 1M output tokens, for `/cost`. */
  outputPricePerMTok?: number;
}

export interface ModelProfile extends ModelSettings {
  model: string;
  supportsTemperature: boolean;
  tokenParam: 'max_tokens' | 'max_completion_tokens';
  contextWindow: number;
  systemRole: SystemRole;
  reasoning: boolean;
}

/** Context window used for models we know nothing about (conservative). */
export const DEFAULT_CONTEXT_WINDOW = 32_768;

interface Rule {
  test: RegExp;
  settings: ModelSettings & { reasoning?: boolean };
}

const REASONING: ModelSettings & { reasoning: boolean } = {
  reasoning: true,
  supportsTemperature: false,
  tokenParam: 'max_completion_tokens',
  systemRole: 'developer',
};

// First match wins. Matched against the model name without any provider
// prefix ("openai/o3-mini" → "o3-mini"), lowercased.
const BUILTIN_RULES: Rule[] = [
  // The first o1 previews accepted neither system nor developer messages.
  { test: /^o1-(mini|preview)/, settings: { ...REASONING, systemRole: 'user', contextWindow: 128_000 } },
  { test: /^o\d/, settings: { ...REASONING, contextWindow: 200_000 } },
  { test: /^gpt-5-chat/, settings: { contextWindow: 128_000 } },
  { test: /^gpt-5/, settings: { ...REASONING, contextWindow: 400_000 } },
  { test: /^gpt-4\.1/, settings: { contextWindow: 1_047_576 } },
  { test: /^gpt-4o|^gpt-4-turbo|^chatgpt-4o/, settings: { contextWindow: 128_000 } },
  { test: /^gpt-4(?!\.|o|-turbo)/, settings: { contextWindow: 8_192 } },
  { test: /^gpt-3\.5/, settings: { contextWindow: 16_385 } },
  { test: /claude/, settings: { contextWindow: 200_000 } },
  { test: /gemini/, settings: { contextWindow: 1_048_576 } },
  { test: /deepseek-(reasoner|r1)/, settings: { supportsTemperature: false, contextWindow: 64_000, reasoning: true } },
  { test: /deepseek/, settings: { contextWindow: 64_000 } },
];

/** Strip a provider prefix such as `openai/` or `azure/` and lowercase. */
export function baseModelName(model: string): string {
  const parts = model.trim().toLowerCase().split('/');
  return parts[parts.length - 1] ?? '';
}

/** Match a `modelSettings` key against a model name: exact, or a `*` glob. */
function keyMatches(key: string, model: string): boolean {
  const k = key.toLowerCase();
  const m = model.toLowerCase();
  if (!k.includes('*')) return k === m || k === baseModelName(m);
  const re = new RegExp('^' + k.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(m) || re.test(baseModelName(m));
}

/**
 * Resolve the profile for a model. User settings override built-ins; among
 * user keys, globs apply first (in key order) and an exact key applies last.
 */
export function resolveModelProfile(
  model: string,
  userSettings: Record<string, ModelSettings> = {},
  globalContextWindow?: number
): ModelProfile {
  const base = baseModelName(model);
  const builtin = BUILTIN_RULES.find((r) => r.test.test(base))?.settings ?? {};
  const profile: ModelProfile = {
    supportsTemperature: true,
    tokenParam: 'max_tokens',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    systemRole: 'system',
    reasoning: false,
    ...builtin,
    model,
  };
  if (globalContextWindow) profile.contextWindow = globalContextWindow;

  const entries = Object.entries(userSettings ?? {});
  const globs = entries.filter(([k]) => k.includes('*') && keyMatches(k, model));
  const exact = entries.filter(([k]) => !k.includes('*') && keyMatches(k, model));
  for (const [, s] of [...globs, ...exact]) {
    if (s && typeof s === 'object') Object.assign(profile, stripUndefined(s));
  }
  return profile;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export interface RequestParams {
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: ReasoningEffort;
}

/**
 * Build model-specific request parameters.
 * Returns the params and an optional warning (e.g. a temperature was asked
 * for but the model does not accept one).
 */
export function buildRequestParams(
  profile: ModelProfile,
  opts: { temperature?: number; temperatureExplicit?: boolean } = {}
): { params: RequestParams; warning?: string } {
  const params: RequestParams = {};
  let warning: string | undefined;

  const temperature = profile.temperature ?? opts.temperature;
  if (temperature !== undefined && Number.isFinite(temperature)) {
    if (profile.supportsTemperature) params.temperature = temperature;
    else if (opts.temperatureExplicit) {
      warning = `Model ${profile.model} does not accept a temperature; ignoring --temperature.`;
    }
  }
  if (profile.maxOutputTokens && profile.maxOutputTokens > 0) {
    params[profile.tokenParam] = Math.floor(profile.maxOutputTokens);
  }
  if (profile.reasoningEffort) params.reasoning_effort = profile.reasoningEffort;
  return { params, warning };
}

/** Validate a `modelSettings` object from config. Throws with a readable message. */
export function validateModelSettings(raw: unknown): Record<string, ModelSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('modelSettings must be an object mapping model names (or globs) to settings');
  }
  const out: Record<string, ModelSettings> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`modelSettings["${model}"] must be an object`);
    }
    const v = value as Record<string, unknown>;
    const s: ModelSettings = {};
    for (const [k, val] of Object.entries(v)) {
      switch (k) {
        case 'supportsTemperature':
          if (typeof val !== 'boolean') throw new Error(`modelSettings["${model}"].${k} must be a boolean`);
          s.supportsTemperature = val;
          break;
        case 'temperature':
          if (typeof val !== 'number' || val < 0 || val > 2) throw new Error(`modelSettings["${model}"].${k} must be 0-2`);
          s.temperature = val;
          break;
        case 'maxOutputTokens':
        case 'contextWindow':
          if (typeof val !== 'number' || !Number.isInteger(val) || val < 1) {
            throw new Error(`modelSettings["${model}"].${k} must be a positive integer`);
          }
          s[k] = val;
          break;
        case 'inputPricePerMTok':
        case 'outputPricePerMTok':
          if (typeof val !== 'number' || val < 0) throw new Error(`modelSettings["${model}"].${k} must be a number >= 0`);
          s[k] = val;
          break;
        case 'tokenParam':
          if (val !== 'max_tokens' && val !== 'max_completion_tokens') {
            throw new Error(`modelSettings["${model}"].tokenParam must be "max_tokens" or "max_completion_tokens"`);
          }
          s.tokenParam = val;
          break;
        case 'reasoningEffort':
          if (!['minimal', 'low', 'medium', 'high'].includes(val as string)) {
            throw new Error(`modelSettings["${model}"].reasoningEffort must be minimal, low, medium or high`);
          }
          s.reasoningEffort = val as ReasoningEffort;
          break;
        case 'systemRole':
          if (!['system', 'developer', 'user'].includes(val as string)) {
            throw new Error(`modelSettings["${model}"].systemRole must be system, developer or user`);
          }
          s.systemRole = val as SystemRole;
          break;
        default:
          throw new Error(`modelSettings["${model}"]: unknown setting "${k}"`);
      }
    }
    out[model] = s;
  }
  return out;
}
