# Contributing to aicli

Thank you for your interest in contributing to aicli! This document provides guidelines for contributing to the project.

## Development Setup

```bash
# Fork and clone the repository
git clone https://github.com/YOUR_USERNAME/aicli.git
cd aicli

# Install dependencies
npm install

# Set up your API key
export OPENAI_API_KEY=sk-...

# Run in development mode
npm run dev -- chat "hello world"
```

## Project Structure

```
src/
├── cli.ts          # CLI entry point
├── agent/
│   └── index.ts    # Core ReAct agent loop
├── tools/
│   └── index.ts    # Tool definitions and executors
├── ui/
│   └── banner.ts   # Terminal UI utilities
└── utils/
    ├── config.ts   # Configuration management
    └── types.ts    # TypeScript type definitions
```

## Adding a New Tool

1. Add the tool definition to `src/tools/index.ts` in the `getTools()` function
2. Add the tool executor in the `executeTool()` switch statement
3. Implement the tool function
4. Add tests in `src/tools/index.test.ts`

Example:

```typescript
// In getTools():
{
  type: 'function',
  function: {
    name: 'my_new_tool',
    description: 'Description of what the tool does',
    parameters: {
      type: 'object',
      properties: {
        param1: { type: 'string', description: 'Parameter description' },
      },
      required: ['param1'],
    },
  },
},

// In executeTool():
case 'my_new_tool':
  return myNewTool(args.param1 as string);

// Implementation:
async function myNewTool(param1: string): Promise<string> {
  // ...
}
```

## Pull Request Process

1. Create a feature branch: `git checkout -b feature/my-feature`
2. Make your changes with clear, focused commits
3. Add or update tests as appropriate
4. Ensure all tests pass: `npm test`
5. Ensure the build succeeds: `npm run build`
6. Submit a pull request with a clear description

## Code Style

- Use TypeScript strict mode
- Follow the existing code style
- Use `async/await` over raw Promises
- Add JSDoc comments for public APIs
- Keep functions small and focused

## Reporting Issues

Please use [GitHub Issues](https://github.com/HarrisonCN/aicli/issues) to report bugs or request features. Include:

- A clear description of the issue
- Steps to reproduce
- Expected vs actual behavior
- Your environment (OS, Node version, model used)

## License

By contributing, you agree that your contributions will be licensed under the Apache 2.0 License.
