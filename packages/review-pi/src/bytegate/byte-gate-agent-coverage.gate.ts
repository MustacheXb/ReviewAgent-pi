import { expect, test } from "vitest";
import { discoverGateRecords } from "./ground-truth.js";
import { RUNS_ROOT } from "./gate-runner.js";

// P3a 语义等价门(#6)——C/D/E 覆盖完整性(防真源部分缺席时门静默缩水)。
//
// 票面冻结范围:phase2-dsh-t{1..5} × C/D/E × 3 rep = 270 记录;各实验案集合
// 冻结且不等宽(t1=5 案、t2/t3/t5=6 案、t4=7 案——真源盘点 2026-09-20)
// (A/B 字节门面另见 byte-gate-coverage.gate.ts,30 案口径)。
// per-experiment agent 门文件只对照各自发现的记录——某实验/记录缺席时
// 该文件零测试空转,本文件把总账。真源整体缺席(CI:runs/ gitignored)
// → 整档 skip。

const T_SERIES = ["phase2-dsh-t1", "phase2-dsh-t2", "phase2-dsh-t3", "phase2-dsh-t4", "phase2-dsh-t5"] as const;
const EXPECTED_RECORD_COUNT = 270;
/** 各实验冻结记录数 = 案数 × C/D/E(3) × rep(3) */
const EXPECTED_PER_EXPERIMENT: Readonly<Record<string, number>> = {
  "phase2-dsh-t1": 45, // 5 案
  "phase2-dsh-t2": 54, // 6 案
  "phase2-dsh-t3": 54, // 6 案
  "phase2-dsh-t4": 63, // 7 案
  "phase2-dsh-t5": 54, // 6 案
};

const refs = discoverGateRecords(RUNS_ROOT, ["C", "D", "E"]);

test.skipIf(refs.length === 0)(
  "C/D/E 真源覆盖完整:t1-t5 × 各实验冻结案集合 × C/D/E × 3 rep = 270",
  () => {
    const experiments = [...new Set(refs.map((ref) => ref.experimentId))];
    expect(
      experiments,
      `缺席实验: ${T_SERIES.filter((id) => !experiments.includes(id)).join(", ") || "无"}`,
    ).toEqual([...T_SERIES]);

    expect(
      refs,
      `记录数 ${refs.length} ≠ ${EXPECTED_RECORD_COUNT}(真源部分缺席)`,
    ).toHaveLength(EXPECTED_RECORD_COUNT);

    const perExperiment = new Map<string, number>();
    for (const ref of refs) {
      perExperiment.set(ref.experimentId, (perExperiment.get(ref.experimentId) ?? 0) + 1);
    }
    for (const [experimentId, count] of perExperiment) {
      expect(
        count,
        `${experimentId} 记录数 ${count} ≠ ${EXPECTED_PER_EXPERIMENT[experimentId]}(冻结案集合 × C/D/E × 3 rep)`,
      ).toBe(EXPECTED_PER_EXPERIMENT[experimentId]);
    }
  },
);
