# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenAI-compatible proxy for Vercel AI Gateway. Translates standard OpenAI API parameters (reasoning_effort, thinking, size, etc.) into Vercel AI Gateway's non-standard format (reasoning object, providerOptions), so any OpenAI-compatible client works without modification.

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
- `PORT` (default: `3000`)

## Architecture

Two source files, both in `src/`:

**`index.ts`** — HTTP server (Node.js `http.createServer`, no framework). Routes:
- `POST /v1/chat/completions` → `translateChatRequest()` → upstream
- `POST /v1/images/generations` → `translateImageRequest()` → upstream
- `POST /v1/embeddings` → `translateEmbeddingRequest()` → upstream
- `GET /v1/models`, `/v1/models/{id}` → pass-through
- `GET /health` → local health check

Handles SSE streaming pass-through, CORS, request body cleanup (strips `"[undefined]"` values from clients like Cherry Studio), and API key extraction from Authorization header or .env.

**`translate.ts`** — Pure translation functions, no side effects:
- `addProviderPrefix()` — auto-detects provider from model name prefix (e.g. `claude-` → `anthropic/`). Mapping table `MODEL_PREFIXES` at top of file.
- `translateChatRequest()` — normalizes 6+ reasoning/thinking parameter formats into Vercel's `reasoning` object; handles Gemini image size aliases (`-2k`/`-4k` model suffix); translates `provider_order`, `fallback_models`, `reasoning_exclude`.
- `translateImageRequest()` — normalizes resolution params (`size`, `width`/`height`, `aspect_ratio`, `resolution`) per provider capabilities (DALL-E=size, Flux=width+height, Imagen/Grok=aspectRatio). Uses `IMAGE_PROVIDER_CAPS` for provider detection.
- `translateEmbeddingRequest()` — only adds provider prefix.

## Key Design Decisions

- Zero runtime dependencies beyond `dotenv` — uses Node.js built-in `http` and `fetch`
- ES module format (`"type": "module"` in package.json, ES2022 target)
- All translation functions are pure: shallow-copy input, transform, return. No mutations of original body.
- Provider-specific params go into `providerOptions.{provider}.*` (Vercel's format)
- `reasoning.max_tokens` and `reasoning.effort` are mutually exclusive in Vercel's API — translation logic handles this
