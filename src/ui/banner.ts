/**
 * Terminal banner and UI utilities
 */

export function printBanner(): void {
  const banner = `
  ╔═══════════════════════════════════════╗
  ║                                       ║
  ║    ██████╗  ██╗ ██████╗██╗     ██╗   ║
  ║   ██╔══██╗ ██║██╔════╝██║     ██║   ║
  ║   ███████║ ██║██║     ██║     ██║   ║
  ║   ██╔══██║ ██║██║     ██║     ██║   ║
  ║   ██║  ██║ ██║╚██████╗███████╗██║   ║
  ║   ╚═╝  ╚═╝ ╚═╝ ╚═════╝╚══════╝╚═╝   ║
  ║                                       ║
  ║   AI Agent for your terminal  v0.1.0  ║
  ╚═══════════════════════════════════════╝
`;
  console.log(banner);
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
  console.log(`\n⚡ ${toolName}(${argsStr})`);
}
