/**
 * Terminal banner and UI utilities
 */

export function printBanner(version = '', stream: NodeJS.WritableStream = process.stderr): void {
  const tagline = `AI Agent for your terminal${version ? `  v${version}` : ''}`;
  const width = 41;
  const pad = (s: string) => `  ║${s.padEnd(width - 2)}║`;
  const art = [
    '   █████╗ ██╗ ██████╗██╗     ██╗',
    '  ██╔══██╗██║██╔════╝██║     ██║',
    '  ███████║██║██║     ██║     ██║',
    '  ██╔══██║██║██║     ██║     ██║',
    '  ██║  ██║██║╚██████╗███████╗██║',
    '  ╚═╝  ╚═╝╚═╝ ╚═════╝╚══════╝╚═╝',
  ];
  const lines = [
    `  ╔${'═'.repeat(width - 2)}╗`,
    pad(''),
    ...art.map(pad),
    pad(''),
    pad(`  ${tagline}`),
    `  ╚${'═'.repeat(width - 2)}╝`,
  ];
  stream.write('\n' + lines.join('\n') + '\n\n');
}

export function printSuccess(message: string): void {
  console.log(`✅ ${message}`);
}

export function printError(message: string): void {
  console.error(`❌ ${message}`);
}

export function printWarning(message: string): void {
  console.warn(`⚠️  ${message}`);
}

export function printInfo(message: string): void {
  console.log(`ℹ️  ${message}`);
}

export function printToolUse(toolName: string, args: Record<string, unknown>): void {
  const argsStr = Object.entries(args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ');
  console.error(`\n⚡ ${toolName}(${argsStr})`);
}
