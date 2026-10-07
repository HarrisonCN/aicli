<div align="center">

# ⚡ aicli

**An open-source AI agent that lives in your terminal.**

Understands your codebase · Runs commands · Edits files · Ships code

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg)](https://www.typescriptlang.org)
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

> `aicli` is not published to npm yet. Install from source:

```bash
git clone https://github.com/HarrisonCN/aicli.git
cd aicli
npm install
npm run build
npm link        # puts `aicli` on your PATH
```

### Configuration

```bash
# Set your API key
export OPENAI_API_KEY=sk-...

# Or use any OpenAI-compatible endpoint (Ollama, Together, Groq, etc.)
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_API_KEY=ollama

# Or configure persistently (stored in ~/.aicli/config.json, mode 600)
aicli config --set apiKey=sk-...
aicli config --set defaultModel=gpt-4o
aicli config --list          # API key is masked
```

> A `.env` file in the current directory is loaded too. aicli warns when
> `OPENAI_BASE_URL` comes from `.env`, since a cloned repo could use it to send
> your API key to another server.

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

# Pipe input in (appended to the task)
git diff main | aicli run "review this diff"

# Output as JSON (for scripting); exit code is non-zero on failure
aicli run --json "list all TODO comments in the codebase"

# Let the agent write files and run commands without asking (use with care)
aicli run --yes "run the tests and fix any failures"
```

In the REPL, type `/reset` to clear the conversation and `exit` to quit.
Press **Ctrl+C** to cancel the current response or command; press it again to
force-quit.

### Options (`chat` and `run`)

| Flag | Description |
|------|-------------|
| `-m, --model <model>` | Model (default: `defaultModel` from config, else `gpt-4o`) |
| `-t, --temperature <n>` | Sampling temperature, 0–2 |
| `--max-iterations <n>` | Max agent loop iterations |
| `--no-tools` | Pure chat, no tools |
| `--no-stream` | Wait for the full response instead of streaming tokens |
| `--context <path>` | Add a file (contents) or directory (file tree) to the prompt |
| `-y, --yes` | Auto-approve writes, edits and shell commands |
| `--allow-outside-workspace` | Let file tools access paths outside the current directory |
| `--json` (`run` only) | Print the result as JSON |

## Safety

- **Approval:** `write_file`, `edit_file` and `run_command` show what they are
  about to do and ask `Allow? [y/N]` first. With no interactive terminal (for
  example when input is piped) they are denied unless you pass `--yes`.
- **Workspace sandbox:** file tools only touch paths inside the current
  directory, including through symlinks, unless `--allow-outside-workspace` is set.
  Note that an approved `run_command` runs with your full user permissions.
- **Limits:** command timeouts (default 30 s), and output/read/search size caps
  keep runaway tools from flooding the model's context.

## Available Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents, optionally by line range |
| `write_file` | Write or create files |
| `edit_file` | Make targeted string replacements in files |
| `run_command` | Execute shell commands with timeout (asks first) |
| `list_directory` | List files and folders (recursive) |
| `search_files` | Regex search across files (pure JS, works on Windows) |

`write_file` and `edit_file` also ask before changing anything. Web search is on
the roadmap and not available yet.

```bash
# List all available tools
aicli tools
```

## Supported Models

`aicli` works with any OpenAI-compatible API that supports function calling, for example:

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
| `stream` | — | `true` | Stream tokens as they arrive |

Unknown keys and invalid values are rejected by `aicli config --set`.

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
│   │   ├── banner.ts   # Terminal UI utilities
│   │   └── repl.ts     # REPL, approval prompts, Ctrl+C handling
│   └── utils/
│       ├── config.ts   # Config management
│       ├── context.ts  # --context loading
│       ├── paths.ts    # Workspace sandboxing
│       ├── text.ts     # Truncation / masking helpers
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

# Typecheck, lint, test, build
npm run typecheck
npm run lint
npm test
npm run build
```

## Roadmap

- [ ] Web search tool
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
