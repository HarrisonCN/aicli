/**
 * Web tools: `web_search` (pluggable providers) and `web_fetch`.
 *
 * web_search is only offered to the model when a provider and API key are
 * configured (config `webSearchProvider` / `webSearchApiKey`, or the
 * TAVILY_API_KEY / BRAVE_API_KEY / SERPAPI_API_KEY environment variables).
 *
 * web_fetch downloads a URL and returns readable text, with limits on size,
 * time and redirects. It refuses private, loopback and link-local addresses
 * unless `allowPrivateNetwork` is set, so a prompt-injected page cannot make
 * the agent probe your local network.
 */

import { lookup } from 'dns/promises';
import { isIP } from 'net';

// ─── Config ───────────────────────────────────────────────────────────────────

export type SearchProviderName = 'tavily' | 'brave' | 'serpapi';
export const SEARCH_PROVIDERS: SearchProviderName[] = ['tavily', 'brave', 'serpapi'];

export interface WebConfig {
  /** Search provider; inferred from which API key env var is set when omitted. */
  searchProvider?: SearchProviderName;
  /** API key for the search provider. */
  searchApiKey?: string;
  /** Override the provider endpoint (self-hosted proxy, tests). */
  searchBaseURL?: string;
  /** Enable web_fetch (default: true). */
  fetchEnabled?: boolean;
  /** Allow web_fetch to reach private / loopback addresses (default: false). */
  allowPrivateNetwork?: boolean;
  /** fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
}

const ENV_KEYS: Record<SearchProviderName, string[]> = {
  tavily: ['TAVILY_API_KEY'],
  brave: ['BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY'],
  serpapi: ['SERPAPI_API_KEY', 'SERPAPI_KEY'],
};

/**
 * Resolve the search provider and key from config, then the environment.
 * Returns null when web search is not configured.
 */
export function resolveSearchConfig(
  cfg: WebConfig = {},
  env: NodeJS.ProcessEnv = process.env
): { provider: SearchProviderName; apiKey: string; baseURL?: string } | null {
  const fromEnv = (p: SearchProviderName) => ENV_KEYS[p].map((k) => env[k]).find((v) => !!v);
  if (cfg.searchProvider) {
    const apiKey = cfg.searchApiKey || fromEnv(cfg.searchProvider);
    return apiKey ? { provider: cfg.searchProvider, apiKey, baseURL: cfg.searchBaseURL } : null;
  }
  for (const p of SEARCH_PROVIDERS) {
    const apiKey = fromEnv(p);
    if (apiKey) return { provider: p, apiKey, baseURL: cfg.searchBaseURL };
  }
  return null;
}

export const WEB_LIMITS = {
  searchTimeoutMs: 20_000,
  searchMaxResults: 10,
  snippetChars: 500,
  fetchTimeoutMs: 20_000,
  fetchMaxBytes: 2_000_000,
  fetchDefaultChars: 20_000,
  fetchMaxChars: 100_000,
  maxRedirects: 5,
};

// ─── Search ───────────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface Provider {
  defaultURL: string;
  request(query: string, count: number, apiKey: string, base: string): { url: string; init: RequestInit };
  parse(json: unknown): SearchResult[];
}

const asArray = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');

const PROVIDERS: Record<SearchProviderName, Provider> = {
  tavily: {
    defaultURL: 'https://api.tavily.com/search',
    request: (query, count, apiKey, base) => ({
      url: base,
      init: {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, max_results: count, search_depth: 'basic' }),
      },
    }),
    parse: (json) =>
      asArray((json as { results?: unknown })?.results).map((r) => ({ title: s(r.title), url: s(r.url), snippet: s(r.content) })),
  },
  brave: {
    defaultURL: 'https://api.search.brave.com/res/v1/web/search',
    request: (query, count, apiKey, base) => {
      const u = new URL(base);
      u.searchParams.set('q', query);
      u.searchParams.set('count', String(count));
      return { url: u.toString(), init: { headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' } } };
    },
    parse: (json) =>
      asArray((json as { web?: { results?: unknown } })?.web?.results).map((r) => ({
        title: s(r.title),
        url: s(r.url),
        snippet: stripTags(s(r.description)),
      })),
  },
  serpapi: {
    defaultURL: 'https://serpapi.com/search.json',
    request: (query, count, apiKey, base) => {
      const u = new URL(base);
      u.searchParams.set('engine', 'google');
      u.searchParams.set('q', query);
      u.searchParams.set('num', String(count));
      u.searchParams.set('api_key', apiKey);
      return { url: u.toString(), init: {} };
    },
    parse: (json) =>
      asArray((json as { organic_results?: unknown })?.organic_results).map((r) => ({
        title: s(r.title),
        url: s(r.link),
        snippet: s(r.snippet),
      })),
  },
};

function timeoutSignal(ms: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms} ms`)), ms);
  const onAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener('abort', onAbort, { once: true });
  if (outer?.aborted) controller.abort(outer.reason);
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

export async function webSearch(
  query: unknown,
  countArg: number | undefined,
  cfg: WebConfig,
  signal?: AbortSignal
): Promise<string> {
  if (typeof query !== 'string' || query.trim() === '') throw new Error('"query" must be a non-empty string');
  const resolved = resolveSearchConfig(cfg);
  if (!resolved) return 'Error: web search is not configured (set webSearchProvider and webSearchApiKey).';
  const provider = PROVIDERS[resolved.provider];
  const count = Math.min(WEB_LIMITS.searchMaxResults, Math.max(1, Math.floor(countArg ?? 5)));
  const { url, init } = provider.request(query.trim(), count, resolved.apiKey, resolved.baseURL || provider.defaultURL);
  const doFetch = cfg.fetch ?? fetch;
  const t = timeoutSignal(WEB_LIMITS.searchTimeoutMs, signal);
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal: t.signal });
  } catch (err) {
    t.done();
    if (signal?.aborted) throw err;
    return `Error: ${resolved.provider} search request failed: ${errMessage(err)}`;
  }
  try {
    const text = await res.text();
    if (!res.ok) {
      // Never echo the API key back (SerpAPI takes it in the query string).
      return `Error: ${resolved.provider} search returned HTTP ${res.status}: ${text.slice(0, 300).split(resolved.apiKey).join('****')}`;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return `Error: ${resolved.provider} search returned invalid JSON.`;
    }
    const results = provider.parse(json).filter((r) => r.url).slice(0, count);
    return formatResults(query.trim(), results);
  } finally {
    t.done();
  }
}

export function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No results for "${query}".`;
  const body = results
    .map((r, i) => {
      const snippet = r.snippet.length > WEB_LIMITS.snippetChars ? `${r.snippet.slice(0, WEB_LIMITS.snippetChars)}…` : r.snippet;
      return `${i + 1}. ${r.title || '(untitled)'}\n   ${r.url}${snippet ? `\n   ${snippet.replace(/\s+/g, ' ').trim()}` : ''}`;
    })
    .join('\n');
  return `Search results for "${query}":\n${body}\n\n(Use web_fetch to read a page.)`;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

/** True for loopback, private, link-local, CGNAT, multicast and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase().replace(/^\[|\]$/g, '');
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      x === '::' ||
      x === '::1' ||
      x.startsWith('fc') ||
      x.startsWith('fd') ||
      /^fe[89ab]/.test(x) ||
      x.startsWith('ff')
    );
  }
  return false;
}

async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error(`refusing to fetch private address ${host}`);
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  const bad = addrs.find(isPrivateAddress);
  if (bad) throw new Error(`refusing to fetch ${host}: it resolves to a private address (${bad})`);
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|javascript|ld\+json)|[^;]*\+(json|xml))/i;

export async function webFetch(
  urlArg: unknown,
  maxCharsArg: number | undefined,
  cfg: WebConfig,
  signal?: AbortSignal
): Promise<string> {
  if (typeof urlArg !== 'string' || urlArg.trim() === '') throw new Error('"url" must be a non-empty string');
  let url: URL;
  try {
    url = new URL(urlArg.trim());
  } catch {
    return `Error: invalid URL: ${urlArg}`;
  }
  const maxChars = Math.min(WEB_LIMITS.fetchMaxChars, Math.max(500, Math.floor(maxCharsArg ?? WEB_LIMITS.fetchDefaultChars)));
  const doFetch = cfg.fetch ?? fetch;
  const t = timeoutSignal(WEB_LIMITS.fetchTimeoutMs, signal);
  try {
    let res: Response | null = null;
    for (let hop = 0; hop <= WEB_LIMITS.maxRedirects; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return `Error: only http(s) URLs are supported (got ${url.protocol})`;
      if (url.username || url.password) return 'Error: URLs with embedded credentials are not allowed.';
      if (!cfg.allowPrivateNetwork) await assertPublicHost(url);
      res = await doFetch(url, {
        redirect: 'manual',
        signal: t.signal,
        headers: { 'User-Agent': 'aicli (+https://github.com/HarrisonCN/aicli)', Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' },
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => {});
        url = new URL(location, url);
        res = null;
        continue;
      }
      break;
    }
    if (!res) return `Error: too many redirects (more than ${WEB_LIMITS.maxRedirects}).`;
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return `Error: HTTP ${res.status} ${res.statusText} for ${url.toString()}`;
    }
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type && !TEXT_TYPES.test(type)) {
      await res.body?.cancel().catch(() => {});
      return `Error: ${url.toString()} is ${type}, not a text page; web_fetch only reads text/HTML/JSON.`;
    }
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > WEB_LIMITS.fetchMaxBytes * 5) {
      await res.body?.cancel().catch(() => {});
      return `Error: ${url.toString()} is too large (${declared} bytes).`;
    }
    const { text: raw, truncated: bytesCut } = await readCapped(res, WEB_LIMITS.fetchMaxBytes);
    const isHtml = type === 'text/html' || type === 'application/xhtml+xml' || (!type && /<html[\s>]/i.test(raw));
    let title = '';
    let text = raw;
    if (isHtml) ({ title, text } = htmlToText(raw));
    let out = text.trim();
    const total = out.length;
    if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n… [truncated: showing ${maxChars} of ${total} characters; pass a larger max_chars to read more]`;
    const header = `URL: ${url.toString()}${title ? `\nTitle: ${title}` : ''}${bytesCut ? `\n(Download stopped at ${WEB_LIMITS.fetchMaxBytes} bytes.)` : ''}`;
    return `${header}\n\n${out || '(no readable text)'}`;
  } catch (err) {
    if (signal?.aborted) throw err;
    return `Error: could not fetch ${url.toString()}: ${errMessage(err)}`;
  } finally {
    t.done();
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks)), truncated };
}

// ─── HTML → text ──────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''));
}

/** Convert HTML to readable plain text (no external dependencies). */
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';
  let body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|head|iframe|canvas)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(nav|footer)\b[\s\S]*?<\/\1\s*>/gi, '');
  body = body
    .replace(/<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = stripTags(inner).replace(/\s+/g, ' ').trim();
      return label && /^https?:/i.test(href) && label !== href ? `${label} (${href})` : label;
    })
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|main|header|ul|ol|table|tr|blockquote|pre|figure|dl|dt|dd)\b[^>]*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' | ')
    .replace(/<(td|th)\b[^>]*>/gi, '');
  const text = stripTags(body)
    .replace(/\r/g, '')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}
