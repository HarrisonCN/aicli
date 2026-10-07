import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from './sessions.js';
import {
  defaultExportFile,
  exportSession,
  formatFromPath,
  parseExportFormat,
  sessionToJSON,
  sessionToMarkdown,
  writeExport,
} from './export.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aicli-export-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sample(): Session {
  return {
    version: 1,
    id: '20260101-120000-abcd',
    name: 'auth-fix',
    cwd: '/proj/app',
    model: 'gpt-4o',
    createdAt: '2026-01-01T12:00:00.000Z',
    updatedAt: '2026-01-01T12:05:00.000Z',
    usage: { requests: 2, promptTokens: 1200, completionTokens: 300 },
    messages: [
      { role: 'system', content: 'SYSTEM PROMPT SHOULD NOT APPEAR' },
      { role: 'user', content: 'Fix the bug in `auth.ts`' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/auth.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'const x = "```";\nexport {}' },
      { role: 'assistant', content: 'Fixed: the Bearer prefix check was missing.' },
    ],
  };
}

describe('format helpers', () => {
  it('parses formats and infers them from file names', () => {
    expect(parseExportFormat('MD')).toBe('markdown');
    expect(parseExportFormat('markdown')).toBe('markdown');
    expect(parseExportFormat(' json ')).toBe('json');
    expect(() => parseExportFormat('html')).toThrow(/Unknown export format/);
    expect(formatFromPath('out.JSON')).toBe('json');
    expect(formatFromPath('notes.md')).toBe('markdown');
    expect(formatFromPath('transcript.txt')).toBeUndefined();
    expect(defaultExportFile(sample(), 'markdown')).toBe('aicli-session-auth-fix.md');
    expect(defaultExportFile({ ...sample(), name: undefined }, 'json')).toBe('aicli-session-20260101-120000-abcd.json');
  });
});

describe('sessionToMarkdown', () => {
  it('renders metadata, turns, tool calls and results, and skips the system prompt', () => {
    const md = sessionToMarkdown(sample());
    expect(md.startsWith('# aicli session: auth-fix\n')).toBe(true);
    expect(md).toContain('- **Model:** gpt-4o');
    expect(md).toContain('- **Directory:** `/proj/app`');
    expect(md).toContain('- **Updated:** 2026-01-01 12:05 UTC');
    expect(md).toContain('- **Usage:** 2 requests, 1200 in / 300 out tokens');
    expect(md).not.toContain('SYSTEM PROMPT');
    expect(md).toContain('### 🧑 User\n\nFix the bug in `auth.ts`');
    expect(md).toContain('<summary>🔧 <code>read_file</code></summary>');
    expect(md).toContain('"path": "src/auth.ts"'); // pretty-printed arguments
    expect(md).toContain('<summary>📄 <code>read_file</code> result</summary>');
    expect(md).toContain('Fixed: the Bearer prefix check was missing.');
    expect(md).not.toMatch(/\n{3,}/);
  });

  it('uses a fence longer than any backticks inside tool output', () => {
    const md = sessionToMarkdown(sample());
    expect(md).toContain('````\nconst x = "```";\nexport {}\n````');
  });

  it('can leave tool output out and clips long results', () => {
    const lean = sessionToMarkdown(sample(), { toolOutput: false });
    expect(lean).toContain('_🔧 called `read_file`_');
    expect(lean).not.toContain('<details>');
    expect(lean).not.toContain('export {}');

    const s = sample();
    s.messages[3] = { role: 'tool', tool_call_id: 'call_1', content: 'y'.repeat(50) };
    expect(sessionToMarkdown(s, { maxToolChars: 10 })).toContain('… [40 more characters not exported]');
  });

  it('renders compaction summaries, content parts and unknown tool ids', () => {
    const s = sample();
    s.name = undefined;
    s.usage = undefined;
    s.messages = [
      { role: 'user', content: '[Summary of earlier conversation]\nWe refactored the router.' },
      { role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'image_url', image_url: { url: 'data:x' } }] },
      { role: 'tool', tool_call_id: 'orphan', content: 'r' },
      { role: 'assistant', content: '' },
    ];
    const md = sessionToMarkdown(s);
    expect(md.startsWith('# aicli session 20260101-120000-abcd\n')).toBe(true);
    expect(md).not.toContain('Usage');
    expect(md).toContain('> **Earlier conversation (summarized)**\n>\n> We refactored the router.');
    expect(md).toContain('part one\n[image]');
    expect(md).toContain('<code>tool</code> result');
    expect(md.match(/### 🤖 Assistant/g)).toBeNull(); // empty assistant turns are dropped
  });

  it('escapes HTML in tool names', () => {
    const s = sample();
    s.messages = [
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: '<b>x</b>', arguments: 'not json' } }] },
    ];
    const md = sessionToMarkdown(s);
    expect(md).toContain('<code>&lt;b&gt;x&lt;/b&gt;</code>');
    expect(md).toContain('not json');
  });
});

describe('JSON export and writing', () => {
  it('round-trips the session as JSON', () => {
    const s = sample();
    expect(JSON.parse(sessionToJSON(s))).toEqual(s);
    expect(exportSession(s, 'json')).toBe(sessionToJSON(s));
    expect(exportSession(s, 'markdown')).toBe(sessionToMarkdown(s));
  });

  it('writes privately and refuses to overwrite unless forced', async () => {
    const file = join(dir, 'out.md');
    await writeExport(file, 'one');
    expect(await readFile(file, 'utf-8')).toBe('one');
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(writeExport(file, 'two')).rejects.toThrow(/already exists/);
    await writeExport(file, 'two', true);
    expect(await readFile(file, 'utf-8')).toBe('two');
    await expect(writeExport(join(dir, 'missing-dir', 'a.md'), 'x')).rejects.toThrow();
  });
});
