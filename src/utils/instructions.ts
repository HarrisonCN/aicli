/**
 * Project instructions: AICLI.md files loaded into the system prompt.
 *
 * Looked up, in order (all that exist are included, outermost first):
 *   1. user-level:  <config dir>/AICLI.md            (e.g. ~/.aicli/AICLI.md)
 *   2. from the repository root (nearest ancestor with .git, else the cwd)
 *      down to the cwd, in each directory the first of:
 *        AICLI.md · .aicli/AICLI.md · .aicli/instructions.md · .aicli.md · .aicli (a file)
 */

import { readFile, realpath, stat } from 'fs/promises';
import { dirname, join, relative, resolve } from 'path';
import { looksBinary, truncate } from './text.js';

export const INSTRUCTION_FILES = ['AICLI.md', '.aicli/AICLI.md', '.aicli/instructions.md', '.aicli.md', '.aicli'];
export const INSTRUCTIONS_LIMITS = { fileChars: 20_000, totalChars: 60_000 };

export interface InstructionFile {
  path: string;
  /** Path shown to the model (relative to cwd when inside it). */
  label: string;
  content: string;
}

async function isFile(p: string): Promise<boolean> {
  return stat(p).then((s) => s.isFile(), () => false);
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

/** Nearest ancestor of `start` that contains `.git`, or null. */
export async function findRepoRoot(start: string): Promise<string | null> {
  let dir = resolve(start);
  for (;;) {
    if (await exists(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function findInstructionFiles(cwd: string, configDir?: string): Promise<string[]> {
  const found: string[] = [];
  if (configDir) {
    const userFile = join(configDir, 'AICLI.md');
    if (await isFile(userFile)) found.push(userFile);
  }
  const top = resolve(cwd);
  const root = (await findRepoRoot(top)) ?? top;
  // Directories from root down to cwd.
  const dirs: string[] = [];
  for (let d = top; ; d = dirname(d)) {
    dirs.unshift(d);
    if (d === root || dirname(d) === d) break;
  }
  for (const dir of dirs) {
    for (const name of INSTRUCTION_FILES) {
      const p = join(dir, name);
      if (await isFile(p)) {
        found.push(p);
        break;
      }
    }
  }
  // The user-level file and a repo file can be the same file (cwd = home).
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of found) {
    const real = await realpath(p).catch(() => p);
    if (!seen.has(real)) {
      seen.add(real);
      unique.push(p);
    }
  }
  return unique;
}

export async function loadInstructions(cwd: string, configDir?: string): Promise<InstructionFile[]> {
  const files = await findInstructionFiles(cwd, configDir);
  const out: InstructionFile[] = [];
  let total = 0;
  for (const path of files) {
    const buf = await readFile(path).catch(() => null);
    if (!buf || looksBinary(buf)) continue;
    const text = buf.toString('utf-8').trim();
    if (!text) continue;
    const content = truncate(text, Math.min(INSTRUCTIONS_LIMITS.fileChars, INSTRUCTIONS_LIMITS.totalChars - total));
    if (content.length <= 0 || total >= INSTRUCTIONS_LIMITS.totalChars) break;
    total += content.length;
    const rel = relative(cwd, path);
    out.push({ path, label: rel && !rel.startsWith('..') ? rel : path, content });
  }
  return out;
}

/** Format loaded instruction files for the system prompt. */
export function formatInstructions(files: InstructionFile[]): string {
  return files.map((f) => `From ${f.label}:\n${f.content}`).join('\n\n');
}
