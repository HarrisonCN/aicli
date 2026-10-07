import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeTool, getTools } from './index.js';
import { htmlToText, isPrivateAddress, resolveSearchConfig, webFetch, webSearch, type WebConfig } from './web.js';

// A local fake server standing in for the search providers and for web pages.
// No real API keys or network access are used.
let server: Server;
let base: string;
const seen: { method: string; url: string; headers: IncomingMessage['headers']; body: string }[] = [];

function route(req: IncomingMessage, res: ServerResponse, body: string) {
  const url = new URL(req.url ?? '/', base);
  const json = (status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  switch (url.pathname) {
    case '/tavily':
      if (req.headers.authorization !== 'Bearer test-key') return json(401, { detail: { error: 'Unauthorized' } });
      return json(200, {
        results: [
          { title: 'Tavily One', url: 'https://one.example', content: 'first snippet' },
          { title: 'Tavily Two', url: 'https://two.example', content: 'second snippet' },
        ],
        echo: JSON.parse(body),
      });
    case '/brave':
      if (req.headers['x-subscription-token'] !== 'test-key') return json(401, {});
      return json(200, { web: { results: [{ title: 'Brave', url: 'https://brave.example', description: 'a <strong>bold</strong> claim' }] } });
    case '/serpapi':
      if (url.searchParams.get('api_key') !== 'test-key') return json(401, { error: `Invalid API key test-key-bad ${url.searchParams.get('api_key')}` });
      return json(200, { organic_results: [{ title: 'Serp', link: 'https://serp.example', snippet: 'serp snippet' }] });
    case '/page':
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        '<html><head><title>Test &amp; Page</title><style>body{}</style></head><body><nav>menu</nav>' +
          '<h1>Hello</h1><p>Some <b>bold</b> text &mdash; here.</p><script>alert(1)</script>' +
          '<ul><li>one</li><li>two</li></ul><a href="https://example.com/x">a link</a></body></html>'
      );
    case '/big':
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('y'.repeat(50_000));
    case '/redirect':
      res.writeHead(302, { Location: '/page' });
      return res.end();
    case '/loop':
      res.writeHead(302, { Location: '/loop' });
      return res.end();
    case '/image':
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    case '/json':
      return json(200, { hello: 'world' });
    default:
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      route(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const local: WebConfig = { allowPrivateNetwork: true };

describe('web_search configuration', () => {
  it('is disabled without a key and enabled with one', () => {
    expect(resolveSearchConfig({}, {})).toBeNull();
    expect(resolveSearchConfig({ searchProvider: 'brave' }, {})).toBeNull();
    expect(resolveSearchConfig({}, { BRAVE_API_KEY: 'k' })).toMatchObject({ provider: 'brave', apiKey: 'k' });
    expect(resolveSearchConfig({ searchProvider: 'serpapi', searchApiKey: 'k2' }, {})).toMatchObject({ provider: 'serpapi', apiKey: 'k2' });
    expect(resolveSearchConfig({ searchProvider: 'tavily' }, { TAVILY_API_KEY: 'k3' })).toMatchObject({ apiKey: 'k3' });
  });

  it('only advertises web_search when configured', () => {
    const saved = { ...process.env };
    for (const k of ['TAVILY_API_KEY', 'BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY', 'SERPAPI_API_KEY', 'SERPAPI_KEY']) delete process.env[k];
    try {
      const names = (web?: WebConfig) => getTools({ web }).map((t) => t.function.name);
      expect(names()).not.toContain('web_search');
      expect(names()).toContain('web_fetch');
      expect(names({ searchProvider: 'tavily', searchApiKey: 'x' })).toContain('web_search');
      expect(names({ fetchEnabled: false })).not.toContain('web_fetch');
    } finally {
      process.env = saved;
    }
  });

  it('returns a clear error when called while not configured', async () => {
    const saved = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    expect(await executeTool('web_search', { query: 'x' }, { root: '.', web: {} })).toMatch(/not configured/);
    if (saved) process.env.TAVILY_API_KEY = saved;
  });
});

describe('web_search providers (fake server)', () => {
  it('tavily: POSTs JSON with a bearer token', async () => {
    const out = await webSearch('what is aicli', 2, { searchProvider: 'tavily', searchApiKey: 'test-key', searchBaseURL: `${base}/tavily` });
    expect(out).toContain('1. Tavily One\n   https://one.example\n   first snippet');
    expect(out).toContain('2. Tavily Two');
    const req = seen.filter((r) => r.url === '/tavily').at(-1)!;
    expect(req.method).toBe('POST');
    expect(JSON.parse(req.body)).toMatchObject({ query: 'what is aicli', max_results: 2 });
  });

  it('brave: GET with subscription token, strips markup from snippets', async () => {
    const out = await webSearch('q', 3, { searchProvider: 'brave', searchApiKey: 'test-key', searchBaseURL: `${base}/brave` });
    expect(out).toContain('Brave\n   https://brave.example\n   a bold claim');
    expect(seen.filter((r) => r.url.startsWith('/brave')).at(-1)!.url).toContain('count=3');
  });

  it('serpapi: maps organic results, and never echoes the key in errors', async () => {
    const ok = await webSearch('q', 5, { searchProvider: 'serpapi', searchApiKey: 'test-key', searchBaseURL: `${base}/serpapi` });
    expect(ok).toContain('Serp\n   https://serp.example');
    const bad = await webSearch('q', 5, { searchProvider: 'serpapi', searchApiKey: 'secret-xyz', searchBaseURL: `${base}/serpapi` });
    expect(bad).toMatch(/HTTP 401/);
    expect(bad).not.toContain('secret-xyz');
  });

  it('reports HTTP and network errors as text', async () => {
    expect(await webSearch('q', 1, { searchProvider: 'tavily', searchApiKey: 'wrong', searchBaseURL: `${base}/tavily` })).toMatch(/HTTP 401/);
    expect(await webSearch('q', 1, { searchProvider: 'tavily', searchApiKey: 'k', searchBaseURL: 'http://127.0.0.1:1/' })).toMatch(/request failed/);
    await expect(webSearch('', 1, { searchProvider: 'tavily', searchApiKey: 'k' })).rejects.toThrow(/non-empty/);
  });
});

describe('web_fetch', () => {
  it('converts HTML to readable text', async () => {
    const out = await webFetch(`${base}/page`, undefined, local);
    expect(out).toContain('Title: Test & Page');
    expect(out).toContain('# Hello');
    expect(out).toContain('Some bold text — here.');
    expect(out).toContain('- one\n- two');
    expect(out).toContain('a link (https://example.com/x)');
    expect(out).not.toContain('alert(1)');
    expect(out).not.toContain('menu');
    expect(out).not.toContain('body{}');
  });

  it('follows redirects (bounded) and caps output size', async () => {
    expect(await webFetch(`${base}/redirect`, undefined, local)).toContain(`URL: ${base}/page`);
    expect(await webFetch(`${base}/loop`, undefined, local)).toMatch(/too many redirects/);
    const big = await webFetch(`${base}/big`, 1000, local);
    expect(big).toMatch(/truncated: showing 1000 of 50000 characters/);
    expect(big.length).toBeLessThan(1300);
  });

  it('rejects non-text content, bad URLs, other schemes and HTTP errors', async () => {
    expect(await webFetch(`${base}/image`, undefined, local)).toMatch(/image\/png, not a text page/);
    expect(await webFetch('not a url', undefined, local)).toMatch(/invalid URL/);
    expect(await webFetch('file:///etc/passwd', undefined, local)).toMatch(/only http/);
    expect(await webFetch(`${base}/missing`, undefined, local)).toMatch(/HTTP 404/);
    expect(await webFetch(`${base}/json`, undefined, local)).toContain('"hello":"world"');
  });

  it('refuses private and loopback addresses by default', async () => {
    expect(await webFetch(`${base}/page`, undefined, {})).toMatch(/private address/);
    expect(await webFetch('http://localhost:9/', undefined, {})).toMatch(/private address/);
    expect(await webFetch('http://[::1]:9/', undefined, {})).toMatch(/private address/);
    // ...including when a public URL redirects to one
    const fakeFetch = (async (u: URL | string) =>
      String(u).startsWith('http://93.184.216.34')
        ? new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/admin' } })
        : new Response('secret')) as typeof fetch;
    expect(await webFetch('http://93.184.216.34/', undefined, { fetch: fakeFetch })).toMatch(/private address/);
  });

  it('is reachable through executeTool and can be disabled', async () => {
    expect(await executeTool('web_fetch', { url: `${base}/json` }, { root: '.', web: local })).toContain('world');
    expect(await executeTool('web_fetch', { url: `${base}/json` }, { root: '.', web: { fetchEnabled: false } })).toMatch(/disabled/);
  });
});

describe('helpers', () => {
  it('classifies private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('decodes entities and keeps table cells apart', () => {
    const { text } = htmlToText('<table><tr><td>a</td><td>b</td></tr></table><p>&lt;tag&gt; &#169; &#x4F60;</p>');
    expect(text).toContain('a | b |');
    expect(text).toContain('<tag> © 你');
  });
});
