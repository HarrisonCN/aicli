# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
