/**
 * Interactive terminal I/O: approval prompts, the REPL, and Ctrl+C handling.
 */

import { createInterface, type Interface } from 'readline';
import { AgentAbortError, isAbortError, type Agent } from '../agent/index.js';

/**
 * A lazily created readline interface with Ctrl+C support.
 * Ctrl+C calls the interrupt handler (abort the current run); with no run in
 * flight it closes the prompt.
 */
export class Terminal {
  private rl: Interface | null = null;
  private closed = false;
  private pending: { reject: (err: Error) => void } | null = null;
  onInterrupt: (() => boolean) | null = null;
  onClose: (() => void) | null = null;

  private get iface(): Interface {
    if (!this.rl) {
      this.rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
      this.rl.on('SIGINT', () => {
        // Handler returns true when it cancelled something; otherwise exit the prompt.
        const handled = this.onInterrupt?.() ?? false;
        if (this.pending) {
          this.pending.reject(new AgentAbortError());
          this.pending = null;
        }
        if (!handled) this.close();
      });
      this.rl.on('close', () => {
        this.closed = true;
        this.pending?.reject(new Error('closed'));
        this.pending = null;
        this.onClose?.();
      });
    }
    return this.rl;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Ask a question; resolves null if input closes (Ctrl+D). Rejects with AgentAbortError on Ctrl+C. */
  ask(question: string): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    const rl = this.iface;
    return new Promise<string | null>((resolve, reject) => {
      this.pending = {
        reject: (err) => (err instanceof AgentAbortError ? reject(err) : resolve(null)),
      };
      rl.question(question, (answer) => {
        this.pending = null;
        resolve(answer);
      });
    });
  }

  /** y/N confirmation used for mutating tools. */
  async confirm(summary: string): Promise<boolean> {
    process.stderr.write(`\n🔐 Approval needed:\n${summary}\n`);
    const answer = await this.ask('Allow? [y/N] ');
    return /^\s*y(es)?\s*$/i.test(answer ?? '');
  }

  close(): void {
    if (this.rl && !this.closed) this.rl.close();
    this.closed = true;
  }
}

/** Run one message with Ctrl+C → abort wired up. */
export async function runWithInterrupt(agent: Agent, term: Terminal | null, message: string) {
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130); // second Ctrl+C: hard exit
    controller.abort();
  };
  if (term) {
    term.onInterrupt = () => {
      onSigint();
      return true;
    };
  }
  // When no readline is active, SIGINT reaches the process directly.
  process.on('SIGINT', onSigint);
  try {
    return await agent.run(message, { signal: controller.signal });
  } finally {
    process.off('SIGINT', onSigint);
    if (term) term.onInterrupt = null;
  }
}

/** Start an interactive REPL session. */
export async function startRepl(agent: Agent, term: Terminal): Promise<void> {
  process.stderr.write('\n🤖 aicli ready. Type your message, "/reset" to clear history, or "exit" to quit.\n\n');
  for (;;) {
    let input: string | null;
    try {
      input = await term.ask('You: ');
    } catch {
      input = null; // Ctrl+C at an empty prompt exits
    }
    if (input === null) break;
    const trimmed = input.trim();
    if (!trimmed) continue;
    if (['exit', 'quit', '/exit', '/quit'].includes(trimmed.toLowerCase())) break;
    if (trimmed === '/reset') {
      agent.reset();
      process.stderr.write('History cleared.\n');
      continue;
    }

    try {
      const result = await runWithInterrupt(agent, term, trimmed);
      if (!result.success) process.stderr.write(`\n⚠️  ${result.output}\n`);
    } catch (err) {
      if (isAbortError(err)) process.stderr.write('\n⏹  Cancelled.\n');
      else process.stderr.write(`\nError: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    if (term.isClosed) break;
  }
  term.close();
  process.stderr.write('\nGoodbye! 👋\n');
}
