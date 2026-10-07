/**
 * Shared type definitions for aicli
 */

import type { ModelSettings } from './models.js';
import type { SearchProviderName } from '../tools/web.js';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

export interface AgentConfig {
  /** OpenAI-compatible API key */
  apiKey?: string;
  /** API base URL (for custom endpoints) */
  baseURL?: string;
  /** Model to use */
  model?: string;
  /** Sampling temperature (0-2) */
  temperature?: number;
  /** Whether to enable tools */
  tools?: boolean;
  /** Path to load context from (shown to the model) */
  context?: string;
  /** Maximum agent loop iterations */
  maxIterations?: number;
  /** Stream tokens as they arrive (default: true) */
  stream?: boolean;
  /** Skip confirmation prompts for write/edit/run tools */
  autoApprove?: boolean;
  /** Allow file tools to touch paths outside the workspace root */
  allowOutsideWorkspace?: boolean;
  /** Workspace root (defaults to process.cwd()) */
  root?: string;
  /** True when the temperature came from the command line (warn if the model ignores it). */
  temperatureExplicit?: boolean;
  /** Per-model request settings, keyed by model name or `*` glob. */
  modelSettings?: Record<string, ModelSettings>;
  /** Override the context window (tokens) for every model. */
  contextWindow?: number;
  /** What to do when history would overflow the context window. */
  contextStrategy?: ContextStrategy;
  /** Ask the API for token usage on streamed responses (default: true). */
  streamUsage?: boolean;
  /** Project instructions (AICLI.md etc.) loaded into the system prompt. */
  instructionsText?: string;
  /** Web tools configuration. */
  web?: import('../tools/web.js').WebConfig;
}

export type ContextStrategy = 'summarize' | 'truncate' | 'off';

export interface Usage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

export interface AgentResult {
  success: boolean;
  output: string;
  iterations: number;
  error?: string;
}

/** A chat message in OpenAI's wire format. */
export type Message = ChatCompletionMessageParam;

export type ToolCall = ChatCompletionMessageToolCall;

export interface Config {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  temperature?: number;
  maxIterations?: number;
  stream?: boolean;
  streamUsage?: boolean;
  contextWindow?: number;
  contextStrategy?: ContextStrategy;
  modelSettings?: Record<string, ModelSettings>;
  webSearchProvider?: SearchProviderName;
  webSearchApiKey?: string;
  webSearchBaseURL?: string;
  webFetch?: boolean;
  projectInstructions?: boolean;
  saveSessions?: boolean;
}
