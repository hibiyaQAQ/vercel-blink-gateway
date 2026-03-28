import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { translateChatRequest, translateImageRequest, translateEmbeddingRequest } from './translate.js';

const GATEWAY_BASE = (process.env.GATEWAY_BASE_URL || 'https://ai-gateway.vercel.sh').replace(/\/$/, '');
const BLINK_BASE = (process.env.BLINK_BASE_URL || 'https://core.blink.new/api').replace(/\/$/, '');
const PORT = parseInt(process.env.PORT || '3000', 10);
const DEFAULT_API_KEY = process.env.AI_GATEWAY_API_KEY || '';

// ─── Gateway routing ───

interface GatewayRoute {
  base: string;       // upstream base URL
  path: string;       // cleaned local path (e.g. /v1/chat/completions)
  apiKey: string;     // API key to use
}

function resolveRoute(rawPath: string, req: IncomingMessage): GatewayRoute {
  const clientKey = extractClientKey(req);

  if (rawPath.startsWith('/blink/') || rawPath === '/blink') {
    // Blink gateway: strip /blink prefix, remap /v1/xxx → /v1/ai/xxx
    const stripped = rawPath.replace(/^\/blink/, '') || '/';
    const upstreamPath = stripped.replace(/^\/v1\//, '/v1/ai/');
    return { base: BLINK_BASE, path: upstreamPath, apiKey: clientKey };
  }

  // Default: Vercel AI Gateway
  return { base: GATEWAY_BASE, path: rawPath, apiKey: DEFAULT_API_KEY || clientKey };
}

// ─── Helpers ───

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function extractClientKey(req: IncomingMessage): string {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

// Remove "[undefined]" string values and null/undefined entries sent by some clients (e.g. Cherry Studio)
function cleanBody(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(cleanBody);
  }
  if (obj !== null && typeof obj === 'object') {
    const cleaned: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj)) {
      const c = cleanBody(val);
      if (c !== undefined) cleaned[key] = c;
    }
    return cleaned;
  }
  // Strip literal "[undefined]" strings that some clients send for unset params
  if (obj === '[undefined]' || obj === 'undefined') return undefined;
  return obj;
}

function sendError(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: { message, type: 'proxy_error', code: status },
  }));
}

// ─── Proxy logic ───

async function proxyGet(route: GatewayRoute, res: ServerResponse) {
  const upstream = await fetch(`${route.base}${route.path}`, {
    headers: {
      'Authorization': `Bearer ${route.apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  const body = await upstream.text();
  res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
  res.end(body);
}

async function proxyPost(
  route: GatewayRoute,
  body: Record<string, any>,
  res: ServerResponse,
) {
  // Translate request based on endpoint
  let translated: Record<string, any>;
  let upstreamPath: string;
  const path = route.path;

  if (path.includes('/chat/completions')) {
    translated = translateChatRequest(body);
    upstreamPath = path; // already mapped by resolveRoute
  } else if (path.includes('/images/generations')) {
    translated = translateImageRequest(body);
    upstreamPath = path;
  } else if (path.includes('/embeddings')) {
    translated = translateEmbeddingRequest(body);
    upstreamPath = path;
  } else {
    // Unknown endpoint: forward as-is
    translated = body;
    upstreamPath = path;
  }

  const isStream = !!translated.stream;

  const upstream = await fetch(`${route.base}${upstreamPath}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${route.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(translated),
  });

  if (isStream) {
    // Stream SSE response
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    };
    // Forward rate limit headers
    for (const h of ['x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests']) {
      const val = upstream.headers.get(h);
      if (val) headers[h] = val;
    }
    res.writeHead(upstream.status, headers);

    if (upstream.body) {
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch {
        // Client disconnected
      }
    }
    res.end();
  } else {
    // Non-streaming: forward response body
    const responseBody = await upstream.text();
    const headers: Record<string, string> = {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
    };
    res.writeHead(upstream.status, headers);
    res.end(responseBody);
  }
}

// ─── Request handler (shared between local server and Vercel) ───

export async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const rawPath = url.pathname;

  // Health check
  if (rawPath === '/' || rawPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', gateway: GATEWAY_BASE }));
    return;
  }
  if (rawPath === '/blink' || rawPath === '/blink/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', gateway: BLINK_BASE }));
    return;
  }

  const route = resolveRoute(rawPath, req);

  try {
    if (req.method === 'GET') {
      await proxyGet(route, res);
    } else if (req.method === 'POST') {
      const rawBody = await readBody(req);
      if (!rawBody) {
        sendError(res, 400, 'Empty request body');
        return;
      }
      const body = cleanBody(JSON.parse(rawBody));
      await proxyPost(route, body, res);
    } else {
      sendError(res, 405, 'Method not allowed');
    }
  } catch (err: any) {
    console.error('Proxy error:', err);
    sendError(res, 502, `Gateway proxy error: ${err.message}`);
  }
}

// ─── Server (local development only — skip when imported by Vercel) ───

if (!process.env.VERCEL) {
  const server = createServer(handleRequest);
  server.on('clientError', () => {});
  server.listen(PORT, () => {
    console.log(`OpenAI-compatible proxy for Vercel AI Gateway + Blink`);
    console.log(`Listening on http://localhost:${PORT}`);
    console.log(`Vercel upstream: ${GATEWAY_BASE}`);
    console.log(`Blink upstream:  ${BLINK_BASE}`);
    console.log();
    console.log(`Usage:`);
    console.log(`  Vercel: set base_url to http://localhost:${PORT}/v1`);
    console.log(`  Blink:  set base_url to http://localhost:${PORT}/blink/v1`);
  });
}
