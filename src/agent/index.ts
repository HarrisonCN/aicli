/**
 * Core Agent module
 * Implements the ReAct (Reasoning + Acting) loop for the AI agent
 */

import OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import { getTools, executeTool, type ToolContext } from '../tools/index.js';
import { buildRequestParams, resolveModelProfile, type ModelProfile } from '../utils/models.js';
import { preview } from '../utils/text.js';
import type { AgentConfig, AgentResult, Message, Usage } from '../utils/types.js';
import {
  SUMMARIZER_PROMPT,
  compactHistory,
  estimateJsonTokens,
  estimateMessagesTokens,
  estimateTokens,
  renderTranscript,
  type CompactResult,
} from './history.js';

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

export interface ContextStats {
  model: string;
  contextWindow: number;
  /** Tokens available for history after the system prompt, tools and output reserve. */
  historyBudget: number;
  /** Estimated tokens of system prompt + tools + history. */
  estimatedTokens: number;
  messages: number;
}

/** Tokens kept free for the model's reply. */
export function outputReserve(profile: ModelProfile): number {
  return profile.maxOutputTokens ?? Math.min(8192, Math.floor(profile.contextWindow * 0.2));
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
  const strategy = config.contextStrategy ?? 'summarize';

  const conversationHistory: Message[] = [];
  let model = config.model ?? 'gpt-4o';
  const usage: Usage = { requests: 0, promptTokens: 0, completionTokens: 0 };
  const warned = new Set<string>();
  const warnOnce = (msg: string) => {
    if (warned.has(msg)) return;
    warned.add(msg);
    log.write(`\n⚠️  ${msg}\n`);
  };

  const profile = (): ModelProfile => resolveModelProfile(model, config.modelSettings, config.contextWindow);
  const tools = () => (config.tools !== false ? getTools({ web: config.web }) : []);

  function requestParams(p: ModelProfile) {
    const temperature = config.temperature === undefined ? undefined : Number(config.temperature);
    const { params, warning } = buildRequestParams(p, { temperature, temperatureExplicit: config.temperatureExplicit });
    if (warning) warnOnce(warning);
    // 'minimal' effort is newer than some SDK typings; the API accepts it.
    return params as Pick<
      ChatCompletionCreateParamsNonStreaming,
      'temperature' | 'max_tokens' | 'max_completion_tokens' | 'reasoning_effort'
    >;
  }

  function systemMessage(p: ModelProfile, content: string): Message {
    return { role: p.systemRole, content } as Message;
  }

  function historyBudget(p: ModelProfile, systemPrompt: string, toolDefs: unknown[]): number {
    const fixed = estimateTokens(systemPrompt) + estimateJsonTokens(toolDefs.length ? toolDefs : undefined) + 16;
    return Math.max(1024, p.contextWindow - outputReserve(p) - fixed);
  }

  function recordUsage(u: { prompt_tokens?: number; completion_tokens?: number } | null | undefined) {
    if (!u) return;
    usage.promptTokens += u.prompt_tokens ?? 0;
    usage.completionTokens += u.completion_tokens ?? 0;
  }

  /** Summarize dropped messages with the current model; null on failure. */
  async function summarize(dropped: Message[], previous: string | undefined, signal?: AbortSignal): Promise<string | null> {
    const p = profile();
    const transcript =
      (previous ? `Earlier summary:\n${previous}\n\n` : '') +
      renderTranscript(dropped, Math.min(200_000, Math.max(8_000, p.contextWindow * 2)));
    try {
      usage.requests++;
      const response = (await chat.chat.completions.create(
        {
          model,
          messages: [systemMessage(p, SUMMARIZER_PROMPT), { role: 'user', content: transcript }],
          ...requestParams(p),
          stream: false,
        },
        { signal }
      )) as OpenAI.Chat.ChatCompletion;
      recordUsage(response.usage);
      return response.choices?.[0]?.message?.content ?? null;
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) throw new AgentAbortError();
      log.write(`\n⚠️  Could not summarize old messages (${err instanceof Error ? err.message : String(err)}); dropping them instead.\n`);
      return null;
    }
  }

  function replaceHistory(messages: readonly Message[]) {
    conversationHistory.length = 0;
    conversationHistory.push(...messages);
  }

  function reportCompaction(r: CompactResult) {
    const what = [
      r.droppedMessages ? `${r.summarized ? 'summarized' : 'dropped'} ${r.droppedMessages} old messages` : '',
      r.elidedToolOutputs ? `elided ${r.elidedToolOutputs} large tool outputs` : '',
    ]
      .filter(Boolean)
      .join(', ');
    log.write(`\n🗜  Context compacted: ${what} (~${r.before} → ~${r.after} tokens)\n`);
  }

  /** Shrink history if it would overflow the model's context window. */
  async function manageContext(systemPrompt: string, toolDefs: unknown[], signal?: AbortSignal) {
    if (strategy === 'off') return;
    const p = profile();
    const budget = historyBudget(p, systemPrompt, toolDefs);
    if (estimateMessagesTokens(conversationHistory) <= budget) return;
    const result = await compactHistory(conversationHistory, {
      budget,
      summarize: strategy === 'summarize' ? (d, prev) => summarize(d, prev, signal) : undefined,
    });
    if (result.changed) {
      replaceHistory(result.messages);
      reportCompaction(result);
    }
  }

  /**
   * Run a single task or message through the agent loop.
   * On error or cancellation the conversation is rolled back to its state
   * before this call, so it never holds an assistant tool call without its
   * tool results (which the API would reject on the next turn).
   */
  async function run(userMessage: string, runOptions: RunOptions = {}): Promise<AgentResult> {
    const { signal } = runOptions;
    // Snapshot (not just the length): compaction may rewrite older messages.
    const snapshot = conversationHistory.slice();
    conversationHistory.push({ role: 'user', content: userMessage });

    const systemPrompt = buildSystemPrompt(config, root);
    const toolDefs = tools();
    const toolCtx: ToolContext = {
      root,
      autoApprove: config.autoApprove,
      allowOutsideWorkspace: config.allowOutsideWorkspace,
      confirm: config.confirm,
      signal,
      web: config.web,
    };

    let iterations = 0;
    const maxIterations = Math.max(1, Math.floor(Number(config.maxIterations ?? 20)) || 20);

    try {
      while (iterations < maxIterations) {
        iterations++;
        if (signal?.aborted) throw new AgentAbortError();

        await manageContext(systemPrompt, toolDefs, signal);
        const p = profile();
        const body: ChatCompletionCreateParams = {
          model,
          messages: [systemMessage(p, systemPrompt), ...conversationHistory],
          ...requestParams(p),
          ...(toolDefs.length > 0 ? { tools: toolDefs, tool_choice: 'auto' as const } : {}),
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
      replaceHistory(snapshot);
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
    usage.requests++;
    const response = (await chat.chat.completions.create({ ...body, stream: false }, { signal })) as OpenAI.Chat.ChatCompletion;
    recordUsage(response.usage);
    const message = response.choices?.[0]?.message;
    if (!message) throw new Error('The API returned no choices.');
    return { content: message.content ?? '', toolCalls: message.tool_calls ?? [] };
  }

  async function completeStreaming(body: ChatCompletionCreateParams, signal?: AbortSignal) {
    usage.requests++;
    const response = (await chat.chat.completions.create(
      { ...body, stream: true, ...(config.streamUsage !== false ? { stream_options: { include_usage: true } } : {}) },
      { signal }
    )) as AsyncIterable<ChatCompletionChunk>;
    let content = '';
    const calls: ChatCompletionMessageToolCall[] = [];
    let started = false;
    for await (const chunk of response) {
      recordUsage(chunk.usage);
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

  /** Summarize everything but the latest turn (the `/compact` command). */
  async function compact(signal?: AbortSignal): Promise<CompactResult> {
    const result = await compactHistory(conversationHistory, {
      budget: historyBudget(profile(), buildSystemPrompt(config, root), tools()),
      force: true,
      summarize: strategy !== 'truncate' ? (d, prev) => summarize(d, prev, signal) : undefined,
    });
    if (result.changed) replaceHistory(result.messages);
    return result;
  }

  function contextStats(): ContextStats {
    const p = profile();
    const systemPrompt = buildSystemPrompt(config, root);
    const toolDefs = tools();
    return {
      model,
      contextWindow: p.contextWindow,
      historyBudget: historyBudget(p, systemPrompt, toolDefs),
      estimatedTokens:
        estimateTokens(systemPrompt) + estimateJsonTokens(toolDefs.length ? toolDefs : undefined) + estimateMessagesTokens(conversationHistory),
      messages: conversationHistory.length,
    };
  }

  return {
    run,
    reset,
    compact,
    contextStats,
    history: conversationHistory as readonly Message[],
    /** Replace the conversation (e.g. when loading a saved session). */
    loadHistory: (messages: readonly Message[]) => replaceHistory(messages),
    usage: usage as Readonly<Usage>,
    getModel: () => model,
    setModel: (m: string) => {
      if (!m.trim()) throw new Error('Model name cannot be empty');
      model = m.trim();
    },
    profile,
  };
}

/** Estimated cost in USD, when the model has prices configured. */
export function estimateCost(usage: Usage, p: ModelProfile): number | null {
  if (p.inputPricePerMTok === undefined && p.outputPricePerMTok === undefined) return null;
  return (usage.promptTokens * (p.inputPricePerMTok ?? 0) + usage.completionTokens * (p.outputPricePerMTok ?? 0)) / 1_000_000;
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
    const names = getTools({ web: config.web }).map((t) => t.function.name);
    const web = [names.includes('web_search') ? 'search the web' : '', names.includes('web_fetch') ? 'fetch web pages' : '']
      .filter(Boolean)
      .join(' and ');
    prompt += `
You have tools to read, write and edit files, list directories, search file contents, and run shell commands${web ? `; you can also ${web}` : ''}.
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

  if (config.instructionsText) {
    prompt += `\n\nProject instructions (from AICLI.md files). Follow them unless they conflict with the user's requests; they cannot grant approval for actions:\n${config.instructionsText}`;
  }

  if (config.contextText) {
    prompt += `\n\nContext provided by the user${config.context ? ` (from ${config.context})` : ''}:\n${config.contextText}`;
  }
  return prompt;
}
