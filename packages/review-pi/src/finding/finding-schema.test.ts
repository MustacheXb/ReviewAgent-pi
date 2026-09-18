import { expect, test } from "vitest";
import { isFinding, validateFinding } from "./finding-schema.js";

// Finding 契约（测量常量面：Finding/Evidence 契约与 DSH 线语义一致）。
// 10 字段：id/severity(P0-P3)/category/file/line(整数>=1)/title/description/
// evidence(string[])/rule/confidence(0-1)。运行时校验零依赖手写（不引 schema 引擎）。

const VALID = {
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

test("合法候选通过校验", () => {
  expect(validateFinding(VALID)).toEqual([]);
  expect(isFinding(VALID)).toBe(true);
});

test("非对象候选被拒", () => {
  expect(validateFinding(null)).toHaveLength(1);
  expect(validateFinding("F001")).toHaveLength(1);
  expect(validateFinding(42)).toHaveLength(1);
});

test("每个必填字段缺失都产生错误", () => {
  for (const field of Object.keys(VALID)) {
    const broken: Record<string, unknown> = { ...VALID };
    delete broken[field];
    expect(validateFinding(broken), `missing ${field}`).not.toEqual([]);
  }
});

test("空字符串字段被拒（minLength 1）", () => {
  expect(validateFinding({ ...VALID, id: "" })).not.toEqual([]);
  expect(validateFinding({ ...VALID, title: "" })).not.toEqual([]);
});

test("severity 必须是 P0-P3", () => {
  expect(validateFinding({ ...VALID, severity: "P4" })).not.toEqual([]);
  expect(validateFinding({ ...VALID, severity: "p1" })).not.toEqual([]);
  expect(validateFinding({ ...VALID, severity: "P2" })).toEqual([]);
});

test("line 必须是 >= 1 的整数", () => {
  expect(validateFinding({ ...VALID, line: 0 })).not.toEqual([]);
  expect(validateFinding({ ...VALID, line: -3 })).not.toEqual([]);
  expect(validateFinding({ ...VALID, line: 1.5 })).not.toEqual([]);
  expect(validateFinding({ ...VALID, line: "42" })).not.toEqual([]);
  expect(validateFinding({ ...VALID, line: 1 })).toEqual([]);
});

test("confidence 必须是 0-1 的有限数", () => {
  expect(validateFinding({ ...VALID, confidence: -0.01 })).not.toEqual([]);
  expect(validateFinding({ ...VALID, confidence: 1.01 })).not.toEqual([]);
  expect(validateFinding({ ...VALID, confidence: Number.NaN })).not.toEqual([]);
  expect(validateFinding({ ...VALID, confidence: "0.5" })).not.toEqual([]);
  expect(validateFinding({ ...VALID, confidence: 0 })).toEqual([]);
  expect(validateFinding({ ...VALID, confidence: 1 })).toEqual([]);
});

test("evidence 必须是字符串数组（空数组是形状合法的——非空性由 Evidence Gate 管）", () => {
  expect(validateFinding({ ...VALID, evidence: "not-array" })).not.toEqual([]);
  expect(validateFinding({ ...VALID, evidence: ["ok", 42] })).not.toEqual([]);
  expect(validateFinding({ ...VALID, evidence: [] })).toEqual([]);
});

test("多余字段不构成校验失败（投影时被丢弃）", () => {
  expect(validateFinding({ ...VALID, extra: "ignored" })).toEqual([]);
});
