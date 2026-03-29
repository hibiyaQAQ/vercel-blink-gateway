import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { translateChatRequest, translateImageRequest, translateEmbeddingRequest, translateMessagesRequest } from './translate.js';
import { anthropicRequestToOpenAI, openAIResponseToAnthropic, OpenAIToAnthropicStreamTransformer } from './anthropic-openai.js';

const GATEWAY_BASE = (process.env.GATEWAY_BASE_URL || 'https://ai-gateway.vercel.sh').replace(/\/$/, '');
const BLINK_BASE = (process.env.BLINK_BASE_URL || 'https://core.blink.new/api').replace(/\/$/, '');
const PORT = parseInt(process.env.PORT || '3000', 10);
const DEFAULT_API_KEY = process.env.AI_GATEWAY_API_KEY || '';

// Anthropic-specific headers to forward upstream
const ANTHROPIC_HEADERS = ['anthropic-version', 'anthropic-beta'];

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
  // Anthropic SDK uses x-api-key header; OpenAI SDK uses Authorization: Bearer
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey) return xApiKey;
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

// Send error in Anthropic format
function sendAnthropicError(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    type: 'error',
    error: { type: 'proxy_error', message },
  }));
}

// Build upstream headers, forwarding Anthropic-specific headers when present
function buildUpstreamHeaders(apiKey: string, req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Determine auth style: if original request used x-api-key, keep that style
  if (req.headers['x-api-key']) {
    headers['x-api-key'] = apiKey;
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // Forward Anthropic-specific headers
  for (const h of ANTHROPIC_HEADERS) {
    const val = req.headers[h];
    if (typeof val === 'string') headers[h] = val;
  }

  return headers;
}

// ─── Proxy logic ───

async function proxyGet(route: GatewayRoute, req: IncomingMessage, res: ServerResponse) {
  const upstream = await fetch(`${route.base}${route.path}`, {
    headers: buildUpstreamHeaders(route.apiKey, req),
  });

  const body = await upstream.text();
  res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
  res.end(body);
}

async function proxyPost(
  route: GatewayRoute,
  body: Record<string, any>,
  req: IncomingMessage,
  res: ServerResponse,
) {
  // Translate request based on endpoint
  let translated: Record<string, any>;
  let upstreamPath: string;
  const path = route.path;

  if (path.includes('/chat/completions')) {
    translated = translateChatRequest(body);
    upstreamPath = path;
  } else if (path.includes('/images/generations')) {
    translated = translateImageRequest(body);
    upstreamPath = path;
  } else if (path.includes('/embeddings')) {
    translated = translateEmbeddingRequest(body);
    upstreamPath = path;
  } else if (path.includes('/messages')) {
    // Anthropic Messages API (/v1/messages, /v1/messages/count_tokens)
    translated = translateMessagesRequest(body);
    upstreamPath = path;
  } else {
    // Unknown endpoint: forward as-is
    translated = body;
    upstreamPath = path;
  }

  const isStream = !!translated.stream;

  const upstream = await fetch(`${route.base}${upstreamPath}`, {
    method: 'POST',
    headers: buildUpstreamHeaders(route.apiKey, req),
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

// ─── Blink Messages: Anthropic → OpenAI conversion proxy ───

async function proxyBlinkMessages(
  route: GatewayRoute,
  body: Record<string, any>,
  res: ServerResponse,
) {
  const requestModel = body.model || '';
  const translated = anthropicRequestToOpenAI(body);
  const isStream = !!translated.stream;

  // Override path to chat/completions (Blink has no /messages endpoint)
  const upstreamPath = '/v1/ai/chat/completions';

  // Use OpenAI-style headers (no Anthropic headers for Blink)
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${route.apiKey}`,
    'Content-Type': 'application/json',
  };

  const upstream = await fetch(`${route.base}${upstreamPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(translated),
  });

  if (!upstream.ok && !isStream) {
    // Forward error in Anthropic format
    const errBody = await upstream.text();
    let message = `Upstream error: ${upstream.status}`;
    try {
      const parsed = JSON.parse(errBody);
      message = parsed.error?.message || message;
    } catch {}
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message },
    }));
    return;
  }

  if (isStream) {
    // Stream: convert OpenAI SSE → Anthropic SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const transformer = new OpenAIToAnthropicStreamTransformer(requestModel);

    if (upstream.body) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          const events = transformer.processChunk(text);
          for (const evt of events) {
            res.write(evt);
          }
        }
      } catch {
        // Client disconnected
      }
      // Flush remaining events
      const final = transformer.flush();
      for (const evt of final) {
        res.write(evt);
      }
    }
    res.end();
  } else {
    // Non-streaming: convert OpenAI response → Anthropic response
    const responseBody = await upstream.text();
    console.log('[blink-debug] raw response:', responseBody.slice(0, 2000));
    let anthropicResponse: any;
    try {
      const openaiResponse = JSON.parse(responseBody);
      anthropicResponse = openAIResponseToAnthropic(openaiResponse, requestModel);
    } catch {
      anthropicResponse = {
        type: 'error',
        error: { type: 'api_error', message: 'Failed to parse upstream response' },
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(anthropicResponse));
  }
}

// ─── Request handler (shared between local server and Vercel) ───

export async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  // On Vercel, rewrite passes original path via __path query param
  const pathFromQuery = url.searchParams.get('__path');
  const rawPath = pathFromQuery !== null ? `/${pathFromQuery}` : url.pathname;

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
      await proxyGet(route, req, res);
    } else if (req.method === 'POST') {
      const rawBody = await readBody(req);
      if (!rawBody) {
        // Use Anthropic error format for /messages endpoints
        if (rawPath.includes('/messages')) {
          sendAnthropicError(res, 400, 'Empty request body');
        } else {
          sendError(res, 400, 'Empty request body');
        }
        return;
      }
      const body = cleanBody(JSON.parse(rawBody));

      if (rawPath.startsWith('/blink/') && rawPath.includes('/messages')) {
        console.log('[blink-debug] thinking:', JSON.stringify(body.thinking));
        console.log('[blink-debug] has cache_control in system:', Array.isArray(body.system) && body.system.some((b: any) => b.cache_control));
        console.log('[blink-debug] has cache_control in tools:', Array.isArray(body.tools) && body.tools.some((t: any) => t.cache_control));
        console.log('[blink-debug] tools count:', Array.isArray(body.tools) ? body.tools.length : 0);
      }

      // Blink + Anthropic Messages: convert Anthropic → OpenAI → Blink
      const isBlinkMessages = rawPath.startsWith('/blink/')
        && rawPath.includes('/messages')
        && !rawPath.includes('/count_tokens');

      if (isBlinkMessages) {
        await proxyBlinkMessages(route, body, res);
      } else if (rawPath.startsWith('/blink/') && rawPath.includes('/messages/count_tokens')) {
        sendAnthropicError(res, 501, 'count_tokens is not supported on Blink gateway');
      } else {
        await proxyPost(route, body, req, res);
      }
    } else {
      sendError(res, 405, 'Method not allowed');
    }
  } catch (err: any) {
    console.error('Proxy error:', err);
    if (rawPath.includes('/messages')) {
      sendAnthropicError(res, 502, `Gateway proxy error: ${err.message}`);
    } else {
      sendError(res, 502, `Gateway proxy error: ${err.message}`);
    }
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
    console.log(`  OpenAI format:     base_url = http://localhost:${PORT}/v1`);
    console.log(`  Anthropic format:  ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
    console.log(`  Blink (OpenAI):    base_url = http://localhost:${PORT}/blink/v1`);
    console.log(`  Blink (Anthropic): ANTHROPIC_BASE_URL=http://localhost:${PORT}/blink`);
  });
}
