import type { FetchFunction } from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vitest";
import { createRetryingFetch } from "./retrying-fetch.js";

// 首字节前薄重试（#59 / ADR-0018 §7）：网络错误 / 429 / 5xx 最多重试 2 次，
// 500ms / 1500ms + 抖动，服从 Retry-After；一旦返回 2xx（输出开始）不再重试。
// 退避用 fake timers 驱动，抖动注入确定性随机数。

afterEach(() => {
  vi.useRealTimers();
});

const URL = "https://gw.example/v1/chat/completions";

test("网络错误 → 5xx → 成功：两次重试、退避 500/1500ms、记录原因", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const base: FetchFunction = async () => {
    calls += 1;
    if (calls === 1) {
      throw new TypeError("fetch failed");
    }
    if (calls === 2) {
      return new Response("server error", { status: 503 });
    }
    return new Response("ok", { status: 200 });
  };
  const retrying = createRetryingFetch(base, { random: () => 0.5 });

  const pending = retrying.fetch(URL);
  await vi.runAllTimersAsync();
  const response = await pending;

  expect(response.status).toBe(200);
  expect(calls).toBe(3);
  expect(retrying.summary()).toEqual({
    retries: 2,
    failedAttempts: 2,
    exhausted: false,
    records: [
      { request: 1, attempt: 1, reason: "network", delayMs: 500, retried: true },
      { request: 1, attempt: 2, reason: "http_5xx", status: 503, delayMs: 1_500, retried: true },
    ],
  });
});

test("429 服从 Retry-After（秒）：退避取服务端值，不叠加抖动", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const base: FetchFunction = async () => {
    calls += 1;
    return calls === 1
      ? new Response("slow down", { status: 429, headers: { "retry-after": "3" } })
      : new Response("ok", { status: 200 });
  };
  const retrying = createRetryingFetch(base, { random: () => 0 });

  const pending = retrying.fetch(URL);
  await vi.advanceTimersByTimeAsync(2_999);
  expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  const response = await pending;

  expect(response.status).toBe(200);
  expect(retrying.summary()?.records[0]).toMatchObject({
    reason: "http_429",
    status: 429,
    delayMs: 3_000,
    retried: true,
  });
});

test("429 服从 Retry-After（HTTP-date）：以当前时钟折算等待", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-12T00:00:00.000Z"));
  let calls = 0;
  const base: FetchFunction = async () => {
    calls += 1;
    return calls === 1
      ? new Response("slow down", {
          status: 429,
          headers: { "retry-after": "Thu, 12 Nov 2026 00:00:02 GMT" },
        })
      : new Response("ok", { status: 200 });
  };
  const retrying = createRetryingFetch(base, { random: () => 0.5 });

  const pending = retrying.fetch(URL);
  await vi.advanceTimersByTimeAsync(1_999);
  expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  const response = await pending;

  expect(response.status).toBe(200);
  expect(retrying.summary()?.records[0]?.delayMs).toBe(2_000);
});

test("重试上限 2：第三次失败不再重试并标记 exhausted", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const base: FetchFunction = async () => {
    calls += 1;
    return new Response("server error", { status: 500 });
  };
  const retrying = createRetryingFetch(base, { random: () => 0.5 });

  const pending = retrying.fetch(URL);
  await vi.runAllTimersAsync();
  const response = await pending;

  expect(response.status).toBe(500);
  expect(calls).toBe(3);
  expect(retrying.summary()).toMatchObject({
    retries: 2,
    failedAttempts: 3,
    exhausted: true,
  });
  expect(retrying.summary()?.records.at(-1)).toMatchObject({
    request: 1,
    attempt: 3,
    retried: false,
    delayMs: 0,
    reason: "http_5xx",
  });
});

test("网络错误耗尽：抛出最后一次错误并标记 exhausted", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const base: FetchFunction = async () => {
    calls += 1;
    throw new TypeError(`network down ${calls}`);
  };
  const retrying = createRetryingFetch(base, { random: () => 0.5 });

  const pending = retrying.fetch(URL);
  const rejection = expect(pending).rejects.toThrow(/network down 3/);
  await vi.runAllTimersAsync();
  await rejection;

  expect(calls).toBe(3);
  expect(retrying.summary()).toMatchObject({ retries: 2, failedAttempts: 3, exhausted: true });
});

test("取消（AbortError）不重试；2xx 返回后不再重试（输出已开始）", async () => {
  vi.useFakeTimers();
  const abortError = new Error("aborted");
  abortError.name = "AbortError";
  const abortedBase: FetchFunction = async () => {
    throw abortError;
  };
  const aborted = createRetryingFetch(abortedBase);
  await expect(aborted.fetch(URL)).rejects.toThrow(/aborted/);
  expect(aborted.summary()).toBeUndefined();

  let okCalls = 0;
  const okBase: FetchFunction = async () => {
    okCalls += 1;
    return new Response("stream-body", { status: 200 });
  };
  const ok = createRetryingFetch(okBase);
  const response = await ok.fetch(URL);
  expect(response.status).toBe(200);
  expect(okCalls).toBe(1);
  expect(ok.summary()).toBeUndefined();
});

test("退避期间取消：立即中止，不等 Retry-After 走完", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  let calls = 0;
  const base: FetchFunction = async () => {
    calls += 1;
    return new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
  };
  const retrying = createRetryingFetch(base);

  const pending = retrying.fetch(URL, { signal: controller.signal });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await expect(pending).rejects.toThrow(/aborted/);

  expect(calls).toBe(1);
  expect(retrying.summary()?.records[0]).toMatchObject({
    request: 1,
    attempt: 1,
    reason: "http_429",
    delayMs: 60_000,
    retried: true,
  });
});

test("编程性 TypeError（非法 URL）不重试并原样抛出", async () => {
  let calls = 0;
  const base: FetchFunction = async () => {
    calls += 1;
    throw new TypeError("Failed to parse URL from nope");
  };
  const retrying = createRetryingFetch(base);
  await expect(retrying.fetch(URL)).rejects.toThrow(/Failed to parse URL/);
  expect(calls).toBe(1);
  expect(retrying.summary()).toBeUndefined();
});

test("请求序号：跨 fetch 调用时 records[].request 递增", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const base: FetchFunction = async () => {
    calls += 1;
    if (calls === 1 || calls === 3) {
      return new Response("err", { status: 500 });
    }
    return new Response("ok", { status: 200 });
  };
  const retrying = createRetryingFetch(base, { random: () => 0.5 });
  const first = retrying.fetch(URL);
  await vi.runAllTimersAsync();
  await first;
  const second = retrying.fetch(URL);
  await vi.runAllTimersAsync();
  await second;

  expect(retrying.summary()?.records.map((record) => record.request)).toEqual([1, 2]);
});
