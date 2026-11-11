import { describe, expect, it } from "vitest";
import {
  expandUnits,
  validateCampaignCases,
  validateCampaignPlan,
} from "../../src/eval/campaign/index.js";
import { mrCase, plan } from "./campaign-fixtures.js";

/**
 * Campaign plan seam（#39）：plan / cases 校验与 case × rep × arm 确定性展开。
 * 纯函数测试——零网络、零文件系统。
 */

describe("validateCampaignPlan", () => {
  it("合法 plan 通过校验", () => {
    expect(() => validateCampaignPlan(plan())).not.toThrow();
  });

  it("campaignId 必填且必须是安全路径段", () => {
    for (const campaignId of ["", "  ", "../escape", "a/b", "a\\b"]) {
      expect(() => validateCampaignPlan(plan({ campaignId }))).toThrow(/campaignId/);
    }
  });

  it("baseline / candidate ref、cases file、model 必须非空", () => {
    expect(() => validateCampaignPlan(plan({ baselineRef: "" }))).toThrow(/baselineRef/);
    expect(() => validateCampaignPlan(plan({ candidateRef: " " }))).toThrow(/candidateRef/);
    expect(() => validateCampaignPlan(plan({ casesFile: "" }))).toThrow(/casesFile/);
    expect(() => validateCampaignPlan(plan({ model: "" }))).toThrow(/model/);
  });

  it("reps 必须是正整数", () => {
    for (const reps of [0, -1, 1.5]) {
      expect(() => validateCampaignPlan(plan({ reps }))).toThrow(/reps/);
    }
  });

  it("arms 必须非空、无重复、只接受 baseline / candidate", () => {
    expect(() => validateCampaignPlan(plan({ arms: [] }))).toThrow(/arms/);
    expect(() => validateCampaignPlan(plan({ arms: ["baseline", "baseline"] }))).toThrow(/arms/);
    expect(() =>
      validateCampaignPlan(plan({ arms: ["candidate", "other" as "baseline"] })),
    ).toThrow(/arms/);
  });

  it("outputDir 必须非空", () => {
    expect(() => validateCampaignPlan(plan({ outputDir: "" }))).toThrow(/outputDir/);
  });

  it("拒绝非对象输入", () => {
    expect(() => validateCampaignPlan(null)).toThrow(/plan/);
    expect(() => validateCampaignPlan([])).toThrow(/plan/);
  });
});

describe("validateCampaignCases", () => {
  it("合法 cases 通过校验（clean MR 的 truth 可以为 null）", () => {
    const cases = [
      mrCase("VUL4J-1"),
      mrCase("CLEAN-1", {
        truth: null,
        labels: { source: "vul4j", riskClass: "Low", allowedConfigs: ["E"] },
      }),
    ];
    expect(() => validateCampaignCases(cases)).not.toThrow();
  });

  it("cases 必须是非空数组且 caseId 唯一", () => {
    expect(() => validateCampaignCases([])).toThrow(/cases/);
    expect(() => validateCampaignCases([mrCase("VUL4J-1"), mrCase("VUL4J-1")])).toThrow(
      /duplicate caseId/,
    );
  });

  it("caseId 必须是安全路径段（防目录逃逸 / 静默改写冲突）", () => {
    for (const caseId of ["..", "a/b", "a\\b", ".hidden", ""]) {
      expect(() => validateCampaignCases([mrCase(caseId)])).toThrow(/caseId/);
    }
  });

  it("E-only：allowedConfigs 必须包含 E", () => {
    expect(() =>
      validateCampaignCases([
        mrCase("VUL4J-1", {
          labels: { source: "vul4j", riskClass: "Low", allowedConfigs: ["A", "B"] },
        }),
      ]),
    ).toThrow(/allowedConfigs/);
  });

  it("骨架只跑 vul4j 源（pi 内核写面约束）", () => {
    expect(() =>
      validateCampaignCases([
        mrCase("CLEAN-1", {
          labels: { source: "clean-mr", riskClass: "Low", allowedConfigs: ["E"] },
        }),
      ]),
    ).toThrow(/vul4j/);
  });

  it("truth 形状非法时 fail fast", () => {
    expect(() =>
      validateCampaignCases([
        mrCase("VUL4J-1", {
          truth: { locations: [{} as never], fixPatch: "patch" },
        }),
      ]),
    ).toThrow(/truth/);
    expect(() =>
      validateCampaignCases([mrCase("VUL4J-1", { truth: { locations: [] } as never })]),
    ).toThrow(/truth/);
  });
});

describe("expandUnits", () => {
  it("按 case → rep → arm 展开：同 case 同 rep 的两臂相邻", () => {
    const units = expandUnits(plan({ reps: 2, arms: ["baseline", "candidate"] }), [
      mrCase("VUL4J-1"),
      mrCase("VUL4J-2"),
    ]);
    expect(units).toEqual([
      { source: "vul4j", caseId: "VUL4J-1", arm: "baseline", rep: 1 },
      { source: "vul4j", caseId: "VUL4J-1", arm: "candidate", rep: 1 },
      { source: "vul4j", caseId: "VUL4J-1", arm: "baseline", rep: 2 },
      { source: "vul4j", caseId: "VUL4J-1", arm: "candidate", rep: 2 },
      { source: "vul4j", caseId: "VUL4J-2", arm: "baseline", rep: 1 },
      { source: "vul4j", caseId: "VUL4J-2", arm: "candidate", rep: 1 },
      { source: "vul4j", caseId: "VUL4J-2", arm: "baseline", rep: 2 },
      { source: "vul4j", caseId: "VUL4J-2", arm: "candidate", rep: 2 },
    ]);
  });

  it("arm 顺序沿用 plan 声明（单臂 campaign 也成立）", () => {
    expect(expandUnits(plan({ reps: 1, arms: ["candidate"] }), [mrCase("VUL4J-1")])).toEqual([
      { source: "vul4j", caseId: "VUL4J-1", arm: "candidate", rep: 1 },
    ]);
    expect(
      expandUnits(plan({ reps: 1, arms: ["candidate", "baseline"] }), [mrCase("VUL4J-1")]),
    ).toEqual([
      { source: "vul4j", caseId: "VUL4J-1", arm: "candidate", rep: 1 },
      { source: "vul4j", caseId: "VUL4J-1", arm: "baseline", rep: 1 },
    ]);
  });
});
