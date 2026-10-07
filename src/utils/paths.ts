/**
 * Path helpers that keep file tools inside the workspace root.
 */

import { realpath } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';

/** True when `target` is `root` itself or lives beneath it. Both must be absolute. */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '') return true;
  return !(rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel));
}

/**
 * Resolve symlinks on the longest existing prefix of `p`, so a path that does
 * not exist yet (a file about to be written) still resolves through any
 * symlinked parent directory.
 */
async function realpathNearest(p: string): Promise<string> {
  const tail: string[] = [];
  let current = p;
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = dirname(current);
      if (parent === current) return p;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve a tool-supplied path against the workspace root and reject anything
 * that escapes it (via `..`, an absolute path, or a symlink), unless
 * `allowOutside` is set.
 */
export async function resolveInWorkspace(
  root: string,
  p: unknown,
  allowOutside = false
): Promise<string> {
  if (typeof p !== 'string' || p.trim() === '') {
    throw new Error('A non-empty "path" argument is required');
  }
  const abs = resolve(root, p);
  if (allowOutside) return abs;
  const realRoot = await realpathNearest(resolve(root));
  const real = await realpathNearest(abs);
  if (!isInside(realRoot, real)) {
    throw new Error(
      `Path "${p}" is outside the workspace (${realRoot}). ` +
        'Re-run with --allow-outside-workspace to permit this.'
    );
  }
  return abs;
}
