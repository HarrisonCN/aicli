#!/usr/bin/env node
/**
 * aicli - An open-source AI agent for your terminal
 * Entry point for the CLI application
 */

import { createRequire } from 'module';
import { Command, InvalidArgumentError } from 'commander';
import { createAgent, isAbortError, type Agent, type AgentOptions } from './agent/index.js';
import { CONFIG_DIR, loadConfig } from './utils/config.js';
import { loadContext } from './utils/context.js';
import { formatInstructions, loadInstructions } from './utils/instructions.js';
import { createSession, deleteSession, formatSessionList, listSessions, loadSession, saveSession, type Session } from './utils/sessions.js';
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
  instructions?: boolean;
  resume?: string | boolean;
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
    .option('--allow-outside-workspace', 'Let file tools access paths outside the current directory')
    .option('--no-instructions', 'Do not load AICLI.md project instructions');
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

async function buildAgentOptions(
  options: CommonOptions,
  term: Terminal | null
): Promise<AgentOptions & { saveSessions: boolean }> {
  const config = await loadConfig();
  const root = process.cwd();
  let instructionsText: string | undefined;
  if (options.instructions !== false && config.projectInstructions !== false) {
    const files = await loadInstructions(root, CONFIG_DIR);
    if (files.length) {
      instructionsText = formatInstructions(files);
      if (!options.json) process.stderr.write(`📋 Loaded instructions: ${files.map((f) => f.label).join(', ')}\n`);
    }
  }
  return {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: options.model ?? config.defaultModel,
    temperature: options.temperature ?? config.temperature,
    temperatureExplicit: options.temperature !== undefined,
    maxIterations: options.maxIterations ?? config.maxIterations,
    stream: options.stream === false ? false : config.stream,
    streamUsage: config.streamUsage,
    tools: options.tools,
    context: options.context,
    contextText: options.context ? await loadContext(options.context, root) : undefined,
    instructionsText,
    modelSettings: config.modelSettings,
    contextWindow: config.contextWindow,
    contextStrategy: config.contextStrategy,
    web: {
      searchProvider: config.webSearchProvider,
      searchApiKey: config.webSearchApiKey,
      searchBaseURL: config.webSearchBaseURL,
      fetchEnabled: config.webFetch,
    },
    autoApprove: options.yes === true,
    allowOutsideWorkspace: options.allowOutsideWorkspace === true,
    root,
    quiet: options.json === true,
    confirm: term ? (summary) => term.confirm(summary) : undefined,
    saveSessions: config.saveSessions !== false,
  };
}

/** Load the session named by --resume (true = latest for this directory). */
async function resumeSession(agent: Agent, options: CommonOptions): Promise<Session | undefined> {
  const { resume } = options;
  if (resume === undefined || resume === false) return undefined;
  const ref = typeof resume === 'string' ? resume : undefined;
  const session = await loadSession(ref, ref ? undefined : process.cwd());
  if (!session) {
    process.stderr.write(
      ref ? `No saved session matches "${ref}". Starting a new one (see \`aicli sessions\`).\n` : 'No saved session for this directory yet. Starting a new one.\n'
    );
    return undefined;
  }
  agent.loadHistory(session.messages);
  // An explicit --model wins over the model the session was saved with.
  if (session.model && options.model === undefined) agent.setModel(session.model);
  return session;
}

/** Run one message; `persist` saves it as a session (chat does, run does not). */
async function runOnce(message: string, options: CommonOptions, persist = false): Promise<void> {
  // Approval prompts need a real terminal; with piped stdin, mutating tools are denied unless --yes.
  const term = process.stdin.isTTY ? new Terminal() : null;
  try {
    const agentOptions = await buildAgentOptions(options, term);
    const agent = createAgent(agentOptions);
    const resumed = await resumeSession(agent, options);
    const result = await runWithInterrupt(agent, term, message);
    if (agentOptions.saveSessions && (persist || resumed)) {
      const session = resumed ?? createSession(process.cwd(), agent.getModel());
      session.messages = agent.history.slice();
      session.model = agent.getModel();
      session.usage = { ...agent.usage };
      await saveSession(session);
      if (!options.json) process.stderr.write(`\n💾 Session ${session.id} (continue with: aicli chat --resume ${session.id})\n`);
    }
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

addCommonOptions(program.command('chat [message]').description('Start a chat session with the AI agent'))
  .option('-r, --resume [id]', 'Resume a saved session (default: the latest one for this directory)')
  .action(async (message: string | undefined, options: CommonOptions) => {
    printBanner(version);
    if (message) {
      await runOnce(message, options, true);
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
      await runOnce(input, options, true);
      return;
    }
    const term = new Terminal();
    try {
      const agentOptions = await buildAgentOptions(options, term);
      const agent = createAgent(agentOptions);
      const session = await resumeSession(agent, options);
      await startRepl(agent, term, { session, saveSessions: agentOptions.saveSessions });
    } catch (err) {
      term.close();
      process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  });

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
  .option('--unset <key>', 'Remove a configuration value')
  .option('--list', 'List all configuration values')
  .action(async (options: { set?: string; get?: string; unset?: string; list?: boolean }) => {
    const { manageConfig } = await import('./utils/config.js');
    process.exitCode = await manageConfig(options);
  });

program
  .command('tools')
  .description('List all available tools')
  .action(async () => {
    const { listTools } = await import('./tools/index.js');
    const config = await loadConfig();
    listTools({
      web: {
        searchProvider: config.webSearchProvider,
        searchApiKey: config.webSearchApiKey,
        searchBaseURL: config.webSearchBaseURL,
        fetchEnabled: config.webFetch,
      },
    });
  });

program
  .command('sessions')
  .description('List, export or delete saved chat sessions')
  .option('--delete <id>', 'Delete a session by id or name')
  .option('--export <id>', 'Export a session (by id, name or prefix) as Markdown or JSON')
  .option('--format <format>', 'Export format: markdown (md) or json (default: from --output, else markdown)')
  .option('-o, --output <file>', 'Write the export to a file instead of stdout')
  .option('--force', 'Overwrite --output if it exists')
  .option('--no-tool-output', 'Leave tool arguments and results out of a Markdown export')
  .action(
    async (options: { delete?: string; export?: string; format?: string; output?: string; force?: boolean; toolOutput?: boolean }) => {
      if (options.delete && options.export) {
        process.stderr.write('Use either --delete or --export, not both.\n');
        process.exitCode = 1;
        return;
      }
      if (options.export) {
        const { exportSession, formatFromPath, parseExportFormat, writeExport } = await import('./utils/export.js');
        try {
          const format = options.format
            ? parseExportFormat(options.format)
            : (options.output && formatFromPath(options.output)) || 'markdown';
          const session = await loadSession(options.export);
          if (!session) {
            process.stderr.write(`No session matches "${options.export}".\n`);
            process.exitCode = 1;
            return;
          }
          const content = exportSession(session, format, { toolOutput: options.toolOutput !== false });
          if (options.output) {
            await writeExport(options.output, content, options.force === true);
            process.stderr.write(`✓ Exported session ${session.id} to ${options.output}\n`);
          } else {
            process.stdout.write(content);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`Error: ${msg}${/already exists/.test(msg) ? ' Use --force to overwrite.' : ''}\n`);
          process.exitCode = 1;
        }
        return;
      }
      if (options.delete) {
        const ok = await deleteSession(options.delete).catch((err: unknown) => {
          process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
          return false;
        });
        if (ok) console.log(`✓ Deleted session ${options.delete}`);
        else {
          process.stderr.write(`No session matches "${options.delete}".\n`);
          process.exitCode = 1;
        }
        return;
      }
      console.log(formatSessionList(await listSessions(), 50));
    }
  );

program
  .command('doctor')
  .description('Check your setup: API key, endpoint, model, web tools, sessions')
  .option('--offline', 'Skip the API connection check')
  .option('--json', 'Output the checks as JSON')
  .action(async (options: { offline?: boolean; json?: boolean }) => {
    const { runDoctor, formatDoctorReport, doctorExitCode } = await import('./utils/doctor.js');
    const { CONFIG_FILE } = await import('./utils/config.js');
    const configWarnings: string[] = [];
    const config = await loadConfig((msg) => configWarnings.push(msg));
    const results = await runDoctor({
      config,
      configWarnings,
      configDir: CONFIG_DIR,
      configFile: CONFIG_FILE,
      cwd: process.cwd(),
      offline: options.offline === true,
    });
    if (options.json) console.log(JSON.stringify({ ok: doctorExitCode(results) === 0, checks: results }, null, 2));
    else console.log(formatDoctorReport(results));
    process.exitCode = doctorExitCode(results);
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
