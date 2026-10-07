/**
 * Load `--context <path>` into text the model can see.
 * A file is included (truncated); a directory becomes a file tree.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { looksBinary, truncate } from './text.js';

export const CONTEXT_LIMITS = { fileChars: 50_000, treeEntries: 500 };

export async function loadContext(p: string, root = process.cwd()): Promise<string> {
  const abs = resolve(root, p);
  const info = await stat(abs).catch(() => null);
  if (!info) throw new Error(`--context path not found: ${p}`);

  if (info.isFile()) {
    const buf = await readFile(abs);
    if (looksBinary(buf)) throw new Error(`--context file looks binary: ${p}`);
    return `File ${p}:\n\`\`\`\n${truncate(buf.toString('utf-8'), CONTEXT_LIMITS.fileChars)}\n\`\`\``;
  }

  const lines: string[] = [];
  let truncated = false;
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
      if (lines.length >= CONTEXT_LIMITS.treeEntries) {
        truncated = true;
        return;
      }
      lines.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory()) await walk(join(dir, e.name), prefix + '  ');
    }
  }
  await walk(abs, '');
  return `Directory tree of ${p}:\n${lines.join('\n')}${truncated ? '\n… [tree truncated]' : ''}\n(Use read_file to open files.)`;
}
