import { describe, expect, it } from 'vitest';
import { printBanner } from './banner.js';

function capture(version?: string): string {
  let out = '';
  const stream = { write: (s: string) => ((out += s), true) } as unknown as NodeJS.WritableStream;
  printBanner(version, stream);
  return out;
}

describe('printBanner', () => {
  it('writes a box whose lines all have the same width', () => {
    const lines = capture('1.2.3').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(5);
    const widths = new Set(lines.map((l) => [...l].length));
    expect(widths.size).toBe(1);
  });

  it('shows the version only when given', () => {
    expect(capture('1.2.3')).toContain('v1.2.3');
    expect(capture()).not.toMatch(/ v\d/);
  });
});
