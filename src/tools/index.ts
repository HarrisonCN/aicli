/**
 * Tools registry
 * Provides the agent with capabilities to interact with the environment
 */

import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';

// ─── Tool Definitions (OpenAI function calling format) ────────────────────────

export function getTools(): ChatCompletionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read the contents of a file at the given path.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute or relative path to the file' },
            start_line: { type: 'number', description: 'Optional: start line (1-indexed)' },
            end_line: { type: 'number', description: 'Optional: end line (1-indexed)' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write content to a file, creating it if it does not exist.',
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
        description: 'Make a targeted edit to a file by replacing a specific string.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the file' },
            old_string: { type: 'string', description: 'Exact string to find and replace' },
            new_string: { type: 'string', description: 'Replacement string' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Execute a shell command and return its output. Use with caution.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute' },
            cwd: { type: 'string', description: 'Working directory for the command' },
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
        description: 'List files and directories at the given path.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path to list' },
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
        description: 'Search for a pattern in files using grep-style matching.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regex pattern to search for' },
            path: { type: 'string', description: 'Directory or file to search in' },
            file_pattern: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.ts")' },
          },
          required: ['pattern', 'path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web for up-to-date information.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            num_results: { type: 'number', description: 'Number of results to return (default: 5)' },
          },
          required: ['query'],
        },
      },
    },
  ];
}

// ─── Tool Executor ────────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case 'read_file':
      return readFile(args.path as string, args.start_line as number | undefined, args.end_line as number | undefined);
    case 'write_file':
      return writeFile(args.path as string, args.content as string);
    case 'edit_file':
      return editFile(args.path as string, args.old_string as string, args.new_string as string);
    case 'run_command':
      return runCommand(args.command as string, args.cwd as string | undefined, args.timeout as number | undefined);
    case 'list_directory':
      return listDirectory(args.path as string, args.recursive as boolean | undefined);
    case 'search_files':
      return searchFiles(args.pattern as string, args.path as string, args.file_pattern as string | undefined);
    case 'web_search':
      return webSearch(args.query as string, args.num_results as number | undefined);
    default:
      return `Unknown tool: ${name}`;
  }
}

export function listTools(): void {
  const tools = getTools();
  console.log('\nAvailable tools:\n');
  for (const tool of tools) {
    const fn = tool.function;
    console.log(`  ${fn.name.padEnd(20)} ${fn.description}`);
  }
  console.log();
}

// ─── Tool Implementations ─────────────────────────────────────────────────────

async function readFile(path: string, startLine?: number, endLine?: number): Promise<string> {
  const { readFile: fsRead } = await import('fs/promises');
  const content = await fsRead(path, 'utf-8');
  if (startLine !== undefined || endLine !== undefined) {
    const lines = content.split('\n');
    const start = (startLine ?? 1) - 1;
    const end = endLine ?? lines.length;
    return lines.slice(start, end).join('\n');
  }
  return content;
}

async function writeFile(path: string, content: string): Promise<string> {
  const { writeFile: fsWrite, mkdir } = await import('fs/promises');
  const { dirname } = await import('path');
  await mkdir(dirname(path), { recursive: true });
  await fsWrite(path, content, 'utf-8');
  return `Successfully wrote ${content.length} characters to ${path}`;
}

async function editFile(path: string, oldString: string, newString: string): Promise<string> {
  const { readFile: fsRead, writeFile: fsWrite } = await import('fs/promises');
  const content = await fsRead(path, 'utf-8');
  if (!content.includes(oldString)) {
    return `Error: Could not find the specified string in ${path}`;
  }
  const newContent = content.replace(oldString, newString);
  await fsWrite(path, newContent, 'utf-8');
  return `Successfully edited ${path}`;
}

async function runCommand(command: string, cwd?: string, timeout?: number): Promise<string> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd ?? process.cwd(),
      timeout: timeout ?? 30000,
    });
    return stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    return `Command failed:\n${error.stdout ?? ''}\n${error.stderr ?? error.message ?? String(err)}`;
  }
}

async function listDirectory(path: string, recursive?: boolean): Promise<string> {
  const { readdir, stat } = await import('fs/promises');
  const { join } = await import('path');

  async function walk(dir: string, prefix = ''): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const lines: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = join(dir, entry.name);
      const isDir = entry.isDirectory();
      lines.push(`${prefix}${isDir ? '📁' : '📄'} ${entry.name}`);
      if (isDir && recursive) {
        lines.push(...(await walk(fullPath, prefix + '  ')));
      }
    }
    return lines;
  }

  const lines = await walk(path);
  return lines.join('\n');
}

async function searchFiles(pattern: string, searchPath: string, filePattern?: string): Promise<string> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  const includeFlag = filePattern ? `--include="${filePattern}"` : '';
  const command = `grep -rn ${includeFlag} "${pattern}" "${searchPath}" 2>/dev/null | head -50`;

  try {
    const { stdout } = await execAsync(command);
    return stdout || 'No matches found.';
  } catch {
    return 'No matches found.';
  }
}

async function webSearch(query: string, numResults = 5): Promise<string> {
  // Placeholder: integrate with a real search API (e.g. Brave, Tavily, SerpAPI)
  return `Web search for "${query}" would return ${numResults} results. Configure SEARCH_API_KEY to enable this feature.`;
}
