import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { formatSmokeDiagnostics, resolveReviewerEndpoint, runSmokeProbes } from "review-pi";
import { hasReviewerApiKey } from "review-llm";
import type { ConfigId } from "../../src/instrument/contracts/config.js";
import type { MRCase } from "../../src/instrument/contracts/mr-case.js";
import { FakeLlmClient } from "../../src/fake/fake-llm-client.js";
import { piKernel } from "../../src/experiment/pi-kernel.js";
import type { ExperimentPlan } from "../../src/experiment/plan.js";
import { rebuildExperimentOutcome } from "../../src/experiment/report.js";
import {
  FAILURES_FILE,
  PLAN_FILE,
  loadPersistedCases,
  loadPersistedPlan,
  runExperiment,
} from "../../src/experiment/runner.js";
import { loadEnvLocalFile } from "../../src/instrument/env-local.js";

// #8 P4a 执行缝真跑验收：smoke 单案（VUL4J-38，data/vul4j/smoke-cases.json）
// × 配置 A–E × rep1，经 REVIEWER_URL 企业网关全链真跑——真 pi 内核
// （runReview）+ 真 fetch + 真仓库快照（Zone B/C 上下文构建 + 七工具），
// 实验面走 root runExperiment（记录唯一写者、plan/cases/failures 留痕）。
//
// 断言面（每配置 ≥1 单元经缝真跑成功 = 450 全量矩阵可跑性就绪的直接证明；
// 矩阵形状门见 tests/experiment/matrix-readiness.test.ts）：
// - 双探针先行（网关健康 + 模型可达，含静默错路由拦截），失败 → 人话诊断整体抛出；
// - 5 条 RunRecord 完整（模型/轮次/usage 对账），可被 rebuildExperimentOutcome
//   消费（analyze/report 的离线重建入口，--report-only 同路径）；
// - pi 审计文件在位：usage 与记录同源、requests[].wireBody 携带计划模型 id；
// - 密钥零留痕：plan/cases/failures/records/audits 落盘字节绝不包含 key 值；
// - 断点续跑：重跑同根 5 单元全跳过（注入抛错 fetch——任何网络调用即失败，
//   零预算烧穿防回归）。
//
// env 守卫：快照缺失 / REVIEWER_URL / API key 缺一即整档 skip（CI 上自动
// 跳过，全量证明以本地实跑为准）。密钥纪律：key 只进 Authorization 头与
// 内存，绝不进日志/断言输出/留痕文件。

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const EXPERIMENT_ID = "pi-seam-e2e-matrix";
const SEAM_CASE_ID = "VUL4J-38";
const MODEL_ID = "deepseek-v4-flash";
const CONFIGS: readonly ConfigId[] = ["A", "B", "C", "D", "E"];

// vitest 不自动读 .env.local——显式装载（显式环境变量优先，文件只补缺）
loadEnvLocalFile(path.join(REPO_ROOT, ".env.local"), process.env);

/** smoke 单案（repoPath 是 repo-root 相对——解析为绝对，防 CWD 漂移） */
function loadSeamCase(): MRCase | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(REPO_ROOT, "data", "vul4j", "smoke-cases.json"), "utf8")) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  const entry = raw.find(
    (candidate) =>
      typeof candidate === "object" && candidate !== null && (candidate as { caseId?: unknown }).caseId === SEAM_CASE_ID,
  );
  if (entry === undefined) {
    return null;
  }
  const mrCase = entry as MRCase;
  return { ...mrCase, repoPath: path.join(REPO_ROOT, mrCase.repoPath) };
}

const SEAM_CASE = loadSeamCase();

const SKIP_REASON = (() => {
  if (SEAM_CASE === null) {
    return `smoke case ${SEAM_CASE_ID} not found in data/vul4j/smoke-cases.json`;
  }
  if (!existsSync(SEAM_CASE.repoPath)) {
    return `repository snapshot missing (${SEAM_CASE.repoPath}) — run pnpm materialize:vul4j`;
  }
  if ((process.env.REVIEWER_URL ?? "").trim() === "") {
    return "REVIEWER_URL not set — this acceptance drives the enterprise gateway (set it in .env.local; the official DeepSeek endpoint is a different entry)";
  }
  if (!hasReviewerApiKey()) {
    return "no reviewer API key found (expected REVIEWER_API_KEY or the legacy DEEPSEEK_API_KEY)";
  }
  return null;
})();

if (SKIP_REASON !== null) {
  console.info(`[pi-seam-matrix] skipped: ${SKIP_REASON}`);
}

test.skipIf(SKIP_REASON !== null)(
  "执行缝真跑验收：VUL4J-38 × A–E × rep1 经 REVIEWER_URL 网关真跑（记录完整可被 analyze 消费 + 密钥零留痕 + 断点续跑）",
  async () => {
    expect(SEAM_CASE, "seam case").not.toBeNull();
    const mrCase = SEAM_CASE as MRCase;
    const endpoint = resolveReviewerEndpoint();

    // 双探针先行（一次，五配置共享）：网关健康 + 模型可达（含静默错路由拦截）
    const probes = await runSmokeProbes({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      modelId: MODEL_ID,
      fetch: globalThis.fetch,
    });
    if (!probes.ok) {
      throw new Error(
        `smoke probes failed — fix the gateway findings before spending budget on the matrix:\n${formatSmokeDiagnostics(probes)}`,
      );
    }
    console.info(`[pi-seam-matrix] probes ok:\n${formatSmokeDiagnostics(probes)}`);

    const experimentRoot = path.join(REPO_ROOT, "runs", EXPERIMENT_ID);
    // 自清理实验目录（本测试专属 id；重跑本地验收不被上次残留记录短路成 resumed）
    await rm(experimentRoot, { recursive: true, force: true });

    const plan: ExperimentPlan = {
      experimentId: EXPERIMENT_ID,
      sources: ["vul4j"],
      configs: [...CONFIGS],
      reps: 1,
      verifier: "off" as const,
      model: MODEL_ID,
      highRiskOnly: false,
      perSourceLimit: null,
      caseFilter: [SEAM_CASE_ID],
      judge: false,
      judgeModel: null,
      humanReviewRate: 0.1,
      humanReviewSeed: "pi-seam-e2e-2026",
      kernel: "pi" as const,
    };

    // 全链真跑：真 pi 内核经缝（piKernel 只注入网关端点与真 fetch）；
    // legacy llmClient 为零触达哨兵（pi 路径任何调用即抛错）
    const outcome = await runExperiment(
      plan,
      [mrCase],
      {
        llmClient: FakeLlmClient.fromResponses([]),
        kernel: piKernel({ apiKey: endpoint.apiKey, baseUrl: endpoint.baseUrl, fetch: globalThis.fetch }),
      },
      { experimentRoot },
    );

    // 5 单元全部经缝真跑成功（请求/轮次/工具调用数由模型行为驱动——断言取不变量）
    expect(outcome.executed).toBe(5);
    expect(outcome.resumed).toBe(0);
    expect(outcome.failures).toEqual([]);
    expect(outcome.records).toHaveLength(5);
    expect(outcome.records.map((record) => record.configId)).toEqual([...CONFIGS]);

    const auditPaths: string[] = [];
    const recordPaths: string[] = [];
    for (const record of outcome.records) {
      expect(record, `${record.configId} record`).toMatchObject({
        source: "vul4j",
        caseId: SEAM_CASE_ID,
        model: MODEL_ID,
        verifier: "off",
        rep: 1,
      });
      expect(record.baseline.rounds, `${record.configId} rounds`).toBeGreaterThanOrEqual(1);
      expect(record.baseline.rounds, `${record.configId} rounds`).toBeLessThanOrEqual(5);
      expect(record.baseline.usage.inputTokens, `${record.configId} input usage`).toBeGreaterThan(0);
      expect(record.baseline.usage.outputTokens, `${record.configId} output usage`).toBeGreaterThan(0);
      expect(typeof record.baseline.usage.cacheReadTokens).toBe("number");

      // pi 审计文件在位：usage 与记录同源、可重放字节携带计划模型 id
      expect(existsSync(record.baseline.auditPath), `${record.configId} audit file`).toBe(true);
      const audit = JSON.parse(readFileSync(record.baseline.auditPath, "utf8")) as {
        readonly model: string;
        readonly usage: unknown;
        readonly findings: readonly unknown[];
        readonly requests: readonly { readonly wireBody: string }[];
      };
      expect(audit.model).toBe(MODEL_ID);
      expect(audit.usage, `${record.configId} audit usage mirrors record`).toEqual(record.baseline.usage);
      expect(Array.isArray(audit.findings)).toBe(true);
      expect(audit.requests.length, `${record.configId} request count`).toBeGreaterThanOrEqual(6);
      const wire = JSON.parse(audit.requests[0]?.wireBody ?? "{}") as { readonly model?: string };
      expect(wire.model).toBe(MODEL_ID);

      auditPaths.push(record.baseline.auditPath);
      recordPaths.push(
        path.join(experimentRoot, "runs", "vul4j", SEAM_CASE_ID, record.configId, "rep-1.json"),
      );
    }

    // 记录可被 analyze/report 消费：--report-only 同一重建入口回读全部 5 条
    const rebuilt = await rebuildExperimentOutcome(
      experimentRoot,
      () => loadPersistedPlan(experimentRoot),
      () => loadPersistedCases(experimentRoot),
    );
    expect(rebuilt.records).toHaveLength(5);
    expect(rebuilt.resumed).toBe(5);
    expect(rebuilt.failures).toEqual([]);
    expect(rebuilt.skippedCorruptFiles).toEqual([]);
    expect(rebuilt.plan.kernel).toBe("pi");

    // 密钥零留痕哨兵：实验目录全部落盘产物（plan/cases/failures/记录/审计）
    // 的原始字节绝不包含 key 值
    const persistedFiles = [
      path.join(experimentRoot, PLAN_FILE),
      path.join(experimentRoot, "cases.json"),
      path.join(experimentRoot, FAILURES_FILE),
      ...recordPaths,
      ...auditPaths,
    ];
    for (const filePath of persistedFiles) {
      const text = readFileSync(filePath, "utf8");
      expect(text, `${path.relative(REPO_ROOT, filePath)} must not leak the API key`).not.toContain(endpoint.apiKey);
    }

    // 断点续跑：重跑同根 5 单元全跳过。fetch 换抛错哨兵——任何网络调用
    // 即失败（零预算烧穿的防回归：resume 逻辑若失效，此处立刻红）
    const resumedOutcome = await runExperiment(
      plan,
      [mrCase],
      {
        llmClient: FakeLlmClient.fromResponses([]),
        kernel: piKernel({
          apiKey: endpoint.apiKey,
          baseUrl: endpoint.baseUrl,
          fetch: async () => {
            throw new Error("pi seam e2e: unexpected network call during the resume run — resume must skip completed units");
          },
        }),
      },
      { experimentRoot },
    );
    expect(resumedOutcome.resumed).toBe(5);
    expect(resumedOutcome.executed).toBe(0);
    expect(resumedOutcome.failures).toEqual([]);

    const totalUsage = outcome.records.reduce(
      (total, record) => ({
        input: total.input + record.baseline.usage.inputTokens,
        output: total.output + record.baseline.usage.outputTokens,
      }),
      { input: 0, output: 0 },
    );
    console.info(
      `[pi-seam-matrix] ${SEAM_CASE_ID} × A–E × rep1 via ${endpoint.baseUrl} (${MODEL_ID}): 5/5 units OK; ` +
        `total usage input ${totalUsage.input} / output ${totalUsage.output}; experiment root ${path.relative(REPO_ROOT, experimentRoot)}`,
    );
    for (const record of outcome.records) {
      const usage = record.baseline.usage;
      console.info(
        `  ${record.configId}: rounds ${record.baseline.rounds}, toolCalls ${record.baseline.toolCalls}, ` +
          `usage ${usage.inputTokens}/${usage.outputTokens}/${usage.cacheReadTokens ?? 0}, ` +
          `audit ${path.relative(REPO_ROOT, record.baseline.auditPath)}`,
      );
    }
  },
  45 * 60_000,
);
