import { expect, test } from "vitest";
import {
  cacheHitTokensOf,
  classifyUsageFields,
  endpointKindOf,
  modelEchoOf,
  usageOf,
} from "./cache-contract.js";

// 缓存合同纯分类器（#58）：字段存在性判定（不看数值）、endpoint 类型与
// 响应回显抽取。unknown 是缺字段的显式口径，不按 0 / 固定折扣假设。

test("classifyUsageFields：DeepSeek 原生 / OpenAI 口径 / 无缓存字段 / 空 usage", () => {
  expect(classifyUsageFields({ prompt_cache_hit_tokens: 0 })).toEqual({
    usageFieldFamily: "deepseek-native",
    cacheMetering: true,
  });
  expect(classifyUsageFields({ prompt_cache_miss_tokens: 12 })).toEqual({
    usageFieldFamily: "deepseek-native",
    cacheMetering: true,
  });
  expect(classifyUsageFields({ prompt_tokens_details: { cached_tokens: 3 } })).toEqual({
    usageFieldFamily: "openai-cached-tokens",
    cacheMetering: true,
  });
  expect(classifyUsageFields({ cached_tokens: 3 })).toEqual({
    usageFieldFamily: "openai-cached-tokens",
    cacheMetering: true,
  });
  expect(classifyUsageFields({ prompt_tokens: 10, completion_tokens: 2 })).toEqual({
    usageFieldFamily: "unknown",
    cacheMetering: false,
  });
  expect(classifyUsageFields({})).toEqual({
    usageFieldFamily: "unknown",
    cacheMetering: false,
  });
});

test("cacheHitTokensOf：两族命中字段提取；缺失 undefined", () => {
  expect(cacheHitTokensOf({ prompt_cache_hit_tokens: 7 })).toBe(7);
  expect(cacheHitTokensOf({ prompt_tokens_details: { cached_tokens: 5 } })).toBe(5);
  expect(cacheHitTokensOf({ cached_tokens: 4 })).toBe(4);
  expect(cacheHitTokensOf({ prompt_tokens: 10 })).toBeUndefined();
});

test("endpointKindOf：chat-completions / responses / anthropic-messages / unknown", () => {
  expect(endpointKindOf("https://gw.example/v1/chat/completions")).toBe("chat-completions");
  expect(endpointKindOf("https://gw.example/v1/responses")).toBe("responses");
  expect(endpointKindOf("https://gw.example/v1/messages")).toBe("anthropic-messages");
  expect(endpointKindOf("https://gw.example/v1/models")).toBe("unknown");
  expect(endpointKindOf("not a url")).toBe("unknown");
});

test("modelEchoOf / usageOf：非对象与缺字段返回 undefined", () => {
  expect(modelEchoOf({ model: "deepseek-v4-flash" })).toBe("deepseek-v4-flash");
  expect(modelEchoOf({ model: "" })).toBeUndefined();
  expect(modelEchoOf(null)).toBeUndefined();
  expect(usageOf({ usage: { prompt_tokens: 1 } })).toEqual({ prompt_tokens: 1 });
  expect(usageOf({ usage: null })).toBeUndefined();
  expect(usageOf({})).toBeUndefined();
});
