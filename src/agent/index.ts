/**
 * Core Agent module
 * Implements the ReAct (Reasoning + Acting) loop for the AI agent
 */

import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import { getTools, executeTool, type ToolContext } from '../tools/index.js';
import { preview } from '../utils/text.js';
import type { AgentConfig, AgentResult, Message } from '../utils/types.js';

/** The slice of the OpenAI client the agent uses (injectable for tests). */
export interface ChatClient {
  chat: {
    completions: {
      create(body: ChatCompletionCreateParams, options?: { signal?: AbortSignal }): Promise<unknown>;
    };
  };
}

export interface AgentOptions extends AgentConfig {
  /** Custom client (defaults to a new OpenAI client). */
  client?: ChatClient;
  /** Ask the user to approve a mutating tool call. */
  confirm?: ToolContext['confirm'];
  /** Where the assistant's answer is written (default: stdout). */
  output?: NodeJS.WritableStream;
  /** Where tool activity is logged (default: stderr). */
  log?: NodeJS.WritableStream;
  /** Do not write the answer to `output` (e.g. for --json). */
  quiet?: boolean;
  /** Extra context text appended to the system prompt. */
  contextText?: string;
}

export interface RunOptions {
  signal?: AbortSignal;
}

export class AgentAbortError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'AgentAbortError';
  }
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof AgentAbortError) return true;
  const e = err as { name?: string } | null;
  return !!e && (e.name === 'AbortError' || e.name === 'APIUserAbortError');
}

export function createAgent(config: AgentOptions) {
  let client = config.client;
  if (!client) {
    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'No API key configured. Set OPENAI_API_KEY, or run `aicli config --set apiKey=<key>`.'
      );
    }
    client = new OpenAI({ apiKey, baseURL: config.baseURL ?? process.env.OPENAI_BASE_URL });
  }
  const chat = client;
  const output = config.output ?? process.stdout;
  const log = config.log ?? process.stderr;
  const stream = config.stream !== false;
  const root = config.root ?? process.cwd();

  const conversationHistory: Message[] = [];

  /**
   * Run a single task or message through the agent loop.
   * On error or cancellation the conversation is rolled back to its state
   * before this call, so it never holds an assistant tool call without its
   * tool results (which the API would reject on the next turn).
   */
  async function run(userMessage: string, runOptions: RunOptions = {}): Promise<AgentResult> {
    const { signal } = runOptions;
    const historyLength = conversationHistory.length;
    conversationHistory.push({ role: 'user', content: userMessage });

    const systemPrompt = buildSystemPrompt(config, root);
    const tools = config.tools !== false ? getTools() : [];
    const toolCtx: ToolContext = {
      root,
      autoApprove: config.autoApprove,
      allowOutsideWorkspace: config.allowOutsideWorkspace,
      confirm: config.confirm,
      signal,
    };

    let iterations = 0;
    const maxIterations = Math.max(1, Math.floor(Number(config.maxIterations ?? 20)) || 20);
    const temperature = config.temperature === undefined ? undefined : Number(config.temperature);

    try {
      while (iterations < maxIterations) {
        iterations++;
        if (signal?.aborted) throw new AgentAbortError();

        const body: ChatCompletionCreateParams = {
          model: config.model ?? 'gpt-4o',
          messages: [{ role: 'system', content: systemPrompt }, ...conversationHistory],
          ...(temperature !== undefined && Number.isFinite(temperature) ? { temperature } : {}),
          ...(tools.length > 0 ? { tools, tool_choice: 'auto' as const } : {}),
        };

        const { content, toolCalls } = stream
          ? await completeStreaming(body, signal)
          : await completeOnce(body, signal);

        conversationHistory.push({
          role: 'assistant',
          content: content || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });

        // No tool calls: this is the final answer
        if (toolCalls.length === 0) {
          if (!config.quiet) output.write(stream ? '\n' : `\n${content}\n`);
          return { success: true, output: content, iterations };
        }
        if (content && stream && !config.quiet) output.write('\n');

        for (const toolCall of toolCalls) {
          if (signal?.aborted) throw new AgentAbortError();
          const toolName = toolCall.function.name;
          let toolArgs: Record<string, unknown> | null = null;
          let parseError = '';
          try {
            const parsed: unknown = JSON.parse(toolCall.function.arguments || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              toolArgs = parsed as Record<string, unknown>;
            } else {
              parseError = 'arguments must be a JSON object';
            }
          } catch (err) {
            parseError = err instanceof Error ? err.message : String(err);
          }

          log.write(`\n⚡ ${toolName}(${preview(toolArgs ?? toolCall.function.arguments)})\n`);

          const toolResult = toolArgs
            ? await executeTool(toolName, toolArgs, toolCtx)
            : `Error: could not parse tool arguments as JSON (${parseError}). Retry with valid JSON.`;

          conversationHistory.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });
        }
      }
    } catch (err) {
      conversationHistory.length = historyLength;
      if (isAbortError(err) || signal?.aborted) throw new AgentAbortError();
      throw err;
    }

    return {
      success: false,
      output: 'Max iterations reached without a final answer.',
      iterations,
      error: 'max_iterations',
    };
  }

  async function completeOnce(body: ChatCompletionCreateParams, signal?: AbortSignal) {
    const response = (await chat.chat.completions.create({ ...body, stream: false }, { signal })) as OpenAI.Chat.ChatCompletion;
    const message = response.choices?.[0]?.message;
    if (!message) throw new Error('The API returned no choices.');
    return { content: message.content ?? '', toolCalls: message.tool_calls ?? [] };
  }

  async function completeStreaming(body: ChatCompletionCreateParams, signal?: AbortSignal) {
    const response = (await chat.chat.completions.create({ ...body, stream: true }, { signal })) as AsyncIterable<ChatCompletionChunk>;
    let content = '';
    const calls: ChatCompletionMessageToolCall[] = [];
    let started = false;
    for await (const chunk of response) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        if (!started && !config.quiet) {
          output.write('\n');
          started = true;
        }
        content += delta.content;
        if (!config.quiet) output.write(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        const call = (calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.function.name += tc.function.name;
        if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
      }
    }
    const toolCalls = calls
      .filter((c): c is ChatCompletionMessageToolCall => !!c && !!c.function.name)
      .map((c, i) => (c.id ? c : { ...c, id: `call_${Date.now()}_${i}` }));
    return { content, toolCalls };
  }

  /** Clear the conversation history. */
  function reset(): void {
    conversationHistory.length = 0;
  }

  return { run, reset, history: conversationHistory as readonly Message[] };
}

export type Agent = ReturnType<typeof createAgent>;

export function buildSystemPrompt(config: AgentOptions, root = process.cwd()): string {
  const now = new Date().toISOString();
  const toolsEnabled = config.tools !== false;

  let prompt = `You are aicli, a powerful AI coding agent running in the user's terminal.

Workspace root (current working directory): ${root}
Platform: ${process.platform}
Current time: ${now}
`;

  if (toolsEnabled) {
    prompt += `
You have tools to read, write and edit files, list directories, search file contents, and run shell commands.
File tools are limited to the workspace root${config.allowOutsideWorkspace ? ' (the user has allowed access outside it)' : ''}.
${config.autoApprove ? 'The user has pre-approved write, edit and command actions.' : 'Writing, editing and running commands ask the user for approval; if an action is denied, do not retry it — explain or ask instead.'}
`;
  }

  prompt += `
Guidelines:
- Be concise and action-oriented
- Prefer showing code over explaining it
- Use tools proactively to gather context before answering
- When fixing bugs, first read the relevant files, then make targeted edits`;

  if (config.contextText) {
    prompt += `\n\nContext provided by the user${config.context ? ` (from ${config.context})` : ''}:\n${config.contextText}`;
  }
  return prompt;
}
