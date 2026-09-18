import type { FetchFunction } from "@earendil-works/pi-ai";

/**
 * fake 适配器（离线 canned SSE）：与真适配器同缝（FetchFunction）注册。
 *
 * 每条脚本回复渲染为确定性 SSE 帧序列：两段 content delta（钉住 delta
 * 拼接语义）→ finish chunk → usage chunk（deepseek 口径
 * prompt_cache_hit_tokens）→ [DONE]。脚本依序消费，耗尽即抛错——
 * 脚本错配是测试自身的 bug，要尽早炸出来，不能静默复用旧回复。
 */

export interface FakeUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens: number;
}

export interface FakeReply {
  readonly text: string;
  readonly usage: FakeUsage;
  /** 缺省 "stop"；错误路径脚本用（如 "content_filter" → pi-ai 映射 stopReason "error"） */
  readonly finishReason?: string;
}

export interface FakeFetchRequest {
  readonly url: string;
}

export interface FakeFetchScript {
  readonly fetch: FetchFunction;
  /** 已发出请求的只读快照（每次读取返回新数组） */
  readonly requests: readonly FakeFetchRequest[];
}

/** fake 帧里上报的模型 id（与钉住的评审模型一致；流入 AssistantMessage.model） */
const FAKE_MODEL_ID = "deepseek-v4-flash";

export function fakeFetch(replies: readonly FakeReply[]): FakeFetchScript {
  const recorded: FakeFetchRequest[] = [];
  let calls = 0;
  const fetch: FetchFunction = async (input) => {
    calls += 1;
    recorded.push({ url: normalizeUrl(input) });
    const reply = replies[calls - 1];
    if (reply === undefined) {
      throw new Error(
        `fake adapter: no scripted reply for request ${calls} (scripted ${replies.length} replies)`,
      );
    }
    return sseResponse(sseBody(reply));
  };
  return {
    fetch,
    get requests(): readonly FakeFetchRequest[] {
      return recorded.map((request) => ({ ...request }));
    },
  };
}

/** SDK 可能以 string / URL / Request 三种形态调 fetch；统一取 URL 字符串 */
function normalizeUrl(input: Parameters<FetchFunction>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function sseBody(reply: FakeReply): string {
  const frames = [
    ...contentDeltas(reply.text).map((delta) => contentChunk(delta)),
    finishChunk(reply.finishReason ?? "stop"),
    usageChunk(reply.usage),
    "data: [DONE]",
  ];
  return `${frames.join("\n\n")}\n\n`;
}

/** 确定性切分：≥2 字符对半两段；1 字符单段；空文本零段 */
function contentDeltas(text: string): readonly string[] {
  if (text.length === 0) {
    return [];
  }
  if (text.length === 1) {
    return [text];
  }
  const half = Math.ceil(text.length / 2);
  return [text.slice(0, half), text.slice(half)];
}

function contentChunk(content: string): string {
  return dataFrame({
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
}

function finishChunk(finishReason: string): string {
  return dataFrame({
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });
}

function usageChunk(usage: FakeUsage): string {
  return dataFrame({
    choices: [],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      prompt_cache_hit_tokens: usage.cacheReadTokens,
    },
  });
}

function dataFrame(chunk: { choices: unknown[]; [extra: string]: unknown }): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    model: FAKE_MODEL_ID,
    ...chunk,
  })}`;
}

function sseResponse(body: string): Response {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}
