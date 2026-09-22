import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Finding } from "../../src/instrument/contracts/finding.js";
import type { ToolCallRecord, RunResult } from "../../src/instrument/contracts/run.js";
import { FakeJudgeClient } from "../../src/judge/fake-judge-client.js";
import { FAILURES_FILE, loadPersistedCases, loadPersistedPlan, runExperiment } from "../../src/experiment/runner.js";
import {
  JudgeStore,
  buildExperimentReport,
  persistExperimentReport,
  rebuildExperimentOutcome,
} from "../../src/experiment/report.js";
import type { ExperimentReport } from "../../src/experiment/report.js";
import { toRunSnapshot } from "../../src/experiment/run-store.js";
import { RunStore } from "../../src/experiment/run-store.js";
import type { RunRecord, RunSnapshot, VerifierRecord } from "../../src/experiment/run-store.js";
import { renderDashboardMarkdown } from "../../src/experiment/dashboard.js";
import type { ExperimentSource, RunUnit } from "../../src/experiment/plan.js";
import {
  HAPPY_KERNEL_RESULT,
  experimentCleanCase,
  experimentMainCase,
  experimentPlan,
  happyKernel,
  judgeAdjudication,
  scriptedKernel,
} from "./helpers.js";

/**
 * 实验报告装配（Ticket 12 / issue #13 验收）：
 * 分层指标（rep1 冷单列 / rep2+ 热主口径）+ S/A/B 判定（锚 C）+ 阴性对照 +
 * Verifier 消融（历史 legacy 记录的读面，#9 后执行面已退役）+ Ledger 去重 +
 * judge 判定链（断点续跑）+ 10% 人工抽检（种子确定性）+ 报告落盘 +
 * --report-only 重建。零网络：fake 内核 / FakeJudgeClient。
 */

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "review-agent-report-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** verifier 恒 off（pi 内核 baseline-only，#9）——报告主口径 = 单遍基线 */
const REPORT_PLAN = experimentPlan({
  experimentId: "report-integration",
  configs: ["A", "C"],
  reps: 3,
  judge: true,
});

/** 集成夹具：1 主集 case + 1 clean MR × {A, C} × 3 rep */
async function runIntegrationFixture(): Promise<{
  readonly report: ExperimentReport;
  readonly experimentRoot: string;
}> {
  const cases = [experimentMainCase("rep-main-1"), experimentCleanCase("rep-clean-1")];
  const experimentRoot = path.join(workDir, "integration");
  const outcome = await runExperiment(REPORT_PLAN, cases, {
    kernel: happyKernel(12).kernel,
  }, { experimentRoot });
  expect(outcome.failures).toEqual([]);
  const judgeClient = FakeJudgeClient.fromAdjudications(
    Array.from({ length: 6 }, () => judgeAdjudication()),
  );
  const report = await buildExperimentReport(outcome, { judgeClient }, { experimentRoot });
  return { report, experimentRoot };
}

describe("buildExperimentReport（集成：指标 / 判定 / 阴性对照）", () => {
  let report: ExperimentReport;
  let judgeCallCount: number;

  // 夹具 = 完整实验（2 case × {A,C} × 3 rep）+ 报告装配，满套件
  // 并行下可超默认 hookTimeout（#29 曾按文件显式放宽到 60s，高负载下仍可超）——
  // 现由 vitest.config.ts 的全局 hookTimeout（120s 有界）统一覆盖
  beforeAll(async () => {
    const cases = [experimentMainCase("rep-main-1"), experimentCleanCase("rep-clean-1")];
    const experimentRoot = path.join(workDir, "integration");
    const outcome = await runExperiment(REPORT_PLAN, cases, {
      kernel: happyKernel(12).kernel,
    }, { experimentRoot });
    expect(outcome.failures).toEqual([]);
    judgeClientRef = FakeJudgeClient.fromAdjudications(
      Array.from({ length: 6 }, () => judgeAdjudication()),
    );
    report = await buildExperimentReport(outcome, { judgeClient: judgeClientRef }, { experimentRoot });
    judgeCallCount = judgeClientRef.callCount;
  });

  it("主集/clean 分箱与基础计数", () => {
    expect(report.caseCount).toBe(1); // 主集
    expect(report.negativeControlCaseCount).toBe(1); // clean MR
    expect(report.executed).toBe(12);
    expect(report.failed).toBe(0);
  });

  it("分层指标：rep1 冷单列、rep2+ 热主口径（config A 与 C 都有）", () => {
    expect(report.metrics).not.toBeNull();
    const perConfig = report.metrics?.perConfig ?? {};
    for (const configId of ["A", "C"] as const) {
      const summary = perConfig[configId];
      expect(summary, `config ${configId} summary`).toBeDefined();
      expect(summary?.caseCount).toBeGreaterThan(0);
      expect(summary?.cold).not.toBeNull(); // rep1 单列
      expect(summary?.hot).not.toBeNull(); // rep2+（case 级聚合：1 个 case 的热均值 = 1 个样本）
      expect(summary?.hot?.sampleCount).toBe(1);
      // 快乐路径 Finding 命中唯一真值位置 → recall = 1（热口径均值）
      const hotRecall = summary?.hot?.values.lineRecall ?? null;
      expect(hotRecall?.mean).toBe(1);
      expect(hotRecall?.std).toBe(0);
    }
  });

  it("S/A/B 判定：锚 = config C（热口径）；判据明细齐全", () => {
    expect(report.verdicts).not.toBeNull();
    expect(report.verdicts?.anchorConfigId).toBe("C");
    expect(report.verdicts?.anchorAvailable).toBe(true);
    const verdicts = report.verdicts?.verdicts ?? [];
    expect(verdicts.map((verdict) => verdict.configId)).toEqual(["A", "C"]);
    for (const verdict of verdicts) {
      // S 级 4 判据（Recall/Precision/Token/Cache，ADR-0004）+ A/B 各 3 判据 = 10
      expect(verdict.criteria).toHaveLength(10);
      expect(verdict.anchor.configId).toBe("C");
    }
    // 脚本化 usage：A 与 C 的 token 相同 → Token ≤ C×30% 不可能通过 → BELOW_B（可复现的算术）
    expect(verdicts[0]?.outcome).toBe("BELOW_B");
  });

  it("阴性对照：clean MR 每 Finding 计 1 FP（不进主指标）", () => {
    expect(report.negativeControl).not.toBeNull();
    expect(report.negativeControl?.caseCount).toBe(1);
    for (const entry of report.negativeControl?.perConfig ?? []) {
      expect(["A", "C"]).toContain(entry.configId);
      expect(entry.caseCount).toBe(1);
      expect(entry.totalFalsePositives).toBe(3); // 3 rep × 1 finding
      const stat = entry.falsePositivesPerCase.values.lineFp;
      expect(stat?.mean).toBe(1);
      expect(stat?.std).toBe(0);
    }
    expect(report.negativeControl?.perConfig).toHaveLength(2);
  });

  it("verifier 恒 off（#9 pi baseline-only）：无消融对照（读面消费历史记录见下方专测）", () => {
    expect(report.verifierAblation).toBeNull();
  });

  it("judge 判定链：主集 judged、clean MR skipped-clean-mr、repIndex 回填", () => {
    const judge = report.judge;
    expect(judge).not.toBeNull();
    expect(judge?.runCount).toBe(12);
    expect(judge?.judgedCount).toBe(6); // 主集 A×3 + C×3
    expect(judge?.skippedCleanMrCount).toBe(6); // clean MR 不经 judge
    expect(judge?.skippedNoFindingsCount).toBe(0);
    expect(judge?.errorCount).toBe(0);
    expect(judgeCallCount).toBe(6); // fake judge 恰好 6 次调用
    const mainResults = (judge?.results ?? []).filter(
      (result) => result.caseId === "rep-main-1",
    );
    expect(mainResults.map((result) => result.repIndex).sort()).toEqual([0, 0, 1, 1, 2, 2]);
    for (const configId of ["A", "C"] as const) {
      const entry = judge?.perConfig.find((candidate) => candidate.configId === configId);
      expect(entry?.runCount).toBe(6); // 主集 3 + clean 3
      expect(entry?.rule.values.lineRecall?.mean).toBe(1);
      expect(entry?.judge.values.lineRecall?.mean).toBe(1); // judge 裁定命中
    }
  });

  it("人工抽检：种子确定性 + 比例覆盖", () => {
    const humanReview = report.humanReview;
    expect(humanReview).not.toBeNull();
    expect(humanReview?.seed).toBe(REPORT_PLAN.humanReviewSeed);
    expect(humanReview?.rate).toBe(0.1);
    expect(humanReview?.totalUnits).toBe(12); // 主集 6 + clean 6
    expect(humanReview?.selectedUnits.length).toBeGreaterThanOrEqual(1);
    expect(humanReview?.forms).toHaveLength(humanReview?.selectedUnits.length ?? 0);
    for (const form of humanReview?.forms ?? []) {
      expect(form.protocolVersion).toBe("1");
      expect(humanReview?.selectedUnits).toContain(form.unitKey);
      expect(form.items.length).toBeGreaterThan(0);
    }
  });
});

let judgeClientRef: FakeJudgeClient;

describe("judge 判定链断点续跑（JudgeStore 落盘）", () => {
  it("同实验重建报告：judge 结果全部命中缓存（零 judge 调用）", async () => {
    const cases = [experimentMainCase("rep-main-1"), experimentCleanCase("rep-clean-1")];
    const experimentRoot = path.join(workDir, "integration");
    // 检视记录全部续跑：内核零调用（预算哨兵——任何执行都会耗尽脚本抛错）
    const outcome = await runExperiment(REPORT_PLAN, cases, {
      kernel: happyKernel(0).kernel,
    }, { experimentRoot });
    expect(outcome.resumed).toBe(12);
    expect(outcome.executed).toBe(0);
    // 空 steps 的 fake judge：任何真实调用都会抛 JudgeScriptExhaustedError → error 口径；
    // 缓存命中则零调用
    const emptyJudge = FakeJudgeClient.fromAdjudications([]);
    const rebuilt = await buildExperimentReport(
      outcome,
      { judgeClient: emptyJudge },
      { experimentRoot },
    );
    expect(emptyJudge.callCount).toBe(0);
    expect(rebuilt.judge?.judgedCount).toBe(6);
    expect(rebuilt.judge?.runCount).toBe(12);
    expect(rebuilt.judge?.errorCount).toBe(0);
  });

  it("JudgeStore 落盘路径与形状（judge/<source>/<caseId>/<configId>/rep-<rep>.json）", async () => {
    const store = new JudgeStore(path.join(workDir, "integration", "judge"));
    const filePath = store.pathOf({
      source: "defects4j",
      caseId: "rep-main-1",
      configId: "A",
      rep: 1,
    });
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as {
      readonly status: string;
      readonly repIndex: number;
    };
    expect(parsed.status).toBe("judged");
    expect(parsed.repIndex).toBe(0);
  });
});

describe("报告落盘与重建", () => {
  it("persistExperimentReport：report.json + human-review/forms.json", async () => {
    const { report, experimentRoot } = await runIntegrationFixture();
    await persistExperimentReport(experimentRoot, report);
    const persisted = JSON.parse(
      await readFile(path.join(experimentRoot, "report.json"), "utf8"),
    ) as { readonly experimentId: string; readonly metrics: unknown };
    expect(persisted.experimentId).toBe("report-integration");
    expect(persisted.metrics).toBeDefined();
    const forms = JSON.parse(
      await readFile(path.join(experimentRoot, "human-review", "forms.json"), "utf8"),
    ) as { readonly seed: string; readonly forms: readonly unknown[] };
    expect(forms.seed).toBe(REPORT_PLAN.humanReviewSeed);
    expect(forms.forms).toHaveLength(report.humanReview?.forms.length ?? 0);
  });

  it("rebuildExperimentOutcome：从落盘产物重建（--report-only 数据面）", async () => {
    const { report, experimentRoot } = await runIntegrationFixture();
    await persistExperimentReport(experimentRoot, report);
    const outcome = await rebuildExperimentOutcome(
      experimentRoot,
      () => loadPersistedPlan(experimentRoot),
      () => loadPersistedCases(experimentRoot),
    );
    expect(outcome.plan.experimentId).toBe("report-integration");
    expect(outcome.cases.map((mrCase) => mrCase.caseId)).toEqual(["rep-main-1", "rep-clean-1"]);
    expect(outcome.records).toHaveLength(12);
    expect(outcome.resumed).toBe(12);
    expect(outcome.executed).toBe(0);
    expect(outcome.failures).toEqual([]);
    // 重建 outcome 可再次装配出等价的报告
    const rebuilt = await buildExperimentReport(outcome, {}, { experimentRoot });
    expect(rebuilt.caseCount).toBe(report.caseCount);
    expect(rebuilt.judge).toBeNull(); // 未提供 judgeClient
    expect(rebuilt.humanReview).not.toBeNull(); // 抽检仍可基于规则口径构建
  });

  it("重建读取 failures.json 留痕", async () => {
    const experimentRoot = path.join(workDir, "with-failures");
    const cases = [experimentMainCase("fail-main-1"), experimentMainCase("fail-main-2")];
    const { kernel } = scriptedKernel([
      { kind: "result", result: HAPPY_KERNEL_RESULT },
      { kind: "fail", error: new Error("boom") },
    ]);
    const outcome = await runExperiment(
      experimentPlan({ experimentId: "with-failures" }),
      cases,
      { kernel },
      { experimentRoot },
    );
    expect(outcome.failures).toHaveLength(1);
    const failures = JSON.parse(
      await readFile(path.join(experimentRoot, FAILURES_FILE), "utf8"),
    ) as readonly { readonly caseId: string }[];
    expect(failures).toHaveLength(1);
    const rebuilt = await rebuildExperimentOutcome(
      experimentRoot,
      () => loadPersistedPlan(experimentRoot),
      () => loadPersistedCases(experimentRoot),
    );
    expect(rebuilt.failures.map((failure) => failure.caseId)).toEqual(["fail-main-2"]);
  });

  it("重建遇损坏记录：不静默丢弃——skippedCorruptFiles 上报，报告与 dashboard 留痕", async () => {
    const experimentRoot = path.join(workDir, "with-corrupt");
    const outcome = await runExperiment(
      experimentPlan({ experimentId: "with-corrupt" }),
      [experimentMainCase("corrupt-main-1")],
      { kernel: happyKernel(1).kernel },
      { experimentRoot },
    );
    expect(outcome.failures).toEqual([]);
    // 覆写唯一一条记录为损坏 JSON → 重建时视同未完成，但不再静默丢弃
    const store = new RunStore(path.join(experimentRoot, "runs"));
    const unit: RunUnit = { source: "defects4j", caseId: "corrupt-main-1", configId: "A", rep: 1 };
    await writeFile(store.pathOf(unit), "{ not json", "utf8");
    const rebuilt = await rebuildExperimentOutcome(
      experimentRoot,
      () => loadPersistedPlan(experimentRoot),
      () => loadPersistedCases(experimentRoot),
    );
    expect(rebuilt.records).toHaveLength(0);
    expect(rebuilt.skippedCorruptFiles).toEqual([
      path.join("defects4j", "corrupt-main-1", "A", "rep-1.json"),
    ]);
    const report = await buildExperimentReport(rebuilt, {}, { experimentRoot });
    expect(report.corruptRecordFiles).toEqual(rebuilt.skippedCorruptFiles);
    const markdown = renderDashboardMarkdown(report);
    expect(markdown).toContain(
      "## Corrupt run records (1; treated as incomplete, rerun overwrites)",
    );
  });
});

// ===== 手工记录（无需执行的定向断言：Verifier 消融读面 / Ledger 去重 / 边界） =====

function craftRecord(
  unit: { readonly source: ExperimentSource; readonly caseId: string; readonly configId: "A" | "B" | "C" | "D" | "E"; readonly rep: number },
  findings: readonly Finding[],
  toolCallLog: readonly ToolCallRecord[],
): RunRecord {
  const result: RunResult = {
    caseId: unit.caseId,
    configId: unit.configId,
    findings,
    usage: { inputTokens: 100, outputTokens: 10 },
    rounds: 1,
    toolCalls: toolCallLog.length,
    audit: {
      requests: [],
      toolCallLog,
      phaseLog: [],
      rejections: [],
      cacheBreaks: [],
      truncated: false,
      truncationReasons: [],
    },
    auditPath: "unused.json",
  };
  return {
    source: unit.source,
    caseId: unit.caseId,
    configId: unit.configId,
    rep: unit.rep,
    model: "deepseek-v4-flash",
    verifier: "off",
    completedAt: "2026-09-04T00:00:00.000Z",
    baseline: toRunSnapshot(result),
    effective: null,
    verifierPass: null,
  };
}

/**
 * 历史 legacy 记录（verifier=on，#9 后执行面退役——报告读面仍按冻结契约消费）：
 * baseline = 快乐路径基线；verifierPass = 逐 Finding 裁定（+50 输入 / +5 输出）；
 * effective = 复核后 Finding + 合并 usage（token 计入 CARC 的口径）。
 */
function craftVerifierOnRecord(
  unit: { readonly source: ExperimentSource; readonly caseId: string; readonly configId: "A" | "B" | "C" | "D" | "E"; readonly rep: number },
  options: { readonly removeFinding?: boolean } = {},
): RunRecord {
  const baseline: RunSnapshot = toRunSnapshot({
    ...HAPPY_KERNEL_RESULT,
    caseId: unit.caseId,
    configId: unit.configId,
  });
  const removed = options.removeFinding ?? false;
  const verifierPass: VerifierRecord = {
    status: "verified",
    errorMessage: null,
    verdicts: [
      {
        id: "F001",
        pass: !removed,
        reason: removed
          ? "No concrete support in the diff."
          : "The diff excerpt directly supports the finding.",
      },
    ],
    removedFindingIds: removed ? ["F001"] : [],
    unverifiedFindingIds: [],
    usage: { inputTokens: 50, outputTokens: 5 },
  };
  const effective: RunSnapshot = {
    ...baseline,
    findings: removed ? [] : baseline.findings,
    usage: {
      inputTokens: baseline.usage.inputTokens + 50,
      outputTokens: baseline.usage.outputTokens + 5,
      ...(baseline.usage.cacheReadTokens !== undefined
        ? { cacheReadTokens: baseline.usage.cacheReadTokens }
        : {}),
      ...(baseline.usage.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: baseline.usage.cacheWriteTokens }
        : {}),
    },
  };
  return {
    source: unit.source,
    caseId: unit.caseId,
    configId: unit.configId,
    rep: unit.rep,
    model: "deepseek-v4-flash",
    verifier: "on",
    completedAt: "2026-09-04T00:00:00.000Z",
    baseline,
    effective,
    verifierPass,
  };
}

describe("Verifier 消融读面（历史 legacy 记录；#9 后执行面退役、记录契约冻结）", () => {
  it("verifier=on 历史记录：off 档 = 基线、on 档 = 复核后 + 合并 usage（token 计入 CARC）", async () => {
    const case_ = experimentMainCase("vf-ablation-1");
    const records = [1, 2, 3].map((rep) =>
      craftVerifierOnRecord({ source: "defects4j", caseId: "vf-ablation-1", configId: "A", rep }),
    );
    const report = await buildExperimentReport(
      {
        plan: experimentPlan({
          experimentId: "vf-ablation",
          kernel: "legacy",
          verifier: "on",
          configs: ["A"],
        }),
        records,
        cases: [case_],
        executed: records.length,
        resumed: 0,
        failures: [],
      },
      {},
      { experimentRoot: path.join(workDir, "vf-ablation") },
    );
    expect(report.verifierAblation).not.toBeNull();
    const entry = report.verifierAblation?.perConfig[0];
    expect(entry).toMatchObject({ configId: "A", removedFindings: 0 });
    // verifier 每单元 +50 输入 / +5 输出；3 单元合计 150 / 15
    expect(entry?.verifierTokens).toEqual({ input: 150, output: 15 });
    expect(entry?.off).not.toBeNull();
    expect(entry?.on).not.toBeNull();
    // 合并 usage：on 档总 token = 基线 + 55/单元 × 3（热口径均值同算术）
    const offTokens = entry?.off?.totalTokens ?? null;
    const onTokens = entry?.on?.totalTokens ?? null;
    expect(offTokens).toBe(
      HAPPY_KERNEL_RESULT.usage.inputTokens +
        (HAPPY_KERNEL_RESULT.usage.cacheReadTokens ?? 0) +
        (HAPPY_KERNEL_RESULT.usage.cacheWriteTokens ?? 0) +
        HAPPY_KERNEL_RESULT.usage.outputTokens,
    );
    expect(onTokens).toBe((offTokens ?? 0) + 55);
  });

  it("复核剔除的历史记录：removedFindings 计数 + effective.findings 为空（基线保留对照）", async () => {
    const case_ = experimentMainCase("vf-remove-1");
    const records = [1, 2].map((rep) =>
      craftVerifierOnRecord(
        { source: "defects4j", caseId: "vf-remove-1", configId: "A", rep },
        { removeFinding: true },
      ),
    );
    const report = await buildExperimentReport(
      {
        plan: experimentPlan({
          experimentId: "vf-remove",
          kernel: "legacy",
          verifier: "on",
          configs: ["A"],
        }),
        records,
        cases: [case_],
        executed: records.length,
        resumed: 0,
        failures: [],
      },
      {},
      { experimentRoot: path.join(workDir, "vf-remove") },
    );
    expect(report.verifierAblation?.perConfig[0]).toMatchObject({
      configId: "A",
      removedFindings: 2, // 2 rep × 各剔除 1 条
    });
    // on 档（复核后）零命中；off 档（基线）保留对照口径
    expect(report.verifierAblation?.perConfig[0]?.on?.lineRecall).toBe(0);
    expect(report.verifierAblation?.perConfig[0]?.off?.lineRecall).toBe(1);
  });
});

describe("Ledger 去重统计（toolCallLog 前缀口径）", () => {
  it("dedupCalls 计 \"Already loaded: ctx#\" 前缀调用，ratio = dedup/toolCalls", async () => {
    const case_ = experimentMainCase("dedup-main-1");
    const records = [
      craftRecord(
        { source: "defects4j", caseId: "dedup-main-1", configId: "E", rep: 1 },
        [HAPPY_KERNEL_RESULT.findings[0] as Finding],
        [
          { name: "review.get_file", argumentsJson: "{}", resultSummary: "Loaded src/Foo.java (30 lines)." },
          { name: "review.get_file", argumentsJson: "{}", resultSummary: "Already loaded: ctx#001" },
          { name: "review.get_symbol", argumentsJson: "{}", resultSummary: "Already loaded: ctx#002" },
        ],
      ),
      craftRecord(
        { source: "defects4j", caseId: "dedup-main-1", configId: "E", rep: 2 },
        [HAPPY_KERNEL_RESULT.findings[0] as Finding],
        [{ name: "review.get_file", argumentsJson: "{}", resultSummary: "Loaded src/Bar.java (10 lines)." }],
      ),
    ];
    const report = await buildExperimentReport(
      {
        plan: experimentPlan({ experimentId: "dedup-craft", configs: ["E"] }),
        records,
        cases: [case_],
        executed: records.length,
        resumed: 0,
        failures: [],
      },
      {},
      { experimentRoot: path.join(workDir, "dedup-craft") },
    );
    expect(report.dedup).toHaveLength(1);
    expect(report.dedup[0]).toMatchObject({ configId: "E", toolCalls: 4, dedupCalls: 2 });
    expect(report.dedup[0]?.dedupRatio).toBe(0.5);
    expect(report.verifierAblation).toBeNull(); // verifier off → 无消融对照
    expect(report.negativeControl).toBeNull(); // 无 clean case
  });

  it("clean MR 零 Finding：FP=0 计入阴性对照（零 finding ≠ 无记录）", async () => {
    const clean = experimentCleanCase("dedup-clean-1");
    const records = [
      craftRecord({ source: "clean-mr", caseId: "dedup-clean-1", configId: "A", rep: 1 }, [], []),
      craftRecord({ source: "clean-mr", caseId: "dedup-clean-1", configId: "A", rep: 2 }, [], []),
    ];
    const report = await buildExperimentReport(
      {
        plan: experimentPlan({ experimentId: "clean-zero", configs: ["A"] }),
        records,
        cases: [clean],
        executed: records.length,
        resumed: 0,
        failures: [],
      },
      {},
      { experimentRoot: path.join(workDir, "clean-zero") },
    );
    expect(report.metrics).toBeNull(); // 无主集 case
    expect(report.verdicts).toBeNull();
    expect(report.negativeControl?.perConfig[0]).toMatchObject({
      configId: "A",
      caseCount: 1,
      totalFalsePositives: 0,
    });
    // 零 finding 的主集判定链场景由 judge 阶段覆盖（skipped-no-findings）
  });
});
