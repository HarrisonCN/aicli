#!/usr/bin/env node
/**
 * aicli - An open-source AI agent for your terminal
 * Entry point for the CLI application
 */

import { createRequire } from 'module';
import { Command, InvalidArgumentError } from 'commander';
import { createAgent, isAbortError, type AgentOptions } from './agent/index.js';
import { loadConfig } from './utils/config.js';
import { loadContext } from './utils/context.js';
import { printBanner } from './ui/banner.js';
import { Terminal, runWithInterrupt, startRepl } from './ui/repl.js';

// JSON import attributes differ across Node 18/20/22 (`assert` was removed in 22);
// createRequire works everywhere and from both src/ (tsx) and dist/.
const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const MAX_STDIN_CHARS = 1_000_000;

interface CommonOptions {
  model?: string;
  temperature?: number;
  maxIterations?: number;
  tools?: boolean;
  stream?: boolean;
  context?: string;
  yes?: boolean;
  allowOutsideWorkspace?: boolean;
  json?: boolean;
}

function parseTemperature(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new InvalidArgumentError('must be a number between 0 and 2');
  return n;
}

function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('must be a positive integer');
  return n;
}

function addCommonOptions(cmd: Command): Command {
  return cmd
    .option('-m, --model <model>', 'Model to use (default: config defaultModel, else gpt-4o)')
    .option('-t, --temperature <number>', 'Sampling temperature (0-2)', parseTemperature)
    .option('--max-iterations <n>', 'Max agent loop iterations', parsePositiveInt)
    .option('--no-tools', 'Disable tool use')
    .option('--no-stream', 'Wait for the full response instead of streaming tokens')
    .option('--context <path>', 'Load context from a file or directory')
    .option('-y, --yes', 'Auto-approve file writes, edits and shell commands (use with care)')
    .option('--allow-outside-workspace', 'Let file tools access paths outside the current directory');
}

/** Read piped stdin (e.g. `git diff | aicli run "review this"`). */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: string[] = [];
  let size = 0;
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) {
    chunks.push(chunk as string);
    size += (chunk as string).length;
    if (size > MAX_STDIN_CHARS) break;
  }
  const text = chunks.join('');
  return text.length > MAX_STDIN_CHARS ? text.slice(0, MAX_STDIN_CHARS) + '\n… [stdin truncated]' : text;
}

async function buildAgentOptions(options: CommonOptions, term: Terminal | null): Promise<AgentOptions> {
  const config = await loadConfig();
  const root = process.cwd();
  return {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: options.model ?? config.defaultModel,
    temperature: options.temperature ?? config.temperature,
    maxIterations: options.maxIterations ?? config.maxIterations,
    stream: options.stream === false ? false : config.stream,
    tools: options.tools,
    context: options.context,
    contextText: options.context ? await loadContext(options.context, root) : undefined,
    autoApprove: options.yes === true,
    allowOutsideWorkspace: options.allowOutsideWorkspace === true,
    root,
    quiet: options.json === true,
    confirm: term ? (summary) => term.confirm(summary) : undefined,
  };
}

async function runOnce(message: string, options: CommonOptions): Promise<void> {
  // Approval prompts need a real terminal; with piped stdin, mutating tools are denied unless --yes.
  const term = process.stdin.isTTY ? new Terminal() : null;
  try {
    const agent = createAgent(await buildAgentOptions(options, term));
    const result = await runWithInterrupt(agent, term, message);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (!result.success) process.stderr.write(`\n⚠️  ${result.output}\n`);
    if (!result.success) process.exitCode = 1;
  } catch (err) {
    const cancelled = isAbortError(err);
    const msg = cancelled ? 'Cancelled' : err instanceof Error ? err.message : String(err);
    if (options.json) console.log(JSON.stringify({ success: false, output: '', iterations: 0, error: msg }, null, 2));
    else process.stderr.write(`\n${cancelled ? '⏹ ' : 'Error:'} ${msg}\n`);
    process.exitCode = cancelled ? 130 : 1;
  } finally {
    term?.close();
  }
}

const program = new Command();

program
  .name('aicli')
  .description('An open-source AI agent that lives in your terminal')
  .version(version);

addCommonOptions(program.command('chat [message]').description('Start a chat session with the AI agent')).action(
  async (message: string | undefined, options: CommonOptions) => {
    printBanner(version);
    if (message) {
      await runOnce(message, options);
      return;
    }
    if (!process.stdin.isTTY) {
      // Piped input with no message: treat stdin as a single message.
      const input = (await readStdin()).trim();
      if (!input) {
        process.stderr.write('No message given. Run `aicli chat` in a terminal, or pass a message.\n');
        process.exitCode = 1;
        return;
      }
      await runOnce(input, options);
      return;
    }
    const term = new Terminal();
    try {
      const agent = createAgent(await buildAgentOptions(options, term));
      await startRepl(agent, term);
    } catch (err) {
      term.close();
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  }
);

addCommonOptions(program.command('run <task>').description('Run a one-shot task and exit'))
  .option('--json', 'Output result as JSON')
  .action(async (task: string, options: CommonOptions) => {
    const piped = await readStdin();
    const message = piped.trim() ? `${task}\n\n<stdin>\n${piped}\n</stdin>` : task;
    await runOnce(message, options);
  });

program
  .command('config')
  .description('Manage aicli configuration')
  .option('--set <key=value>', 'Set a configuration value')
  .option('--get <key>', 'Get a configuration value')
  .option('--list', 'List all configuration values')
  .action(async (options: { set?: string; get?: string; list?: boolean }) => {
    const { manageConfig } = await import('./utils/config.js');
    process.exitCode = await manageConfig(options);
  });

program
  .command('tools')
  .description('List all available tools')
  .action(async () => {
    const { listTools } = await import('./tools/index.js');
    listTools();
  });

// Show help if no command provided
if (!process.argv.slice(2).length) {
  printBanner(version);
  program.outputHelp();
} else {
  // parseAsync so rejections from async actions are caught instead of becoming unhandled.
  program.parseAsync(process.argv).catch((err: unknown) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
