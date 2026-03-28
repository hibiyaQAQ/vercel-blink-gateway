# vercel-ai-gateway-openai

**English** | [中文](README.zh-CN.md)

OpenAI-compatible proxy for [Vercel AI Gateway](https://vercel.com/ai-gateway) — use standard OpenAI API format to access Claude, Gemini, Grok and 100+ models.

Vercel AI Gateway is a unified API to access hundreds of AI models through a single endpoint. However, it uses non-standard parameter formats (e.g. `reasoning` object instead of `reasoning_effort`, `providerOptions` for provider-specific settings). This proxy translates standard OpenAI API parameters into the format Vercel AI Gateway expects, so you can use any OpenAI-compatible client without modification.

## Features

- **Standard OpenAI API** — works with any OpenAI-compatible client (Cherry Studio, Chatbox, Open WebUI, etc.)
- **Auto model prefix** — write `claude-sonnet-4.6` instead of `anthropic/claude-sonnet-4.6`
- **Thinking/reasoning translation** — supports `reasoning_effort`, `thinking`, `thinking_budget` and Anthropic SDK format, all translated to Vercel's `reasoning` object
- **Image generation normalization** — `size`, `width`/`height`, `aspect_ratio`, `resolution` are auto-converted per provider (DALL-E, Flux, Imagen, Grok)
- **Gemini image size alias** — append `-2k` / `-4k` to model name for higher resolution output
- **Request body cleanup** — strips `"[undefined]"` values sent by some clients
- **Streaming support** — full SSE pass-through
- **CORS enabled** — use from browser-based clients
- **Zero runtime dependencies** (except `dotenv`)

## Quick Start

```bash
git clone https://github.com/hibiyaQAQ/vercel-ai-gateway-openai.git
cd vercel-ai-gateway-openai
npm install
cp .env.example .env
# Edit .env and set your AI_GATEWAY_API_KEY
npm run dev
```

Then point your client to `http://localhost:3000/v1`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `AI_GATEWAY_API_KEY` | _(required)_ | Your Vercel AI Gateway API key |
| `GATEWAY_BASE_URL` | `https://ai-gateway.vercel.sh` | Upstream gateway URL |
| `PORT` | `3000` | Local server port |

## Usage

### With any OpenAI client

Set base URL to `http://localhost:3000/v1` and use your Vercel AI Gateway API key.

**Python:**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="your-vercel-ai-gateway-key"
)

response = client.chat.completions.create(
    model="claude-sonnet-4.6",  # auto-prefixed to anthropic/claude-sonnet-4.6
    messages=[{"role": "user", "content": "Hello!"}]
)
```

**cURL:**

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gemini-3-pro", "messages": [{"role": "user", "content": "Hello!"}]}'
```

### Auto Model Prefix

No need to type `provider/model` — the proxy auto-detects the provider:

| You write | Sent to Vercel |
|---|---|
| `claude-sonnet-4.6` | `anthropic/claude-sonnet-4.6` |
| `gpt-4o` | `openai/gpt-4o` |
| `gemini-3-pro` | `google/gemini-3-pro` |
| `grok-4` | `xai/grok-4` |
| `flux-2-pro` | `bfl/flux-2-pro` |
| `deepseek-r1` | `deepseek/deepseek-r1` |

Already prefixed model names (e.g. `anthropic/claude-sonnet-4.6`) are passed through as-is.

## Parameter Translation

### Reasoning / Thinking

Multiple formats are accepted and unified into Vercel's `reasoning` object:

```jsonc
// 1. OpenAI standard
{ "reasoning_effort": "high" }
// → { "reasoning": { "effort": "high", "enabled": true } }

// 2. Anthropic SDK format (used by many clients)
{ "thinking": { "type": "enabled", "budget_tokens": 28800 } }
// → { "reasoning": { "max_tokens": 28800, "enabled": true } }

// 3. camelCase variant
{ "thinking": { "type": "enabled", "budgetTokens": 16000 } }
// → { "reasoning": { "max_tokens": 16000, "enabled": true } }

// 4. Simple budget shorthand
{ "thinking_budget": 5000 }
// → { "reasoning": { "max_tokens": 5000, "enabled": true } }

// 5. providerOptions.anthropic.thinking (Cherry Studio style)
{ "providerOptions": { "anthropic": { "thinking": { "type": "enabled", "budgetTokens": 16000 } } } }
// → { "reasoning": { "max_tokens": 16000, "enabled": true } }

// 6. Vercel native format — passed through as-is
{ "reasoning": { "max_tokens": 2000, "enabled": true } }
```

### Image Generation — Resolution

The proxy normalizes resolution parameters based on each provider's capabilities:

| Parameter | DALL-E | Flux (BFL) | Imagen (Google) | Grok (xAI) |
|---|---|---|---|---|
| `size: "1024x768"` | Keep as-is | → `width`+`height` | → `aspectRatio` | → `aspectRatio` |
| `width` + `height` | → `size` | → `width`+`height` | → `aspectRatio` | → `aspectRatio` |
| `aspect_ratio: "16:9"` | — | → `width`+`height` | → `aspectRatio` | → `aspectRatio` |
| `resolution: "1920x1080"` | → `size` | → `width`+`height` | → `aspectRatio` | → `aspectRatio` |

### Image Generation — Gemini Image Size

Gemini models support `imageSize` for output resolution control (`512`, `1K`, `2K`, `4K`).

**Option 1: Model name suffix**

Append `-2k` or `-4k` to the model name:

```json
{ "model": "google/gemini-3.1-flash-image-preview-2k" }
```

The proxy strips the suffix and sets `providerOptions.google.imageConfig.imageSize = "2K"`.

**Option 2: Parameter**

```json
{
  "model": "google/gemini-3.1-flash-image-preview",
  "imageSize": "2k",
  "aspect_ratio": "16:9"
}
```

Both `imageSize` and `aspect_ratio` map to `providerOptions.google.imageConfig`.

### Other Convenience Parameters

| Parameter | Translates to |
|---|---|
| `provider_order: ["vertex", "anthropic"]` | `providerOptions.gateway.order` |
| `fallback_models: ["anthropic/claude-sonnet-4.6"]` | `models` (Vercel model fallback) |
| `reasoning_exclude: true` | `reasoning.exclude` |

## Supported Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/v1/chat/completions` | POST | Chat completions (streaming + non-streaming) |
| `/v1/images/generations` | POST | Image generation |
| `/v1/embeddings` | POST | Embeddings |
| `/v1/models` | GET | List available models |
| `/v1/models/{id}` | GET | Retrieve model info |
| `/health` | GET | Health check |

## Build for Production

```bash
npm run build
npm start
```

## Requirements

- Node.js >= 18
- A [Vercel AI Gateway](https://vercel.com/ai-gateway) API key

## License

[MIT](LICENSE)
