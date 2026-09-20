import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { discoverGateRecords, loadCaseInputs } from "./ground-truth.js";
import { REPO_ROOT, RUNS_ROOT } from "./gate-runner.js";

// P2 字节纪律门(#5)——覆盖完整性(防真源部分缺席时门静默缩水)。
//
// 票面冻结范围:phase2-dsh-t{1..5} × 30 案 × A/B × 3 rep = 180 记录。
// per-experiment 门文件只对照各自发现的记录——某实验/记录缺席时该文件
// 零测试空转,本文件把总账:任何真源在场(≥1 实验目录)而覆盖不满额
// 即红,并给出缺席清单。真源整体缺席(如 CI:runs/ 数据 gitignored)→
// 整档 skip(重型验收不在 CI 口径内,与仓内「CI 绿不等于重型验收通过」
// 约定一致)。

const T_SERIES = ["phase2-dsh-t1", "phase2-dsh-t2", "phase2-dsh-t3", "phase2-dsh-t4", "phase2-dsh-t5"] as const;
const EXPECTED_RECORD_COUNT = 180;

const refs = discoverGateRecords(RUNS_ROOT);

test.skipIf(refs.length === 0)(
  "真源覆盖完整:t1-t5 × 30 案 × A/B × 3 rep = 180,案输入与 B 快照齐备",
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

    const caseInputs = loadCaseInputs(REPO_ROOT);
    const caseIds = [...new Set(refs.map((ref) => ref.caseId))];
    const missingInputs = caseIds.filter((caseId) => !caseInputs.has(caseId));
    expect(missingInputs, "target-cases.json 缺案输入").toEqual([]);

    const bCases = [
      ...new Set(refs.filter((ref) => ref.configId === "B").map((ref) => ref.caseId)),
    ];
    const missingSnapshots = bCases.filter((caseId) => {
      const input = caseInputs.get(caseId);
      return input === undefined || !existsSync(path.resolve(REPO_ROOT, input.repoPath));
    });
    expect(missingSnapshots, "config B 仓库快照缺席(.cache/datasets)").toEqual([]);
  },
);
