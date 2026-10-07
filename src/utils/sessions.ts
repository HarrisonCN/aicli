/**
 * Chat sessions saved as JSON under <config dir>/sessions/ (mode 600, since
 * a conversation can contain file contents and command output).
 */

import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import type { Message, Usage } from './types.js';

export interface Session {
  version: 1;
  id: string;
  name?: string;
  cwd: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  usage?: Usage;
  messages: Message[];
}

export interface SessionSummary {
  id: string;
  name?: string;
  cwd: string;
  model?: string;
  updatedAt: string;
  messageCount: number;
  /** First user message, shortened. */
  title: string;
}

/** Resolved at call time so tests (and AICLI_CONFIG_DIR) can redirect it. */
export function sessionsDir(): string {
  return join(process.env.AICLI_CONFIG_DIR ?? join(homedir(), '.aicli'), 'sessions');
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function newSessionId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

export function createSession(cwd: string, model?: string): Session {
  const now = new Date().toISOString();
  return { version: 1, id: newSessionId(), cwd: resolve(cwd), model, createdAt: now, updatedAt: now, messages: [] };
}

function fileFor(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`Invalid session id "${id}"`);
  return join(sessionsDir(), `${id}.json`);
}

export async function saveSession(session: Session): Promise<string> {
  const dir = sessionsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  session.updatedAt = new Date().toISOString();
  const file = fileFor(session.id);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(session, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  // Rename for an atomic replace, so a crash never leaves a half-written session.
  await rename(tmp, file);
  await chmod(file, 0o600).catch(() => {});
  return file;
}

function isSession(v: unknown): v is Session {
  const s = v as Session;
  return !!s && typeof s === 'object' && typeof s.id === 'string' && Array.isArray(s.messages) && typeof s.cwd === 'string';
}

async function readSessionFile(file: string): Promise<Session | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf-8'));
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function titleOf(s: Session): string {
  const first = s.messages.find((m) => m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('[Summary'));
  const text = typeof first?.content === 'string' ? first.content.replace(/\s+/g, ' ').trim() : '';
  return text.length > 60 ? `${text.slice(0, 60)}…` : text || '(empty)';
}

/** All sessions, newest first. */
export async function listSessions(): Promise<SessionSummary[]> {
  const dir = sessionsDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: SessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const s = await readSessionFile(join(dir, name));
    if (!s) continue;
    out.push({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      model: s.model,
      updatedAt: s.updatedAt,
      messageCount: s.messages.length,
      title: titleOf(s),
    });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Load a session by id, name, or unique id prefix. Without a reference,
 * load the most recent session for `cwd`. Returns null when none matches.
 */
export async function loadSession(ref: string | undefined, cwd?: string): Promise<Session | null> {
  const all = await listSessions();
  let match: SessionSummary | undefined;
  if (!ref) {
    const dir = cwd ? resolve(cwd) : undefined;
    match = all.find((s) => !dir || s.cwd === dir);
  } else {
    match =
      all.find((s) => s.id === ref) ??
      all.find((s) => s.name === ref) ??
      (() => {
        const byPrefix = all.filter((s) => s.id.startsWith(ref));
        if (byPrefix.length > 1) throw new Error(`"${ref}" matches ${byPrefix.length} sessions; use a longer id.`);
        return byPrefix[0];
      })();
  }
  if (!match) return null;
  return readSessionFile(fileFor(match.id));
}

export async function deleteSession(ref: string): Promise<boolean> {
  const s = await loadSession(ref);
  if (!s) return false;
  await rm(fileFor(s.id), { force: true });
  return true;
}

export function formatSessionList(sessions: SessionSummary[], limit = 20): string {
  if (sessions.length === 0) return 'No saved sessions.';
  const rows = sessions.slice(0, limit).map((s) => {
    const when = s.updatedAt.replace('T', ' ').slice(0, 16);
    const name = s.name ? ` [${s.name}]` : '';
    return `  ${s.id}${name}  ${when}  ${String(s.messageCount).padStart(3)} msgs  ${s.title}\n      ${s.cwd}`;
  });
  const more = sessions.length > limit ? `\n  … and ${sessions.length - limit} more` : '';
  return rows.join('\n') + more;
}
