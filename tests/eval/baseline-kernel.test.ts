import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { baselineSubprocessKernel } from "../../src/eval/assembly/baseline-kernel.js";
import { createRealCampaignDeps } from "../../src/eval/assembly/deps.js";
import type { UnitReviewRequest } from "../../src/gate/review-kernel.js";

// baseline 臂子进程内核（#49 质量验证准备）：跨 commit L2 的 baseline runner。
// 测试用 fake runner 脚本（零网络），只验证 spawn/stdin/结果映射与 arm 注入。

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-baseline-kernel-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const REQUEST: UnitReviewRequest = {
  unit: { source: "vul4j", caseId: "VUL4J-1", configId: "E", rep: 1 },
  mrCase: {
    caseId: "VUL4J-1",
    repoPath: "/repo",
    diff: "diff",
    issueDescription: "issue",
    truth: null,
    labels: { source: "vul4j", riskClass: "High", allowedConfigs: ["E"] },
  },
  model: "deepseek-v4-flash",
  experimentRoot: "/runs/exp",
};

const FAKE_RESULT = {
  runId: "fake",
  recordPath: "",
  auditPath: "/runs/exp/audit.json",
  record: {
    source: "vul4j",
    caseId: "VUL4J-1",
    configId: "E",
    rep: 1,
    model: "deepseek-v4-flash",
    verifier: "off",
    completedAt: "2026-11-13T00:00:00.000Z",
    effective: null,
    verifierPass: null,
    baseline: {
      findings: [],
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 },
      rounds: 1,
      toolCalls: 0,
      auditPath: "/runs/exp/audit.json",
      audit: {
        toolCallLog: [],
        phaseLog: [],
        rejections: [],
        truncated: false,
        truncationReasons: [],
      },
    },
  },
};

function fakeRunner(dir: string): string {
  const runnerPath = path.join(dir, "fake-runner.mjs");
  writeFileSync(
    runnerPath,
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      'JSON.parse(readFileSync(0, "utf8"));',
      `writeFileSync(process.argv[2], JSON.stringify(${JSON.stringify(FAKE_RESULT)}));`,
    ].join("\n"),
    "utf8",
  );
  return runnerPath;
}

it("baseline 子进程内核：结果映射为 root RunResult，且临时结果文件清理", async () => {
  const dir = tempDir();
  const kernel = baselineSubprocessKernel({
    repoPath: dir,
    apiKey: "offline-test",
    runnerPath: fakeRunner(dir),
  });
  const result = await kernel.execute(REQUEST);
  expect(result).toMatchObject({
    caseId: "VUL4J-1",
    configId: "E",
    model: "deepseek-v4-flash",
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 },
    rounds: 1,
    toolCalls: 0,
    auditPath: "/runs/exp/audit.json",
    audit: { requests: [], truncated: false, truncationReasons: [] },
  });
  // 结果文件目录为空（finally 清理）
  const resultsDir = path.join(dir, ".tmp-gen", "baseline-kernel-results");
  expect(existsSync(resultsDir) ? readdirSync(resultsDir) : []).toEqual([]);
});

it("真实装配：提供 baselineRepoPath 时按 arm 注入 baseline / candidate 内核", () => {
  const deps = createRealCampaignDeps({
    model: "deepseek-v4-flash",
    judgeModel: "glm-5.2",
    reviewerApiKey: "offline-test",
    judgeApiKey: "offline-test",
    baselineRepoPath: tempDir(),
    baselineRef: "eval-e-baseline-2026-11-11",
  });
  expect(deps.armKernels?.baseline).toBeDefined();
  expect(deps.armKernels?.candidate).toBe(deps.kernel);
});
