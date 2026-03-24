/**
 * Shared type definitions for aicli
 */

export interface AgentConfig {
  /** OpenAI-compatible API key */
  apiKey?: string;
  /** API base URL (for custom endpoints) */
  baseURL?: string;
  /** Model to use */
  model?: string;
  /** Sampling temperature */
  temperature?: number | string;
  /** Whether to enable tools */
  tools?: boolean;
  /** Path to load context from */
  context?: string;
  /** Maximum agent loop iterations */
  maxIterations?: number;
  /** Output as JSON */
  json?: boolean;
}

export interface AgentResult {
  success: boolean;
  output: string;
  iterations: number;
  error?: string;
}

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: MessageRole;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface Config {
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  temperature?: number;
  maxIterations?: number;
}
