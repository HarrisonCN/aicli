# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Session export**: `aicli sessions --export <id> [--format md|json] [-o file] [--force] [--no-tool-output]`
  and the `/export [file]` REPL command write a conversation as a Markdown transcript (tool calls and
  results folded into `<details>`, long results clipped) or as raw JSON. Files are mode 600 and are not
  overwritten without `--force`.
- **`aicli doctor`** checks your setup: Node.js version, config file (valid JSON, private permissions,
  invalid values), API key, base URL (invalid, set by `./.env`, plain http to a remote host), the default
  model's profile, a live `GET /models` call (key accepted, model offered), web tools, `AICLI.md` files
  and the sessions directory. `--offline` skips the network call; `--json` for scripts; exits 1 on failure.

## [0.2.0] - 2026-10-06

### Added
- **`web_search` tool** with pluggable providers: Tavily, Brave Search and SerpAPI. Configure with
  `webSearchProvider` / `webSearchApiKey` (or `TAVILY_API_KEY`, `BRAVE_API_KEY`, `SERPAPI_API_KEY`).
  The tool is only offered to the model when a key is configured; `aicli tools` shows its status.
- **`web_fetch` tool**: fetches an http(s) URL and returns readable text (built-in HTML-to-text, no new
  dependencies). Limits: 20 s timeout, 2 MB download, 5 redirects, 100k characters returned. Private,
  loopback and link-local addresses are refused, including via redirects. Disable with `webFetch=false`.
- **Context management**: token estimates for the conversation (CJK-aware) and automatic compaction before
  the context window overflows — old large tool outputs are elided, then the oldest turns are summarized by
  the model (`contextStrategy=summarize`, default), dropped (`truncate`), or left alone (`off`). Tool calls
  are never separated from their results.
- **Model-aware request parameters**: reasoning models (`o1`, `o3`, `o4-mini`, `gpt-5`, …) no longer get
  `temperature`, use the `developer` role and `max_completion_tokens`. Built-in context windows for common
  models. Per-model overrides via `modelSettings` (temperature, max output tokens, context window,
  reasoning effort, system role, prices).
- **Sessions**: chats auto-save to `~/.aicli/sessions/` (mode 600). `aicli chat --resume [id|name]`,
  `aicli sessions [--delete <id>]`, and `saveSessions=false` to opt out.
- **Slash commands**: `/help`, `/model [name]`, `/cost` (`/usage`, `/tokens`), `/compact`, `/save [name]`,
  `/load <id|name>`, `/sessions`, `/clear` (`/reset`), `/exit`.
- **Token usage tracking** (from the API's `usage`, incl. `stream_options.include_usage` when streaming;
  `streamUsage=false` to disable) and optional cost estimates.
- **Project instructions**: `AICLI.md` (or `.aicli/AICLI.md`, `.aicli/instructions.md`, `.aicli.md`,
  `.aicli`) from the repo root down to the cwd, plus `~/.aicli/AICLI.md`, are added to the system prompt.
  `--no-instructions` / `projectInstructions=false` to skip.
- `aicli config --unset <key>`; enum and JSON config values are validated.

### Changed
- One-shot `aicli chat "<message>"` now saves a session so it can be resumed (`aicli run` does not).

The audit fixes merged in #1 (never released separately) are also part of 0.2.0:

### Security
- `search_files` no longer builds a shell command from model input (command injection); it is now a pure-JS search.
- File tools are confined to the workspace root, including through symlinks (`--allow-outside-workspace` to opt out).
- `write_file`, `edit_file` and `run_command` require user approval (`--yes` to skip); denied when there is no TTY.
- Config file is written with `0600` permissions; `config --list/--get` mask the API key.
- Warn when `OPENAI_BASE_URL` is loaded from a local `.env`.

### Fixed
- CLI crashed on Node 22 (`import ... assert { type: 'json' }`); the project also failed `tsc` typechecking.
- `defaultModel` from config was always overridden by the hardcoded `--model` default.
- `edit_file` corrupted replacements containing `$&`, `$1`, `$$`; it now also rejects ambiguous matches.
- Tool errors (e.g. missing file) and API errors became unhandled rejections; they are now reported cleanly.
- Conversation history is rolled back after an error or cancel, so the next turn is not rejected by the API.
- `run --json` mixed the answer text into the JSON on stdout.
- Piped stdin was ignored (`git diff | aicli run ...` in the examples did nothing).
- `--context` only passed the path to the model; it now loads the file or directory tree.
- `run_command`: large output no longer throws (`maxBuffer`), timeouts kill the whole process tree, and commands that read stdin no longer hang.
- Invalid tool-call JSON is reported to the model instead of running the tool with `{}`.
- Non-zero exit codes on failure.

### Added (audit)
- Token streaming (`--no-stream` / `stream` config to disable), Ctrl+C cancellation, `/reset` in the REPL.
- `--yes`, `--allow-outside-workspace`, `--max-iterations`, `-t` validation; `edit_file.replace_all`, `search_files.ignore_case`.
- Vitest test suite, ESLint flat config, `typecheck` script, CI workflow.

### Removed
- The placeholder `web_search` tool (it returned fake results); unused dependencies `ink`, `react`, `ora`, `zod`, `chalk`.

### Planned
- MCP (Model Context Protocol) server support
- Plugin system for custom tools
- Web UI / dashboard

## [0.1.0] - 2026-03-24

### Added
- Initial release of aicli
- Interactive REPL chat mode (`aicli chat`)
- One-shot task runner (`aicli run`)
- Configuration management (`aicli config`)
- Tool listing (`aicli tools`)
- Core tools: `read_file`, `write_file`, `edit_file`, `run_command`, `list_directory`, `search_files`, `web_search`
- ReAct agent loop with configurable max iterations
- Support for any OpenAI-compatible API endpoint
- TypeScript source with full type safety
- Apache 2.0 license
- CI/CD via GitHub Actions (Ubuntu, macOS, Windows × Node 18/20/22)
