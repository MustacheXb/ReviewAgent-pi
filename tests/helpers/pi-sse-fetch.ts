/**
 * root 侧最小 SSE fake（#8 P4a 离线过缝测试用）。
 *
 * 为什么不复用 packages/review-pi 的 provider/fake-fetch：review-pi 仅经包入口
 * （exports "."）公开 runReview 与契约类型，fake-fetch 属包内模块，root 测试
 * 无法深导入。此处按同一 wire 格式（openai-completions 流式：两段 content
 * delta → finish chunk → usage chunk（deepseek 口径 prompt_cache_hit_tokens）
 * → [DONE]）自建最小渲染器，只覆盖离线过缝需要的两种形态：
 * - 零工具六相位脚本（A–E 全配置同构消费）；
 * - HTTP 4xx 失败注入（pi-ai 重试策略对 4xx 不重试——单发即抛，确定性失败）。
 * 工具调用帧等其余 wire 形态由 pi 包内测试钉住，不在此重复。
 */

export interface SseUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens: number;
}

/** 脚本步：SSE 回复，或 HTTP 错误响应注入（4xx——不可重试，单发即抛） */
export type SseStep =
  | { readonly text: string; readonly usage: SseUsage }
  | { readonly httpStatus: number };

export interface SseFetchRequest {
  readonly url: string;
}

export interface SseFetchScript {
  readonly fetch: typeof globalThis.fetch;
  /** 已发出请求的只读快照（每次读取返回新数组） */
  readonly requests: readonly SseFetchRequest[];
}

/** fake 帧里上报的模型 id（与计划的评审模型一致） */
const FAKE_MODEL_ID = "deepseek-v4-flash";

export function sseFetchScript(steps: readonly SseStep[]): SseFetchScript {
  const recorded: SseFetchRequest[] = [];
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    calls += 1;
    recorded.push({ url: normalizeUrl(input) });
    const step = steps[calls - 1];
    if (step === undefined) {
      throw new Error(
        `pi-sse-fetch: no scripted step for request ${calls} (scripted ${steps.length} steps)`,
      );
    }
    if ("httpStatus" in step) {
      return new Response(`pi-sse-fetch: scripted gateway rejection (${step.httpStatus})`, {
        status: step.httpStatus,
      });
    }
    return sseResponse(renderSseBody(step));
  };
  return {
    fetch,
    get requests(): readonly SseFetchRequest[] {
      return recorded.map((request) => ({ ...request }));
    },
  };
}

/**
 * 六相位零工具脚本 × 1 单元（A–E 全配置同构消费）：4 × 自由文本 →
 * 空候选 → 完成判定。pi 内核按请求参数逐单元切 preset，脚本不感知配置。
 */
export function sixPhaseNoToolSteps(usage: SseUsage): SseStep[] {
  return [
    { text: "ok", usage },
    { text: "ok", usage },
    { text: "ok", usage },
    { text: "ok", usage },
    { text: '{"candidates":[]}', usage },
    { text: '{"verdicts":[],"complete":true}', usage },
  ];
}

/** 脚本回复 → SSE 帧序列原文（两段 content delta → finish → usage → [DONE]） */
function renderSseBody(step: { readonly text: string; readonly usage: SseUsage }): string {
  const frames = [
    ...contentDeltas(step.text).map((delta) => contentChunk(delta)),
    finishChunk(),
    usageChunk(step.usage),
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

function finishChunk(): string {
  return dataFrame({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
}

function usageChunk(usage: SseUsage): string {
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

/** SDK 可能以 string / URL / Request 三种形态调 fetch；统一取 URL 字符串 */
function normalizeUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
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
