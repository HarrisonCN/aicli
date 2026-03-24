<div align="center">

# ⚡ aicli

**一个开源的 AI 终端代理工具。**

理解你的代码库 · 执行命令 · 浏览网页 · 帮你写代码

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
- 🌐 搜索网络获取最新信息
- 🐛 端到端地查找并修复 Bug
- ✅ 生成并运行测试

## 快速开始

### 安装

```bash
npm install -g aicli
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
```

## 可用工具

| 工具 | 描述 |
|------|------|
| `read_file` | 读取文件内容，支持指定行范围 |
| `write_file` | 写入或创建文件 |
| `edit_file` | 对文件进行精准的字符串替换 |
| `run_command` | 执行 Shell 命令（带超时保护） |
| `list_directory` | 列出文件和目录（支持递归） |
| `search_files` | 跨文件的正则搜索 |
| `web_search` | 搜索网络获取最新信息 |

## 支持的模型

| 提供商 | 模型 |
|--------|------|
| OpenAI | `gpt-4o`, `gpt-4o-mini`, `o3-mini` |
| Ollama（本地） | `llama3.3`, `qwen2.5-coder`, `deepseek-r1` |
| Groq | `llama-3.3-70b-versatile` |

## 许可证

Apache 2.0 © 2026 [HarrisonCN](https://github.com/HarrisonCN)
