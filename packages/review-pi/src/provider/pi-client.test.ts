import { expect, test } from "vitest";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
  LOCKED_EFFORT_LABEL,
  LOCKED_REASONING_EFFORT,
  REVIEW_MODEL_ID,
  assistantText,
  captureWire,
  reviewModelOf,
} from "./pi-client.js";

// pi-ai 序列化缝（内核变量面）的共享面测试（#32 / ADR-0014 后形态）：
// 模型解析（reviewModelOf——agent 循环 initialState.model 的单源）、wire
// 捕获投影（captureWire——审计 requests[] 条目来源）、assistant 文本抽取
// （assistantText）。直驱回合驱动器（runReviewTurn）已随 A/B 直驱路径根除，
// 其序列化锁档断言（thinking / reasoning_effort / 无 max_tokens / 网关 URL）
// 由 run/review-run.test.ts 的 E 全链测试承接（真 provider 真序列化路径）。

// ---- 锁档常量（DSH 线 ADR-0002 单源对齐）----

test("锁档常量：评审模型 id + effort 标签 + 线上档位", () => {
  expect(REVIEW_MODEL_ID).toBe("deepseek-v4-flash");
  expect(LOCKED_EFFORT_LABEL).toBe("default");
  expect(LOCKED_REASONING_EFFORT).toBe("high");
});

// ---- reviewModelOf：模型解析（id 命中 / 自由 id / baseUrl / fail fast）----

test("reviewModelOf：缺省 id → 钉住的评审模型，baseUrl 保持官方端点（无覆写）", () => {
  const model = reviewModelOf(undefined, undefined);
  expect(model.id).toBe(REVIEW_MODEL_ID);
  expect(model.baseUrl).toBe("https://api.deepseek.com");
});

test("reviewModelOf：目录外自由 model id 可发（钉住模型画像作模板，#45 语义）", () => {
  const model = reviewModelOf("custom-gateway-model", undefined);
  // 自由 id 原样上 wire；画像模板不随 id 漂移（provider 恒 deepseek、官方
  // baseUrl 兜底——锁档序列化与接入点不随 id 变）
  expect(model.id).toBe("custom-gateway-model");
  expect(model.provider).toBe("deepseek");
  expect(model.baseUrl).toBe("https://api.deepseek.com");
});

test("reviewModelOf：baseUrl 覆盖 → 接入点展开（网关缝，#4）", () => {
  const model = reviewModelOf(undefined, "https://gw.example.com/v1");
  expect(model.baseUrl).toBe("https://gw.example.com/v1");
});

test("reviewModelOf：modelId 空白 → fail fast（自由 id 非空校验）", () => {
  expect(() => reviewModelOf("   ", undefined)).toThrow(/model id/);
});

// ---- captureWire：onPayload 投影（边界校验 + null content 归一 + tools 口径）----

test("captureWire：合法 payload → 审计条目（model/effort 标签/messages/tools + wireBody 原文）", () => {
  const payload = {
    model: "deepseek-v4-flash",
    messages: [
      { role: "system", content: "You are the reviewer." },
      { role: "user", content: "Review the diff." },
    ],
    tools: [
      {
        type: "function",
        function: { name: "review_get_diff", description: "Get the diff", parameters: { type: "object" } },
      },
    ],
  };
  const wire = captureWire(payload);
  expect(wire.model).toBe("deepseek-v4-flash");
  // effort 是锁档标签投影（harness/审计面），不从 payload 读取
  expect(wire.effort).toBe(LOCKED_EFFORT_LABEL);
  expect(wire.messages).toEqual(payload.messages);
  expect(wire.tools).toEqual([
    { name: "review_get_diff", description: "Get the diff", parametersJson: '{"type":"object"}' },
  ]);
  // wireBody = JSON.stringify 原文（可原样重放）
  expect(wire.wireBody).toBe(JSON.stringify(payload));
});

test("captureWire：assistant 仅携带工具调用的消息（content null）投影为 \"\"；wireBody 原文保持 null", () => {
  const payload = {
    model: "deepseek-v4-flash",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [] },
    ],
  };
  const wire = captureWire(payload);
  expect(wire.messages[1]).toEqual({ role: "assistant", content: "", tool_calls: [] });
  expect(JSON.parse(wire.wireBody).messages[1].content).toBe(null);
});

test("captureWire：无 tools 键 → 空数组（E 全链零工具形态由调用方保证）", () => {
  const wire = captureWire({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "go" }] });
  expect(wire.tools).toEqual([]);
});

test("captureWire：边界校验 fail fast——非对象 / 无 model / 无 messages / 未知 role / 非 openai 工具", () => {
  expect(() => captureWire("nope")).toThrow("not an object");
  expect(() => captureWire(null)).toThrow("not an object");
  expect(() => captureWire({ messages: [] })).toThrow("model field");
  expect(() => captureWire({ model: "m" })).toThrow("messages array");
  expect(() => captureWire({ model: "m", messages: [{ role: "tool", content: "x" }] })).not.toThrow();
  expect(() => captureWire({ model: "m", messages: [{ role: "weird", content: "x" }] })).toThrow(
    /unknown wire role/,
  );
  expect(() =>
    captureWire({ model: "m", messages: [], tools: [{ type: "function", function: "not-an-object" }] }),
  ).toThrow(/openai function tool/);
});

// ---- assistantText：回复纯文本抽取（text 块 join "\n"，非 text 块过滤）----

function assistantOf(content: unknown): AssistantMessage {
  return { role: "assistant", content, stopReason: "stop", usage: { input: 1, output: 1 } } as unknown as AssistantMessage;
}

test("assistantText：content text 块按 \"\\n\" 连接；非 text 块（thinking 等）被过滤", () => {
  const thinkingBlock = { type: "thinking", thinking: "internal" };
  const text = (value: string): TextContent => ({ type: "text", text: value });
  expect(assistantText(assistantOf([text("part-1"), text("part-2")]))).toBe("part-1\npart-2");
  expect(assistantText(assistantOf([thinkingBlock, text("only-text")]))).toBe("only-text");
  expect(assistantText(assistantOf([]))).toBe("");
});
