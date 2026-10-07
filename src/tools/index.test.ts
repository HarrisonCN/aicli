import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTool, getTools, globToRegExp, type ToolContext } from './index.js';

let root: string;
let outside: string;
let ctx: ToolContext;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'aicli-ws-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'aicli-out-')));
  ctx = { root, autoApprove: true };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('tool definitions', () => {
  it('has unique names and does not advertise web_search without a key', () => {
    const names = getTools({ web: { searchProvider: 'tavily' } }).map((t) => t.function.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain('web_search');
  });
});

describe('read_file', () => {
  it('reads a line range (inclusive)', async () => {
    await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\nfour');
    expect(await executeTool('read_file', { path: 'a.txt', start_line: 2, end_line: 3 }, ctx)).toBe('two\nthree');
  });
  it('returns an error string instead of throwing for missing files', async () => {
    expect(await executeTool('read_file', { path: 'nope.txt' }, ctx)).toMatch(/^Error: .*ENOENT/);
  });
  it('refuses binary files', async () => {
    await writeFile(join(root, 'b.bin'), Buffer.from([1, 0, 2, 3]));
    expect(await executeTool('read_file', { path: 'b.bin' }, ctx)).toMatch(/binary/);
  });
});

describe('workspace sandbox', () => {
  it('blocks ../ traversal and absolute paths outside the root', async () => {
    await writeFile(join(outside, 'secret.txt'), 'top secret');
    const rel = await executeTool('read_file', { path: `../${basename(outside)}/secret.txt` }, ctx);
    expect(rel).toMatch(/outside the workspace/);
    expect(await executeTool('read_file', { path: join(outside, 'secret.txt') }, ctx)).toMatch(/outside the workspace/);
    expect(await executeTool('write_file', { path: join(outside, 'x.txt'), content: 'x' }, ctx)).toMatch(/outside the workspace/);
  });
  it.skipIf(process.platform === 'win32')('blocks escapes through a symlinked directory, including for new files', async () => {
    await writeFile(join(outside, 'secret.txt'), 'top secret');
    await symlink(outside, join(root, 'link'), 'dir');
    expect(await executeTool('read_file', { path: 'link/secret.txt' }, ctx)).toMatch(/outside the workspace/);
    expect(await executeTool('write_file', { path: 'link/new/file.txt', content: 'x' }, ctx)).toMatch(/outside the workspace/);
  });
  it('allows outside paths when explicitly enabled', async () => {
    await writeFile(join(outside, 'ok.txt'), 'fine');
    expect(await executeTool('read_file', { path: join(outside, 'ok.txt') }, { ...ctx, allowOutsideWorkspace: true })).toBe('fine');
  });
});

describe('approval', () => {
  it('denies mutating tools when no confirm function is available', async () => {
    const res = await executeTool('write_file', { path: 'a.txt', content: 'x' }, { root });
    expect(res).toMatch(/^Denied/);
    expect(await executeTool('run_command', { command: 'echo hi' }, { root })).toMatch(/^Denied/);
  });
  it('asks and respects the answer', async () => {
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await executeTool('write_file', { path: 'a.txt', content: 'x' }, { root, confirm })).toMatch(/declined/);
    expect(await executeTool('write_file', { path: 'a.txt', content: 'x' }, { root, confirm })).toMatch(/Successfully/);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(await readFile(join(root, 'a.txt'), 'utf-8')).toBe('x');
  });
  it('does not need approval for read-only tools', async () => {
    await writeFile(join(root, 'a.txt'), 'hi');
    expect(await executeTool('read_file', { path: 'a.txt' }, { root })).toBe('hi');
  });
});

describe('edit_file', () => {
  it('treats $ sequences in the replacement literally', async () => {
    await writeFile(join(root, 'a.js'), 'const x = OLD;');
    await executeTool('edit_file', { path: 'a.js', old_string: 'OLD', new_string: "'$&$1$$'" }, ctx);
    expect(await readFile(join(root, 'a.js'), 'utf-8')).toBe("const x = '$&$1$$';");
  });
  it('rejects ambiguous matches unless replace_all', async () => {
    await writeFile(join(root, 'a.txt'), 'foo foo');
    expect(await executeTool('edit_file', { path: 'a.txt', old_string: 'foo', new_string: 'bar' }, ctx)).toMatch(/matches 2 times/);
    await executeTool('edit_file', { path: 'a.txt', old_string: 'foo', new_string: 'bar', replace_all: true }, ctx);
    expect(await readFile(join(root, 'a.txt'), 'utf-8')).toBe('bar bar');
  });
  it('rejects an empty old_string', async () => {
    await writeFile(join(root, 'a.txt'), 'x');
    expect(await executeTool('edit_file', { path: 'a.txt', old_string: '', new_string: 'y' }, ctx)).toMatch(/non-empty/);
  });
});

describe('search_files', () => {
  it('does not pass the pattern or path through a shell', async () => {
    await writeFile(join(root, 'a.txt'), 'hello');
    const marker = join(root, 'pwned');
    const res = await executeTool('search_files', { pattern: `$(touch ${marker})`, path: '.' }, ctx);
    expect(res).toBe('No matches found.');
    await expect(readFile(marker)).rejects.toThrow();
    await executeTool('search_files', { pattern: 'x', path: '.', file_pattern: `"; touch ${marker}; "` }, ctx);
    await expect(readFile(marker)).rejects.toThrow();
  });
  it('finds matches with path:line output, honours file_pattern and skips node_modules', async () => {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules/pkg'), { recursive: true });
    await writeFile(join(root, 'src/a.ts'), 'line\nconst needle = 1;\n');
    await writeFile(join(root, 'src/b.md'), 'needle\n');
    await writeFile(join(root, 'node_modules/pkg/c.ts'), 'needle\n');
    const res = await executeTool('search_files', { pattern: 'needle', path: '.', file_pattern: '*.ts' }, ctx);
    expect(res).toBe('src/a.ts:2: const needle = 1;');
  });
  it('reports invalid regexes', async () => {
    expect(await executeTool('search_files', { pattern: '(', path: '.' }, ctx)).toMatch(/invalid regular expression/);
  });
});

describe('globToRegExp', () => {
  it('handles *, **, ? and braces', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('a/b.ts')).toBe(false);
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/x/y/a.ts')).toBe(true);
    expect(globToRegExp('*.{ts,tsx}').test('a.tsx')).toBe(true);
    expect(globToRegExp('a?.js').test('ab.js')).toBe(true);
    expect(globToRegExp('a.js').test('aXjs')).toBe(false);
  });
});

describe('list_directory', () => {
  it('lists sorted entries, dirs first, skipping hidden and node_modules', async () => {
    await mkdir(join(root, 'zdir'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'a.txt'), '');
    await writeFile(join(root, '.env'), '');
    await writeFile(join(root, 'zdir/inner.txt'), '');
    expect(await executeTool('list_directory', { path: '.', recursive: true }, ctx)).toBe('zdir/\n  inner.txt\na.txt');
  });
});

describe.skipIf(process.platform === 'win32')('run_command', () => {
  it('returns exit code and output', async () => {
    const res = await executeTool('run_command', { command: 'echo out; echo err 1>&2; exit 3' }, ctx);
    expect(res).toContain('Exit code: 3');
    expect(res).toContain('STDOUT:\nout');
    expect(res).toContain('STDERR:\nerr');
  });
  it('kills commands that time out', async () => {
    const start = Date.now();
    const res = await executeTool('run_command', { command: 'sleep 5', timeout: 200 }, ctx);
    expect(res).toMatch(/timed out/);
    expect(Date.now() - start).toBeLessThan(4000);
  });
  it('can be aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const res = await executeTool('run_command', { command: 'sleep 5' }, { ...ctx, signal: controller.signal });
    expect(res).toMatch(/cancelled/);
  });
  it('does not hang on commands that read stdin', async () => {
    const res = await executeTool('run_command', { command: 'cat', timeout: 3000 }, ctx);
    expect(res).toContain('Exit code: 0');
  });
  it('refuses a cwd outside the workspace', async () => {
    expect(await executeTool('run_command', { command: 'pwd', cwd: outside }, ctx)).toMatch(/outside the workspace/);
  });
});
