<div align="center">

# ⚡ aicli

**An open-source AI agent that lives in your terminal.**

Understands your codebase · Runs commands · Browses the web · Ships code

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg)](https://www.typescriptlang.org)
[![npm version](https://img.shields.io/npm/v/aicli.svg)](https://www.npmjs.com/package/aicli)
[![CI](https://github.com/HarrisonCN/aicli/actions/workflows/ci.yml/badge.svg)](https://github.com/HarrisonCN/aicli/actions)

[English](#) · [中文](docs/README.zh-CN.md) · [Docs](docs/) · [Examples](examples/)

</div>

---

## What is aicli?

`aicli` is a lightweight, open-source AI coding agent that runs entirely in your terminal. Inspired by tools like [Gemini CLI](https://github.com/google-gemini/gemini-cli) and [Claude Code](https://github.com/anthropics/claude-code), `aicli` gives you a **model-agnostic**, **fully hackable** alternative that works with any OpenAI-compatible API.

It uses a **ReAct (Reasoning + Acting)** loop to autonomously:

- 📂 Read and write files in your project
- 🖥️ Execute shell commands and interpret output
- 🔍 Search across your codebase with regex
- 🌐 Search the web for up-to-date information
- 🐛 Find and fix bugs end-to-end
- ✅ Generate and run tests

## Demo

```
$ aicli chat "There's a bug in my auth middleware. Find it and fix it."

⚡ list_directory(path=src/middleware)
⚡ read_file(path=src/middleware/auth.ts)
⚡ search_files(pattern="req.headers.authorization", path=src)

I found the issue. In `auth.ts` line 42, the token is split on " " but the
Bearer prefix check is missing. Here's the fix:

⚡ edit_file(path=src/middleware/auth.ts, old_string=..., new_string=...)

✅ Fixed! The middleware now correctly validates Bearer tokens.
```

## Quick Start

### Installation

```bash
# npm
npm install -g aicli

# or run directly with npx
npx aicli chat "explain this codebase"
```

### Configuration

```bash
# Set your API key
export OPENAI_API_KEY=sk-...

# Or use any OpenAI-compatible endpoint (Ollama, Together, Groq, etc.)
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_API_KEY=ollama

# Or configure persistently
aicli config --set apiKey=sk-...
aicli config --set defaultModel=gpt-4o
```

### Usage

```bash
# Interactive chat mode (REPL)
aicli chat

# Single message
aicli chat "refactor my utils folder to use ES modules"

# One-shot task runner
aicli run "add JSDoc comments to all exported functions in src/"

# Use a specific model
aicli chat --model claude-3-5-sonnet "review my PR diff"

# Disable tools (pure chat)
aicli chat --no-tools "explain the difference between TCP and UDP"

# Load context from a directory
aicli chat --context ./src "what does this codebase do?"

# Output as JSON (for scripting)
aicli run --json "list all TODO comments in the codebase"
```

## Available Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents, optionally by line range |
| `write_file` | Write or create files |
| `edit_file` | Make targeted string replacements in files |
| `run_command` | Execute shell commands with timeout |
| `list_directory` | List files and folders (recursive) |
| `search_files` | Grep-style regex search across files |
| `web_search` | Search the web for current information |

```bash
# List all available tools
aicli tools
```

## Supported Models

`aicli` works with any OpenAI-compatible API. Tested with:

| Provider | Models |
|----------|--------|
| OpenAI | `gpt-4o`, `gpt-4o-mini`, `o1`, `o3-mini` |
| Anthropic (via proxy) | `claude-3-5-sonnet`, `claude-3-haiku` |
| Google (via proxy) | `gemini-2.0-flash`, `gemini-1.5-pro` |
| Ollama (local) | `llama3.3`, `qwen2.5-coder`, `deepseek-r1` |
| Groq | `llama-3.3-70b-versatile` |
| Together AI | `meta-llama/Llama-3-70b-chat-hf` |

## Configuration Reference

`aicli` reads configuration from `~/.aicli/config.json` and environment variables.

| Key | Env Variable | Default | Description |
|-----|-------------|---------|-------------|
| `apiKey` | `OPENAI_API_KEY` | — | API key |
| `baseURL` | `OPENAI_BASE_URL` | OpenAI | API base URL |
| `defaultModel` | `AICLI_MODEL` | `gpt-4o` | Default model |
| `temperature` | — | `0.7` | Sampling temperature |
| `maxIterations` | — | `20` | Max agent loop iterations |

## Architecture

```
aicli/
├── src/
│   ├── cli.ts          # CLI entry point (Commander.js)
│   ├── agent/
│   │   └── index.ts    # ReAct agent loop
│   ├── tools/
│   │   └── index.ts    # Tool definitions & executors
│   ├── ui/
│   │   └── banner.ts   # Terminal UI utilities
│   └── utils/
│       ├── config.ts   # Config management
│       └── types.ts    # Shared TypeScript types
├── examples/           # Usage examples
├── docs/               # Documentation
└── .github/workflows/  # CI/CD
```

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](docs/CONTRIBUTING.md) first.

```bash
# Clone and set up
git clone https://github.com/HarrisonCN/aicli.git
cd aicli
npm install

# Run in development mode
npm run dev -- chat "hello"

# Run tests
npm test
```

## Roadmap

- [ ] MCP (Model Context Protocol) server support
- [ ] Plugin system for custom tools
- [ ] Persistent conversation memory
- [ ] Web UI / dashboard
- [ ] Multi-agent orchestration
- [ ] Vision support (screenshot analysis)
- [ ] Voice input/output

## License

Apache 2.0 © 2026 [HarrisonCN](https://github.com/HarrisonCN)

---

<div align="center">
  <sub>Built with ❤️ · Star ⭐ if you find it useful</sub>
</div>
