import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCampaignCases } from "../../src/eval/campaign/index.js";

/**
 * P1 空对照校准数据集守卫（#42）：30 案 = 冻结 target 列表全集
 * （`a9e7b80^:data/vul4j/target-cases.json`，byte-identical 恢复）。
 * 10 案冒烟集是该列表的确定性前 10 案；两文件同序同 id。
 * 数据集字节入 plan / environment hash，改动即破坏可复算性。
 */

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CASES_FILE = path.join(REPO_ROOT, "data", "vul4j", "target-cases.json");
const SMOKE_FILE = path.join(REPO_ROOT, "data", "vul4j", "p1-smoke-cases.json");

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
  "VUL4J-35",
  "VUL4J-38",
  "VUL4J-39",
  "VUL4J-40",
  "VUL4J-41",
  "VUL4J-42",
  "VUL4J-44",
  "VUL4J-52",
  "VUL4J-53",
  "VUL4J-56",
  "VUL4J-57",
  "VUL4J-58",
  "VUL4J-61",
  "VUL4J-67",
  "VUL4J-72",
  "VUL4J-73",
  "VUL4J-74",
  "VUL4J-75",
  "VUL4J-78",
  "VUL4J-79",
] as const;

function load(file: string) {
  return parseCampaignCases(readFileSync(file, "utf8"), file);
}

describe("P1 空对照校准数据集（30 案）", () => {
  it("恰好 30 案，id 与冻结 target 列表一致", () => {
    expect(load(CASES_FILE).map((mrCase) => mrCase.caseId)).toEqual([...EXPECTED_CASE_IDS]);
  });

  it("与 10 案冒烟集同序：冒烟集是校准集的前 10 案", () => {
    const calibrationIds = load(CASES_FILE).map((mrCase) => mrCase.caseId);
    const smokeIds = load(SMOKE_FILE).map((mrCase) => mrCase.caseId);
    expect(smokeIds).toEqual(calibrationIds.slice(0, smokeIds.length));
  });

  it("全部为 vul4j 源、allowedConfigs 含 E、真值非空（当前无 clean MR 阴性对照）", () => {
    const cases = load(CASES_FILE);
    for (const mrCase of cases) {
      expect(mrCase.labels.source).toBe("vul4j");
      expect(mrCase.labels.allowedConfigs).toContain("E");
      expect(mrCase.truth).not.toBeNull();
      expect(mrCase.truth?.locations.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("repoPath 是相对路径（跟随仓库根解析，不写死本机绝对路径）", () => {
    for (const mrCase of load(CASES_FILE)) {
      expect(path.isAbsolute(mrCase.repoPath)).toBe(false);
      expect(mrCase.repoPath.startsWith(".cache/datasets/vul4j-repos/")).toBe(true);
    }
  });
});
