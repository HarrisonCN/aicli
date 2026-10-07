/**
 * Small text helpers shared by the agent and tools.
 */

/** Truncate a string to `max` characters, noting how much was dropped. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} more characters]`;
}

/** One-line preview of a value, for logs. */
export function preview(value: unknown, max = 200): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const oneLine = s.replace(/\s+/g, ' ');
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Heuristic: a buffer with a NUL byte in its first 8 KB is treated as binary. */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

/** Mask a secret for display, keeping only the last 4 characters. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return `****${value.slice(-4)}`;
}
