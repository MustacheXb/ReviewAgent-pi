import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/instrument/contracts/finding.js";
import { applyCandidateGate } from "../../src/gate/candidate-gate.js";
import type { VerificationVerdict } from "../../src/gate/candidate-gate.js";

/**
 * Evidence Gate（"No Evidence, No Finding"）+ 候选拦截链（#9 P4b 起直测
 * applyCandidateGate 纯函数——原经 legacy runReview 六相位脚本驱动的宿主路径
 * 已随内核退役；判定口径不变，供判定链 / 指标消费记录时重放）。
 * 拦截顺序：Schema → 全英文 → 证据 → 验证裁决 → 重复 id；每候选至多一条
 * 拦截记录（首个失败阶段）。
 */

const VALID_CANDIDATE = {
  id: "F001",
  severity: "P1",
  category: "CORRECTNESS",
  file: "src/main/java/com/example/math/MathUtils.java",
  line: 20,
  title: "Off-by-one loop bound",
  description: "The loop reads one element beyond the requested range.",
  evidence: ["Diff line 20 shows the changed loop bound"],
  rule: "CORRECTNESS-001",
  confidence: 0.9,
};

const candidate = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  ...VALID_CANDIDATE,
  ...overrides,
});

function verdictsOf(
  entries: readonly (readonly [string, boolean, string?])[],
): ReadonlyMap<string, VerificationVerdict> {
  return new Map(
    entries.map(([id, pass, reason]) => [id, { pass, reason: reason ?? "checked" } satisfies VerificationVerdict]),
  );
}

describe("applyCandidateGate — 通过路径", () => {
  it("全部阶段通过的候选晋升 Finding，id 进 emittedIds（跨轮去重数据源）", () => {
    const output = applyCandidateGate({
      candidates: [VALID_CANDIDATE],
      verdicts: verdictsOf([["F001", true]]),
      emittedIds: new Set(),
      round: 1,
    });
    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]).toEqual(VALID_CANDIDATE as Finding);
    expect(output.rejections).toEqual([]);
    expect([...output.emittedIds]).toEqual(["F001"]);
  });

  it("输入 emittedIds 不被就地变更（快照隔离——返回新集合）", () => {
    const inputIds = new Set(["F000"]);
    applyCandidateGate({
      candidates: [VALID_CANDIDATE],
      verdicts: verdictsOf([["F001", true]]),
      emittedIds: inputIds,
      round: 1,
    });
    expect([...inputIds]).toEqual(["F000"]);
  });
});

describe("applyCandidateGate — 拦截链（每候选至多一条，首个失败阶段）", () => {
  it("无证据 / 空白证据 → NO_EVIDENCE（No Evidence, No Finding）", () => {
    const withoutEvidence = candidate({ id: "F100", evidence: [] });
    const blankEvidence = candidate({ id: "F101", evidence: ["", "   "] });
    const output = applyCandidateGate({
      candidates: [withoutEvidence, blankEvidence],
      verdicts: verdictsOf([
        ["F100", true],
        ["F101", true],
      ]),
      emittedIds: new Set(),
      round: 1,
    });
    expect(output.findings).toEqual([]);
    expect(output.rejections).toHaveLength(2);
    expect(output.rejections[0]).toEqual({
      candidateId: "F100",
      stage: "NO_EVIDENCE",
      reason: "no evidence cited (No Evidence, No Finding)",
    });
    expect(output.rejections[1]?.stage).toBe("NO_EVIDENCE");
  });

  it("缺字段 / 非法字段 → SCHEMA_INVALID（字段级 reason）", () => {
    const missingEvidence = { ...VALID_CANDIDATE, id: "F102" } as Record<string, unknown>;
    delete missingEvidence.evidence;
    const noSeverity = candidate({ id: "F200", severity: undefined });
    const badLine = candidate({ id: "F201", line: 0 });
    const badConfidence = candidate({ id: "F202", confidence: 1.5 });
    const output = applyCandidateGate({
      candidates: [missingEvidence, noSeverity, badLine, badConfidence],
      verdicts: verdictsOf([
        ["F102", true],
        ["F200", true],
        ["F201", true],
        ["F202", true],
      ]),
      emittedIds: new Set(),
      round: 1,
    });
    expect(output.findings).toEqual([]);
    const rejections = output.rejections;
    expect(rejections).toHaveLength(4);
    expect(rejections.every((rejection) => rejection.stage === "SCHEMA_INVALID")).toBe(true);
    expect(rejections[0]?.reason).toContain('"evidence"');
    expect(rejections[1]?.reason).toContain('"severity"');
    expect(rejections[2]?.reason).toContain('"line"');
    expect(rejections[3]?.reason).toContain('"confidence"');
  });

  it("中文文本 → NON_ENGLISH（POC1 输出全英文）", () => {
    const chineseFinding = candidate({
      id: "F300",
      title: "循环边界差一错误",
      description: "循环会读取越界元素。",
    });
    const output = applyCandidateGate({
      candidates: [chineseFinding],
      verdicts: verdictsOf([["F300", true]]),
      emittedIds: new Set(),
      round: 1,
    });
    expect(output.findings).toEqual([]);
    expect(output.rejections[0]).toEqual({
      candidateId: "F300",
      stage: "NON_ENGLISH",
      reason: "finding text must be English only",
    });
  });

  it("裁决拒绝 → VERIFICATION_FAILED（保留裁决 reason）；无裁决同样拦截", () => {
    const rejected = candidate({ id: "F400" });
    const unjudged = candidate({ id: "F401" });
    const output = applyCandidateGate({
      candidates: [rejected, unjudged],
      verdicts: verdictsOf([["F400", false, "evidence does not support the claim"]]),
      emittedIds: new Set(),
      round: 1,
    });
    expect(output.findings).toEqual([]);
    expect(output.rejections).toHaveLength(2);
    expect(output.rejections[0]?.stage).toBe("VERIFICATION_FAILED");
    expect(output.rejections[0]?.reason).toContain("evidence does not support the claim");
    expect(output.rejections[1]).toEqual({
      candidateId: "F401",
      stage: "VERIFICATION_FAILED",
      reason: "no verification verdict for candidate",
    });
  });

  it("跨轮重复 id → DUPLICATE_ID（首轮已产出的 id 不再晋升）", () => {
    const output = applyCandidateGate({
      candidates: [VALID_CANDIDATE],
      verdicts: verdictsOf([["F001", true]]),
      emittedIds: new Set(["F001"]),
      round: 2,
    });
    expect(output.findings).toEqual([]);
    expect(output.rejections[0]).toEqual({
      candidateId: "F001",
      stage: "DUPLICATE_ID",
      reason: "a finding with this id was already emitted in an earlier round",
    });
  });

  it("无 id / 空 id 候选 → 合成拒绝 id（round-N-candidate-M）", () => {
    const idless = candidate({ id: "" });
    const output = applyCandidateGate({
      candidates: [idless],
      verdicts: new Map(),
      emittedIds: new Set(),
      round: 3,
    });
    expect(output.findings).toEqual([]);
    expect(output.rejections[0]?.candidateId).toBe("round-3-candidate-0");
  });

  it("拦截顺序：schema 先于后续阶段（schema 失败候选不再走英文/证据检查）", () => {
    const brokenAndChinese = candidate({ id: "F500", title: "循环边界", line: 0 });
    const output = applyCandidateGate({
      candidates: [brokenAndChinese],
      verdicts: verdictsOf([["F500", true]]),
      emittedIds: new Set(),
      round: 1,
    });
    expect(output.rejections[0]?.stage).toBe("SCHEMA_INVALID");
  });
});
