// Anthropic Messages API ↔ OpenAI Chat Completions API format conversion
// Used when Blink gateway (OpenAI-only) receives Anthropic-format requests

import { addProviderPrefix } from './translate.js';

// ─── Request: Anthropic → OpenAI ───

export function anthropicRequestToOpenAI(body: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};

  // Model with provider prefix
  if (body.model) {
    result.model = addProviderPrefix(body.model);
  }

  // Convert messages (system + messages array)
  result.messages = convertMessages(body.messages || [], body.system);

  // max_tokens → max_tokens (pass through)
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;

  // temperature, top_p → pass through
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;

  // stop_sequences → stop
  if (body.stop_sequences) result.stop = body.stop_sequences;

  // stream
  if (body.stream !== undefined) {
    result.stream = body.stream;
    if (body.stream) {
      result.stream_options = { include_usage: true };
    }
  }

  // Tools
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = convertTools(body.tools);
  }

  // Tool choice
  if (body.tool_choice !== undefined) {
    result.tool_choice = convertToolChoice(body.tool_choice);
  }

  // thinking → reasoning object
  if (body.thinking && typeof body.thinking === 'object') {
    if (body.thinking.type === 'adaptive') {
      // New format: adaptive thinking — let the gateway decide budget
      result.reasoning = { enabled: true };
    } else if (body.thinking.type === 'enabled') {
      const budget = body.thinking.budget_tokens ?? body.thinking.budgetTokens;
      if (budget !== undefined) {
        result.reasoning = { max_tokens: budget, enabled: true };
      } else {
        result.reasoning = { enabled: true };
      }
    }
  }

  // cache_control in system/messages → providerOptions.gateway.caching: 'auto'
  // Vercel and Blink both use this nested format
  if (hasCacheControl(body)) {
    if (!result.providerOptions) result.providerOptions = {};
    if (!result.providerOptions.gateway) result.providerOptions.gateway = {};
    result.providerOptions.gateway.caching = 'auto';
  }

  // metadata, top_k → drop

  return result;
}

// Check if any part of the request contains cache_control
function hasCacheControl(body: Record<string, any>): boolean {
  // Check system array
  if (Array.isArray(body.system)) {
    if (body.system.some((b: any) => b.cache_control)) return true;
  }
  // Check tools array (Claude Code puts cache_control on the last tool)
  if (Array.isArray(body.tools)) {
    if (body.tools.some((t: any) => t.cache_control)) return true;
  }
  // Check messages
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (Array.isArray(msg.content)) {
        if (msg.content.some((b: any) => b.cache_control)) return true;
      }
    }
  }
  return false;
}

// ─── Message Conversion ───

function convertMessages(
  messages: any[],
  system?: string | any[],
): any[] {
  const result: any[] = [];

  // System prompt → system role message
  if (system) {
    if (typeof system === 'string') {
      result.push({ role: 'system', content: system });
    } else if (Array.isArray(system)) {
      // Array of content blocks — extract text
      const text = system
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n\n');
      if (text) result.push({ role: 'system', content: text });
    }
  }

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      result.push(convertAssistantMessage(msg));
    } else if (msg.role === 'user') {
      // User messages may contain tool_result blocks that need to be split out
      const converted = convertUserMessage(msg);
      result.push(...converted);
    } else {
      // Pass through unknown roles
      result.push(msg);
    }
  }

  return result;
}

function convertAssistantMessage(msg: any): any {
  // Simple string content
  if (typeof msg.content === 'string') {
    return { role: 'assistant', content: msg.content };
  }

  if (!Array.isArray(msg.content)) {
    return { role: 'assistant', content: msg.content ?? null };
  }

  // Array of content blocks: extract text and tool_use
  let textParts: string[] = [];
  const toolCalls: any[] = [];

  for (const block of msg.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
        },
      });
    }
    // thinking, redacted_thinking → skip
  }

  const result: any = { role: 'assistant' };
  result.content = textParts.length > 0 ? textParts.join('') : null;
  if (toolCalls.length > 0) {
    result.tool_calls = toolCalls;
  }
  return result;
}

function convertUserMessage(msg: any): any[] {
  // Simple string content
  if (typeof msg.content === 'string') {
    return [{ role: 'user', content: msg.content }];
  }

  if (!Array.isArray(msg.content)) {
    return [{ role: 'user', content: msg.content }];
  }

  // Split content blocks into tool_result messages and regular content
  const toolResults: any[] = [];
  const contentParts: any[] = [];

  for (const block of msg.content) {
    if (block.type === 'tool_result') {
      toolResults.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: extractToolResultContent(block.content),
      });
    } else if (block.type === 'text') {
      contentParts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      contentParts.push(convertImageBlock(block));
    } else {
      contentParts.push(block);
    }
  }

  const result: any[] = [];

  // Tool result messages first
  result.push(...toolResults);

  // Then remaining user content
  if (contentParts.length > 0) {
    // If only text parts, simplify to string
    if (contentParts.length === 1 && contentParts[0].type === 'text') {
      result.push({ role: 'user', content: contentParts[0].text });
    } else {
      result.push({ role: 'user', content: contentParts });
    }
  }

  return result;
}

function extractToolResultContent(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
  }
  return String(content ?? '');
}

function convertImageBlock(block: any): any {
  const source = block.source;
  if (!source) return block;

  if (source.type === 'base64') {
    return {
      type: 'image_url',
      image_url: {
        url: `data:${source.media_type};base64,${source.data}`,
      },
    };
  }
  if (source.type === 'url') {
    return {
      type: 'image_url',
      image_url: { url: source.url },
    };
  }
  return block;
}

// ─── Tool Conversion ───

function convertTools(tools: any[]): any[] {
  return tools
    .filter((t: any) => t.name && t.input_schema) // skip built-in tools like web_search
    .map((t: any) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema,
      },
    }));
}

function convertToolChoice(choice: any): any {
  if (typeof choice === 'string') return choice;
  if (!choice || typeof choice !== 'object') return 'auto';

  switch (choice.type) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool':
      return { type: 'function', function: { name: choice.name } };
    default:
      return 'auto';
  }
}

// ─── Response: OpenAI → Anthropic (non-streaming) ───

export function openAIResponseToAnthropic(
  openai: Record<string, any>,
  requestModel: string,
): Record<string, any> {
  const choice = openai.choices?.[0];
  const message = choice?.message;

  // Build content blocks
  const content: any[] = [];

  if (message) {
    // Case 1: content is an array of content parts (some providers return thinking as parts)
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'thinking' || part.type === 'reasoning') {
          content.push({ type: 'thinking', thinking: part.thinking ?? part.text ?? part.content ?? '' });
        } else if (part.type === 'text') {
          content.push({ type: 'text', text: part.text ?? '' });
        }
        // tool_use parts handled below via tool_calls
      }
    } else {
      // Case 2: separate fields for reasoning and text
      // reasoning_content / thinking_content → thinking block (must come before text)
      const thinkingText = message.reasoning ?? message.reasoning_content ?? message.thinking_content ?? message.thinking ?? null;
      if (thinkingText) {
        // Extract signature from reasoning_details if present (Blink format)
        const signature = extractSignature(message.reasoning_details);
        const thinkingBlock: any = { type: 'thinking', thinking: thinkingText };
        if (signature) thinkingBlock.signature = signature;
        content.push(thinkingBlock);
      }
      if (message.content) {
        content.push({ type: 'text', text: message.content });
      }
    }

    if (message.tool_calls && Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        let input: any = {};
        try {
          input = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          input = {};
        }
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name || '',
          input,
        });
      }
    }
  }

  // If no content at all, add empty text block
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  return {
    id: `msg_${openai.id || 'proxy'}`,
    type: 'message',
    role: 'assistant',
    model: requestModel,
    content,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openai.usage?.prompt_tokens || 0,
      output_tokens: openai.usage?.completion_tokens || 0,
      // Cache tokens: Blink puts these in choices[0].message.provider_metadata
      cache_creation_input_tokens: choice?.message?.provider_metadata?.anthropic?.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: choice?.message?.provider_metadata?.anthropic?.usage?.cache_read_input_tokens ?? 0,
    },
  };
}

// Extract signature from reasoning_details array (Blink format)
function extractSignature(reasoningDetails: any): string | null {
  if (!Array.isArray(reasoningDetails)) return null;
  for (const detail of reasoningDetails) {
    if (detail.signature) return detail.signature;
  }
  return null;
}

function mapFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'content_filter': return 'end_turn';
    default: return 'end_turn';
  }
}

// ─── Streaming: OpenAI SSE → Anthropic SSE ───

function formatSSE(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class OpenAIToAnthropicStreamTransformer {
  private model: string;
  private messageStarted = false;
  private currentBlockIndex = -1;
  private currentBlockType: 'thinking' | 'text' | 'tool_use' | null = null;
  private toolCallMap = new Map<number, { id: string; name: string }>(); // OpenAI tool_calls index → id/name
  private finishReason: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheCreationTokens = 0;
  private cacheReadTokens = 0;
  private buffer = '';
  private pendingSignature: string | null = null; // accumulated signature for current thinking block

  constructor(model: string) {
    this.model = model;
  }

  /** Feed raw SSE text from upstream, returns Anthropic SSE lines to emit */
  processChunk(rawText: string): string[] {
    this.buffer += rawText;
    const output: string[] = [];

    // Split on double newline to get complete SSE events
    const parts = this.buffer.split('\n\n');
    this.buffer = parts.pop()!; // keep incomplete part

    for (const part of parts) {
      if (!part.trim()) continue;
      const lines = part.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          output.push(...this.processDataLine(data));
        }
      }
    }

    return output;
  }

  /** Call when upstream is done to emit any remaining events */
  flush(): string[] {
    const output: string[] = [];

    // Process any remaining buffer
    if (this.buffer.trim()) {
      const lines = this.buffer.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          output.push(...this.processDataLine(line.slice(6).trim()));
        }
      }
      this.buffer = '';
    }

    // Close any open block
    if (this.currentBlockType !== null) {
      output.push(formatSSE('content_block_stop', {
        type: 'content_block_stop',
        index: this.currentBlockIndex,
      }));
      this.currentBlockType = null;
    }

    // Emit message_delta and message_stop if message was started
    if (this.messageStarted) {
      output.push(formatSSE('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: mapFinishReason(this.finishReason),
          stop_sequence: null,
        },
        usage: {
          output_tokens: this.outputTokens,
          cache_creation_input_tokens: this.cacheCreationTokens,
          cache_read_input_tokens: this.cacheReadTokens,
        },
      }));
      output.push(formatSSE('message_stop', { type: 'message_stop' }));
    }

    return output;
  }

  private processDataLine(data: string): string[] {
    if (data === '[DONE]') {
      return this.flush();
    }

    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return [];
    }

    const output: string[] = [];

    // Emit message_start on first chunk
    if (!this.messageStarted) {
      this.messageStarted = true;
      output.push(formatSSE('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${parsed.id || 'proxy'}`,
          type: 'message',
          role: 'assistant',
          content: [],
          model: this.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));
      output.push(formatSSE('ping', { type: 'ping' }));
    }

    const choice = parsed.choices?.[0];
    if (!choice) {
      // Usage-only chunk (with stream_options.include_usage)
      if (parsed.usage) {
        this.inputTokens = parsed.usage.prompt_tokens || 0;
        this.outputTokens = parsed.usage.completion_tokens || 0;
      }
      return output;
    }

    const delta = choice.delta;
    if (choice.finish_reason) {
      this.finishReason = choice.finish_reason;
    }

    // Extract usage if present (prompt_tokens / completion_tokens from top-level or choice)
    const usageSrc = parsed.usage || choice.usage;
    if (usageSrc) {
      this.inputTokens = usageSrc.prompt_tokens || this.inputTokens;
      this.outputTokens = usageSrc.completion_tokens || this.outputTokens;
    }
    // Cache tokens: Blink puts them in delta.provider_metadata or choice.delta.provider_metadata
    const provMeta = delta?.provider_metadata ?? choice.delta?.provider_metadata;
    if (provMeta?.anthropic?.usage) {
      const u = provMeta.anthropic.usage;
      this.cacheCreationTokens = u.cache_creation_input_tokens ?? this.cacheCreationTokens;
      this.cacheReadTokens = u.cache_read_input_tokens ?? this.cacheReadTokens;
    }

    if (!delta) return output;

    // reasoning_content / thinking_content delta → thinking block (must come before text)
    const thinkingDelta = delta.reasoning ?? delta.reasoning_content ?? delta.thinking_content ?? delta.thinking ?? null;
    if (thinkingDelta != null && thinkingDelta !== '') {
      if (this.currentBlockType !== 'thinking') {
        output.push(...this.closeCurrentBlock());
        this.currentBlockIndex++;
        this.currentBlockType = 'thinking';
        output.push(formatSSE('content_block_start', {
          type: 'content_block_start',
          index: this.currentBlockIndex,
          content_block: { type: 'thinking', thinking: '' },
        }));
      }
      output.push(formatSSE('content_block_delta', {
        type: 'content_block_delta',
        index: this.currentBlockIndex,
        delta: { type: 'thinking_delta', thinking: thinkingDelta },
      }));
    }

    // reasoning_details signature (Blink streams this alongside or after reasoning text)
    if (delta.reasoning_details && Array.isArray(delta.reasoning_details)) {
      const sig = extractSignature(delta.reasoning_details);
      if (sig) this.pendingSignature = sig;
    }

    // Text content delta
    if (delta.content != null && delta.content !== '') {
      if (this.currentBlockType !== 'text') {
        // Close previous block if any
        output.push(...this.closeCurrentBlock());
        // Start new text block
        this.currentBlockIndex++;
        this.currentBlockType = 'text';
        output.push(formatSSE('content_block_start', {
          type: 'content_block_start',
          index: this.currentBlockIndex,
          content_block: { type: 'text', text: '' },
        }));
      }
      output.push(formatSSE('content_block_delta', {
        type: 'content_block_delta',
        index: this.currentBlockIndex,
        delta: { type: 'text_delta', text: delta.content },
      }));
    }

    // Tool calls delta
    if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const tcIndex = tc.index ?? 0;

        if (tc.id && tc.function?.name) {
          // New tool call — close previous block, start new tool_use block
          output.push(...this.closeCurrentBlock());
          this.currentBlockIndex++;
          this.currentBlockType = 'tool_use';
          this.toolCallMap.set(tcIndex, { id: tc.id, name: tc.function.name });

          output.push(formatSSE('content_block_start', {
            type: 'content_block_start',
            index: this.currentBlockIndex,
            content_block: {
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: {},
            },
          }));
        }

        // Arguments fragment
        if (tc.function?.arguments) {
          output.push(formatSSE('content_block_delta', {
            type: 'content_block_delta',
            index: this.currentBlockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: tc.function.arguments,
            },
          }));
        }
      }
    }

    return output;
  }

  private closeCurrentBlock(): string[] {
    if (this.currentBlockType === null) return [];
    const output: string[] = [];
    // Emit signature_delta before closing a thinking block
    if (this.currentBlockType === 'thinking' && this.pendingSignature) {
      output.push(formatSSE('content_block_delta', {
        type: 'content_block_delta',
        index: this.currentBlockIndex,
        delta: { type: 'signature_delta', signature: this.pendingSignature },
      }));
      this.pendingSignature = null;
    }
    output.push(formatSSE('content_block_stop', {
      type: 'content_block_stop',
      index: this.currentBlockIndex,
    }));
    this.currentBlockType = null;
    return output;
  }
}
