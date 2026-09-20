import { expect, test } from "vitest";
import { fakeFetch } from "./fake-fetch.js";

// fake 适配器（离线 canned SSE）：与真适配器同缝（FetchFunction）注册。
// 确定性帧序列：两段 content delta → finish chunk → usage chunk → [DONE]；
// 脚本依序消费，耗尽即抛错（脚本错配是测试自身的 bug，要尽早炸出来）。

test("fakeFetch：依序返回确定性 SSE 帧（两段 delta + finish + usage + DONE）", async () => {
  const script = fakeFetch([
    { text: "hello world", usage: { promptTokens: 10, completionTokens: 5, cacheReadTokens: 2 } },
  ]);
  const response = await script.fetch("https://api.deepseek.com/chat/completions", { method: "POST" });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");

  const frames = (await response.text()).split("\n\n").filter((frame) => frame !== "");
  expect(frames).toHaveLength(5);
  expect(JSON.parse(frameData(frames[0]!)).choices[0].delta.content).toBe("hello ");
  expect(JSON.parse(frameData(frames[1]!)).choices[0].delta.content).toBe("world");
  expect(JSON.parse(frameData(frames[2]!)).choices[0].finish_reason).toBe("stop");
  expect(JSON.parse(frameData(frames[3]!)).usage).toEqual({
    prompt_tokens: 10,
    completion_tokens: 5,
    prompt_cache_hit_tokens: 2,
  });
  expect(frames[4]).toBe("data: [DONE]");
  expect(script.requests).toEqual([{ url: "https://api.deepseek.com/chat/completions" }]);
});

test("fakeFetch：空回复零 content delta（仅 finish + usage + DONE）", async () => {
  const script = fakeFetch([{ text: "", usage: { promptTokens: 1, completionTokens: 0, cacheReadTokens: 0 } }]);
  const response = await script.fetch("https://api.deepseek.com/chat/completions", {});

  const frames = (await response.text()).split("\n\n").filter((frame) => frame !== "");
  expect(frames).toHaveLength(3);
  expect(frames[0]).toContain('"finish_reason":"stop"');
  expect(frames[2]).toBe("data: [DONE]");
});

test("fakeFetch：脚本耗尽后继续调用即抛错", async () => {
  const script = fakeFetch([{ text: "only", usage: { promptTokens: 1, completionTokens: 1, cacheReadTokens: 0 } }]);
  await script.fetch("https://api.deepseek.com/chat/completions", {});

  await expect(script.fetch("https://api.deepseek.com/chat/completions", {})).rejects.toThrow(
    /no scripted reply for request 2/,
  );
});

test("fakeFetch：URL 归一（string / URL 实例 / Request 对象）", async () => {
  const usage = { promptTokens: 1, completionTokens: 1, cacheReadTokens: 0 };
  const script = fakeFetch([{ text: "a", usage }, { text: "b", usage }, { text: "c", usage }]);

  await script.fetch("https://api.deepseek.com/chat/completions", {});
  await script.fetch(new URL("https://api.deepseek.com/chat/completions"), {});
  await script.fetch(new Request("https://api.deepseek.com/chat/completions"));

  expect(script.requests.map((request) => request.url)).toEqual([
    "https://api.deepseek.com/chat/completions",
    "https://api.deepseek.com/chat/completions",
    "https://api.deepseek.com/chat/completions",
  ]);
});

test("fakeFetch：工具调用回复（tool_calls delta 帧 + finish tool_calls + usage + DONE）", async () => {
  const script = fakeFetch([
    {
      toolCalls: [
        { id: "call-1", name: "review_get_diff", arguments: {} },
        { id: "call-2", name: "review_get_file", arguments: { path: "Foo.java" } },
      ],
      usage: { promptTokens: 10, completionTokens: 5, cacheReadTokens: 0 },
    },
  ]);
  const response = await script.fetch("https://api.deepseek.com/chat/completions", {});

  const frames = (await response.text()).split("\n\n").filter((frame) => frame !== "");
  expect(frames).toHaveLength(5);
  const first = JSON.parse(frameData(frames[0]!));
  expect(first.choices[0].delta.tool_calls[0]).toEqual({
    index: 0,
    id: "call-1",
    type: "function",
    function: { name: "review_get_diff", arguments: "{}" },
  });
  const second = JSON.parse(frameData(frames[1]!));
  expect(second.choices[0].delta.tool_calls[0].index).toBe(1);
  expect(second.choices[0].delta.tool_calls[0].function.name).toBe("review_get_file");
  expect(JSON.parse(frameData(frames[1]!)).choices[0].delta.tool_calls[0].function.arguments).toBe(
    JSON.stringify({ path: "Foo.java" }),
  );
  expect(JSON.parse(frameData(frames[2]!)).choices[0].finish_reason).toBe("tool_calls");
  expect(frames[4]).toBe("data: [DONE]");
});

test("fakeFetch：文本 + 工具调用混合回复（content delta 在前，finish 仍为 tool_calls）", async () => {
  const script = fakeFetch([
    {
      text: "let me look",
      toolCalls: [{ id: "call-1", name: "review_get_diff", arguments: {} }],
      usage: { promptTokens: 1, completionTokens: 1, cacheReadTokens: 0 },
    },
  ]);
  const response = await script.fetch("https://api.deepseek.com/chat/completions", {});

  const frames = (await response.text()).split("\n\n").filter((frame) => frame !== "");
  expect(frames).toHaveLength(6);
  expect(JSON.parse(frameData(frames[0]!)).choices[0].delta.content).toBe("let me");
  expect(JSON.parse(frameData(frames[1]!)).choices[0].delta.content).toBe(" look");
  expect(JSON.parse(frameData(frames[3]!)).choices[0].finish_reason).toBe("tool_calls");
});

function frameData(frame: string): string {
  return frame.slice("data: ".length);
}
