# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Added
- Token streaming (`--no-stream` / `stream` config to disable), Ctrl+C cancellation, `/reset` in the REPL.
- `--yes`, `--allow-outside-workspace`, `--max-iterations`, `-t` validation; `edit_file.replace_all`, `search_files.ignore_case`.
- Vitest test suite, ESLint flat config, `typecheck` script, CI workflow.

### Removed
- The placeholder `web_search` tool (it returned fake results); unused dependencies `ink`, `react`, `ora`, `zod`, `chalk`.

### Planned
- MCP (Model Context Protocol) server support
- Plugin system for custom tools
- Persistent conversation memory
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
