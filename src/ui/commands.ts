/**
 * REPL slash commands (/help, /model, /cost, /save, /load, …).
 * Kept free of readline so they can be unit tested.
 */

import { estimateCost, type Agent } from '../agent/index.js';
import {
  createSession,
  formatSessionList,
  listSessions,
  loadSession,
  saveSession,
  type Session,
} from '../utils/sessions.js';
import { defaultExportFile, exportSession, formatFromPath, writeExport } from '../utils/export.js';

export interface CommandContext {
  agent: Agent;
  /** The current session; commands may replace it. */
  session: Session;
  /** Whether sessions are persisted. */
  saveSessions: boolean;
  write: (text: string) => void;
  signal?: AbortSignal;
}

export interface CommandResult {
  exit?: boolean;
}

interface Command {
  usage: string;
  description: string;
  aliases?: string[];
  run(args: string, ctx: CommandContext): Promise<CommandResult | void> | CommandResult | void;
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** Copy the agent's state into the session object. */
export function syncSession(ctx: CommandContext): void {
  ctx.session.messages = ctx.agent.history.slice();
  ctx.session.model = ctx.agent.getModel();
  ctx.session.usage = { ...ctx.agent.usage };
}

export const COMMANDS: Record<string, Command> = {
  help: {
    usage: '/help',
    description: 'Show this help',
    run: (_a, ctx) => {
      const lines = Object.values(COMMANDS).map((c) => {
        const aliases = c.aliases?.length ? ` (${c.aliases.map((a) => '/' + a).join(', ')})` : '';
        return `  ${c.usage.padEnd(18)} ${c.description}${aliases}`;
      });
      ctx.write(`Commands:\n${lines.join('\n')}\n  ${'exit'.padEnd(18)} Quit (also Ctrl+D)\n`);
    },
  },
  clear: {
    usage: '/clear',
    description: 'Clear the conversation and start a new session',
    aliases: ['reset'],
    run: (_a, ctx) => {
      ctx.agent.reset();
      ctx.session = createSession(ctx.session.cwd, ctx.agent.getModel());
      ctx.write('History cleared.\n');
    },
  },
  model: {
    usage: '/model [name]',
    description: 'Show or switch the model',
    run: (args, ctx) => {
      if (args) ctx.agent.setModel(args);
      const p = ctx.agent.profile();
      const notes = [
        `context ${fmt(p.contextWindow)} tokens`,
        p.supportsTemperature ? 'temperature on' : 'no temperature',
        p.reasoningEffort ? `reasoning effort ${p.reasoningEffort}` : '',
      ].filter(Boolean);
      ctx.write(`${args ? 'Switched to' : 'Model:'} ${p.model} (${notes.join(', ')})\n`);
    },
  },
  cost: {
    usage: '/cost',
    description: 'Show token usage, cost and context size',
    aliases: ['usage', 'tokens'],
    run: (_a, ctx) => {
      const u = ctx.agent.usage;
      const stats = ctx.agent.contextStats();
      const cost = estimateCost(u, ctx.agent.profile());
      const pct = Math.round((stats.estimatedTokens / stats.contextWindow) * 100);
      ctx.write(
        [
          `Requests:  ${fmt(u.requests)}`,
          `Tokens:    ${fmt(u.promptTokens)} in / ${fmt(u.completionTokens)} out (as reported by the API)`,
          `Cost:      ${cost === null ? 'n/a (set inputPricePerMTok/outputPricePerMTok in modelSettings)' : `$${cost.toFixed(4)}`}`,
          `Context:   ~${fmt(stats.estimatedTokens)} / ${fmt(stats.contextWindow)} tokens (${pct}%), ${stats.messages} messages`,
        ].join('\n') + '\n'
      );
    },
  },
  compact: {
    usage: '/compact',
    description: 'Summarize older turns to free up context',
    run: async (_a, ctx) => {
      if (ctx.agent.history.length === 0) {
        ctx.write('Nothing to compact.\n');
        return;
      }
      const r = await ctx.agent.compact(ctx.signal);
      if (!r.changed) ctx.write('Nothing to compact (only the latest turn is in history).\n');
      else ctx.write(`Compacted ${r.droppedMessages} messages${r.summarized ? ' into a summary' : ''} (~${fmt(r.before)} → ~${fmt(r.after)} tokens).\n`);
      if (ctx.saveSessions) {
        syncSession(ctx);
        await saveSession(ctx.session);
      }
    },
  },
  save: {
    usage: '/save [name]',
    description: 'Save this session (optionally naming it)',
    run: async (args, ctx) => {
      if (args) {
        if (!/^[\w.-]{1,60}$/.test(args)) {
          ctx.write('Session names may only use letters, digits, ".", "_" and "-".\n');
          return;
        }
        ctx.session.name = args;
      }
      syncSession(ctx);
      await saveSession(ctx.session);
      ctx.write(`Saved session ${ctx.session.id}${ctx.session.name ? ` [${ctx.session.name}]` : ''}.\n`);
    },
  },
  load: {
    usage: '/load <id|name>',
    description: 'Load a saved session',
    run: async (args, ctx) => {
      if (!args) {
        ctx.write('Usage: /load <id|name>  (see /sessions)\n');
        return;
      }
      const s = await loadSession(args);
      if (!s) {
        ctx.write(`No session matches "${args}". See /sessions.\n`);
        return;
      }
      ctx.agent.loadHistory(s.messages);
      if (s.model) ctx.agent.setModel(s.model);
      ctx.session = s;
      ctx.write(`Loaded session ${s.id}${s.name ? ` [${s.name}]` : ''} (${s.messages.length} messages, model ${ctx.agent.getModel()}).\n`);
    },
  },
  export: {
    usage: '/export [file]',
    description: 'Export this conversation as Markdown (or JSON for a .json file)',
    run: async (args, ctx) => {
      if (ctx.agent.history.length === 0) {
        ctx.write('Nothing to export yet.\n');
        return;
      }
      syncSession(ctx);
      const format = (args && formatFromPath(args)) || 'markdown';
      const file = args || defaultExportFile(ctx.session, format);
      try {
        await writeExport(file, exportSession(ctx.session, format));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.write(`${msg}${/already exists/.test(msg) ? ' Choose another file name.' : ''}\n`);
        return;
      }
      ctx.write(`Exported ${ctx.session.messages.length} messages to ${file}.\n`);
    },
  },
  sessions: {
    usage: '/sessions',
    description: 'List saved sessions',
    run: async (_a, ctx) => {
      ctx.write(formatSessionList(await listSessions()) + '\n');
    },
  },
  exit: {
    usage: '/exit',
    description: 'Quit',
    aliases: ['quit'],
    run: () => ({ exit: true }),
  },
};

const ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(COMMANDS).flatMap(([name, c]) => (c.aliases ?? []).map((a) => [a, name]))
);

/**
 * Handle a slash command. Returns null when `input` is not a command (so it
 * should go to the model). A first word containing another "/" (a path such
 * as /etc/hosts) is not treated as a command.
 */
export async function handleCommand(input: string, ctx: CommandContext): Promise<CommandResult | null> {
  const m = input.trim().match(/^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const cmd = COMMANDS[name] ?? COMMANDS[ALIASES[name] ?? ''];
  if (!cmd) {
    ctx.write(`Unknown command /${name}. Type /help for a list.\n`);
    return {};
  }
  try {
    return (await cmd.run((m[2] ?? '').trim(), ctx)) ?? {};
  } catch (err) {
    ctx.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return {};
  }
}
