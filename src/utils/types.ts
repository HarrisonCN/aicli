/**
 * Shared type definitions for aicli
 */

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
}
