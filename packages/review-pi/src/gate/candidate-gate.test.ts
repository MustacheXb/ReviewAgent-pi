import { expect, test } from "vitest";
import type { VerificationVerdict } from "../loop/parse.js";
import { applyCandidateGate } from "./candidate-gate.js";

// 候选拦截链（测量常量面：六阶段语义的一部分）。
// 顺序：SCHEMA_INVALID → NON_ENGLISH → NO_EVIDENCE → VERIFICATION_FAILED → DUPLICATE_ID，
// 每个候选最多留痕一条（首个失败阶段）。

const VALID_CANDIDATE = {
  id: "F001",
  severity: "P1",
  category: "CORRECTNESS",
  file: "src/Foo.java",
  line: 42,
  title: "Null dereference",
  description: "The value may be null at this call site.",
  evidence: ["method Foo.bar at src/Foo.java:42"],
  rule: "CORRECTNESS-001",
  confidence: 0.8,
};

function verdicts(entries: Record<string, VerificationVerdict>): ReadonlyMap<string, VerificationVerdict> {
  return new Map(Object.entries(entries));
}

test("合法候选 + 验证通过 → 产出 finding 并登记 id", () => {
  const out = applyCandidateGate({
    candidates: [VALID_CANDIDATE],
    verdicts: verdicts({ F001: { pass: true, reason: "" } }),
    emittedIds: new Set(),
    round: 1,
  });
  expect(out.findings).toHaveLength(1);
  expect(out.findings[0]?.id).toBe("F001");
  expect(out.rejections).toEqual([]);
  expect([...out.emittedIds]).toEqual(["F001"]);
});

test("schema 失败优先于后续一切阶段（首个失败阶段留痕）", () => {
  const broken = { ...VALID_CANDIDATE, line: 0 };
  const out = applyCandidateGate({
    candidates: [broken],
    verdicts: new Map(), // 无裁决：若无 schema 失败本应 VERIFICATION_FAILED
    emittedIds: new Set(["F001"]), // 已产出：若无前序失败本应 DUPLICATE_ID
    round: 1,
  });
  expect(out.findings).toEqual([]);
  expect(out.rejections).toHaveLength(1);
  expect(out.rejections[0]?.stage).toBe("SCHEMA_INVALID");
  expect(out.rejections[0]?.candidateId).toBe("F001");
});

test("含 CJK 字符的候选被 NON_ENGLISH 拦截", () => {
  const out = applyCandidateGate({
    candidates: [{ ...VALID_CANDIDATE, title: "空指针解引用" }],
    verdicts: verdicts({ F001: { pass: true, reason: "" } }),
    emittedIds: new Set(),
    round: 1,
  });
  expect(out.rejections[0]?.stage).toBe("NON_ENGLISH");
});

test("evidence 空或全空白被 NO_EVIDENCE 拦截（No Evidence, No Finding）", () => {
  for (const evidence of [[], ["   "]] as const) {
    const out = applyCandidateGate({
      candidates: [{ ...VALID_CANDIDATE, evidence: [...evidence] }],
      verdicts: verdicts({ F001: { pass: true, reason: "" } }),
      emittedIds: new Set(),
      round: 1,
    });
    expect(out.rejections[0]?.stage, JSON.stringify(evidence)).toBe("NO_EVIDENCE");
  }
});

test("无裁决或裁决不通过被 VERIFICATION_FAILED 拦截", () => {
  const missing = applyCandidateGate({
    candidates: [VALID_CANDIDATE],
    verdicts: new Map(),
    emittedIds: new Set(),
    round: 1,
  });
  expect(missing.rejections[0]?.stage).toBe("VERIFICATION_FAILED");

  const rejected = applyCandidateGate({
    candidates: [VALID_CANDIDATE],
    verdicts: verdicts({ F001: { pass: false, reason: "evidence does not support the claim" } }),
    emittedIds: new Set(),
    round: 1,
  });
  expect(rejected.rejections[0]?.stage).toBe("VERIFICATION_FAILED");
  expect(rejected.rejections[0]?.reason).toContain("evidence does not support the claim");
});

test("已产出的 id 被 DUPLICATE_ID 拦截", () => {
  const out = applyCandidateGate({
    candidates: [VALID_CANDIDATE],
    verdicts: verdicts({ F001: { pass: true, reason: "" } }),
    emittedIds: new Set(["F001"]),
    round: 2,
  });
  expect(out.findings).toEqual([]);
  expect(out.rejections[0]?.stage).toBe("DUPLICATE_ID");
});

test("缺 id 的候选以 round-N-candidate-I 兜底标识留痕", () => {
  const { id: _omit, ...noId } = VALID_CANDIDATE;
  const out = applyCandidateGate({
    candidates: [noId],
    verdicts: new Map(),
    emittedIds: new Set(),
    round: 3,
  });
  expect(out.rejections[0]?.candidateId).toBe("round-3-candidate-0");
});

test("入参 emittedIds 不被原地修改（不可变纪律）", () => {
  const emittedIds = new Set<string>();
  applyCandidateGate({
    candidates: [VALID_CANDIDATE],
    verdicts: verdicts({ F001: { pass: true, reason: "" } }),
    emittedIds,
    round: 1,
  });
  expect(emittedIds.size).toBe(0);
});
