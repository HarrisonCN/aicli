/**
 * Tools registry
 * Provides the agent with capabilities to interact with the environment.
 *
 * Safety model:
 * - File tools are confined to the workspace root (process.cwd() by default),
 *   including through symlinks, unless `allowOutsideWorkspace` is set.
 * - Tools that change things (write_file, edit_file, run_command) require
 *   approval through `ctx.confirm` unless `autoApprove` is set. With no way
 *   to ask (non-interactive) they are denied.
 * - Every tool returns a string; failures are reported back to the model
 *   instead of crashing the agent loop.
 */

import { spawn } from 'child_process';
import { mkdir, readdir, readFile as fsRead, stat, writeFile as fsWrite } from 'fs/promises';
import { dirname, join, relative, sep } from 'path';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { resolveInWorkspace } from '../utils/paths.js';
import { looksBinary, truncate } from '../utils/text.js';
import { resolveSearchConfig, webFetch, webSearch, type WebConfig } from './web.js';

// ─── Limits ───────────────────────────────────────────────────────────────────

export const LIMITS = {
  /** Max characters returned by read_file */
  readChars: 200_000,
  /** Max characters of command output kept per stream */
  commandOutputChars: 100_000,
  /** Default / maximum command timeout in ms */
  commandTimeoutMs: 30_000,
  commandTimeoutMaxMs: 10 * 60_000,
  /** Max entries returned by list_directory */
  listEntries: 1_000,
  /** Max matches returned by search_files */
  searchMatches: 100,
  /** Files larger than this are skipped by search_files */
  searchFileBytes: 1_000_000,
  /** Max characters per matching line in search_files */
  searchLineChars: 300,
};

const SKIP_DIRS = new Set(['node_modules', '.git']);

// ─── Context ──────────────────────────────────────────────────────────────────

export interface ToolContext {
  /** Workspace root; relative paths resolve against it. */
  root: string;
  /** Skip approval for mutating tools. */
  autoApprove?: boolean;
  /** Allow file tools outside `root`. */
  allowOutsideWorkspace?: boolean;
  /** Ask the user to approve an action. Resolve true to proceed. */
  confirm?: (summary: string) => Promise<boolean>;
  /** Aborts long-running tools (run_command, web tools). */
  signal?: AbortSignal;
  /** Web tool settings (search provider/key, fetch limits). */
  web?: WebConfig;
}

export interface ToolOptions {
  web?: WebConfig;
}

// ─── Tool Definitions (OpenAI function calling format) ────────────────────────

export function getTools(options: ToolOptions = {}): ChatCompletionTool[] {
  return [...fileTools(), ...webTools(options.web)];
}

/** web_search only when a provider key is configured; web_fetch unless disabled. */
function webTools(web: WebConfig = {}): ChatCompletionTool[] {
  const tools: ChatCompletionTool[] = [];
  const search = resolveSearchConfig(web);
  if (search) {
    tools.push({
      type: 'function',
      function: {
        name: 'web_search',
        description: `Search the web (via ${search.provider}). Returns titles, URLs and snippets; use web_fetch to read a result.`,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            count: { type: 'number', description: 'Number of results (1-10, default 5)' },
          },
          required: ['query'],
        },
      },
    });
  }
  if (web.fetchEnabled !== false) {
    tools.push({
      type: 'function',
      function: {
        name: 'web_fetch',
        description:
          'Fetch an http(s) URL and return its readable text (HTML is converted to text). Output is capped; private/local addresses are refused.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The http(s) URL to fetch' },
            max_chars: { type: 'number', description: 'Max characters to return (default 20000, max 100000)' },
          },
          required: ['url'],
        },
      },
    });
  }
  return tools;
}

function fileTools(): ChatCompletionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read the contents of a text file, optionally a line range.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the file, relative to the workspace root' },
            start_line: { type: 'number', description: 'Optional: start line (1-indexed, inclusive)' },
            end_line: { type: 'number', description: 'Optional: end line (1-indexed, inclusive)' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write content to a file, creating it (and parent directories) if needed. Requires user approval.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the file' },
            content: { type: 'string', description: 'Content to write' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description:
          'Replace an exact string in a file. old_string must match exactly once unless replace_all is true. Requires user approval.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the file' },
            old_string: { type: 'string', description: 'Exact string to find' },
            new_string: { type: 'string', description: 'Replacement string' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence (default: false)' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Execute a shell command and return its exit code and output. Requires user approval.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute' },
            cwd: { type: 'string', description: 'Working directory (default: workspace root)' },
            timeout: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_directory',
        description: 'List files and directories at the given path. Hidden files and node_modules are skipped.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path to list (default: workspace root)' },
            recursive: { type: 'boolean', description: 'Whether to list recursively' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_files',
        description: 'Search file contents for a JavaScript regular expression. Returns path:line: text matches.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regular expression to search for' },
            path: { type: 'string', description: 'Directory or file to search in' },
            file_pattern: { type: 'string', description: 'Glob to filter files (e.g. "*.ts" or "src/**/*.tsx")' },
            ignore_case: { type: 'boolean', description: 'Case-insensitive match (default: false)' },
          },
          required: ['pattern', 'path'],
        },
      },
    },
  ];
}

// ─── Tool Executor ────────────────────────────────────────────────────────────

/** Tools that change the filesystem or run code, and so need approval. */
export const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'run_command']);

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
function bool(v: unknown): boolean {
  return v === true || v === 'true';
}

/**
 * Execute a tool by name. Never throws: errors are returned as text so the
 * model can see them and recover.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext = { root: process.cwd() }
): Promise<string> {
  try {
    switch (name) {
      case 'read_file':
        return await readFile(ctx, args.path, num(args.start_line), num(args.end_line));
      case 'write_file':
        return await writeFile(ctx, args.path, args.content);
      case 'edit_file':
        return await editFile(ctx, args.path, args.old_string, args.new_string, bool(args.replace_all));
      case 'run_command':
        return await runCommand(ctx, args.command, str(args.cwd), num(args.timeout));
      case 'list_directory':
        return await listDirectory(ctx, str(args.path) || '.', bool(args.recursive));
      case 'search_files':
        return await searchFiles(ctx, args.pattern, str(args.path) || '.', str(args.file_pattern), bool(args.ignore_case));
      case 'web_search':
        if (!resolveSearchConfig(ctx.web)) return 'Error: web_search is not configured. Set webSearchProvider and webSearchApiKey.';
        return await webSearch(args.query, num(args.count), ctx.web ?? {}, ctx.signal);
      case 'web_fetch':
        if (ctx.web?.fetchEnabled === false) return 'Error: web_fetch is disabled (config webFetch=false).';
        return await webFetch(args.url, num(args.max_chars), ctx.web ?? {}, ctx.signal);
      default:
        return `Error: Unknown tool "${name}"`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function listTools(options: ToolOptions = {}): void {
  const tools = getTools(options);
  console.log('\nAvailable tools:\n');
  for (const tool of tools) {
    const fn = tool.function;
    console.log(`  ${fn.name.padEnd(20)} ${fn.description ?? ''}`);
  }
  const names = new Set(tools.map((t) => t.function.name));
  if (!names.has('web_search')) {
    console.log(`  ${'web_search'.padEnd(20)} (disabled: set webSearchProvider + webSearchApiKey, or TAVILY_API_KEY / BRAVE_API_KEY / SERPAPI_API_KEY)`);
  }
  if (!names.has('web_fetch')) console.log(`  ${'web_fetch'.padEnd(20)} (disabled: config webFetch=false)`);
  console.log();
}

async function approve(ctx: ToolContext, summary: string): Promise<string | null> {
  if (ctx.autoApprove) return null;
  if (!ctx.confirm) {
    return 'Denied: this action needs user approval, but no interactive terminal is available. Re-run aicli with --yes to allow it.';
  }
  const ok = await ctx.confirm(summary);
  return ok ? null : 'Denied: the user declined this action.';
}

// ─── Tool Implementations ─────────────────────────────────────────────────────

async function readFile(ctx: ToolContext, p: unknown, startLine?: number, endLine?: number): Promise<string> {
  const path = await resolveInWorkspace(ctx.root, p, ctx.allowOutsideWorkspace);
  const buf = await fsRead(path);
  if (looksBinary(buf)) return `Error: ${String(p)} looks like a binary file (${buf.length} bytes); not reading it.`;
  let content = buf.toString('utf-8');
  if (startLine !== undefined || endLine !== undefined) {
    const lines = content.split('\n');
    const start = Math.max(1, Math.floor(startLine ?? 1));
    const end = Math.min(lines.length, Math.floor(endLine ?? lines.length));
    if (start > end) return `Error: invalid line range ${start}-${end} (file has ${lines.length} lines)`;
    content = lines.slice(start - 1, end).join('\n');
  }
  return truncate(content, LIMITS.readChars);
}

async function writeFile(ctx: ToolContext, p: unknown, content: unknown): Promise<string> {
  if (typeof content !== 'string') throw new Error('"content" must be a string');
  const path = await resolveInWorkspace(ctx.root, p, ctx.allowOutsideWorkspace);
  const exists = await stat(path).then(() => true, () => false);
  const bytes = Buffer.byteLength(content, 'utf-8');
  const denied = await approve(ctx, `${exists ? 'Overwrite' : 'Create'} ${path} (${bytes} bytes)`);
  if (denied) return denied;
  await mkdir(dirname(path), { recursive: true });
  await fsWrite(path, content, 'utf-8');
  return `Successfully wrote ${bytes} bytes to ${String(p)}`;
}

async function editFile(
  ctx: ToolContext,
  p: unknown,
  oldString: unknown,
  newString: unknown,
  replaceAll: boolean
): Promise<string> {
  if (typeof oldString !== 'string' || oldString === '') throw new Error('"old_string" must be a non-empty string');
  if (typeof newString !== 'string') throw new Error('"new_string" must be a string');
  const path = await resolveInWorkspace(ctx.root, p, ctx.allowOutsideWorkspace);
  const content = await fsRead(path, 'utf-8');
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) return `Error: Could not find the specified string in ${String(p)}`;
  if (occurrences > 1 && !replaceAll) {
    return `Error: old_string matches ${occurrences} times in ${String(p)}. Add more surrounding context to make it unique, or set replace_all.`;
  }
  const denied = await approve(
    ctx,
    `Edit ${path} (${replaceAll ? occurrences : 1} replacement${occurrences > 1 && replaceAll ? 's' : ''})\n` +
      `- ${truncate(oldString, 400).replace(/\n/g, '\n- ')}\n+ ${truncate(newString, 400).replace(/\n/g, '\n+ ')}`
  );
  if (denied) return denied;
  // Split/join (or indexOf) instead of String#replace: replace() interprets
  // `$&`, `$1`, `$$` in the replacement, corrupting code that contains them.
  let next: string;
  if (replaceAll) {
    next = content.split(oldString).join(newString);
  } else {
    const i = content.indexOf(oldString);
    next = content.slice(0, i) + newString + content.slice(i + oldString.length);
  }
  await fsWrite(path, next, 'utf-8');
  return `Successfully edited ${String(p)} (${replaceAll ? occurrences : 1} replacement${replaceAll && occurrences > 1 ? 's' : ''})`;
}

async function runCommand(ctx: ToolContext, command: unknown, cwdArg?: string, timeoutArg?: number): Promise<string> {
  if (typeof command !== 'string' || command.trim() === '') throw new Error('"command" must be a non-empty string');
  const cwd = cwdArg ? await resolveInWorkspace(ctx.root, cwdArg, ctx.allowOutsideWorkspace) : ctx.root;
  const timeout = Math.min(Math.max(1, timeoutArg ?? LIMITS.commandTimeoutMs), LIMITS.commandTimeoutMaxMs);

  const denied = await approve(ctx, `Run command in ${cwd}:\n  $ ${command}`);
  if (denied) return denied;
  if (ctx.signal?.aborted) return 'Cancelled before the command started.';

  return new Promise<string>((resolvePromise) => {
    const isWin = process.platform === 'win32';
    const child = spawn(command, {
      cwd,
      shell: true,
      // No stdin: an interactive command would otherwise hang (and fight the REPL for the terminal).
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group on POSIX so a timeout kills the whole tree, not just the shell.
      detached: !isWin,
      windowsHide: true,
    });

    // Keep at most `cap` characters per stream; count the rest instead of buffering it.
    const cap = LIMITS.commandOutputChars;
    const out = { stdout: '', stderr: '', stdoutTotal: 0, stderrTotal: 0 };
    let killedReason: string | null = null;
    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (s: string) => {
      out.stdoutTotal += s.length;
      if (out.stdout.length < cap) out.stdout += s.slice(0, cap - out.stdout.length);
    });
    child.stderr?.on('data', (s: string) => {
      out.stderrTotal += s.length;
      if (out.stderr.length < cap) out.stderr += s.slice(0, cap - out.stderr.length);
    });

    const kill = (reason: string) => {
      if (killedReason || child.exitCode !== null) return;
      killedReason = reason;
      try {
        if (!isWin && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill();
      } catch {
        child.kill();
      }
      setTimeout(() => {
        try {
          if (child.exitCode === null) {
            if (!isWin && child.pid) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          }
        } catch {
          /* already gone */
        }
      }, 2000).unref();
    };

    const timer = setTimeout(() => kill(`timed out after ${timeout} ms`), timeout);
    const onAbort = () => kill('cancelled by user');
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (header: string) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      let text = header;
      const outDropped = out.stdoutTotal - out.stdout.length;
      const errDropped = out.stderrTotal - out.stderr.length;
      if (out.stdout) text += `\nSTDOUT:\n${out.stdout}${outDropped ? `\n… [${outDropped} more characters dropped]` : ''}`;
      if (out.stderr) text += `\nSTDERR:\n${out.stderr}${errDropped ? `\n… [${errDropped} more characters dropped]` : ''}`;
      resolvePromise(text);
    };

    child.on('error', (err) => finish(`Command failed to start: ${err.message}`));
    child.on('close', (code, signal) => {
      if (killedReason) finish(`Command ${killedReason}.`);
      else finish(`Exit code: ${code ?? `signal ${signal}`}`);
    });
  });
}

async function listDirectory(ctx: ToolContext, p: string, recursive: boolean): Promise<string> {
  const root = await resolveInWorkspace(ctx.root, p, ctx.allowOutsideWorkspace);
  const lines: string[] = [];
  let truncated = false;

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (lines.length >= LIMITS.listEntries) {
        truncated = true;
        return;
      }
      const isDir = entry.isDirectory();
      lines.push(`${prefix}${entry.name}${isDir ? '/' : ''}`);
      // Do not follow symlinked directories (isDirectory() is false for symlinks), avoiding loops.
      if (isDir && recursive) await walk(join(dir, entry.name), prefix + '  ');
    }
  }

  await walk(root, '');
  if (lines.length === 0) return '(empty directory)';
  return lines.join('\n') + (truncated ? `\n… [stopped after ${LIMITS.listEntries} entries]` : '');
}

/** Convert a simple glob (*, **, ?, {a,b}) to a RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) re += '\\{';
      else {
        re += '(?:' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')).join('|') + ')';
        i = end;
      }
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

async function searchFiles(
  ctx: ToolContext,
  pattern: unknown,
  p: string,
  filePattern?: string,
  ignoreCase = false
): Promise<string> {
  if (typeof pattern !== 'string' || pattern === '') throw new Error('"pattern" must be a non-empty string');
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (err) {
    return `Error: invalid regular expression: ${err instanceof Error ? err.message : String(err)}`;
  }
  const base = await resolveInWorkspace(ctx.root, p, ctx.allowOutsideWorkspace);
  const glob = filePattern ? globToRegExp(filePattern) : null;
  const globHasSlash = filePattern?.includes('/') ?? false;
  const results: string[] = [];
  let hitLimit = false;

  const toPosix = (s: string) => s.split(sep).join('/');

  async function searchFile(file: string): Promise<void> {
    const rel = toPosix(relative(ctx.root, file)) || file;
    if (glob) {
      const subject = globHasSlash ? toPosix(relative(base, file)) : file.split(sep).pop() ?? '';
      if (!glob.test(subject)) return;
    }
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile() || info.size > LIMITS.searchFileBytes) return;
    const buf = await fsRead(file).catch(() => null);
    if (!buf || looksBinary(buf)) return;
    const lines = buf.toString('utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        if (results.length >= LIMITS.searchMatches) {
          hitLimit = true;
          return;
        }
        const line = lines[i].length > LIMITS.searchLineChars ? lines[i].slice(0, LIMITS.searchLineChars) + '…' : lines[i];
        results.push(`${rel}:${i + 1}: ${line}`);
      }
    }
  }

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (hitLimit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(full);
      } else if (entry.isFile()) {
        await searchFile(full);
      }
    }
  }

  const info = await stat(base);
  if (info.isFile()) await searchFile(base);
  else await walk(base);

  if (results.length === 0) return 'No matches found.';
  return results.join('\n') + (hitLimit ? `\n… [stopped after ${LIMITS.searchMatches} matches]` : '');
}
