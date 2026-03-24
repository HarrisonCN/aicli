/**
 * Configuration management for aicli
 * Reads from ~/.aicli/config.json and environment variables
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import type { Config } from './types.js';

const CONFIG_DIR = join(homedir(), '.aicli');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export async function loadConfig(): Promise<Config> {
  // Load .env if present
  try {
    const { config: dotenvConfig } = await import('dotenv');
    dotenvConfig();
  } catch {
    // dotenv not available, skip
  }

  let fileConfig: Partial<Config> = {};

  try {
    const raw = await readFile(CONFIG_FILE, 'utf-8');
    fileConfig = JSON.parse(raw);
  } catch {
    // Config file doesn't exist yet, use defaults
  }

  return {
    apiKey: process.env.OPENAI_API_KEY ?? fileConfig.apiKey,
    baseURL: process.env.OPENAI_BASE_URL ?? fileConfig.baseURL,
    defaultModel: process.env.AICLI_MODEL ?? fileConfig.defaultModel ?? 'gpt-4o',
    temperature: fileConfig.temperature ?? 0.7,
    maxIterations: fileConfig.maxIterations ?? 20,
  };
}

export async function saveConfig(config: Partial<Config>): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  let existing: Partial<Config> = {};
  try {
    const raw = await readFile(CONFIG_FILE, 'utf-8');
    existing = JSON.parse(raw);
  } catch {
    // ignore
  }
  const merged = { ...existing, ...config };
  await writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
}

export async function manageConfig(options: {
  set?: string;
  get?: string;
  list?: boolean;
}): Promise<void> {
  if (options.set) {
    const [key, ...valueParts] = options.set.split('=');
    const value = valueParts.join('=');
    await saveConfig({ [key]: value } as Partial<Config>);
    console.log(`✓ Set ${key} = ${value}`);
  } else if (options.get) {
    const config = await loadConfig();
    const value = config[options.get as keyof Config];
    console.log(value !== undefined ? String(value) : `Key "${options.get}" not found`);
  } else if (options.list) {
    const config = await loadConfig();
    console.log('\nCurrent configuration:\n');
    for (const [key, value] of Object.entries(config)) {
      const displayValue = key === 'apiKey' && value
        ? `${String(value).slice(0, 8)}...`
        : String(value ?? '(not set)');
      console.log(`  ${key.padEnd(20)} ${displayValue}`);
    }
    console.log();
  }
}
