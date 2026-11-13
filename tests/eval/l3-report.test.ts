import { describe, expect, it } from "vitest";
import type { EnvironmentManifest } from "../../src/eval/campaign/contracts.js";
import {
  DEFAULT_L3_GATE_THRESHOLDS,
  type L3Column,
  type L3ReportInput,
  type L3SignOff,
} from "../../src/eval/l3/contracts.js";
import {
  buildL3Report,
  renderL3ReportMarkdown,
} from "../../src/eval/l3/report.js";

/**
 * L3 三列报告 / 宣称门（#45）：三列不混入 S/A/B；C_ref totalTokens 仅参考
 * 分母；无报告 + environment + 产品签字则 claimsAllowed=false。
 */

function env(overrides: Partial<EnvironmentManifest> = {}): EnvironmentManifest {
  return {
    campaignId: "l3-2026-11-13",
    evaluation: {
      branch: "eval/bench",
      campaign: "l3-2026-11-13",
      calibrationRef: "p1-calibration-2026-11-12",
    },
    git: { branch: "eval/bench", commit: "deadbeef", tag: null },
    runtime: { node: "v24.13.0", os: "win32-x64", machine: "dev" },
    model: {
      requestedId: "deepseek-v4-flash",
      actualDeployment: null,
      providerClass: "volcengine",
      baseUrlClass: "gateway-endpoint",
    },
    gateway: { cacheProbeBefore: null, cacheProbeAfter: null },
    judge: {
      model: "glm-5.2",
      promptVersion: "mcr-bench-llm-hit-judge-2026-09-03+poc1-ext-1",
      temperature: 0.2,
      topP: 0.95,
    },
    prompts: { zoneA: "zone-a-v1", toolsSchema: "tools-v1" },
    claudeCode: {
      cliVersion: "2.1.241",
      requestedModel: "deepseek-v4-flash",
      actualModels: ["deepseek-v4-flash"],
      maxTurns: 5,
    },
    window: {
      start: "2026-11-12T00:00:00.000Z",
      end: "2026-11-12T06:00:00.000Z",
      timezone: "Asia/Shanghai",
    },
    dataset: {
      casesFile: "data/vul4j/p1-smoke-cases.json",
      caseCount: 30,
      hash: "hash",
    },
    ...overrides,
  };
}

function column(
  key: L3Column["key"],
  overrides: Partial<L3Column> = {},
): L3Column {
  return {
    key,
    label: key === "e" ? "E" : key === "c-ref" ? "C_ref" : "Claude Code",
    model: "deepseek-v4-flash",
    cases: 30,
    runs: 60,
    coverage: { planned: 60, executed: 60, judged: 60, failed: 0, ratio: 1 },
    quality: { recall: 0.7, precision: 0.6, f1: 0.65 },
    cost: {
      carcMean: 50_000,
      totalTokensMean: 110_000,
      cacheHitRateMean: 0.9,
      billedCostUsd: null,
    },
    harness: null,
    budget: "bounded",
    failures: [],
    ...overrides,
  };
}

function input(overrides: Partial<L3ReportInput> = {}): L3ReportInput {
  const claude = column("claude-code", {
    model: "deepseek-v4-flash",
    quality: { recall: 0.5, precision: 0.5, f1: 0.5 },
    cost: {
      carcMean: 120_000,
      totalTokensMean: 500_000,
      cacheHitRateMean: null,
      billedCostUsd: 30,
    },
    harness: { turnsMean: 20, durationMsMean: 400_000, permissionDenials: 0 },
  });
  return {
    campaignId: "l3-2026-11-13",
    generatedAt: "2026-11-13T00:00:00.000Z",
    environment: env(),
    columns: {
      e: column("e", {
        quality: { recall: 0.8, precision: 0.8, f1: 0.8 },
        cost: {
          carcMean: 50_000,
          totalTokensMean: 110_000,
          cacheHitRateMean: 0.9,
          billedCostUsd: null,
        },
      }),
      cRef: column("c-ref", {
        model: "deepseek-v4-flash",
        cost: {
          carcMean: 80_000,
          totalTokensMean: 220_000,
          cacheHitRateMean: 0.9,
          billedCostUsd: null,
        },
        quality: { recall: 0.75, precision: 0.65, f1: 0.7 },
      }),
      claudeCode: claude,
    },
    signOff: null,
    ...overrides,
  };
}

const SIGN_OFF: L3SignOff = {
  signedBy: "product-owner",
  signedAt: "2026-11-13T00:00:00.000Z",
  scope: "external-claim",
};

describe("buildL3Report", () => {
  it("三列 / environment / coverage / C_ref 参考分母；无签字 → claimsAllowed false", () => {
    const report = buildL3Report(input());

    expect(report.columns.e.key).toBe("e");
    expect(report.columns.cRef.key).toBe("c-ref");
    expect(report.columns.claudeCode.key).toBe("claude-code");
    expect(report.referenceDenominator).toEqual({
      eOverCRefTotalTokens: 0.5,
      note: expect.stringMatching(/参考分母|reference/i),
    });
    expect(report.environment).toEqual({ complete: true, missing: [] });
    expect(report.gates.environment.pass).toBe(true);
    expect(report.gates.coverage.pass).toBe(true);
    expect(report.gates.signOff.pass).toBe(false);
    expect(report.claimsAllowed).toBe(false);
    expect(report.allowedClaim).toBeNull();
    expect(report.limitations.join("\n")).toMatch(/S\/A\/B/);
    expect(report.limitations.join("\n")).toMatch(/C_ref.*参考分母/s);
  });

  it("四门 + environment + 产品签字齐全 → claimsAllowed true 并给宣称模板", () => {
    const base = input({ signOff: SIGN_OFF });
    const report = buildL3Report({
      ...base,
      columns: {
        e: {
          ...base.columns.e,
          runs: 90,
          cost: { ...base.columns.e.cost, billedCostUsd: 9 },
        },
        cRef: { ...base.columns.cRef, runs: 90 },
        claudeCode: { ...base.columns.claudeCode, runs: 90 },
      },
    });

    expect(report.gates.comparability.pass).toBe(true);
    expect(report.gates.quality.pass).toBe(true);
    expect(report.gates.cost.pass).toBe(true); // USD 9 / 30 = 0.30
    expect(report.gates.cache.pass).toBe(true);
    expect(report.gates.coverage.pass).toBe(true);
    expect(report.gates.environment.pass).toBe(true);
    expect(report.gates.signOff.pass).toBe(true);
    expect(report.claimsAllowed).toBe(true);
    expect(report.allowedClaim).toContain("E judge Recall");
    expect(report.allowedClaim).toContain("C_ref totalTokens 仅参考分母");
  });

  it("USD 缺失时成本门 fail（不得用 totalTokens 代替成本结论）", () => {
    const report = buildL3Report(input({ signOff: SIGN_OFF }));
    expect(report.gates.cost.pass).toBe(false);
    expect(report.gates.cost.detail).toMatch(/totalTokens|USD N\/A/i);
    expect(report.claimsAllowed).toBe(false);
  });

  it("三列 cases / reps / harness budget 不可比 → comparability fail，claims false", () => {
    const base = input({ signOff: SIGN_OFF });
    const unequal = buildL3Report({
      ...base,
      columns: {
        ...base.columns,
        cRef: {
          ...base.columns.cRef,
          cases: 1,
          runs: 1,
        },
        e: {
          ...base.columns.e,
          cost: { ...base.columns.e.cost, billedCostUsd: 9 },
        },
      },
    });
    expect(unequal.gates.comparability.pass).toBe(false);
    expect(unequal.claimsAllowed).toBe(false);

    const ceiling = buildL3Report({
      ...base,
      columns: {
        ...base.columns,
        e: {
          ...base.columns.e,
          cost: { ...base.columns.e.cost, billedCostUsd: 9 },
        },
        claudeCode: { ...base.columns.claudeCode, budget: "ceiling" },
      },
    });
    expect(ceiling.gates.comparability.pass).toBe(false);
    expect(ceiling.claimsAllowed).toBe(false);
  });

  it("environment 缺字段 → claimsAllowed false，缺失路径逐项列出", () => {
    const broken = env({
      prompts: { zoneA: null, toolsSchema: null },
      claudeCode: {
        cliVersion: null,
        requestedModel: null,
        actualModels: null,
        maxTurns: null,
      },
      judge: { ...env().judge, promptVersion: null },
    });
    const report = buildL3Report(input({ environment: broken, signOff: SIGN_OFF }));

    expect(report.environment.complete).toBe(false);
    expect(report.environment.missing).toEqual(
      expect.arrayContaining([
        "prompts.zoneA",
        "prompts.toolsSchema",
        "claudeCode.cliVersion",
        "claudeCode.actualModels",
        "judge.promptVersion",
      ]),
    );
    expect(report.gates.environment.pass).toBe(false);
    expect(report.claimsAllowed).toBe(false);
  });

  it("coverage 不足 / 质量或缓存门失败 → claimsAllowed false", () => {
    const base = input({ signOff: SIGN_OFF });
    const lowCoverage = buildL3Report({
      ...base,
      columns: {
        ...base.columns,
        claudeCode: {
          ...base.columns.claudeCode,
          coverage: { planned: 60, executed: 50, judged: 48, failed: 12, ratio: 0.8 },
        },
      },
    });
    expect(lowCoverage.gates.coverage.pass).toBe(false);
    expect(lowCoverage.claimsAllowed).toBe(false);

    const lowQuality = buildL3Report({
      ...base,
      columns: {
        ...base.columns,
        e: {
          ...base.columns.e,
          quality: { recall: 0.2, precision: 0.2, f1: 0.2 },
          cost: { ...base.columns.e.cost, cacheHitRateMean: 0.5 },
        },
      },
    });
    expect(lowQuality.gates.quality.pass).toBe(false);
    expect(lowQuality.gates.cache.pass).toBe(false);
    expect(lowQuality.claimsAllowed).toBe(false);
  });

  it("C_ref totalTokens 变化不影响任何门 / claims（只作参考分母）", () => {
    const a = buildL3Report(input({ signOff: SIGN_OFF }));
    const base = input({ signOff: SIGN_OFF });
    const b = buildL3Report({
      ...base,
      columns: {
        ...base.columns,
        cRef: {
          ...base.columns.cRef,
          cost: { ...base.columns.cRef.cost, totalTokensMean: 9_999_999 },
        },
      },
    });
    expect(a.gates).toEqual(b.gates);
    expect(a.claimsAllowed).toBe(b.claimsAllowed);
    expect(b.referenceDenominator.eOverCRefTotalTokens).not.toBe(
      a.referenceDenominator.eOverCRefTotalTokens,
    );
  });

  it("跨模型 token 语义不作等价；成本门缺 USD 时不冒充 token 等价", () => {
    const base = input({ signOff: SIGN_OFF });
    const cross = buildL3Report({
      ...base,
      columns: {
        ...base.columns,
        claudeCode: {
          ...base.columns.claudeCode,
          model: "claude-opus-5",
          cost: { ...base.columns.claudeCode.cost, billedCostUsd: null },
        },
      },
    });

    expect(cross.gates.cost.pass).toBe(false);
    expect(cross.claimsAllowed).toBe(false);
    expect(cross.limitations.join("\n")).toMatch(/跨模型|token 语义/);
  });

  it("签字过期 → signOff 门失败，claimsAllowed false", () => {
    const report = buildL3Report(
      input({
        signOff: { ...SIGN_OFF, expiresAt: "2026-11-12T00:00:00.000Z" },
        generatedAt: "2026-11-13T00:00:00.000Z",
      }),
    );
    expect(report.gates.signOff.pass).toBe(false);
    expect(report.claimsAllowed).toBe(false);
  });

  it("Markdown 确定性；含三列 / environment / 门 / 宣称纪律", () => {
    const report = buildL3Report(input());
    const first = renderL3ReportMarkdown(report);
    expect(renderL3ReportMarkdown(report)).toBe(first);
    expect(first).toContain("# L3 三列定位报告 l3-2026-11-13");
    expect(first).toContain("| 指标 | E | C_ref | Claude Code |");
    expect(first).toContain("C_ref 参考分母");
    expect(first).toContain("claimsAllowed = false");
    expect(first).toContain("不进 S/A/B");
    expect(first).toContain("原始 runs / audit / wireBody 外置");
  });

  it("默认阈值与 ADR-0017 目标线一致", () => {
    expect(DEFAULT_L3_GATE_THRESHOLDS).toEqual({
      recallVsClaude: 0.9,
      precisionVsClaude: 1.0,
      costVsClaude: 0.3,
      minCacheHitRate: 0.85,
      minCoverage: 0.9,
      minCases: 30,
      minReps: 3,
    });
  });
});
