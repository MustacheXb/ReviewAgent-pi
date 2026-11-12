import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { fakeFetch, type FakeReply } from "../provider/fake-fetch.js";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";
import { runReview } from "./review-run.js";

// 缓存合同（#58 / ADR-0018 §6）：从实际 fake 响应被动采集 usage 字段族与
// 模型回显，审计与 RunRecord 可读；未知字段记 unknown（不按 0 / 固定折扣）。
// 行为缝 = runReview（fake fetch 与真适配器同缝），只断言外部可观察产物。

const tempDirs: string[] = [];

function tempRunsRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-cache-contract-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;

/** 一轮零工具回复脚本（六相位各一文本回复） */
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

async function runOffline(replies: readonly FakeReply[], apiKey = "offline-test") {
  const script = fakeFetch(replies);
  const runsRoot = tempRunsRoot();
  const result = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: "The MR under review may contain a vulnerability.",
    apiKey,
    fetch: script.fetch,
    runsRoot,
    experimentId: "cache-contract",
    rep: 1,
  });
  return { ...result, script };
}

test("deepseek-native fake 响应：usage 字段族与模型回显进 RunRecord / 审计", async () => {
  const usage = { promptTokens: 1_000, completionTokens: 20, cacheReadTokens: 400 };
  const { record, auditPath } = await runOffline(
    sixPhaseNoToolCorpus().map((reply) => ({ ...reply, usage })),
  );

  const contract = record.baseline.audit.cacheContract;
  expect(contract).toMatchObject({
    provider: "deepseek",
    endpointKind: "chat-completions",
    requestedModel: "deepseek-v4-flash",
    respondedModel: "deepseek-v4-flash",
    deploymentVersion: "unknown",
    usageFieldFamily: "deepseek-native",
    cacheMetering: true,
    // 被动采集无法推导的字段一律 unknown（不按 0 / 固定折扣假设）
    cacheBlockTokens: "unknown",
    cacheWarmupMs: "unknown",
    providerAffinityRequired: "unknown",
  });
  expect(contract?.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const audit = JSON.parse(readFileSync(auditPath, "utf8")) as {
    cacheContract?: unknown;
  };
  expect(audit.cacheContract).toEqual(contract);
});

test("openai-cached-tokens 字段族：prompt_tokens_details.cached_tokens 可识别", async () => {
  const rawUsage = {
    prompt_tokens: 1_000,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 400 },
  };
  const { record } = await runOffline(
    sixPhaseNoToolCorpus().map((reply) => ({
      ...reply,
      usage: { promptTokens: 1_000, completionTokens: 20, cacheReadTokens: 400 },
      rawUsage,
    })),
  );
  expect(record.baseline.audit.cacheContract).toMatchObject({
    usageFieldFamily: "openai-cached-tokens",
    cacheMetering: true,
  });
});

test("usage 有值但无缓存字段：字段族 unknown、cacheMetering=false（不按 0 冒充已计量）", async () => {
  const rawUsage = { prompt_tokens: 1_000, completion_tokens: 20 };
  const { record } = await runOffline(
    sixPhaseNoToolCorpus().map((reply) => ({
      ...reply,
      usage: { promptTokens: 1_000, completionTokens: 20, cacheReadTokens: 0 },
      rawUsage,
    })),
  );
  expect(record.baseline.audit.cacheContract).toMatchObject({
    usageFieldFamily: "unknown",
    cacheMetering: false,
  });
});

test("响应完全不带 usage：字段族与 cacheMetering 均记 unknown", async () => {
  const { record } = await runOffline(
    sixPhaseNoToolCorpus().map((reply) => ({ ...reply, omitUsage: true })),
  );
  expect(record.baseline.audit.cacheContract).toMatchObject({
    usageFieldFamily: "unknown",
    cacheMetering: "unknown",
  });
});

test("空 usage 对象：字段缺失同样记 unknown（不按 0 冒充已观测）", async () => {
  const { record } = await runOffline(
    sixPhaseNoToolCorpus().map((reply) => ({ ...reply, rawUsage: {} })),
  );
  expect(record.baseline.audit.cacheContract).toMatchObject({
    usageFieldFamily: "unknown",
    cacheMetering: "unknown",
  });
});

test("缓存合同不含密钥（审计文件可外发）", async () => {
  const apiKey = "sk-cache-contract-secret-sentinel";
  const { record, auditPath } = await runOffline(sixPhaseNoToolCorpus(), apiKey);
  const auditText = readFileSync(auditPath, "utf8");
  expect(auditText).not.toContain(apiKey);
  expect(JSON.stringify(record.baseline.audit.cacheContract)).not.toContain(apiKey);
});
