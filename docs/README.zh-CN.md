<div align="center">

# ⚡ aicli

**一个开源的 AI 终端代理工具。**

理解你的代码库 · 执行命令 · 编辑文件 · 帮你写代码

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](../LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)

[English](../README.md) · **中文** · [文档](.) · [示例](../examples/)

</div>

---

## 什么是 aicli？

`aicli` 是一个轻量级的开源 AI 编程代理，完全运行在你的终端中。受 [Gemini CLI](https://github.com/google-gemini/gemini-cli) 和 [Claude Code](https://github.com/anthropics/claude-code) 等工具的启发，`aicli` 提供了一个**模型无关**、**完全可定制**的替代方案，支持任何兼容 OpenAI API 的服务。

它使用 **ReAct（推理 + 行动）** 循环来自主完成任务：

- 📂 读取和写入项目文件
- 🖥️ 执行 Shell 命令并解读输出
- 🔍 在代码库中进行正则搜索
- 🌐 搜索网页并读取页面内容（可选，需自备搜索 API Key）
- 🐛 端到端地查找并修复 Bug
- ✅ 生成并运行测试

## 快速开始

### 安装

> 目前尚未发布到 npm，请从源码安装：

```bash
git clone https://github.com/HarrisonCN/aicli.git
cd aicli
npm install
npm run build
npm link
```

### 配置

```bash
# 设置 API Key
export OPENAI_API_KEY=sk-...

# 使用本地 Ollama（免费！）
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_API_KEY=ollama
```

### 使用

```bash
# 交互式对话
aicli chat

# 单次提问
aicli chat "帮我重构 utils 文件夹，改用 ES 模块"

# 一次性任务
aicli run "给 src/ 下所有导出函数添加 JSDoc 注释"

# 指定模型
aicli chat --model gpt-4o "帮我审查这段代码"

# 通过管道传入内容
git diff main | aicli run "审查这段 diff"

# 自动批准写文件和执行命令（谨慎使用）
aicli run --yes "运行测试并修复失败的用例"
```

### 会话与斜杠命令

对话会在每轮结束后自动保存到 `~/.aicli/sessions/`（权限 600），随时可以接着聊：

```bash
aicli chat --resume            # 恢复当前目录最近的会话
aicli chat --resume demo       # 按名称、ID 或唯一 ID 前缀恢复
aicli sessions                 # 列出已保存的会话
aicli sessions --delete demo   # 删除会话
```

REPL 中可用的命令：

| 命令 | 说明 |
|------|------|
| `/help` | 列出所有命令 |
| `/model [名称]` | 查看当前模型（上下文窗口、是否支持 temperature）或切换模型 |
| `/cost`（`/usage`、`/tokens`） | 请求次数、API 返回的 token 用量、费用（需配置价格）和上下文占用 |
| `/compact` | 立即把较早的对话压缩成摘要，释放上下文 |
| `/save [名称]` | 保存会话，可选命名 |
| `/load <ID\|名称>` | 加载已保存的会话 |
| `/sessions` | 列出已保存的会话 |
| `/clear`（`/reset`） | 清空对话并开始新会话 |
| `/exit`、`exit` | 退出（也可按 Ctrl+D） |

设置 `saveSessions=false` 可关闭自动保存。

### 项目指令文件（`AICLI.md`）

在仓库根目录放一个 `AICLI.md`，写上构建命令、代码风格、注意事项等，aicli 每次运行都会把它加入系统提示词。查找顺序：

1. `~/.aicli/AICLI.md` —— 对所有项目生效的个人指令
2. 从仓库根目录（最近的 `.git`）到当前目录的每一级目录中，依次取第一个存在的：`AICLI.md`、`.aicli/AICLI.md`、`.aicli/instructions.md`、`.aicli.md` 或 `.aicli` 文件

每个文件最多 20,000 字符。使用 `--no-instructions`（或 `projectInstructions=false`）可跳过。克隆来的仓库里的指令属于不可信文本：它能影响模型，但不能替你批准写文件或执行命令。

### 长对话

aicli 会估算对话占用的 token，在即将超出模型上下文窗口前自动压缩：先省略旧的大段工具输出，再让模型把最早的几轮对话总结成简短摘要（默认 `contextStrategy=summarize`）。设为 `truncate` 则直接丢弃旧对话（不额外调用模型），设为 `off` 则关闭。工具调用和它的结果始终保持在一起。

## 安全

- `write_file`、`edit_file`、`run_command` 执行前会显示操作内容并询问 `Allow? [y/N]`；没有交互终端时（例如管道输入）默认拒绝，除非加 `--yes`。
- 文件工具只能访问当前目录内的路径（包括符号链接），除非加 `--allow-outside-workspace`。
- `web_fetch` 只抓取 `http(s)` 地址，拒绝内网、回环和链路本地地址（每次重定向都会重新检查），下载上限 2 MB、最多 5 次重定向，返回最多 100,000 字符。它不需要审批；如果不希望代理访问网络，请设置 `webFetch=false`。网页内容可能包含提示词注入，浏览网页时请保持对写文件和命令的审批。
- 按 **Ctrl+C** 取消当前回复或命令，再按一次强制退出。

## 可用工具

| 工具 | 描述 |
|------|------|
| `read_file` | 读取文件内容，支持指定行范围 |
| `write_file` | 写入或创建文件 |
| `edit_file` | 对文件进行精准的字符串替换 |
| `run_command` | 执行 Shell 命令（带超时保护，执行前询问） |
| `list_directory` | 列出文件和目录（支持递归） |
| `search_files` | 跨文件的正则搜索（纯 JS 实现，支持 Windows） |
| `web_search` | 通过 Tavily、Brave 或 SerpAPI 搜索网页（仅在配置了 Key 时启用） |
| `web_fetch` | 抓取网页并返回可读文本（HTML 自动转换，有大小限制） |

### 配置网络搜索

```bash
# 选择一个服务商
aicli config --set webSearchProvider=tavily     # 或 brave、serpapi
aicli config --set webSearchApiKey=tvly-...

# 或者直接设置对应的环境变量（自动识别服务商）
export TAVILY_API_KEY=tvly-...
export BRAVE_API_KEY=...
export SERPAPI_API_KEY=...
```

运行 `aicli tools` 可查看网络搜索是否已启用。

## 支持的模型

| 提供商 | 模型 |
|--------|------|
| OpenAI | `gpt-4o`, `gpt-4.1`, `o1`, `o3`, `o4-mini`, `gpt-5` |
| Ollama（本地） | `llama3.3`, `qwen2.5-coder`, `deepseek-r1` |
| Groq | `llama-3.3-70b-versatile` |

### 按模型调整请求参数

推理模型（`o1`、`o3`、`o4-mini`、`gpt-5` 等）不接受 `temperature`，aicli 会自动省略它（如果你传了 `-t` 会给出提示），用 `developer` 角色发送系统提示词，并改用 `max_completion_tokens`。也能识别 `openai/o3-mini` 这类带服务商前缀的名称。常见模型的上下文窗口已内置，未知模型默认 32,768 token。

可以用 `modelSettings` 按模型名（精确匹配或 `*` 通配）覆盖任意设置：

```bash
aicli config --set 'modelSettings={"o3*":{"reasoningEffort":"high"},"qwen2.5*":{"contextWindow":32768}}'
```

可用设置：`supportsTemperature`、`temperature`、`maxOutputTokens`、`tokenParam`、`contextWindow`、`reasoningEffort`、`systemRole`、`inputPricePerMTok` / `outputPricePerMTok`（用于 `/cost` 计算费用）。

## 配置项

| 配置项 | 环境变量 | 默认值 | 说明 |
|--------|----------|--------|------|
| `apiKey` | `OPENAI_API_KEY` | — | API Key |
| `baseURL` | `OPENAI_BASE_URL` | OpenAI | API 地址 |
| `defaultModel` | `AICLI_MODEL` | `gpt-4o` | 默认模型 |
| `temperature` | — | `0.7` | 采样温度（推理模型会忽略） |
| `maxIterations` | — | `20` | 代理循环最大轮数 |
| `stream` | — | `true` | 流式输出 |
| `streamUsage` | — | `true` | 流式输出时请求 token 用量（服务端不支持 `stream_options` 时设为 `false`） |
| `contextWindow` | — | 按模型 | 统一覆盖上下文窗口大小 |
| `contextStrategy` | — | `summarize` | `summarize`、`truncate` 或 `off` |
| `modelSettings` | — | — | 按模型的设置（JSON） |
| `webSearchProvider` | `AICLI_WEB_SEARCH_PROVIDER` | 自动 | `tavily`、`brave` 或 `serpapi` |
| `webSearchApiKey` | `TAVILY_API_KEY` 等 | — | 搜索 API Key（`config --list` 中会打码） |
| `webSearchBaseURL` | — | 服务商默认 | 自定义搜索接口地址 |
| `webFetch` | — | `true` | 启用 `web_fetch` 工具 |
| `projectInstructions` | — | `true` | 加载 `AICLI.md` |
| `saveSessions` | — | `true` | 自动保存会话 |

用 `aicli config --unset <配置项>` 删除某项配置。

## 许可证

Apache 2.0 © 2026 [HarrisonCN](https://github.com/HarrisonCN)
