import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 治理 runbook 守卫（#46）：L2 硬门、例外模板、L3 宣称审批、CI/保留规则与
 * ADR-0016/0017 口径必须可执行且不漂移。纯文档测试，零网络 / 零运行时。
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TOKEN_EVAL = path.join(ROOT, "docs", "report", "token-eval");
const GOVERNANCE = path.join(TOKEN_EVAL, "GOVERNANCE.md");
const EXCEPTION_TEMPLATE = path.join(TOKEN_EVAL, "templates", "l2-cost-exception.md");
const CLAIM_TEMPLATE = path.join(TOKEN_EVAL, "templates", "l3-claim-approval.md");
const PR_CHECKLIST = path.join(TOKEN_EVAL, "templates", "l2-pr-checklist.md");
const RUNBOOK = path.join(TOKEN_EVAL, "RUNBOOK.md");

function read(file: string): string {
  expect(existsSync(file), `${path.relative(ROOT, file)} must exist`).toBe(true);
  return readFileSync(file, "utf8");
}

describe("治理 runbook（#46）", () => {
  it("L2 硬合并门：token 相关改动、同模型 / 同 provider、随机臂序、功效边界", () => {
    const text = read(GOVERNANCE);
    for (const phrase of [
      "L2 硬合并门",
      "token 相关",
      "同模型",
      "同 provider",
      "合并前必查",
      "质量非劣",
      "CARC",
      "随机臂序",
      "underpowered",
      "43 案",
      "220 案",
    ]) {
      expect(text, `GOVERNANCE.md missing ${phrase}`).toContain(phrase);
    }
    expect(text).toMatch(/质量非劣[^。]*不可豁免/);
    expect(text).not.toContain("covereage");
  });

  it("例外模板：仅成本门可豁免、质量非劣不可、过期日与回滚计划", () => {
    const text = read(EXCEPTION_TEMPLATE);
    for (const phrase of [
      "仅成本门可豁免",
      "过期日",
      "回滚计划",
      "签字",
      "underpowered",
    ]) {
      expect(text, `exception template missing ${phrase}`).toContain(phrase);
    }
    expect(text).toMatch(/质量非劣[^。]*不可豁免/);
  });

  it("宣称审批：L3 报告 + environment.json + 产品签字；数值门与单列降级", () => {
    const text = read(CLAIM_TEMPLATE);
    for (const phrase of [
      "L3 报告",
      "environment.json",
      "产品签字",
      "单列事实",
      "claimsAllowed",
      "同模型",
      "bounded",
      "ceiling",
      "0.3",
      "0.85",
      "0.9",
      "≥30",
      "≥3",
    ]) {
      expect(text, `claim template missing ${phrase}`).toContain(phrase);
    }
    expect(text).not.toContain("除非产品签字");
    const gov = read(GOVERNANCE);
    expect(gov).toContain("单列事实");
    expect(gov).toMatch(/不得.*相对结论|不能.*相对结论/);
    expect(gov).toContain("产品签字**不能**替代");
  });

  it("PR 清单包含基线 / candidate / 数据集 / calibrationRef / 质量与覆盖证据", () => {
    const text = read(PR_CHECKLIST);
    for (const phrase of [
      "baseline",
      "candidate",
      "数据集",
      "calibrationRef",
      "L2",
      "environment",
      "coverage",
      "failures",
      "随机臂序",
      "零 finding",
      "阴性对照",
      "underpowered",
    ]) {
      expect(text, `PR checklist missing ${phrase}`).toContain(phrase);
    }
  });

  it("CI / campaign 节奏与摘要 / 原始数据保留规则写入治理文档", () => {
    const text = read(GOVERNANCE);
    for (const phrase of ["确定性 CI", "campaign", "L3", "摘要", "原始", "保留", "外置"]) {
      expect(text, `GOVERNANCE.md missing ${phrase}`).toContain(phrase);
    }
    expect(text).toContain("ADR-0016");
    expect(text).toContain("ADR-0017");
  });

  it("RUNBOOK 链接治理文档与模板；ADR 文件存在", () => {
    const runbook = read(RUNBOOK);
    expect(runbook).toContain("GOVERNANCE.md");
    expect(runbook).toContain("templates/l2-pr-checklist.md");
    expect(runbook).toContain("templates/l2-cost-exception.md");
    expect(runbook).toContain("templates/l3-claim-approval.md");
    for (const adr of ["0016-evaluation-plane-isolation.md", "0017-token-optimization-gates.md"]) {
      expect(existsSync(path.join(ROOT, "docs", "adr", adr)), `${adr} must exist`).toBe(true);
    }
  });
});
