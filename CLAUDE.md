# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

API proxy for Vercel AI Gateway and Blink Gateway. Supports both OpenAI and Anthropic (Claude) API formats. Translates standard parameters into each gateway's expected format, so any OpenAI-compatible or Anthropic-compatible client works without modification.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Development with live reload (tsx watch)
npm run build        # Compile TypeScript → dist/
npm start            # Run compiled server (dist/index.js)
```

No test framework is configured.

## Configuration

Environment variables in `.env` (copy from `.env.example`):
- `AI_GATEWAY_API_KEY` (required) — Vercel AI Gateway API key
- `GATEWAY_BASE_URL` (default: `https://ai-gateway.vercel.sh`)
- `BLINK_BASE_URL` (default: `https://core.blink.new/api`)
- `PORT` (default: `3000`)

## Deployment

- **Local**: `npm run dev` or `npm run build && npm start`
- **Vercel**: `vercel.json` + `api/index.ts` serverless function. Set `buildCommand: ""` to skip tsc (Vercel auto-compiles `api/`). Server startup guarded by `if (!process.env.VERCEL)`.

## Architecture

Two source files in `src/`, plus `api/index.ts` for Vercel deployment:

**`index.ts`** — HTTP server (Node.js `http.createServer`, no framework). Dual-gateway routing via `resolveRoute()`:
- Default routes → Vercel AI Gateway (`GATEWAY_BASE`)
- `/blink/*` routes → Blink Gateway (`BLINK_BASE`), path remapped `/v1/xxx` → `/v1/ai/xxx`

Routes:
- `POST /v1/chat/completions` → `translateChatRequest()` → upstream (OpenAI format)
- `POST /v1/images/generations` → `translateImageRequest()` → upstream (OpenAI format)
- `POST /v1/embeddings` → `translateEmbeddingRequest()` → upstream (OpenAI format)
- `POST /v1/messages` → `translateMessagesRequest()` → upstream (Anthropic format)
- `POST /v1/messages/count_tokens` → upstream (Anthropic format)
- `GET /v1/models`, `/v1/models/{id}` → pass-through
- `GET /health`, `/blink/health` → local health check

All routes also available under `/blink/` prefix for Blink Gateway.

Auth: extracts API key from `x-api-key` header (Anthropic) or `Authorization: Bearer` (OpenAI). Forwards `anthropic-version` and `anthropic-beta` headers upstream.

Core handler exported as `handleRequest()` — used by both local `createServer` and Vercel's `api/index.ts`.

**`translate.ts`** — Pure translation functions, no side effects:
- `addProviderPrefix()` — auto-detects provider from model name prefix (e.g. `claude-` → `anthropic/`). Mapping table `MODEL_PREFIXES` at top of file.
- `translateChatRequest()` — normalizes 6+ reasoning/thinking parameter formats into Vercel's `reasoning` object; handles Gemini image size aliases (`-2k`/`-4k` model suffix); translates `provider_order`, `fallback_models`, `reasoning_exclude`.
- `translateImageRequest()` — normalizes resolution params per provider capabilities (DALL-E=size, Flux=width+height, Imagen/Grok=aspectRatio).
- `translateMessagesRequest()` — Anthropic Messages API: adds provider prefix to model. Body is already in Anthropic native format (thinking, tools, etc.) so minimal translation needed.
- `translateEmbeddingRequest()` — only adds provider prefix.

## Client Usage

```bash
# OpenAI-compatible clients → Vercel
base_url = http://localhost:3000/v1

# OpenAI-compatible clients → Blink
base_url = http://localhost:3000/blink/v1

# Claude Code → Vercel
ANTHROPIC_BASE_URL=http://localhost:3000 ANTHROPIC_AUTH_TOKEN=your-key ANTHROPIC_API_KEY="" claude

# Claude Code → Blink
ANTHROPIC_BASE_URL=http://localhost:3000/blink ANTHROPIC_AUTH_TOKEN=your-key ANTHROPIC_API_KEY="" claude
```

## Key Design Decisions

- Zero runtime dependencies beyond `dotenv` — uses Node.js built-in `http` and `fetch`
- ES module format (`"type": "module"` in package.json, ES2022 target)
- All translation functions are pure: shallow-copy input, transform, return. No mutations of original body.
- Provider-specific params go into `providerOptions.{provider}.*` (Vercel's format)
- `reasoning.max_tokens` and `reasoning.effort` are mutually exclusive in Vercel's API — translation logic handles this
- Anthropic error responses use `{ type: "error", error: { ... } }` format (different from OpenAI's `{ error: { ... } }`)
