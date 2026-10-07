import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTEXT_LIMITS, loadContext } from './context.js';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'aicli-ctx-'));
  await mkdir(join(root, 'src', 'lib'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'dep'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Title\nhello');
  await writeFile(join(root, 'src', 'index.ts'), 'export {}');
  await writeFile(join(root, 'src', 'lib', 'a.ts'), '');
  await writeFile(join(root, '.env'), 'SECRET=1');
  await writeFile(join(root, 'node_modules', 'dep', 'x.js'), '');
  await writeFile(join(root, 'dist', 'out.js'), '');
  await writeFile(join(root, 'image.bin'), Buffer.from([1, 2, 0, 3]));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('loadContext', () => {
  it('includes a text file in a fenced block', async () => {
    const out = await loadContext('README.md', root);
    expect(out).toBe('File README.md:\n```\n# Title\nhello\n```');
  });

  it('truncates large files', async () => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(CONTEXT_LIMITS.fileChars + 10));
    const out = await loadContext('big.txt', root);
    expect(out).toContain('[truncated 10 more characters]');
  });

  it('renders a sorted, indented tree and skips dotfiles, node_modules and dist', async () => {
    const out = await loadContext('.', root);
    expect(out.startsWith('Directory tree of .:\n')).toBe(true);
    expect(out).toContain('README.md');
    expect(out).toContain('src/\n  index.ts\n  lib/\n    a.ts');
    expect(out).not.toContain('.env');
    expect(out).not.toContain('.git');
    expect(out).not.toContain('node_modules');
    expect(out).not.toContain('out.js');
    expect(out).toContain('(Use read_file to open files.)');
    expect(out).not.toContain('[tree truncated]');
  });

  it('caps the tree at the entry limit', async () => {
    const wide = join(root, 'wide');
    await mkdir(wide);
    await Promise.all(
      Array.from({ length: CONTEXT_LIMITS.treeEntries + 5 }, (_, i) => writeFile(join(wide, `f${String(i).padStart(4, '0')}`), ''))
    );
    const out = await loadContext('wide', root);
    const entries = out.split('\n').filter((l) => l.startsWith('f'));
    expect(entries).toHaveLength(CONTEXT_LIMITS.treeEntries);
    expect(out).toContain('[tree truncated]');
  });

  it('rejects missing paths and binary files', async () => {
    await expect(loadContext('nope.txt', root)).rejects.toThrow(/not found: nope\.txt/);
    await expect(loadContext('image.bin', root)).rejects.toThrow(/looks binary/);
  });
});
