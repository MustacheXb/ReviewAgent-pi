import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { fakeFetch, type FakeReply } from "../provider/fake-fetch.js";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";
import { runReview } from "./review-run.js";

// 首字节前薄重试的行为缝（#59）：fake 适配器在传输层返回 429 / 5xx / 网络
// 错误，runReview 的重试包装在首字节前重试；审计与 RunRecord 留痕。
// Retry-After=0 让集成测试不引入真实等待；退避时序由 retrying-fetch.test.ts
// 用 fake timers 锁定。

const tempDirs: string[] = [];

function tempRunsRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-retry-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;

function sixPhaseNoToolCorpus(): FakeReply[] {
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: '{"candidates":[]}', usage: ZERO },
    { text: '{"verdicts":[],"complete":true}', usage: ZERO },
  ];
}

function reviewInput(replies: readonly FakeReply[]): {
  readonly script: ReturnType<typeof fakeFetch>;
  readonly input: Parameters<typeof runReview>[0];
} {
  const script = fakeFetch(replies);
  return {
    script,
    input: {
      caseId: "VUL4J-1",
      repoPath: repoFixturePath("sample"),
      diff: goldenFixture("vul4j-1.diff"),
      issueDescription: "The MR under review may contain a vulnerability.",
      apiKey: "offline-test",
      fetch: script.fetch,
      runsRoot: tempRunsRoot(),
      experimentId: "retry-smoke",
      rep: 1,
    },
  };
}

async function runOffline(replies: readonly FakeReply[]) {
  const { script, input } = reviewInput(replies);
  const result = await runReview(input);
  return { ...result, script };
}

test("429 首字节前失败 → 重试成功；审计留痕重试次数/原因/失败 usage", async () => {
  const failure: FakeReply = {
    usage: ZERO,
    failWith: {
      kind: "http",
      status: 429,
      retryAfter: "0",
      body: JSON.stringify({
        usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 20 },
      }),
    },
  };
  const { record, auditPath, script } = await runOffline([failure, ...sixPhaseNoToolCorpus()]);

  // 首次 429 + 六相位各一请求
  expect(script.requests).toHaveLength(7);
  const expectedRetry = {
    retries: 1,
    failedAttempts: 1,
    exhausted: false,
    records: [
      {
        request: 1,
        attempt: 1,
        reason: "http_429",
        status: 429,
        delayMs: 0,
        retried: true,
        usage: { inputTokens: 80, outputTokens: 5, cacheReadTokens: 20 },
      },
    ],
  };
  expect(record.baseline.audit.retry).toEqual(expectedRetry);
  const audit = JSON.parse(readFileSync(auditPath, "utf8")) as { retry?: unknown };
  expect(audit.retry).toEqual(expectedRetry);

  // 重试后的成功响应仍参与缓存合同 / 正常 usage 记账
  expect(record.baseline.usage).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
  });
  expect(record.baseline.audit.cacheContract?.usageFieldFamily).toBe("deepseek-native");
});

test("无重试 run：审计省 retry 键", async () => {
  const { record } = await runOffline(sixPhaseNoToolCorpus());
  expect("retry" in record.baseline.audit).toBe(false);
});

test("重试耗尽：run 失败且错误携带重试留痕", async () => {
  const failure: FakeReply = {
    usage: ZERO,
    failWith: { kind: "http", status: 500, retryAfter: "0", body: "{}" },
  };
  const { script, input } = reviewInput([failure, failure, failure]);
  await expect(runReview(input)).rejects.toThrow(
    /retry: 2 retries, 3 failed attempt\(s\), exhausted=true/,
  );
  expect(script.requests).toHaveLength(3);
});
