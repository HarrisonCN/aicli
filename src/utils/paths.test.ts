import { describe, expect, it } from 'vitest';
import { join, resolve } from 'path';
import { isInside } from './paths.js';

describe('isInside', () => {
  const root = resolve('/tmp/ws');
  it('accepts the root and children', () => {
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, join(root, 'a/b'))).toBe(true);
    expect(isInside(root, join(root, '..foo'))).toBe(true);
  });
  it('rejects parents and siblings with a shared prefix', () => {
    expect(isInside(root, resolve('/tmp'))).toBe(false);
    expect(isInside(root, resolve('/tmp/ws2/file'))).toBe(false);
  });
});
