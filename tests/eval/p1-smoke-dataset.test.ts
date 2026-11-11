import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCampaignCases } from "../../src/eval/campaign/index.js";

/**
 * P1 冒烟数据集守卫（#40）：10 案 × 2 reps 的 E-only 真实冒烟数据集。
 * 集合从冻结的 30 案 target 列表前 10 案确定性截取（同序同 id），
 * 数据集字节入 plan / environment hash，改动即破坏可复算性。
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CASES_FILE = path.join(REPO_ROOT, "data", "vul4j", "p1-smoke-cases.json");

const EXPECTED_CASE_IDS = [
  "VUL4J-1",
  "VUL4J-12",
  "VUL4J-15",
  "VUL4J-16",
  "VUL4J-21",
  "VUL4J-22",
  "VUL4J-25",
  "VUL4J-29",
  "VUL4J-30",
  "VUL4J-33",
] as const;

describe("P1 冒烟数据集", () => {
  it("恰好 10 案，id 与冻结 target 列表前 10 案一致", () => {
    const cases = parseCampaignCases(readFileSync(CASES_FILE, "utf8"), CASES_FILE);
    expect(cases.map((mrCase) => mrCase.caseId)).toEqual([...EXPECTED_CASE_IDS]);
  });

  it("全部为 vul4j 源、allowedConfigs 含 E、真值非空（无 clean MR 混入冒烟）", () => {
    const cases = parseCampaignCases(readFileSync(CASES_FILE, "utf8"), CASES_FILE);
    for (const mrCase of cases) {
      expect(mrCase.labels.source).toBe("vul4j");
      expect(mrCase.labels.allowedConfigs).toContain("E");
      expect(mrCase.truth).not.toBeNull();
      expect(mrCase.truth?.locations.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("repoPath 是相对路径（跟随仓库根解析，不写死本机绝对路径）", () => {
    const cases = parseCampaignCases(readFileSync(CASES_FILE, "utf8"), CASES_FILE);
    for (const mrCase of cases) {
      expect(path.isAbsolute(mrCase.repoPath)).toBe(false);
      expect(mrCase.repoPath.startsWith(".cache/datasets/vul4j-repos/")).toBe(true);
    }
  });
});
