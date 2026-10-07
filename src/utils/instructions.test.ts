import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INSTRUCTIONS_LIMITS, formatInstructions, loadInstructions } from './instructions.js';
import { buildSystemPrompt } from '../agent/index.js';

let tmp: string;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'aicli-instr-')));
});
afterEach(() => rm(tmp, { recursive: true, force: true }));

describe('project instructions', () => {
  it('loads user, repo-root and nested files in order (first match per directory)', async () => {
    const home = join(tmp, 'home');
    const repo = join(tmp, 'repo');
    const sub = join(repo, 'packages', 'web');
    await mkdir(home, { recursive: true });
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, '.aicli'), { recursive: true });
    await mkdir(sub, { recursive: true });
    await writeFile(join(home, 'AICLI.md'), 'user rule');
    await writeFile(join(repo, 'AICLI.md'), 'repo rule');
    await writeFile(join(repo, '.aicli', 'instructions.md'), 'shadowed by AICLI.md');
    await writeFile(join(sub, '.aicli'), 'sub rule');

    const files = await loadInstructions(sub, home);
    expect(files.map((f) => f.content)).toEqual(['user rule', 'repo rule', 'sub rule']);
    expect(files[2].label).toBe('.aicli');
    const text = formatInstructions(files);
    expect(text).toContain('From .aicli:\nsub rule');
  });

  it('supports .aicli/AICLI.md, outside a git repo only looks in cwd, and caps size', async () => {
    await mkdir(join(tmp, '.aicli'));
    await writeFile(join(tmp, '.aicli', 'AICLI.md'), 'z'.repeat(INSTRUCTIONS_LIMITS.fileChars + 100));
    const files = await loadInstructions(tmp);
    expect(files).toHaveLength(1);
    expect(files[0].content).toMatch(/truncated 100 more characters/);
    // No .git: parent directories are not searched.
    await mkdir(join(tmp, 'empty'));
    expect(await loadInstructions(join(tmp, 'empty'))).toEqual([]);
  });

  it('puts instructions into the system prompt', () => {
    const prompt = buildSystemPrompt({ instructionsText: 'From AICLI.md:\nUse pnpm.' }, tmp);
    expect(prompt).toContain('Project instructions');
    expect(prompt).toContain('Use pnpm.');
    expect(buildSystemPrompt({}, tmp)).not.toContain('Project instructions');
  });
});
