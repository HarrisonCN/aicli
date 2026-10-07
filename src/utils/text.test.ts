import { describe, expect, it } from 'vitest';
import { looksBinary, maskSecret, preview, truncate } from './text.js';

describe('truncate', () => {
  it('returns short text unchanged', () => {
    expect(truncate('hello', 5)).toBe('hello');
    expect(truncate('', 0)).toBe('');
  });

  it('cuts long text and says how much was dropped', () => {
    const out = truncate('abcdefghij', 4);
    expect(out.startsWith('abcd\n')).toBe(true);
    expect(out).toContain('[truncated 6 more characters]');
  });
});

describe('preview', () => {
  it('collapses whitespace into one line', () => {
    expect(preview('a\n\n  b\tc')).toBe('a b c');
  });

  it('serializes non-strings and shortens with an ellipsis', () => {
    expect(preview({ a: 1 })).toBe('{"a":1}');
    expect(preview(42)).toBe('42');
    expect(preview(undefined)).toBe('undefined');
    expect(preview('x'.repeat(10), 4)).toBe('xxxx…');
  });
});

describe('looksBinary', () => {
  it('detects a NUL byte only within the first 8 KB', () => {
    expect(looksBinary(Buffer.from('plain text\n'))).toBe(false);
    expect(looksBinary(Buffer.from([0x50, 0x4b, 0x00, 0x03]))).toBe(true);
    const late = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]);
    expect(looksBinary(late)).toBe(false);
  });
});

describe('maskSecret', () => {
  it('never reveals short secrets and keeps only the last 4 characters of long ones', () => {
    expect(maskSecret('')).toBe('****');
    expect(maskSecret('12345678')).toBe('****');
    expect(maskSecret('sk-abcdefgh1234')).toBe('****1234');
  });
});
