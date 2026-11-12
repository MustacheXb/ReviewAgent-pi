import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { PHASE_INSTRUCTIONS } from "../loop/phases.js";
import { fakeFetch, type FakeReply } from "../provider/fake-fetch.js";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";
import { vul4j1Corpus } from "../testing/vul4j1-script.js";
import { SYSTEM_PROMPT } from "../zonea/system-prompt.js";
import { runReview } from "./review-run.js";

// 单案全链 E2E（离线 fake 适配器形态）：E 工具驱动 agentLoop → pi-ai 序列化
// → fake 适配器 → findings 解析 → 候选拦截 → 审计投影（AuditFileContent +
// RunRecord）。E 是唯一内核形态（#32 / ADR-0014：A–D 直驱/预取/全仓注入
// 已根除；历史 t-series 黄金对照随研究线退役，回复脚本 fixture 见
// ../testing/vul4j1-script.ts，供网关透传测试复用）。
//
// 全链只观测 RunRecord / 审计文件的外部行为（不窥探内核内部状态）。

const tempDirs: string[] = [];

function tempRunsRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-e2e-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** fake 脚本零 usage（usage 只进记账,零值即「脚本不带 usage 语义」） */
const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;

/** 一轮零工具回复脚本:六相位各一文本回复(phase-5 空候选 / phase-6 complete) */
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

/** 审计文件请求投影(wireBody 解析 + requests[].tools 点分名) */
function readAudit(auditPath: string): {
  requests: { wireBody: string; tools?: { name: string }[] }[];
  [extra: string]: unknown;
} {
  return JSON.parse(readFileSync(auditPath, "utf8")) as {
    requests: { wireBody: string; tools?: { name: string }[] }[];
    [extra: string]: unknown;
  };
}

/** 七工具 wire 名序(REVIEW_TOOL_ORDER 下划线形态) */
const WIRE_TOOL_NAMES = [
  "review_get_diff",
  "review_get_symbol",
  "review_get_file",
  "review_find_references",
  "review_get_call_chain",
  "review_search_rule",
  "review_search_history",
];
/** 审计投影 tools 点分名序（fromWireToolName：仅首个下划线转点分） */
const DOTTED_TOOL_NAMES = [
  "review.get_diff",
  "review.get_symbol",
  "review.get_file",
  "review.find_references",
  "review.get_call_chain",
  "review.search_rule",
  "review.search_history",
];

test("E 工具驱动全链:配置内核单源派生恒 E,req0 = ZoneA+MR+Phase-1 + 七工具面,零工具调用 complete", async () => {
  const script = fakeFetch(sixPhaseNoToolCorpus());
  const runsRoot = tempRunsRoot();
  const { record, recordPath, auditPath, runId } = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: "The MR under review may contain a vulnerability.",
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
  });

  // E 派生（v3 起）：输入无 configId,记录与落盘布局恒切 E 段
  expect(record.configId).toBe("E");
  expect(recordPath).toBe(
    path.join(runsRoot, "phase2-smoke", "runs", "vul4j", "VUL4J-1", "E", "rep-1.json"),
  );
  expect(path.dirname(auditPath)).toBe(
    path.join(runsRoot, "phase2-smoke", "audit", "vul4j", "VUL4J-1", "E", "rep-1", "audit"),
  );

  // runId 透出（CLI stdout 契约）：毫秒时间戳 + 配置 + 用例,与审计文件名同源
  expect(runId).toMatch(/^\d{8}T\d{6}\.\d{3}-E-VUL4J-1$/);
  expect(path.basename(auditPath)).toBe(`${runId}.json`);

  // 六相位各一请求(零工具);零值 usage 聚合
  expect(script.requests).toHaveLength(6);
  expect(record.baseline.rounds).toBe(1);
  expect(record.baseline.toolCalls).toBe(0);
  expect(record.baseline.audit.truncated).toBe(false);
  expect(record.baseline.audit.truncationReasons).toEqual([]);
  expect(record.baseline.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  // E 恒投影 ledger 键(零工具调用 → 空数组):RunRecord 与审计文件同源
  expect(record.baseline.audit.ledger).toEqual([]);
  const audit = readAudit(auditPath);
  expect(audit.configId).toBe("E");
  expect(audit.ledger).toEqual([]);

  // req0:三条消息(system + MR + Phase-1) + 工具面(wire 下划线名;tool_choice 缺席为 pi 方言)
  const req0 = JSON.parse(audit.requests[0].wireBody) as {
    messages: { role: string; content: string }[];
    tools?: { function: { name: string } }[];
    [extra: string]: unknown;
  };
  expect(req0.messages.map((message) => message.role)).toEqual(["system", "user", "user"]);
  expect(req0.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
  expect(req0.messages[1].content).toContain("Merge request under review.");
  expect(req0.messages[2]).toEqual({ role: "user", content: PHASE_INSTRUCTIONS[0] });
  expect(req0.tools?.map((tool) => tool.function.name)).toEqual(WIRE_TOOL_NAMES);
  expect("tool_choice" in req0).toBe(false);
  // 锁档纪律（DSH 线 ADR-0002，原 runReviewTurn 缝测试承接到全链）：
  // thinking enabled + reasoning_effort "high"；不传 max_tokens；pi 内核
  // openai-completions 恒流式（stream + stream_options.include_usage）
  expect(req0.thinking).toEqual({ type: "enabled" });
  expect(req0.reasoning_effort).toBe("high");
  expect("max_tokens" in req0).toBe(false);
  expect(req0.stream).toBe(true);
  expect(req0.stream_options).toEqual({ include_usage: true });
  // 审计投影 tools = 点分名(DSH 审计口径)
  expect(audit.requests[0].tools?.map((tool) => tool.name)).toEqual(DOTTED_TOOL_NAMES);
  // append-only(compaction 显式禁用):每请求 = 上一请求 + assistant 回复 + 下一相位指令
  const requests = audit.requests.map(
    (request) => JSON.parse(request.wireBody).messages as { role: string; content: string }[],
  );
  for (let index = 1; index < requests.length; index++) {
    expect(requests[index].slice(0, -2)).toEqual(requests[index - 1]);
    expect(requests[index].at(-1)).toEqual({ role: "user", content: PHASE_INSTRUCTIONS[index] });
  }
}, 120_000);

test("零网络纪律:globalThis.fetch 探针不被触碰(fetch 全程注入,离线全链零网络)", async () => {
  const originalFetch = globalThis.fetch;
  const networkProbe = vi.fn(() => {
    throw new Error("network access is disabled in offline tests");
  });
  globalThis.fetch = networkProbe as unknown as typeof globalThis.fetch;
  try {
    const script = fakeFetch(sixPhaseNoToolCorpus());
    const { record } = await runReview({
      caseId: "VUL4J-1",
      repoPath: repoFixturePath("sample"),
      diff: goldenFixture("vul4j-1.diff"),
      issueDescription: "Offline MR under review.",
      apiKey: "offline-test",
      fetch: script.fetch,
      runsRoot: tempRunsRoot(),
      experimentId: "phase2-smoke",
      rep: 1,
    });
    expect(record.baseline.audit.truncated).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(networkProbe).not.toHaveBeenCalled();
}, 120_000);

test("Zone A 跨 MR 字节稳定:另一案(不同 caseId/仓库/diff/issue)全链重跑,system 逐字节不变", async () => {
  // systemPrompt 与 MR 无关;用样本小仓库控制耗时
  const betaDiff = [
    "diff --git a/src/main/java/com/example/Beta.java b/src/main/java/com/example/Beta.java",
    "--- a/src/main/java/com/example/Beta.java",
    "+++ b/src/main/java/com/example/Beta.java",
    "@@ -5,4 +5,4 @@",
    " context",
    "+changed",
  ].join("\n");
  const firstScript = fakeFetch(sixPhaseNoToolCorpus());
  const first = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: "First MR under review.",
    apiKey: "offline-test",
    fetch: firstScript.fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
  });
  const secondScript = fakeFetch(sixPhaseNoToolCorpus());
  const second = await runReview({
    caseId: "SAMPLE-2",
    repoPath: repoFixturePath("sample"),
    diff: betaDiff,
    issueDescription: "Another MR under review.",
    apiKey: "offline-test",
    fetch: secondScript.fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
  });
  const firstSystem = readAudit(first.auditPath).requests.map(
    (request) => JSON.parse(request.wireBody).messages as { role: string; content: string }[],
  )[0][0];
  const secondSystem = readAudit(second.auditPath).requests.map(
    (request) => JSON.parse(request.wireBody).messages as { role: string; content: string }[],
  )[0][0];
  expect(secondSystem).toEqual(firstSystem);
  expect(secondSystem).toEqual({ role: "system", content: SYSTEM_PROMPT });
}, 120_000);

test("persistRecord=false(#8 runner 执行缝):记录不落盘、recordPath 空串;审计照常落盘", async () => {
  const script = fakeFetch(sixPhaseNoToolCorpus());
  const runsRoot = tempRunsRoot();
  const { record, recordPath, auditPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: "Runner-owned record MR under review.",
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
    persistRecord: false,
  });

  // 记录不落盘：runner 是记录唯一写者（执行缝纪律）；recordPath 空串 = 未持久化
  expect(recordPath).toBe("");
  expect(
    existsSync(path.join(runsRoot, "phase2-smoke", "runs", "vul4j", "VUL4J-1", "E", "rep-1.json")),
  ).toBe(false);

  // 审计照常落盘（重放字节是内核职责）；内存 record 完整返回（auditPath 同源）
  expect(existsSync(auditPath)).toBe(true);
  expect(record.configId).toBe("E");
  expect(record.baseline.auditPath).toBe(auditPath);
}, 120_000);

test("工具轮:review.get_diff 执行记账 + recall 请求(工具结果进上下文)", async () => {
  const diff = goldenFixture("vul4j-1.diff");
  const script = fakeFetch([
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    {
      text: "Let me check the diff first.",
      toolCalls: [{ id: "call-diff-1", name: "review_get_diff", arguments: {} }],
      usage: ZERO,
    },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: '{"candidates":[]}', usage: ZERO },
    { text: '{"verdicts":[],"complete":true}', usage: ZERO },
  ]);
  const runsRoot = tempRunsRoot();
  const { record, auditPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff,
    issueDescription: "Tool turn MR under review.",
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
  });

  // 7 请求:六相位 + 1 次工具 recall;工具记账 1 条(真 toolkit 执行 get_diff)
  expect(script.requests).toHaveLength(7);
  expect(record.baseline.toolCalls).toBe(1);
  expect(record.baseline.audit.toolCallLog).toEqual([
    {
      name: "review.get_diff",
      argumentsJson: "{}",
      resultSummary: ["MR unified diff:", ...diff.split("\n")].join("\n"),
    },
  ]);
  // 工具调用恒进 Context Ledger(读取成功后登记;E 功能态账本)
  expect(record.baseline.audit.ledger).toEqual([
    expect.objectContaining({
      id: "ctx#001",
      kind: "evidence",
      description: "review.get_diff",
      requestedRange: null,
      deliveredRange: null,
      complete: true,
      hitCount: 0,
    }),
  ]);
  // 一次真实读取 = 一次未命中（账本统计随审计落盘，#56）
  expect(record.baseline.audit.ledgerStats).toEqual({
    ledgerHits: 0,
    ledgerMisses: 1,
    savedCharsEstimate: 0,
  });

  // recall 请求 = 上一请求 + assistant(伴随文本 + tool_calls) + tool 应答
  const audit = readAudit(auditPath);
  const requests = audit.requests.map(
    (request) => JSON.parse(request.wireBody).messages as Record<string, unknown>[],
  );
  const toolTurn = requests[3];
  expect(toolTurn.slice(0, requests[2].length)).toEqual(requests[2]);
  const assistant = toolTurn[requests[2].length];
  expect(assistant).toMatchObject({
    role: "assistant",
    content: "Let me check the diff first.",
    tool_calls: [
      {
        id: "call-diff-1",
        type: "function",
        function: { name: "review_get_diff", arguments: "{}" },
      },
    ],
  });
  expect(toolTurn[requests[2].length + 1]).toMatchObject({
    role: "tool",
    tool_call_id: "call-diff-1",
    content: ["MR unified diff:", ...diff.split("\n")].join("\n"),
  });
}, 120_000);

test("Ledger 命中：同 run 重复 get_diff 返回引用，审计可读 ledgerStats 与命中条目", async () => {
  const diff = goldenFixture("vul4j-1.diff");
  const firstDiffResult = ["MR unified diff:", ...diff.split("\n")].join("\n");
  const script = fakeFetch([
    { text: "ok", usage: ZERO },
    {
      text: "Checking the diff.",
      toolCalls: [{ id: "call-diff-1", name: "review_get_diff", arguments: {} }],
      usage: ZERO,
    },
    { text: "ok", usage: ZERO },
    {
      text: "Checking the diff again.",
      toolCalls: [{ id: "call-diff-2", name: "review_get_diff", arguments: {} }],
      usage: ZERO,
    },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: '{"candidates":[]}', usage: ZERO },
    { text: '{"verdicts":[],"complete":true}', usage: ZERO },
  ]);
  const { record, auditPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff,
    issueDescription: "Ledger hit MR under review.",
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
  });

  // 首次真实读取 + 第二次引用：1 miss / 1 hit；节省字符 = 首次送达长度
  expect(record.baseline.audit.ledgerStats).toEqual({
    ledgerHits: 1,
    ledgerMisses: 1,
    savedCharsEstimate: firstDiffResult.length,
  });
  const entries = record.baseline.audit.ledger ?? [];
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    id: "ctx#001",
    kind: "evidence",
    description: "review.get_diff",
    requestedRange: null,
    deliveredRange: null,
    complete: true,
    hitCount: 1,
    charCount: firstDiffResult.length,
  });
  expect(entries[0]?.lastHitAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(record.baseline.audit.toolCallLog[1]?.resultSummary).toBe(
    "Already loaded: ctx#001 (review.get_diff; delivered whole result of requested whole result; complete=true)",
  );
  // 审计文件与 RunRecord 同源
  expect(readAudit(auditPath).ledgerStats).toEqual({
    ledgerHits: 1,
    ledgerMisses: 1,
    savedCharsEstimate: firstDiffResult.length,
  });
}, 120_000);

test("截断路径:phase-6 恒 complete:false → MAX_ROUNDS 上界,正常返回(退出码 0)+ truncated 留痕", async () => {
  const replies: FakeReply[] = [];
  for (let round = 0; round < 5; round++) {
    replies.push(
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: '{"candidates":[]}', usage: ZERO },
      { text: '{"verdicts":[],"complete":false}', usage: ZERO },
    );
  }
  const script = fakeFetch(replies);
  const runsRoot = tempRunsRoot();
  const { record, auditPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: "Truncation path MR under review.",
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
    // 请求预算放宽到「5 轮 × 6 相位」以隔离轮次上界（#55 起缺省 maxRequests=24
    // 会先于 5 轮上界收口）
    budget: { maxRequests: 30 },
  });

  // 5 轮 × 6 相位各一请求;runReview 正常返回(不抛——防御性路径退出码 0)
  expect(script.requests).toHaveLength(30);
  expect(record.baseline.rounds).toBe(5);
  expect(record.baseline.audit.truncated).toBe(true);
  expect(record.baseline.audit.truncationReasons).toEqual(["MAX_ROUNDS_REACHED"]);
  expect(record.baseline.toolCalls).toBe(0);
  const audit = readAudit(auditPath);
  expect(audit.truncated).toBe(true);
  expect(audit.truncationReasons).toEqual(["MAX_ROUNDS_REACHED"]);
  // phaseLog:5 轮 × 6 相位全留痕
  expect(record.baseline.audit.phaseLog).toHaveLength(30);
}, 180_000);

// ---- 网关注入透传（#4）：baseUrl/modelId 贯穿传输层与审计/RunRecord ----

test(
  "网关注入透传:baseUrl/modelId 贯穿请求 URL、wireBody 与审计/RunRecord model 字段",
  async () => {
    const GATEWAY_URL = "https://gw.example.com/v1";
    const script = fakeFetch(vul4j1Corpus());
    const { record, auditPath } = await runReview({
      caseId: "SAMPLE-GW",
      repoPath: repoFixturePath("sample"),
      diff: ["diff --git a/src/main/java/com/example/Beta.java b/src/main/java/com/example/Beta.java",
        "--- a/src/main/java/com/example/Beta.java",
        "+++ b/src/main/java/com/example/Beta.java",        "@@ -5,4 +5,4 @@",
        " context",
        "+changed",
      ].join("\n"),
      issueDescription: "Gateway passthrough MR under review.",
      apiKey: "sentinel-key",
      baseUrl: GATEWAY_URL,
      modelId: "custom-gateway-model",
      fetch: script.fetch,
      runsRoot: tempRunsRoot(),
      experimentId: "phase2-smoke",
      rep: 1,
    });

    // 传输层：六回合全部命中网关端点（${baseUrl}/chat/completions）
    expect(script.requests).toHaveLength(6);
    for (const request of script.requests) {
      expect(request.url).toBe(`${GATEWAY_URL}/chat/completions`);
    }

    // 审计与 RunRecord 只含 model（实际请求的 id），不含 baseUrl/key
    expect(record.model).toBe("custom-gateway-model");
    const audit = JSON.parse(readFileSync(auditPath, "utf8")) as {
      model: string;
      requests: { wireBody: string }[];
    };
    expect(audit.model).toBe("custom-gateway-model");
    for (const request of audit.requests) {
      expect(JSON.parse(request.wireBody).model).toBe("custom-gateway-model");
    }
  },
  300_000,
);
