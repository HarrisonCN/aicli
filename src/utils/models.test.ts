import { describe, expect, it } from 'vitest';
import { baseModelName, buildRequestParams, resolveModelProfile, validateModelSettings, DEFAULT_CONTEXT_WINDOW } from './models.js';

describe('model profiles', () => {
  it('detects reasoning models (with or without a provider prefix)', () => {
    for (const m of ['o1', 'o1-2024-12-17', 'o3-mini', 'o4-mini', 'openai/o3', 'gpt-5', 'gpt-5-mini']) {
      const p = resolveModelProfile(m);
      expect(p.supportsTemperature, m).toBe(false);
      expect(p.tokenParam, m).toBe('max_completion_tokens');
      expect(p.systemRole, m).toBe('developer');
    }
    expect(resolveModelProfile('o1-mini').systemRole).toBe('user');
    expect(baseModelName('OpenRouter/OpenAI/O3-Mini')).toBe('o3-mini');
  });

  it('keeps temperature for chat models and knows common context windows', () => {
    const p = resolveModelProfile('gpt-4o');
    expect(p).toMatchObject({ supportsTemperature: true, tokenParam: 'max_tokens', systemRole: 'system', contextWindow: 128_000 });
    expect(resolveModelProfile('gpt-5-chat-latest').supportsTemperature).toBe(true);
    expect(resolveModelProfile('claude-sonnet-4').contextWindow).toBe(200_000);
    expect(resolveModelProfile('llama3.1:8b').contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('applies user settings: globs first, exact key last, global context window override', () => {
    const p = resolveModelProfile(
      'llama3.1:8b',
      { 'llama*': { contextWindow: 8192, temperature: 0.1 }, 'llama3.1:8b': { contextWindow: 16384 } },
      100_000
    );
    expect(p.contextWindow).toBe(16384);
    expect(p.temperature).toBe(0.1);
    expect(resolveModelProfile('mystery', {}, 100_000).contextWindow).toBe(100_000);
    expect(resolveModelProfile('my-reasoner', { 'my-reasoner': { supportsTemperature: false } }).supportsTemperature).toBe(false);
  });

  it('builds request params per model', () => {
    expect(buildRequestParams(resolveModelProfile('gpt-4o'), { temperature: 0.7 }).params).toEqual({ temperature: 0.7 });

    const o3 = resolveModelProfile('o3-mini', { 'o3-mini': { reasoningEffort: 'high', maxOutputTokens: 4000 } });
    const r = buildRequestParams(o3, { temperature: 0.7 });
    expect(r.params).toEqual({ max_completion_tokens: 4000, reasoning_effort: 'high' });
    expect(r.warning).toBeUndefined(); // config default temperature: silently dropped

    const explicit = buildRequestParams(o3, { temperature: 0.2, temperatureExplicit: true });
    expect(explicit.params.temperature).toBeUndefined();
    expect(explicit.warning).toMatch(/does not accept a temperature/);

    const capped = buildRequestParams(resolveModelProfile('gpt-4o', { 'gpt-4o': { maxOutputTokens: 100, temperature: 0 } }), { temperature: 1 });
    expect(capped.params).toEqual({ temperature: 0, max_tokens: 100 });
  });

  it('validates modelSettings', () => {
    expect(validateModelSettings({ 'o3*': { reasoningEffort: 'low' } })).toEqual({ 'o3*': { reasoningEffort: 'low' } });
    expect(() => validateModelSettings([])).toThrow();
    expect(() => validateModelSettings({ x: { reasoningEffort: 'max' } })).toThrow(/reasoningEffort/);
    expect(() => validateModelSettings({ x: { contextWindow: -1 } })).toThrow(/positive integer/);
    expect(() => validateModelSettings({ x: { bogus: 1 } })).toThrow(/unknown setting/);
  });

  it('matches built-in families precisely', () => {
    expect(resolveModelProfile('gpt-4').contextWindow).toBe(8_192);
    expect(resolveModelProfile('gpt-4-turbo').contextWindow).toBe(128_000);
    expect(resolveModelProfile('gpt-4.1-mini').contextWindow).toBe(1_047_576);
    expect(resolveModelProfile('gpt-3.5-turbo').contextWindow).toBe(16_385);
    expect(resolveModelProfile('google/gemini-2.0-flash').contextWindow).toBe(1_048_576);
    const r1 = resolveModelProfile('deepseek-r1:14b');
    expect(r1).toMatchObject({ supportsTemperature: false, reasoning: true, contextWindow: 64_000, tokenParam: 'max_tokens' });
    expect(resolveModelProfile('deepseek-chat')).toMatchObject({ supportsTemperature: true, reasoning: false });
    // The model name is kept as given, even when matching uses the normalized form.
    expect(resolveModelProfile('OpenAI/GPT-4o').model).toBe('OpenAI/GPT-4o');
  });

  it('matches user keys case-insensitively, by base name, and escapes regex characters in globs', () => {
    expect(resolveModelProfile('openai/gpt-4o', { 'GPT-4O': { contextWindow: 1234 } }).contextWindow).toBe(1234);
    expect(resolveModelProfile('qwen2.5-coder', { 'qwen2.5*': { contextWindow: 999 } }).contextWindow).toBe(999);
    // "." in a glob is literal, so "qwen2x5" must not match "qwen2.5*".
    expect(resolveModelProfile('qwen2x5-coder', { 'qwen2.5*': { contextWindow: 999 } }).contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    // Undefined fields in user settings do not erase built-ins.
    expect(resolveModelProfile('gpt-4o', { 'gpt-4o': { contextWindow: undefined } }).contextWindow).toBe(128_000);
  });

  it('ignores non-positive output caps and non-finite temperatures', () => {
    const p = resolveModelProfile('gpt-4o', { 'gpt-4o': { maxOutputTokens: 0 } });
    expect(buildRequestParams(p, { temperature: Number.NaN }).params).toEqual({});
    const frac = resolveModelProfile('gpt-4o', { 'gpt-4o': { maxOutputTokens: 100.9 } });
    expect(buildRequestParams(frac).params).toEqual({ max_tokens: 100 });
  });

  it('validates every modelSettings field type', () => {
    expect(() => validateModelSettings({ x: 1 })).toThrow(/must be an object/);
    expect(() => validateModelSettings({ x: { supportsTemperature: 'no' } })).toThrow(/boolean/);
    expect(() => validateModelSettings({ x: { inputPricePerMTok: -1 } })).toThrow(/>= 0/);
    expect(() => validateModelSettings({ x: { tokenParam: 'max_output_tokens' } })).toThrow(/tokenParam/);
    expect(() => validateModelSettings({ x: { systemRole: 'admin' } })).toThrow(/systemRole/);
    expect(() => validateModelSettings({ x: { maxOutputTokens: 1.5 } })).toThrow(/positive integer/);
    expect(validateModelSettings({ x: { systemRole: 'user', tokenParam: 'max_completion_tokens', outputPricePerMTok: 0 } })).toEqual({
      x: { systemRole: 'user', tokenParam: 'max_completion_tokens', outputPricePerMTok: 0 },
    });
  });
});
