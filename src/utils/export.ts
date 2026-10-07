/**
 * Export a saved chat session as Markdown (readable transcript to share or
 * paste into an issue/PR) or JSON (the raw session, for scripts).
 */

import { writeFile } from 'fs/promises';
import type { Session } from './sessions.js';
import type { Message } from './types.js';
import { SUMMARY_PREFIX } from '../agent/history.js';

export type ExportFormat = 'markdown' | 'json';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['markdown', 'json'];

export interface MarkdownExportOptions {
  /** Include tool call arguments and results (default: true). */
  toolOutput?: boolean;
  /** Max characters of each tool result kept in the export (default: 4000). */
  maxToolChars?: number;
}

/** Normalize a user-supplied format name (`md` → `markdown`). */
export function parseExportFormat(raw: string): ExportFormat {
  const f = raw.trim().toLowerCase();
  if (f === 'md' || f === 'markdown') return 'markdown';
  if (f === 'json') return 'json';
  throw new Error(`Unknown export format "${raw}". Use markdown (md) or json.`);
}

/** Format inferred from a file extension, if it names one. */
export function formatFromPath(path: string): ExportFormat | undefined {
  if (/\.json$/i.test(path)) return 'json';
  if (/\.(md|markdown)$/i.test(path)) return 'markdown';
  return undefined;
}

export function defaultExportFile(session: Session, format: ExportFormat): string {
  return `aicli-session-${session.name ?? session.id}.${format === 'json' ? 'json' : 'md'}`;
}

/** Text of a message's content, whether a string or an array of parts. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: { type?: string; text?: string; refusal?: string }) => {
      if (part?.type === 'text') return part.text ?? '';
      if (part?.type === 'refusal') return part.refusal ?? '';
      if (part?.type === 'image_url') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** A code fence longer than any backtick run inside `text`, so it cannot be closed early. */
function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters not exported]` : text;
}

function prettyArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** `2026-01-01T12:00:00.000Z` → `2026-01-01 12:00 UTC`; anything else is shown as is. */
function when(iso: string | undefined): string | undefined {
  if (!iso) return iso;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render a session as a Markdown transcript. */
export function sessionToMarkdown(session: Session, opts: MarkdownExportOptions = {}): string {
  const toolOutput = opts.toolOutput !== false;
  const maxToolChars = opts.maxToolChars ?? 4000;
  const out: string[] = [];

  const title = session.name ? `aicli session: ${session.name}` : `aicli session ${session.id}`;
  out.push(`# ${title}`, '');
  const meta: [string, string | undefined][] = [
    ['Session', session.id],
    ['Model', session.model],
    ['Directory', session.cwd],
    ['Created', when(session.createdAt)],
    ['Updated', when(session.updatedAt)],
    ['Messages', String(session.messages.length)],
  ];
  if (session.usage) {
    meta.push(['Usage', `${session.usage.requests} requests, ${session.usage.promptTokens} in / ${session.usage.completionTokens} out tokens`]);
  }
  for (const [k, v] of meta) if (v) out.push(`- **${k}:** ${k === 'Directory' || k === 'Session' ? `\`${v}\`` : v}`);
  out.push('');

  // Tool call ids → names, so results can be labelled.
  const toolNames = new Map<string, string>();

  for (const m of session.messages as Message[]) {
    const text = textOf((m as { content?: unknown }).content).trim();
    switch (m.role) {
      case 'system':
      case 'developer':
        break; // the system prompt is not part of the conversation
      case 'user':
        if (text.startsWith(SUMMARY_PREFIX)) {
          out.push('---', '', '> **Earlier conversation (summarized)**', '>', ...text.slice(SUMMARY_PREFIX.length).trim().split('\n').map((l) => `> ${l}`.trimEnd()), '');
        } else {
          out.push('---', '', '### 🧑 User', '', text || '_(empty)_', '');
        }
        break;
      case 'assistant': {
        const calls = 'tool_calls' in m && Array.isArray(m.tool_calls) ? m.tool_calls : [];
        if (!text && !calls.length) break;
        out.push('---', '', '### 🤖 Assistant', '');
        if (text) out.push(text, '');
        for (const call of calls) {
          if (call.type !== 'function') continue;
          toolNames.set(call.id, call.function.name);
          if (toolOutput) {
            out.push(`<details><summary>🔧 <code>${escapeHtml(call.function.name)}</code></summary>`, '', fence(prettyArgs(call.function.arguments ?? ''), 'json'), '', '</details>', '');
          } else {
            out.push(`_🔧 called \`${call.function.name}\`_`, '');
          }
        }
        break;
      }
      case 'tool': {
        if (!toolOutput) break;
        const name = toolNames.get(m.tool_call_id) ?? 'tool';
        out.push(`<details><summary>📄 <code>${escapeHtml(name)}</code> result</summary>`, '', fence(clip(text, maxToolChars)), '', '</details>', '');
        break;
      }
      default:
        break;
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function sessionToJSON(session: Session): string {
  return JSON.stringify(session, null, 2) + '\n';
}

export function exportSession(session: Session, format: ExportFormat, opts: MarkdownExportOptions = {}): string {
  return format === 'json' ? sessionToJSON(session) : sessionToMarkdown(session, opts);
}

/**
 * Write an export to `file` (mode 600: transcripts can contain file contents
 * and command output). Refuses to overwrite unless `force`.
 */
export async function writeExport(file: string, content: string, force = false): Promise<void> {
  try {
    await writeFile(file, content, { encoding: 'utf-8', mode: 0o600, flag: force ? 'w' : 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${file} already exists.`);
    throw err;
  }
}
