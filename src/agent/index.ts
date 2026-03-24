/**
 * Core Agent module
 * Implements the ReAct (Reasoning + Acting) loop for the AI agent
 */

import OpenAI from 'openai';
import { getTools, executeTool } from '../tools/index.js';
import type { AgentConfig, AgentResult, Message } from '../utils/types.js';

export function createAgent(config: AgentConfig) {
  const client = new OpenAI({
    apiKey: config.apiKey ?? process.env.OPENAI_API_KEY,
    baseURL: config.baseURL ?? process.env.OPENAI_BASE_URL,
  });

  const conversationHistory: Message[] = [];

  /**
   * Run a single task or message through the agent loop
   */
  async function run(userMessage: string): Promise<AgentResult> {
    conversationHistory.push({ role: 'user', content: userMessage });

    const systemPrompt = buildSystemPrompt(config);
    const tools = config.tools !== false ? getTools() : [];

    let iterations = 0;
    const maxIterations = config.maxIterations ?? 20;

    while (iterations < maxIterations) {
      iterations++;

      const response = await client.chat.completions.create({
        model: config.model ?? 'gpt-4o',
        temperature: Number(config.temperature ?? 0.7),
        messages: [
          { role: 'system', content: systemPrompt },
          ...conversationHistory,
        ],
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? 'auto' : undefined,
      });

      const choice = response.choices[0];
      const assistantMessage = choice.message;

      conversationHistory.push(assistantMessage as Message);

      // If no tool calls, we have a final answer
      if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        const content = assistantMessage.content ?? '';
        process.stdout.write('\n' + content + '\n');
        return { success: true, output: content, iterations };
      }

      // Execute tool calls
      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        let toolArgs: Record<string, unknown>;

        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          toolArgs = {};
        }

        process.stderr.write(`\n⚡ Using tool: ${toolName}(${JSON.stringify(toolArgs)})\n`);

        const toolResult = await executeTool(toolName, toolArgs);

        conversationHistory.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
        } as Message);
      }
    }

    return {
      success: false,
      output: 'Max iterations reached without a final answer.',
      iterations,
    };
  }

  /**
   * Start an interactive REPL session
   */
  async function startRepl(): Promise<void> {
    const { createInterface } = await import('readline');
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log('\n🤖 aicli ready. Type your message or "exit" to quit.\n');

    const prompt = () => {
      rl.question('You: ', async (input) => {
        const trimmed = input.trim();
        if (!trimmed) {
          prompt();
          return;
        }
        if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
          console.log('\nGoodbye! 👋\n');
          rl.close();
          return;
        }

        try {
          await run(trimmed);
        } catch (err) {
          console.error('Error:', err instanceof Error ? err.message : String(err));
        }

        prompt();
      });
    };

    prompt();
  }

  return { run, startRepl };
}

function buildSystemPrompt(config: AgentConfig): string {
  const cwd = process.cwd();
  const platform = process.platform;
  const now = new Date().toISOString();

  return `You are aicli, a powerful AI coding agent running in the user's terminal.

Current working directory: ${cwd}
Platform: ${platform}
Current time: ${now}
${config.context ? `\nContext loaded from: ${config.context}` : ''}

You have access to tools that let you:
- Read and write files
- Execute shell commands
- Search the web
- Analyze code

Guidelines:
- Be concise and action-oriented
- Prefer showing code over explaining it
- Always confirm before destructive operations
- Use tools proactively to gather context before answering
- When fixing bugs, first read the relevant files, then make targeted edits`;
}
