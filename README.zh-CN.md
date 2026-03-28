# vercel-ai-gateway-openai

[English](README.md) | **中文**

OpenAI 兼容代理，用于 [Vercel AI Gateway](https://vercel.com/ai-gateway) —— 用标准 OpenAI API 格式访问 Claude、Gemini、Grok 等 100+ 模型。

Vercel AI Gateway 提供了统一的 API 来访问数百个 AI 模型，但它使用非标准的参数格式（例如用 `reasoning` 对象代替 `reasoning_effort`，用 `providerOptions` 传递各厂商特有参数）。本代理将标准 OpenAI API 参数自动翻译为 Vercel AI Gateway 所需的格式，让你可以直接使用任何 OpenAI 兼容客户端而无需做任何适配。

## 特性

- **标准 OpenAI API** —— 兼容任何 OpenAI 格式客户端（Cherry Studio、Chatbox、Open WebUI 等）
- **模型名自动补全** —— 直接写 `claude-sonnet-4.6`，自动补全为 `anthropic/claude-sonnet-4.6`
- **思考/推理参数翻译** —— 支持 `reasoning_effort`、`thinking`、`thinking_budget` 以及 Anthropic SDK 格式，统一翻译为 Vercel 的 `reasoning` 对象
- **图片生成参数归一化** —— `size`、`width`/`height`、`aspect_ratio`、`resolution` 根据目标模型自动转换（DALL-E、Flux、Imagen、Grok）
- **Gemini 分辨率别名** —— 在模型名后加 `-2k` / `-4k` 即可输出更高分辨率的图片
- **请求体清洗** —— 自动清除部分客户端发送的 `"[undefined]"` 无效值
- **流式传输** —— 完整 SSE 透传
- **CORS 支持** —— 可从浏览器端客户端直接调用
- **几乎零依赖**（仅 `dotenv`）

## 快速开始

```bash
git clone https://github.com/hibiyaQAQ/vercel-ai-gateway-openai.git
cd vercel-ai-gateway-openai
npm install
cp .env.example .env
# 编辑 .env，填入你的 AI_GATEWAY_API_KEY
npm run dev
```

然后将客户端的 base URL 指向 `http://localhost:3000/v1`。

## 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `AI_GATEWAY_API_KEY` | _(必填)_ | Vercel AI Gateway API Key |
| `GATEWAY_BASE_URL` | `https://ai-gateway.vercel.sh` | 上游网关地址 |
| `PORT` | `3000` | 本地服务端口 |

## 使用方法

### 接入任意 OpenAI 客户端

将 base URL 设为 `http://localhost:3000/v1`，API Key 填入你的 Vercel AI Gateway Key。

**Python：**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="your-vercel-ai-gateway-key"
)

response = client.chat.completions.create(
    model="claude-sonnet-4.6",  # 自动补全为 anthropic/claude-sonnet-4.6
    messages=[{"role": "user", "content": "你好！"}]
)
```

**cURL：**

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gemini-3-pro", "messages": [{"role": "user", "content": "你好！"}]}'
```

### 模型名自动补全

无需手动输入 `provider/model` 格式，代理会自动识别厂商并补全前缀：

| 你输入的 | 发送给 Vercel 的 |
|---|---|
| `claude-sonnet-4.6` | `anthropic/claude-sonnet-4.6` |
| `gpt-4o` | `openai/gpt-4o` |
| `gemini-3-pro` | `google/gemini-3-pro` |
| `grok-4` | `xai/grok-4` |
| `flux-2-pro` | `bfl/flux-2-pro` |
| `deepseek-r1` | `deepseek/deepseek-r1` |

已有前缀的模型名（如 `anthropic/claude-sonnet-4.6`）会直接透传，不做修改。

## 参数翻译

### 推理 / 思考

支持多种格式，统一转换为 Vercel 的 `reasoning` 对象：

```jsonc
// 1. OpenAI 标准格式
{ "reasoning_effort": "high" }
// → { "reasoning": { "effort": "high", "enabled": true } }

// 2. Anthropic SDK 格式（许多客户端使用此格式）
{ "thinking": { "type": "enabled", "budget_tokens": 28800 } }
// → { "reasoning": { "max_tokens": 28800, "enabled": true } }

// 3. 驼峰写法
{ "thinking": { "type": "enabled", "budgetTokens": 16000 } }
// → { "reasoning": { "max_tokens": 16000, "enabled": true } }

// 4. 简写
{ "thinking_budget": 5000 }
// → { "reasoning": { "max_tokens": 5000, "enabled": true } }

// 5. providerOptions.anthropic.thinking（Cherry Studio 风格）
{ "providerOptions": { "anthropic": { "thinking": { "type": "enabled", "budgetTokens": 16000 } } } }
// → { "reasoning": { "max_tokens": 16000, "enabled": true } }

// 6. Vercel 原生格式 —— 直接透传
{ "reasoning": { "max_tokens": 2000, "enabled": true } }
```

### 图片生成 —— 分辨率

代理根据各厂商模型的能力自动转换分辨率参数：

| 参数 | DALL-E | Flux (BFL) | Imagen (Google) | Grok (xAI) |
|---|---|---|---|---|
| `size: "1024x768"` | 保持原样 | → `width`+`height` | → `aspectRatio` | → `aspectRatio` |
| `width` + `height` | → `size` | → `width`+`height` | → `aspectRatio` | → `aspectRatio` |
| `aspect_ratio: "16:9"` | — | → `width`+`height` | → `aspectRatio` | → `aspectRatio` |
| `resolution: "1920x1080"` | → `size` | → `width`+`height` | → `aspectRatio` | → `aspectRatio` |

### 图片生成 —— Gemini 图片分辨率

Gemini 模型通过 `imageSize` 控制输出分辨率，支持 `512`、`1K`、`2K`、`4K`。

**方式一：模型名后缀**

在模型名末尾加 `-2k` 或 `-4k`：

```json
{ "model": "google/gemini-3.1-flash-image-preview-2k" }
```

代理会自动剥离后缀，并设置 `providerOptions.google.imageConfig.imageSize = "2K"`。

**方式二：参数**

```json
{
  "model": "google/gemini-3.1-flash-image-preview",
  "imageSize": "2k",
  "aspect_ratio": "16:9"
}
```

`imageSize` 和 `aspect_ratio` 均映射到 `providerOptions.google.imageConfig`。

### 其他便捷参数

| 参数 | 翻译为 |
|---|---|
| `provider_order: ["vertex", "anthropic"]` | `providerOptions.gateway.order` |
| `fallback_models: ["anthropic/claude-sonnet-4.6"]` | `models`（Vercel 模型回退） |
| `reasoning_exclude: true` | `reasoning.exclude` |

## 支持的端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/v1/chat/completions` | POST | 对话补全（支持流式和非流式） |
| `/v1/images/generations` | POST | 图片生成 |
| `/v1/embeddings` | POST | 向量嵌入 |
| `/v1/models` | GET | 列出可用模型 |
| `/v1/models/{id}` | GET | 获取模型信息 |
| `/health` | GET | 健康检查 |

## 生产构建

```bash
npm run build
npm start
```

## 环境要求

- Node.js >= 18
- [Vercel AI Gateway](https://vercel.com/ai-gateway) API Key

## 许可证

[MIT](LICENSE)
