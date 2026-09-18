import { expect, test, vi } from "vitest";
import type { Context, UserMessage } from "@earendil-works/pi-ai";
import { fakeFetch } from "./fake-fetch.js";
import { LOCKED_EFFORT_LABEL, REVIEW_MODEL_ID, assistantText, runReviewTurn } from "./pi-client.js";

// pi-ai 序列化缝（内核变量面）：真 provider + 真 SDK 序列化路径 + fake 传输适配器。
// wireBody = onPayload 序列化点捕获的请求原文（审计 requests[].wireBody 真源）。
// 请求面对齐 DSH deepseek 画像：不传 max_tokens（t 系列审计 wireBody 无此键）；
// 锁档纪律（DSH 线 ADR-0002）：审计 effort 标签 "default"，线上档位 reasoning_effort "high"。
// 零网络纪律：全链只经注入的 fetch；globalThis.fetch 被替换为抛错探针仍全程可用。

const API_KEY = "offline-test";

function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: 0 };
}

const BASE_CONTEXT: Context = {
  systemPrompt: "You are the reviewer.",
  messages: [user("Review the diff.")],
};

test("runReviewTurn：onPayload 序列化点捕获 wireBody 原文（模型 / 锁档 effort / 无 max_tokens / 无 tools）", async () => {
  const script = fakeFetch([
    { text: '{"summary":"ok"}', usage: { promptTokens: 100, completionTokens: 20, cacheReadTokens: 40 } },
  ]);
  const { message, wire } = await runReviewTurn({
    context: BASE_CONTEXT,
    apiKey: API_KEY,
    fetch: script.fetch,
  });

  expect(message.stopReason).toBe("stop");

  const parsed = JSON.parse(wire.wireBody) as Record<string, unknown>;
  expect(parsed.model).toBe("deepseek-v4-flash");
  expect(parsed.messages).toEqual([
    { role: "system", content: "You are the reviewer." },
    { role: "user", content: "Review the diff." },
  ]);
  expect(parsed.thinking).toEqual({ type: "enabled" });
  expect(parsed.reasoning_effort).toBe("high");
  expect(parsed.stream).toBe(true);
  // DSH deepseek 画像不传 max_tokens（t 系列审计 wireBody 无此键）；config B 无工具。
  expect("max_tokens" in parsed).toBe(false);
  expect("tools" in parsed).toBe(false);

  expect(wire.model).toBe(REVIEW_MODEL_ID);
  expect(wire.effort).toBe(LOCKED_EFFORT_LABEL);
  // 审计 requests[].messages ≡ wireBody.messages（同源投影，不允许两套序列化）。
  expect(wire.messages).toEqual(parsed.messages);
  expect(wire.tools).toEqual([]);
});

test("runReviewTurn：两段 content delta 拼接为回复文本，usage 按缓存口径折算", async () => {
  const script = fakeFetch([
    {
      text: '{"id":"F001","severity":"high"}',
      usage: { promptTokens: 100, completionTokens: 20, cacheReadTokens: 40 },
    },
  ]);
  const { message } = await runReviewTurn({ context: BASE_CONTEXT, apiKey: API_KEY, fetch: script.fetch });

  expect(message.stopReason).toBe("stop");
  expect(assistantText(message)).toBe('{"id":"F001","severity":"high"}');
  // pi-ai openai-completions：input = max(0, prompt_tokens − cacheRead − cacheWrite)。
  expect(message.usage).toMatchObject({ input: 60, output: 20, cacheRead: 40 });
});

test("runReviewTurn：assistant 回复回填上下文重放（deepseek 画像补空 reasoning_content）", async () => {
  const script = fakeFetch([
    { text: "phase-1 reply", usage: { promptTokens: 10, completionTokens: 5, cacheReadTokens: 0 } },
    { text: "phase-2 reply", usage: { promptTokens: 20, completionTokens: 6, cacheReadTokens: 0 } },
  ]);
  const turn1 = await runReviewTurn({ context: BASE_CONTEXT, apiKey: API_KEY, fetch: script.fetch });
  const turn2 = await runReviewTurn({
    context: {
      ...BASE_CONTEXT,
      messages: [...BASE_CONTEXT.messages, turn1.message, user("Phase 2: verify the finding.")],
    },
    apiKey: API_KEY,
    fetch: script.fetch,
  });

  expect(assistantText(turn1.message)).toBe("phase-1 reply");
  expect(assistantText(turn2.message)).toBe("phase-2 reply");

  // deepseek 画像 requiresReasoningContentOnAssistantMessages：无 thinking 的重放
  // assistant 条目补 reasoning_content: ""（pi 内核身份，审计如实记录实际序列化）。
  const parsed = JSON.parse(turn2.wire.wireBody) as { messages: unknown[] };
  expect(parsed.messages).toEqual([
    { role: "system", content: "You are the reviewer." },
    { role: "user", content: "Review the diff." },
    { role: "assistant", content: "phase-1 reply", reasoning_content: "" },
    { role: "user", content: "Phase 2: verify the finding." },
  ]);
});

test("runReviewTurn：零网络纪律——globalThis.fetch 抛错探针不被触碰", async () => {
  const originalFetch = globalThis.fetch;
  const networkProbe = vi.fn(() => {
    throw new Error("network access is disabled in offline tests");
  });
  globalThis.fetch = networkProbe as unknown as typeof globalThis.fetch;
  try {
    const script = fakeFetch([
      { text: "ok", usage: { promptTokens: 1, completionTokens: 1, cacheReadTokens: 0 } },
    ]);
    const { message } = await runReviewTurn({ context: BASE_CONTEXT, apiKey: API_KEY, fetch: script.fetch });
    expect(message.stopReason).toBe("stop");
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(networkProbe).not.toHaveBeenCalled();
});

test("runReviewTurn：stopReason error（finish_reason content_filter）→ 缝显式抛错", async () => {
  const script = fakeFetch([
    {
      text: "partial",
      finishReason: "content_filter",
      usage: { promptTokens: 1, completionTokens: 1, cacheReadTokens: 0 },
    },
  ]);
  await expect(
    runReviewTurn({ context: BASE_CONTEXT, apiKey: API_KEY, fetch: script.fetch }),
  ).rejects.toThrow(/content_filter/);
});
