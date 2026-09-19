import { exec } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { fakeFetch } from "../provider/fake-fetch.js";
import { goldenFixture } from "../testing/golden.js";
import { VUL4J_1_ISSUE, VUL4J_1_SNAPSHOT, vul4j1Corpus } from "../testing/vul4j1-script.js";
import { runReview } from "./review-run.js";

const execAsync = promisify(exec);

// 冻结 analyze 脚本原样消费 pi RunRecord（#3 验收）：无适配层——
// pi 链落盘的 rep-1.json 与 DSH 记录在同一 runsRoot 下被
// scripts/analyze-phase2.ts（冻结仪器，零改动）一视同仁地聚合进 T5 冒烟行。
//
// fixture runsRoot：
//   phase2-main / phase2-noise / phase2-dsh → NTFS junction 指向仓内真源
//     （脚本零写盘副作用，junction 免 450×3 拷贝）
//   phase2-smoke → 真目录：VUL4J-1 × {A,C,D,E} = DSH t1 真记录拷贝 +
//     {B} = runReview 产出的 pi RunRecord
//
// 断言：smoke 行 5 单元、双口径求和 = 五条 record 独立现算值（数据驱动，
// 不硬编码）；main 侧 450 单元行在场（junction 读通）。
// 本测试验证既有冻结仪器 + 既有 P1a 链的集成性质（无新生产代码，回归钉住）。

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SIDES = ["phase2-main", "phase2-noise", "phase2-dsh"] as const;
const DSH_T1_CASE_DIR = path.join(REPO_ROOT, "runs", "phase2-dsh-t1", "runs", "vul4j", "VUL4J-1");
const MAIN_REPORT = path.join(REPO_ROOT, "runs", "phase2-main", "report.json");

const fixtureRoots: string[] = [];

afterAll(() => {
  for (const root of fixtureRoots.splice(0)) {
    // junction 先摘链接本身：rmdirSync 只删 reparse point（不触真源）；
    // rmSync 非递归对目录类路径抛 EISDIR，不能用于摘链接。
    // 之后再递归清理 fixture 真目录（phase2-smoke）
    for (const side of SIDES) {
      const junction = path.join(root, side);
      if (existsSync(junction)) {
        rmdirSync(junction);
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

/** 冻结脚本 fmtTokens 的测试侧镜像（独立复算口径，不 import 脚本内部） */
function fmtTokens(value: number): string {
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

test.skipIf(
  !existsSync(VUL4J_1_SNAPSHOT) || !existsSync(DSH_T1_CASE_DIR) || !existsSync(MAIN_REPORT),
)(
  "冻结 analyze:phase2 原样消费 pi RunRecord（smoke 行 5 单元双口径求和）",
  async () => {
    // 1) pi 链产出 RunRecord（config B / rep-1），直接落 fixture 的 phase2-smoke
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "review-pi-analyze-"));
    fixtureRoots.push(fixtureRoot);
    const script = fakeFetch(vul4j1Corpus());
    await runReview({
      caseId: "VUL4J-1",
      repoPath: VUL4J_1_SNAPSHOT,
      diff: goldenFixture("vul4j-1.diff"),
      issueDescription: VUL4J_1_ISSUE,
      apiKey: "offline-test",
      fetch: script.fetch,
      runsRoot: fixtureRoot,
      experimentId: "phase2-smoke",
      rep: 1,
    });

    // 2) 同案 DSH t1 真记录补齐 A/C/D/E（B 位 = pi 记录）
    for (const configId of ["A", "C", "D", "E"] as const) {
      const targetDir = path.join(
        fixtureRoot,
        "phase2-smoke",
        "runs",
        "vul4j",
        "VUL4J-1",
        configId,
      );
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(
        path.join(DSH_T1_CASE_DIR, configId, "rep-1.json"),
        path.join(targetDir, "rep-1.json"),
      );
    }

    // 3) 三侧 junction 到仓内真源（脚本对三侧只读）
    for (const side of SIDES) {
      symlinkSync(path.join(REPO_ROOT, "runs", side), path.join(fixtureRoot, side), "junction");
    }

    // 4) 冻结脚本原样跑：package.json 入口（tsc 编译 + node 执行），
    //    runsRoot 经 argv 传入 fixture
    const { stdout } = await execAsync(`pnpm analyze:phase2 "${fixtureRoot}"`, {
      cwd: REPO_ROOT,
      timeout: 240_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });

    // junction 读通：三侧 450 单元行在场
    expect(stdout).toContain("| main | 450 |");

    // 5) smoke 行 = 五条 record（4 DSH + 1 pi）独立现算的双口径求和
    const caseRoot = path.join(fixtureRoot, "phase2-smoke", "runs", "vul4j", "VUL4J-1");
    const configIds = readdirSync(caseRoot).sort();
    expect(configIds).toEqual(["A", "B", "C", "D", "E"]);
    let billed = 0;
    let withCache = 0;
    for (const configId of configIds) {
      const record = JSON.parse(
        readFileSync(path.join(caseRoot, configId, "rep-1.json"), "utf8"),
      ) as {
        baseline: { usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } };
      };
      const unit = record.baseline.usage.inputTokens + record.baseline.usage.outputTokens;
      billed += unit;
      withCache += unit + record.baseline.usage.cacheReadTokens;
    }
    const smokeRow = stdout.split("\n").find((line) => line.startsWith("| smoke |"));
    expect(smokeRow).toBeDefined();
    expect(smokeRow).toBe(`| smoke | 5 | ${fmtTokens(billed)} | ${fmtTokens(withCache)} | — | — |`);
  },
  600_000,
);
