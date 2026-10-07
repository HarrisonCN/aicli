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
- 🌐 Search the web and read pages (optional, bring your own search API key)
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

Then check that everything is wired up:

```bash
aicli doctor            # API key, endpoint reachability, model, web tools, sessions
aicli doctor --offline  # skip the network check
aicli doctor --json     # machine-readable; exit code 1 if any check fails
```

`aicli doctor` calls `GET <baseURL>/models` with your key to confirm the
endpoint is reachable, the key is accepted and your default model is offered.
It also warns about a world-readable config file, a base URL set by `./.env`,
plain-http remote endpoints, and models whose context window it has to guess.

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

Press **Ctrl+C** to cancel the current response or command; press it again to
force-quit.

### Sessions and slash commands

Chat sessions are saved automatically to `~/.aicli/sessions/` (mode 600) after
every turn, so you can pick up where you left off:

```bash
aicli chat --resume            # latest session for this directory
aicli chat --resume demo       # by name, id, or unique id prefix
aicli chat --resume demo "and now add tests"   # one more message, then exit
aicli sessions                 # list saved sessions
aicli sessions --delete demo

# Export a transcript (Markdown by default, JSON for scripts)
aicli sessions --export demo > demo.md
aicli sessions --export demo -o demo.json          # format from the extension
aicli sessions --export demo --no-tool-output -o summary.md
```

Markdown exports list the session's model, directory and token usage, then each
turn; tool calls and their results are folded into `<details>` blocks (results
are clipped at 4,000 characters; `--no-tool-output` leaves them out). Exported
files are created with mode 600 and never overwrite an existing file unless you
pass `--force`. The system prompt is not included.

In the REPL:

| Command | Description |
|---------|-------------|
| `/help` | List commands |
| `/model [name]` | Show the model (context window, temperature support) or switch to another |
| `/cost` (`/usage`, `/tokens`) | Requests, token usage reported by the API, cost (if prices are configured) and context size |
| `/compact` | Summarize older turns now to free up context |
| `/save [name]` | Save the session, optionally giving it a name |
| `/load <id\|name>` | Load a saved session |
| `/sessions` | List saved sessions |
| `/export [file]` | Export the conversation as Markdown (or JSON if the file ends in `.json`); default file `aicli-session-<name or id>.md` |
| `/clear` (`/reset`) | Clear the conversation and start a new session |
| `/exit`, `exit` | Quit (also Ctrl+D) |

Set `saveSessions=false` to turn auto-saving off.

### Project instructions (`AICLI.md`)

Put an `AICLI.md` file in your repository root to give the agent standing
instructions (build commands, code style, things to avoid). It is added to the
system prompt on every run. aicli looks in:

1. `~/.aicli/AICLI.md` — your personal instructions for every project
2. every directory from the repository root (nearest `.git`) down to the current
   directory, taking the first of `AICLI.md`, `.aicli/AICLI.md`,
   `.aicli/instructions.md`, `.aicli.md` or a `.aicli` file

Files are capped at 20,000 characters each. Use `--no-instructions` (or
`projectInstructions=false`) to skip them. Instructions from a cloned repo are
untrusted text: they can steer the model but cannot approve file writes or
commands.

### Long conversations

aicli estimates how many tokens the conversation uses and compacts it before it
would overflow the model's context window: large old tool outputs are elided
first, then the oldest turns are summarized by the model into a short recap
(`contextStrategy=summarize`, the default). Use `contextStrategy=truncate` to
drop old turns without a summary call, or `off` to disable. Tool calls are never
separated from their results.

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
| `--no-instructions` | Do not load `AICLI.md` project instructions |
| `-r, --resume [id]` (`chat` only) | Resume a saved session |
| `--json` (`run` only) | Print the result as JSON |

## Safety

- **Approval:** `write_file`, `edit_file` and `run_command` show what they are
  about to do and ask `Allow? [y/N]` first. With no interactive terminal (for
  example when input is piped) they are denied unless you pass `--yes`.
- **Workspace sandbox:** file tools only touch paths inside the current
  directory, including through symlinks, unless `--allow-outside-workspace` is set.
  Note that an approved `run_command` runs with your full user permissions.
- **Web:** `web_fetch` only fetches `http(s)` URLs, refuses private, loopback
  and link-local addresses (checked again on every redirect), stops after 2 MB
  and 5 redirects, and returns at most 100,000 characters. It does not ask for
  approval; set `webFetch=false` if the agent should have no network access.
  Pages it reads can contain prompt injection, so keep approvals on for writes
  and commands when browsing.
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
| `web_search` | Search the web via Tavily, Brave or SerpAPI (only when a key is configured) |
| `web_fetch` | Fetch a URL and return readable text (HTML converted, size-limited) |

`write_file` and `edit_file` also ask before changing anything.

### Web search setup

`web_search` is only offered to the model when a provider key is configured:

```bash
# Pick one provider
aicli config --set webSearchProvider=tavily     # or brave, serpapi
aicli config --set webSearchApiKey=tvly-...

# …or just export the provider's key (provider is picked automatically)
export TAVILY_API_KEY=tvly-...      # https://tavily.com
export BRAVE_API_KEY=...            # https://brave.com/search/api/
export SERPAPI_API_KEY=...          # https://serpapi.com
```

`aicli tools` shows whether web search is enabled.

```bash
# List all available tools
aicli tools
```

## Supported Models

`aicli` works with any OpenAI-compatible API that supports function calling, for example:

| Provider | Models |
|----------|--------|
| OpenAI | `gpt-4o`, `gpt-4.1`, `o1`, `o3`, `o4-mini`, `gpt-5` |
| Anthropic (via proxy) | `claude-3-5-sonnet`, `claude-3-haiku` |
| Google (via proxy) | `gemini-2.0-flash`, `gemini-1.5-pro` |
| Ollama (local) | `llama3.3`, `qwen2.5-coder`, `deepseek-r1` |
| Groq | `llama-3.3-70b-versatile` |
| Together AI | `meta-llama/Llama-3-70b-chat-hf` |

### Model-aware parameters

Reasoning models (`o1`, `o3`, `o4-mini`, `gpt-5`, …) reject `temperature`, so
aicli leaves it out for them (and warns if you passed `-t`), sends the system
prompt with the `developer` role, and uses `max_completion_tokens`. Provider
prefixes such as `openai/o3-mini` are recognised. Known context windows are
built in; unknown models default to 32,768 tokens.

Override anything per model (exact name or `*` glob) with `modelSettings`:

```bash
aicli config --set 'modelSettings={
  "o3*":        { "reasoningEffort": "high" },
  "qwen2.5*":   { "contextWindow": 32768, "temperature": 0.2 },
  "my-proxy-r1":{ "supportsTemperature": false, "maxOutputTokens": 8000 },
  "gpt-4o":     { "inputPricePerMTok": 2.5, "outputPricePerMTok": 10 }
}'
```

| Setting | Meaning |
|---------|---------|
| `supportsTemperature` | `false` to never send `temperature` |
| `temperature` | Temperature for this model (overrides the global one) |
| `maxOutputTokens` | Cap on reply length (not sent when unset) |
| `tokenParam` | `max_tokens` or `max_completion_tokens` |
| `contextWindow` | Context size in tokens, used for history compaction |
| `reasoningEffort` | `minimal`, `low`, `medium` or `high` |
| `systemRole` | `system`, `developer` or `user` |
| `inputPricePerMTok` / `outputPricePerMTok` | USD per million tokens, for `/cost` |

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
| `streamUsage` | — | `true` | Ask for token usage on streamed replies (`false` for servers that reject `stream_options`) |
| `contextWindow` | — | per model | Override the context window for every model |
| `contextStrategy` | — | `summarize` | `summarize`, `truncate` or `off` |
| `modelSettings` | — | — | Per-model settings (JSON, see above) |
| `webSearchProvider` | `AICLI_WEB_SEARCH_PROVIDER` | auto | `tavily`, `brave` or `serpapi` |
| `webSearchApiKey` | `TAVILY_API_KEY` / `BRAVE_API_KEY` / `SERPAPI_API_KEY` | — | Search API key (masked in `config --list`) |
| `webSearchBaseURL` | — | provider default | Custom search endpoint (e.g. a proxy) |
| `webFetch` | — | `true` | Enable the `web_fetch` tool |
| `projectInstructions` | — | `true` | Load `AICLI.md` files |
| `saveSessions` | — | `true` | Auto-save chat sessions |

Unknown keys and invalid values are rejected by `aicli config --set`; use
`aicli config --unset <key>` to remove one.

## Architecture

```
aicli/
├── src/
│   ├── cli.ts          # CLI entry point (Commander.js)
│   ├── agent/
│   │   ├── index.ts    # ReAct agent loop, usage tracking
│   │   └── history.ts  # Token estimates & context compaction
│   ├── tools/
│   │   ├── index.ts    # Tool definitions & executors
│   │   └── web.ts      # web_search providers & web_fetch
│   ├── ui/
│   │   ├── banner.ts   # Terminal UI utilities
│   │   ├── commands.ts # REPL slash commands
│   │   └── repl.ts     # REPL, approval prompts, Ctrl+C handling
│   └── utils/
│       ├── config.ts   # Config management
│       ├── context.ts  # --context loading
│       ├── export.ts   # Session export (Markdown / JSON)
│       ├── doctor.ts   # `aicli doctor` setup checks
│       ├── instructions.ts # AICLI.md project instructions
│       ├── models.ts   # Model profiles & request params
│       ├── paths.ts    # Workspace sandboxing
│       ├── sessions.ts # Saved chat sessions
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

- [x] Web search & fetch tools
- [x] Saved sessions (`--resume`) and context compaction
- [x] Project instructions (`AICLI.md`)
- [ ] MCP (Model Context Protocol) server support
- [ ] Plugin system for custom tools
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
