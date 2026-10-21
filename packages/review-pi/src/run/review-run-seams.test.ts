import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { fakeFetch, type FakeReply } from "../provider/fake-fetch.js";
import { repoFixturePath } from "../testing/repos.js";
import {
  SAMPLE_DIFF,
  configDToolCorpus,
  expectEmptyTree,
  sixPhaseNoToolCorpus,
  tempRunsRoot,
} from "../testing/seam-fixtures.js";
import { ReviewAbortedError, runReview } from "./review-run.js";

// S2 内核缝测试（#23）：signal（running cancel 的内核侧）与 onProgress
// （phase/round 边界观测）。验收面（spec #21 §6 / 票 #23）：
// - abort 中途 → ReviewAbortedError 上抛，审计与 RunRecord 均不落盘
//   （半途中止无对照价值——现行内核审计在循环完成后统一落盘）；
// - onProgress 只观测：不进 wire、不改消息序（对照纯基线 run 逐字节相等）；
// - 两缝均可选：未配置时字节行为不变（t1–t5 门把口，本文件不重复）。
//
// 与 review-run.test.ts 的分工：那边锁黄金真源形态（不许动）；这边只测
// 新增缝的外部行为——零存量测试修改纪律下独立成文件。
// 共享最小语料/临时目录助手见 testing/seam-fixtures.ts（与 rpc 真适配器
// 测试共用；黄金字节语料仍在 testing/vul4j1-script.ts，两者分工见其头注）。

// ---- signal 缝：A/B 直驱路径（#23）----

test("signal：A/B 边界中止——phase-2 边界 abort → ReviewAbortedError，零落盘", async () => {
  const controller = new AbortController();
  const script = fakeFetch(sixPhaseNoToolCorpus());
  const runsRoot = tempRunsRoot("review-pi-seams-");

  await expect(
    runReview({
      caseId: "VUL4J-1",
      repoPath: repoFixturePath("sample"),
      diff: SAMPLE_DIFF,
      issueDescription: "Issue description under review.",
      apiKey: "offline-test",
      configId: "A",
      fetch: script.fetch,
      runsRoot,
      experimentId: "phase2-smoke",
      rep: 1,
      signal: controller.signal,
      // phase-2 边界（Risk Classification 入口）触发中止——检视半途中止
      onProgress: (progress) => {
        if (progress.phase === "Risk Classification") {
          controller.abort();
        }
      },
    }),
  ).rejects.toBeInstanceOf(ReviewAbortedError);

  // 半途中止：既没有跑完（< 6 请求），也没有落任何盘
  expect(script.requests.length).toBeLessThan(6);
  expectEmptyTree(runsRoot);
});

test("signal：A/B 请求进行中中止——回复已到、signal 已断 → 下一边界止步，零落盘", async () => {
  const controller = new AbortController();
  const script = fakeFetch(sixPhaseNoToolCorpus());
  const runsRoot = tempRunsRoot("review-pi-seams-");

  // 回复返回后才 abort：模拟中止发生在请求进行中（fake 适配器不感知 signal，
  // 内核必须在回合边界自行止步，不依赖传输层取消）
  let calls = 0;
  const abortingFetch: FetchFunction = async (input, init) => {
    calls += 1;
    const response = await script.fetch(input, init);
    if (calls >= 2) {
      controller.abort();
    }
    return response;
  };

  await expect(
    runReview({
      caseId: "VUL4J-1",
      repoPath: repoFixturePath("sample"),
      diff: SAMPLE_DIFF,
      issueDescription: "Issue description under review.",
      apiKey: "offline-test",
      configId: "A",
      fetch: abortingFetch,
      runsRoot,
      experimentId: "phase2-smoke",
      rep: 1,
      signal: controller.signal,
    }),
  ).rejects.toBeInstanceOf(ReviewAbortedError);

  expect(calls).toBeLessThan(6);
  expectEmptyTree(runsRoot);
});

test("signal：调用前已中止——立即 ReviewAbortedError，零请求零落盘", async () => {
  const controller = new AbortController();
  controller.abort();
  const script = fakeFetch(sixPhaseNoToolCorpus());
  const runsRoot = tempRunsRoot("review-pi-seams-");

  await expect(
    runReview({
      caseId: "VUL4J-1",
      repoPath: repoFixturePath("sample"),
      diff: SAMPLE_DIFF,
      issueDescription: "Issue description under review.",
      apiKey: "offline-test",
      configId: "A",
      fetch: script.fetch,
      runsRoot,
      experimentId: "phase2-smoke",
      rep: 1,
      signal: controller.signal,
    }),
  ).rejects.toBeInstanceOf(ReviewAbortedError);

  expect(script.requests).toHaveLength(0);
  expectEmptyTree(runsRoot);
});

// ---- signal 缝：C/D/E agent 路径（#23）----

test("signal：C/D/E 请求进行中中止——agent.abort() → ReviewAbortedError，零落盘", async () => {
  const controller = new AbortController();
  const script = fakeFetch(configDToolCorpus());
  const runsRoot = tempRunsRoot("review-pi-seams-");

  // 第 2 次回复返回后 abort：中止发生在 phase-2 请求进行中——agent 循环
  // 下一回合边界止步（fake 适配器不感知 signal，内核缝是唯一止步点）
  let calls = 0;
  const abortingFetch: FetchFunction = async (input, init) => {
    calls += 1;
    const response = await script.fetch(input, init);
    if (calls >= 2) {
      controller.abort();
    }
    return response;
  };

  await expect(
    runReview({
      caseId: "VUL4J-1",
      repoPath: repoFixturePath("sample"),
      diff: SAMPLE_DIFF,
      issueDescription: "Issue description under review.",
      apiKey: "offline-test",
      configId: "D",
      fetch: abortingFetch,
      runsRoot,
      experimentId: "phase2-smoke",
      rep: 1,
      signal: controller.signal,
    }),
  ).rejects.toBeInstanceOf(ReviewAbortedError);

  expect(calls).toBeLessThan(7);
  expectEmptyTree(runsRoot);
}, 120_000);

// ---- onProgress 缝：A/B 直驱路径（#23）----

/** 每回复非零 usage 档（累计口径可断言；input = prompt − cacheRead = 10） */
const PER_REPLY_USAGE = { promptTokens: 10, completionTokens: 2, cacheReadTokens: 0 } as const;
const ONE_TURN_USAGE = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 };
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 };

/** 覆写 usage 档的六阶段零工具脚本（onProgress 累计口径断言专用） */
function sixPhaseNoToolCorpusWithUsage(usage: FakeReply["usage"]): FakeReply[] {
  return sixPhaseNoToolCorpus().map((reply) => ({ ...reply, usage }));
}

/** 两轮零工具脚本：round-1 验证 complete:false → round-2 complete:true（12 请求） */
function twoRoundNoToolCorpus(): FakeReply[] {
  return [
    ...sixPhaseNoToolCorpusWithUsage(PER_REPLY_USAGE).slice(0, 5),
    { text: '{"verdicts":[],"complete":false}', usage: PER_REPLY_USAGE },
    ...sixPhaseNoToolCorpusWithUsage(PER_REPLY_USAGE),
  ];
}

test("onProgress：A/B phase/round 边界事件——六阶段序、round 推进、累计 usage、toolCalls 恒 0", async () => {
  const events: unknown[] = [];
  const script = fakeFetch(twoRoundNoToolCorpus());
  const runsRoot = tempRunsRoot("review-pi-seams-");

  await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: SAMPLE_DIFF,
    issueDescription: "Issue description under review.",
    apiKey: "offline-test",
    configId: "A",
    fetch: script.fetch,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
    onProgress: (progress) => {
      events.push({ ...progress });
    },
  });

  expect(script.requests).toHaveLength(12);
  expect(events).toEqual([
    { phase: "Change Understanding", round: 1, toolCalls: 0, usage: ZERO_USAGE },
    { phase: "Risk Classification", round: 1, toolCalls: 0, usage: ONE_TURN_USAGE },
    { phase: "Context Decision", round: 1, toolCalls: 0, usage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 0 } },
    { phase: "Context Retrieval", round: 1, toolCalls: 0, usage: { inputTokens: 30, outputTokens: 6, cacheReadTokens: 0 } },
    { phase: "Deep Reasoning", round: 1, toolCalls: 0, usage: { inputTokens: 40, outputTokens: 8, cacheReadTokens: 0 } },
    { phase: "Evidence Verification", round: 1, toolCalls: 0, usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0 } },
    // round 推进边界：round-2 phase-1 入口（round 已 +1，usage 续累计 6 回合）
    { phase: "Change Understanding", round: 2, toolCalls: 0, usage: { inputTokens: 60, outputTokens: 12, cacheReadTokens: 0 } },
    { phase: "Risk Classification", round: 2, toolCalls: 0, usage: { inputTokens: 70, outputTokens: 14, cacheReadTokens: 0 } },
    { phase: "Context Decision", round: 2, toolCalls: 0, usage: { inputTokens: 80, outputTokens: 16, cacheReadTokens: 0 } },
    { phase: "Context Retrieval", round: 2, toolCalls: 0, usage: { inputTokens: 90, outputTokens: 18, cacheReadTokens: 0 } },
    { phase: "Deep Reasoning", round: 2, toolCalls: 0, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 } },
    { phase: "Evidence Verification", round: 2, toolCalls: 0, usage: { inputTokens: 110, outputTokens: 22, cacheReadTokens: 0 } },
  ]);
});

test("onProgress + signal 未中止：纯观测——wire 逐字节同无缝基线 run", async () => {
  // 基线 run（零缝配置 = 现状形态）
  const baselineScript = fakeFetch(sixPhaseNoToolCorpus());
  const baselineRoot = tempRunsRoot("review-pi-seams-");
  const baseline = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: SAMPLE_DIFF,
    issueDescription: "Issue description under review.",
    apiKey: "offline-test",
    configId: "A",
    fetch: baselineScript.fetch,
    runsRoot: baselineRoot,
    experimentId: "phase2-smoke",
    rep: 1,
  });

  // 两缝全配（onProgress 采集 + signal 挂着但全程不中止）
  const controller = new AbortController();
  const observedScript = fakeFetch(sixPhaseNoToolCorpus());
  const observedRoot = tempRunsRoot("review-pi-seams-");
  const events: unknown[] = [];
  const observed = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: SAMPLE_DIFF,
    issueDescription: "Issue description under review.",
    apiKey: "offline-test",
    configId: "A",
    fetch: observedScript.fetch,
    runsRoot: observedRoot,
    experimentId: "phase2-smoke",
    rep: 1,
    signal: controller.signal,
    onProgress: (progress) => {
      events.push({ ...progress });
    },
  });

  // 观测 run 正常完成（signal 未中止），事件齐发
  expect(events).toHaveLength(6);
  expect(observed.record.baseline.audit.truncated).toBe(false);
  // wire 逐字节不变（观测纯度：两缝都不进序列化面）
  const baselineWires = readAuditWires(baseline.auditPath);
  const observedWires = readAuditWires(observed.auditPath);
  expect(observedWires).toEqual(baselineWires);
});

function readAuditWires(auditPath: string): string[] {
  const audit = JSON.parse(readFileSync(auditPath, "utf8")) as {
    requests: { wireBody: string }[];
  };
  return audit.requests.map((request) => request.wireBody);
}

// ---- onProgress 缝：C/D/E agent 路径（#23）----

/**
 * config D 两轮工具脚本：round-1 phase-3 带一次 get_diff 工具轮（7 请求），
 * round-1 验证 complete:false → round-2 六请求 complete:true（共 13 请求）。
 */
function twoRoundToolCorpus(): FakeReply[] {
  return [
    { text: "ok", usage: PER_REPLY_USAGE },
    { text: "ok", usage: PER_REPLY_USAGE },
    {
      text: "Let me check the diff first.",
      toolCalls: [{ id: "call-diff-1", name: "review_get_diff", arguments: {} }],
      usage: PER_REPLY_USAGE,
    },
    { text: "ok", usage: PER_REPLY_USAGE },
    { text: "ok", usage: PER_REPLY_USAGE },
    { text: '{"candidates":[]}', usage: PER_REPLY_USAGE },
    { text: '{"verdicts":[],"complete":false}', usage: PER_REPLY_USAGE },
    { text: "ok", usage: PER_REPLY_USAGE },
    { text: "ok", usage: PER_REPLY_USAGE },
    { text: "ok", usage: PER_REPLY_USAGE },
    { text: "ok", usage: PER_REPLY_USAGE },
    { text: '{"candidates":[]}', usage: PER_REPLY_USAGE },
    { text: '{"verdicts":[],"complete":true}', usage: PER_REPLY_USAGE },
  ];
}

test("onProgress：C/D/E phase/round 边界事件——六阶段序、round 推进、累计 toolCalls/usage", async () => {
  const events: unknown[] = [];
  const script = fakeFetch(twoRoundToolCorpus());
  const runsRoot = tempRunsRoot("review-pi-seams-");

  await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: SAMPLE_DIFF,
    issueDescription: "Issue description under review.",
    apiKey: "offline-test",
    configId: "D",
    fetch: script.fetch,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
    onProgress: (progress) => {
      events.push({ ...progress });
    },
  });

  expect(script.requests).toHaveLength(13);
  // round-1：p1/p2 各 1 请求；p3 = 工具轮 + recall（2 请求，toolCalls 1）；
  // p4–p6 各 1 请求；round-2 六请求（toolCalls 保持累计 1）
  expect(events).toEqual([
    { phase: "Change Understanding", round: 1, toolCalls: 0, usage: ZERO_USAGE },
    { phase: "Risk Classification", round: 1, toolCalls: 0, usage: ONE_TURN_USAGE },
    { phase: "Context Decision", round: 1, toolCalls: 0, usage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 0 } },
    { phase: "Context Retrieval", round: 1, toolCalls: 1, usage: { inputTokens: 40, outputTokens: 8, cacheReadTokens: 0 } },
    { phase: "Deep Reasoning", round: 1, toolCalls: 1, usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0 } },
    { phase: "Evidence Verification", round: 1, toolCalls: 1, usage: { inputTokens: 60, outputTokens: 12, cacheReadTokens: 0 } },
    { phase: "Change Understanding", round: 2, toolCalls: 1, usage: { inputTokens: 70, outputTokens: 14, cacheReadTokens: 0 } },
    { phase: "Risk Classification", round: 2, toolCalls: 1, usage: { inputTokens: 80, outputTokens: 16, cacheReadTokens: 0 } },
    { phase: "Context Decision", round: 2, toolCalls: 1, usage: { inputTokens: 90, outputTokens: 18, cacheReadTokens: 0 } },
    { phase: "Context Retrieval", round: 2, toolCalls: 1, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 } },
    { phase: "Deep Reasoning", round: 2, toolCalls: 1, usage: { inputTokens: 110, outputTokens: 22, cacheReadTokens: 0 } },
    { phase: "Evidence Verification", round: 2, toolCalls: 1, usage: { inputTokens: 120, outputTokens: 24, cacheReadTokens: 0 } },
  ]);
}, 120_000);
