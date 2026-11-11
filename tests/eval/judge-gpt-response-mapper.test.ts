import { describe, expect, it } from "vitest";
import { GptJudgeResponseFormatError } from "../../src/eval/judge/errors.js";
import { mapGptChatCompletionsResponse } from "../../src/eval/judge/gpt-response-mapper.js";

function wireResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: "gpt-5.2-pro",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "judge json" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    ...overrides,
  };
}

describe("mapGptChatCompletionsResponse — 正常路径", () => {
  it("提取 content / finishReason", () => {
    const mapped = mapGptChatCompletionsResponse(wireResponse());
    expect(mapped.content).toBe("judge json");
    expect(mapped.finishReason).toBe("stop");
  });

  it("content null（纯 tool_calls 回复形态）归一为空串", () => {
    const mapped = mapGptChatCompletionsResponse(
      wireResponse({
        choices: [{ index: 0, message: { role: "assistant", content: null }, finish_reason: "stop" }],
      }),
    );
    expect(mapped.content).toBe("");
  });
});


describe("mapGptChatCompletionsResponse — 形状校验（有界失败）", () => {
  it("根非对象 / choices 缺失 / 空数组 → 显式错误", () => {
    expect(() => mapGptChatCompletionsResponse("nope")).toThrowError(/must be a JSON object/);
    expect(() => mapGptChatCompletionsResponse({})).toThrowError(/choices must be a non-empty array/);
    expect(() => mapGptChatCompletionsResponse({ choices: [] })).toThrowError(
      /choices must be a non-empty array/,
    );
  });

  it("message 缺失 / content 非字符串 → 显式错误", () => {
    expect(() =>
      mapGptChatCompletionsResponse({ choices: [{ index: 0, finish_reason: "stop" }] }),
    ).toThrowError(/choices\[0\].message must be a JSON object/);
    expect(() =>
      mapGptChatCompletionsResponse({
        choices: [{ index: 0, message: { role: "assistant", content: 42 }, finish_reason: "stop" }],
      }),
    ).toThrowError(/content must be a string or null/);
  });


  it("错误类型为 GptJudgeResponseFormatError", () => {
    try {
      mapGptChatCompletionsResponse(null);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GptJudgeResponseFormatError);
    }
  });
});
