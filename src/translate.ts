// Model name auto-detection: adds provider prefix if missing
// e.g. "claude-sonnet-4.6" → "anthropic/claude-sonnet-4.6"

const MODEL_PREFIXES: [string, string][] = [
  // OpenAI
  ['gpt-', 'openai'],
  ['o1', 'openai'],
  ['o3', 'openai'],
  ['o4', 'openai'],
  ['dall-e', 'openai'],
  ['text-embedding', 'openai'],
  ['tts', 'openai'],
  ['whisper', 'openai'],
  // Anthropic
  ['claude-', 'anthropic'],
  // Google
  ['gemini-', 'google'],
  ['imagen-', 'google'],
  ['veo-', 'google'],
  // xAI
  ['grok-', 'xai'],
  // Black Forest Labs
  ['flux-', 'bfl'],
  // Meta
  ['llama-', 'meta'],
  // Mistral
  ['mistral-', 'mistral'],
  ['codestral', 'mistral'],
  ['pixtral', 'mistral'],
  // Deepseek
  ['deepseek-', 'deepseek'],
  // Cohere
  ['command-', 'cohere'],
  // Perplexity
  ['sonar-', 'perplexity'],
];

export function addProviderPrefix(model: string): string {
  if (model.includes('/')) return model;
  for (const [prefix, provider] of MODEL_PREFIXES) {
    if (model.startsWith(prefix)) {
      return `${provider}/${model}`;
    }
  }
  return model;
}

// ─── Gemini image model alias ───
// Strips resolution suffix (-2k, -4k) from model name and returns the imageSize value.
// e.g. "google/gemini-3.1-flash-image-preview-2k" → { model: "google/gemini-3.1-flash-image-preview", imageSize: "2K" }
const GEMINI_SIZE_SUFFIXES: Record<string, string> = {
  '-512': '512',
  '-1k': '1K',
  '-2k': '2K',
  '-4k': '4K',
};

function extractGeminiImageSize(model: string): { model: string; imageSize: string | null } {
  const lower = model.toLowerCase();
  for (const [suffix, size] of Object.entries(GEMINI_SIZE_SUFFIXES)) {
    if (lower.endsWith(suffix)) {
      return { model: model.slice(0, -suffix.length), imageSize: size };
    }
  }
  return { model, imageSize: null };
}

// Set Gemini imageConfig in providerOptions.google.imageConfig
function applyGeminiImageConfig(t: Record<string, any>, imageSize?: string | null, aspectRatio?: string | null) {
  if (!imageSize && !aspectRatio) return;
  if (!t.providerOptions) t.providerOptions = {};
  if (!t.providerOptions.google) t.providerOptions.google = {};
  if (!t.providerOptions.google.imageConfig) t.providerOptions.google.imageConfig = {};
  const cfg = t.providerOptions.google.imageConfig;
  if (imageSize) cfg.imageSize = cfg.imageSize ?? imageSize;
  if (aspectRatio) cfg.aspectRatio = cfg.aspectRatio ?? aspectRatio;
}

function isGeminiModel(model: string): boolean {
  return model.toLowerCase().includes('gemini');
}

function normalizeImageSize(raw: string): string {
  const upper = raw.toUpperCase();
  // Accept "2k", "2K", "4k", "4K", "1k", "1K", "512"
  if (['512', '1K', '2K', '4K'].includes(upper)) return upper;
  return raw;
}

// ─── Aspect ratio helpers ───

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function sizeToAspectRatio(size: string): string {
  const parts = size.split('x');
  if (parts.length !== 2) return '1:1';
  const w = parseInt(parts[0]);
  const h = parseInt(parts[1]);
  if (isNaN(w) || isNaN(h)) return '1:1';
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}

type ImageProvider = 'googleVertex' | 'blackForestLabs' | 'xai' | 'openai';

interface ImageProviderCaps {
  key: ImageProvider;
  supportsSize: boolean;       // native OpenAI `size` param ("WxH")
  supportsWidthHeight: boolean; // width + height in pixels
  supportsAspectRatio: boolean; // aspectRatio like "16:9"
}

const IMAGE_PROVIDER_CAPS: Record<ImageProvider, ImageProviderCaps> = {
  openai:          { key: 'openai',          supportsSize: true,  supportsWidthHeight: false, supportsAspectRatio: false },
  blackForestLabs: { key: 'blackForestLabs', supportsSize: false, supportsWidthHeight: true,  supportsAspectRatio: false },
  googleVertex:    { key: 'googleVertex',    supportsSize: false, supportsWidthHeight: false, supportsAspectRatio: true  },
  xai:             { key: 'xai',             supportsSize: false, supportsWidthHeight: false, supportsAspectRatio: true  },
};

function detectImageProvider(model: string): ImageProviderCaps | null {
  const lower = model.toLowerCase();
  if (lower.includes('dall-e'))        return IMAGE_PROVIDER_CAPS.openai;
  if (lower.includes('flux'))          return IMAGE_PROVIDER_CAPS.blackForestLabs;
  if (lower.includes('imagen') || lower.includes('gemini')) return IMAGE_PROVIDER_CAPS.googleVertex;
  if (lower.includes('grok-imagine'))  return IMAGE_PROVIDER_CAPS.xai;
  return null;
}

function parseSize(size: string): { w: number; h: number } | null {
  const parts = size.split('x');
  if (parts.length !== 2) return null;
  const w = parseInt(parts[0]);
  const h = parseInt(parts[1]);
  if (isNaN(w) || isNaN(h)) return null;
  return { w, h };
}

function ensureProviderOpts(t: Record<string, any>, key: string): Record<string, any> {
  if (!t.providerOptions) t.providerOptions = {};
  if (!t.providerOptions[key]) t.providerOptions[key] = {};
  return t.providerOptions[key];
}

// ─── Chat Completions translation ───

export function translateChatRequest(body: Record<string, any>): Record<string, any> {
  const t = { ...body };

  // 1. Model prefix
  if (t.model) {
    t.model = addProviderPrefix(t.model);
  }

  // 2. Gemini image model alias: strip -2k/-4k suffix → set imageSize
  if (t.model) {
    const { model, imageSize } = extractGeminiImageSize(t.model);
    if (imageSize) {
      t.model = model;
      applyGeminiImageConfig(t, imageSize);
    }
  }

  // 3. imageSize param → providerOptions.google.imageConfig.imageSize
  //    For Gemini models generating images via chat completions
  if (t.imageSize !== undefined) {
    if (isGeminiModel(t.model || '')) {
      applyGeminiImageConfig(t, normalizeImageSize(t.imageSize));
    }
    delete t.imageSize;
  }

  // 4. aspect_ratio param → providerOptions.google.imageConfig.aspectRatio (for Gemini)
  if (t.aspect_ratio !== undefined && isGeminiModel(t.model || '')) {
    applyGeminiImageConfig(t, null, t.aspect_ratio);
    delete t.aspect_ratio;
  }

  // 5. thinking object (Anthropic SDK format used by many clients)
  //    { type: "enabled", budget_tokens: 28800 } → reasoning: { max_tokens: 28800, enabled: true }
  //    Also handles budgetTokens (camelCase variant)
  if (t.thinking && typeof t.thinking === 'object' && t.thinking.type === 'enabled') {
    const budget = t.thinking.budget_tokens ?? t.thinking.budgetTokens;
    if (budget !== undefined) {
      if (!t.reasoning) t.reasoning = {};
      t.reasoning.max_tokens = budget;
      t.reasoning.enabled = true;
      delete t.reasoning.effort;
    }
    delete t.thinking;
  }

  // 6. reasoning_effort (OpenAI standard) → reasoning object (Vercel)
  //    OpenAI: reasoning_effort: "low" | "medium" | "high"
  //    Vercel: reasoning: { effort, enabled, max_tokens, exclude }
  if (t.reasoning_effort !== undefined) {
    if (!t.reasoning) t.reasoning = {};
    t.reasoning.effort = t.reasoning_effort;
    if (t.reasoning_effort !== 'none') {
      t.reasoning.enabled = true;
    }
    delete t.reasoning_effort;
  }

  // 7. thinking_budget (custom param for Claude extended thinking)
  //    → reasoning.max_tokens
  if (t.thinking_budget !== undefined) {
    if (!t.reasoning) t.reasoning = {};
    t.reasoning.max_tokens = t.thinking_budget;
    t.reasoning.enabled = true;
    // max_tokens and effort are mutually exclusive in Vercel
    delete t.reasoning.effort;
    delete t.thinking_budget;
  }

  // 7. reasoning_exclude → reasoning.exclude
  if (t.reasoning_exclude !== undefined) {
    if (!t.reasoning) t.reasoning = {};
    t.reasoning.exclude = t.reasoning_exclude;
    delete t.reasoning_exclude;
  }

  // 8. provider_order → providerOptions.gateway.order
  if (t.provider_order !== undefined) {
    if (!t.providerOptions) t.providerOptions = {};
    if (!t.providerOptions.gateway) t.providerOptions.gateway = {};
    t.providerOptions.gateway.order = t.provider_order;
    delete t.provider_order;
  }

  // 9. fallback_models → models (Vercel's model fallback field)
  if (t.fallback_models !== undefined) {
    t.models = t.fallback_models;
    delete t.fallback_models;
  }

  // 10. web_search (convenience flag)
  if (t.web_search !== undefined) {
    delete t.web_search;
  }

  // 11. providerOptions.anthropic.thinking → reasoning (normalize to Vercel format)
  //     Some clients put thinking config inside providerOptions.anthropic
  const anthThinking = t.providerOptions?.anthropic?.thinking;
  if (anthThinking && typeof anthThinking === 'object' && anthThinking.type === 'enabled') {
    const budget = anthThinking.budget_tokens ?? anthThinking.budgetTokens;
    if (budget !== undefined) {
      if (!t.reasoning) t.reasoning = {};
      t.reasoning.max_tokens = t.reasoning.max_tokens ?? budget;
      t.reasoning.enabled = true;
      delete t.reasoning.effort;
    }
    delete t.providerOptions.anthropic.thinking;
    // Clean up empty objects
    if (Object.keys(t.providerOptions.anthropic).length === 0) delete t.providerOptions.anthropic;
    if (Object.keys(t.providerOptions).length === 0) delete t.providerOptions;
  }

  return t;
}

export function translateImageRequest(body: Record<string, any>): Record<string, any> {
  const t = { ...body };

  // 1. Model prefix
  if (t.model) {
    t.model = addProviderPrefix(t.model);
  }

  // 2. Gemini image model alias: strip -2k/-4k suffix → set imageSize
  if (t.model) {
    const { model, imageSize } = extractGeminiImageSize(t.model);
    if (imageSize) {
      t.model = model;
      applyGeminiImageConfig(t, imageSize);
    }
  }

  // 3. imageSize param → providerOptions.google.imageConfig.imageSize (Gemini/Imagen)
  if (t.imageSize !== undefined) {
    if (isGeminiModel(t.model || '') || (t.model || '').toLowerCase().includes('imagen')) {
      applyGeminiImageConfig(t, normalizeImageSize(t.imageSize));
    }
    delete t.imageSize;
  }

  const caps = detectImageProvider(t.model || '');

  // 2. size ("WxH") — the standard OpenAI images API param
  //    - DALL-E: keep as-is (native)
  //    - Flux:   → providerOptions.blackForestLabs.width + .height
  //    - Imagen: → providerOptions.googleVertex.aspectRatio (ratio only)
  //    - xAI:    → providerOptions.xai.aspectRatio (ratio only)
  if (t.size && caps) {
    const parsed = parseSize(t.size);
    if (parsed) {
      if (caps.supportsSize) {
        // DALL-E: keep size as-is
      } else if (caps.supportsWidthHeight) {
        const opts = ensureProviderOpts(t, caps.key);
        opts.width = opts.width ?? parsed.w;
        opts.height = opts.height ?? parsed.h;
        delete t.size;
      } else if (caps.supportsAspectRatio) {
        const opts = ensureProviderOpts(t, caps.key);
        opts.aspectRatio = opts.aspectRatio ?? sizeToAspectRatio(t.size);
        delete t.size;
      }
    }
  }

  // 3. width + height (convenience params, not standard OpenAI)
  //    - Flux: → providerOptions.blackForestLabs.width/height
  //    - Imagen/xAI: → compute aspectRatio
  //    - DALL-E: → convert to size string
  if ((t.width !== undefined || t.height !== undefined) && caps) {
    const w = t.width as number | undefined;
    const h = t.height as number | undefined;

    if (caps.supportsWidthHeight) {
      const opts = ensureProviderOpts(t, caps.key);
      if (w !== undefined) opts.width = opts.width ?? w;
      if (h !== undefined) opts.height = opts.height ?? h;
    } else if (caps.supportsAspectRatio && w && h) {
      const opts = ensureProviderOpts(t, caps.key);
      opts.aspectRatio = opts.aspectRatio ?? sizeToAspectRatio(`${w}x${h}`);
    } else if (caps.supportsSize && w && h) {
      t.size = t.size ?? `${w}x${h}`;
    }
    delete t.width;
    delete t.height;
  }

  // 4. aspect_ratio (convenience param) → providerOptions.{provider}.aspectRatio
  if (t.aspect_ratio && caps) {
    if (caps.supportsAspectRatio) {
      const opts = ensureProviderOpts(t, caps.key);
      opts.aspectRatio = opts.aspectRatio ?? t.aspect_ratio;
    } else if (caps.supportsWidthHeight) {
      // Convert aspect ratio to pixels (default to 1024 on the longer side)
      const ratioParts = (t.aspect_ratio as string).split(':').map(Number);
      if (ratioParts.length === 2 && ratioParts[0] > 0 && ratioParts[1] > 0) {
        const [rw, rh] = ratioParts;
        const maxDim = 1024;
        const opts = ensureProviderOpts(t, caps.key);
        if (rw >= rh) {
          opts.width = opts.width ?? maxDim;
          opts.height = opts.height ?? Math.round(maxDim * rh / rw);
        } else {
          opts.height = opts.height ?? maxDim;
          opts.width = opts.width ?? Math.round(maxDim * rw / rh);
        }
      }
    }
    delete t.aspect_ratio;
  }

  // 5. resolution ("WxH") — alias for size, useful for non-DALL-E models
  if (t.resolution) {
    const parsed = parseSize(t.resolution as string);
    if (parsed && caps) {
      if (caps.supportsWidthHeight) {
        const opts = ensureProviderOpts(t, caps.key);
        opts.width = opts.width ?? parsed.w;
        opts.height = opts.height ?? parsed.h;
      } else if (caps.supportsAspectRatio) {
        const opts = ensureProviderOpts(t, caps.key);
        opts.aspectRatio = opts.aspectRatio ?? sizeToAspectRatio(t.resolution as string);
      } else if (caps.supportsSize) {
        t.size = t.size ?? t.resolution;
      }
    }
    delete t.resolution;
  }

  return t;
}

// ─── Anthropic Messages API translation ───

export function translateMessagesRequest(body: Record<string, any>): Record<string, any> {
  const t = { ...body };

  // Add provider prefix to model name
  if (t.model) {
    t.model = addProviderPrefix(t.model);
  }

  return t;
}

// ─── Embeddings translation ───

export function translateEmbeddingRequest(body: Record<string, any>): Record<string, any> {
  const t = { ...body };
  if (t.model) {
    t.model = addProviderPrefix(t.model);
  }
  return t;
}
