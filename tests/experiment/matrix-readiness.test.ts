import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MRCase } from "../../src/instrument/contracts/mr-case.js";
import type { ExperimentPlan } from "../../src/experiment/plan.js";
import { expandPlan } from "../../src/experiment/plan.js";

/**
 * 450 全量矩阵就绪断言（#8 P4a 验收，离线纯函数——CI 常开）：
 * data/vul4j/target-cases.json（30 案）× 配置 A–E × 3 reps = 450 单元，
 * 零跳过（每案 allowedConfigs ⊇ A–E、vul4j 入选、riskClass 过滤关闭）。
 * 这是 P5a 全量烧预算的矩阵形状门——数据集或计划形态的静默缩水
 * （案数、allowedConfigs、配置清单）在此被钉住。经缝真跑证明（每配置
 * ≥1 单元真跑成功）见 tests/e2e/pi-seam-matrix.e2e.ts（gated，本地实跑）。
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** P5a 全量矩阵的计划形态（kernel 必填——缺省 pi，P4b 唯一可执行内核） */
function fullMatrixPlan(kernel: ExperimentPlan["kernel"] = "pi"): ExperimentPlan {
  return {
    experimentId: "matrix-readiness",
    sources: ["vul4j"],
    configs: ["A", "B", "C", "D", "E"],
    reps: 3,
    verifier: "off",
    model: "deepseek-v4-flash",
    kernel,
    highRiskOnly: false,
    perSourceLimit: null,
    caseFilter: [],
    judge: false,
    judgeModel: null,
    humanReviewRate: 0.1,
    humanReviewSeed: "matrix-readiness-2026",
  };
}

async function loadTargetCases(): Promise<readonly MRCase[]> {
  const raw = JSON.parse(
    await readFile(path.join(REPO_ROOT, "data", "vul4j", "target-cases.json"), "utf8"),
  ) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error("data/vul4j/target-cases.json must contain a JSON array of MRCase");
  }
  return raw as readonly MRCase[];
}

describe("450 全量矩阵就绪（expandPlan 纯函数）", () => {
  it("target-cases 30 案 × A–E × 3 reps = 450 单元，零跳过（历史/现行计划同形）", async () => {
    const cases = await loadTargetCases();
    expect(cases).toHaveLength(30);
    // 每案 allowedConfigs ⊇ A–E（快照本体不在断言面：快照目录 gitignored、
    // CI 不物化——物化欠账是 P5a 烧预算前的独立前置，e2e 侧以快照缺失即 skip 守卫）
    for (const mrCase of cases) {
      expect(mrCase.labels.allowedConfigs, `${mrCase.caseId} allowedConfigs`).toEqual(
        expect.arrayContaining(["A", "B", "C", "D", "E"]),
      );
    }

    // 矩阵形状与内核取值无关：legacy（#9 后只读的历史计划值）与 pi 展开同一 450
    for (const kernel of ["legacy", "pi"] as const) {
      const expanded = expandPlan(fullMatrixPlan(kernel), cases);
      expect(expanded.cases, `kernel=${kernel} cases`).toHaveLength(30);
      expect(expanded.units, `kernel=${kernel} units`).toHaveLength(450);
      expect(expanded.skipped, `kernel=${kernel} skipped`).toEqual([]);
    }
  });

  it("单元展开口径：案 → 配置 → rep 三层嵌套，(case, config) 分组内 rep 升序", async () => {
    const cases = await loadTargetCases();
    const expanded = expandPlan(fullMatrixPlan(), cases);
    const first = expanded.units[0];
    expect(first).toMatchObject({ source: "vul4j", caseId: cases[0]?.caseId, configId: "A", rep: 1 });
    // 每案每配置恰好 3 个 rep（1–3），共 30 × 5 组
    const groups = new Map<string, number[]>();
    for (const unit of expanded.units) {
      const key = `${unit.caseId}/${unit.configId}`;
      groups.set(key, [...(groups.get(key) ?? []), unit.rep]);
    }
    expect(groups.size).toBe(150);
    for (const [key, reps] of groups) {
      expect(reps, `${key} reps`).toEqual([1, 2, 3]);
    }
  });
});
