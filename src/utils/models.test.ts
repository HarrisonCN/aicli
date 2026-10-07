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
});
