import type { FetchFunction } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { createCacheContractCollector } from "./cache-contract.js";

// 响应旁路采集器（#58）：JSON / SSE / choices[].usage / 部署版本响应头 /
// 无 usage 路径。包装后的 fetch 返回原 Response（调用方不受影响）。

function jsonFetch(body: unknown, headers: Record<string, string> = {}): FetchFunction {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    });
}

function sseFetch(frames: readonly unknown[]): FetchFunction {
  const text = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
  return async () =>
    new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const INPUTS = {
  provider: "deepseek",
  requestedModel: "deepseek-v4-flash",
  measuredAt: "2026-11-12T00:00:00.000Z",
} as const;

test("JSON 响应：usage 字段族 / 模型回显 / 部署版本头进合同", async () => {
  const collector = createCacheContractCollector();
  const fetch = collector.wrap(
    jsonFetch(
      { model: "gw-echo-model", usage: { prompt_cache_hit_tokens: 12, prompt_tokens: 20 } },
      { "x-deployment-version": "dep-2026-11" },
    ),
  );
  const response = await fetch("https://gw.example/v1/chat/completions");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("gw-echo-model");
  await collector.settle();

  expect(collector.contract(INPUTS)).toMatchObject({
    provider: "deepseek",
    endpointKind: "chat-completions",
    requestedModel: "deepseek-v4-flash",
    respondedModel: "gw-echo-model",
    deploymentVersion: "dep-2026-11",
    usageFieldFamily: "deepseek-native",
    cacheMetering: true,
  });
});

test("SSE 且 usage 位于 choices[]：回退识别 OpenAI 口径", async () => {
  const collector = createCacheContractCollector();
  await collector.wrap(
    sseFetch([
      { model: "echo", choices: [{ usage: { prompt_tokens_details: { cached_tokens: 4 } } }] },
    ]),
  )("https://gw.example/v1/responses");
  await collector.settle();

  expect(collector.contract(INPUTS)).toMatchObject({
    endpointKind: "responses",
    respondedModel: "echo",
    usageFieldFamily: "openai-cached-tokens",
    cacheMetering: true,
  });
});

test("无 usage / 空 usage → cacheMetering unknown；观测失败不击穿返回", async () => {
  const collector = createCacheContractCollector();
  await collector.wrap(jsonFetch({ model: "echo" }))("https://gw.example/v1/chat/completions");
  await collector.wrap(jsonFetch({ model: "echo", usage: {} }))(
    "https://gw.example/v1/chat/completions",
  );
  await collector.wrap(async () => new Response("not json", { status: 502 }))(
    "https://gw.example/v1/chat/completions",
  );
  await collector.settle();

  expect(collector.contract(INPUTS)).toMatchObject({
    respondedModel: "echo",
    usageFieldFamily: "unknown",
    cacheMetering: "unknown",
    cacheBlockTokens: "unknown",
    cacheWarmupMs: "unknown",
    providerAffinityRequired: "unknown",
  });
});
