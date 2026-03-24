#!/usr/bin/env node
/**
 * aicli - An open-source AI agent for your terminal
 * Entry point for the CLI application
 */

import { Command } from 'commander';
import { createAgent } from './agent/index.js';
import { loadConfig } from './utils/config.js';
import { printBanner } from './ui/banner.js';
import { version } from '../package.json' assert { type: 'json' };

const program = new Command();

program
  .name('aicli')
  .description('An open-source AI agent that lives in your terminal')
  .version(version);

program
  .command('chat [message]')
  .description('Start a chat session with the AI agent')
  .option('-m, --model <model>', 'Model to use (e.g. gpt-4o, claude-3-5-sonnet)', 'gpt-4o')
  .option('-t, --temperature <number>', 'Sampling temperature (0-2)', '0.7')
  .option('--no-tools', 'Disable tool use')
  .option('--context <path>', 'Load context from a file or directory')
  .action(async (message, options) => {
    printBanner();
    const config = await loadConfig();
    const agent = createAgent({ ...config, ...options });

    if (message) {
      // Single-shot mode
      await agent.run(message);
    } else {
      // Interactive REPL mode
      await agent.startRepl();
    }
  });

program
  .command('run <task>')
  .description('Run a one-shot task and exit')
  .option('-m, --model <model>', 'Model to use', 'gpt-4o')
  .option('--json', 'Output result as JSON')
  .action(async (task, options) => {
    const config = await loadConfig();
    const agent = createAgent({ ...config, ...options });
    const result = await agent.run(task);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    }
  });

program
  .command('config')
  .description('Manage aicli configuration')
  .option('--set <key=value>', 'Set a configuration value')
  .option('--get <key>', 'Get a configuration value')
  .option('--list', 'List all configuration values')
  .action(async (options) => {
    const { manageConfig } = await import('./utils/config.js');
    await manageConfig(options);
  });

program
  .command('tools')
  .description('List all available tools')
  .action(async () => {
    const { listTools } = await import('./tools/index.js');
    listTools();
  });

program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  printBanner();
  program.outputHelp();
}
