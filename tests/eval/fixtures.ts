import type { RunRecord, RunSnapshot } from "review-pi";

/** 只读分析器测试夹具（#37）：完整 RunRecord 形状，零网络。 */

export const FINDING = {
  id: "F001",
  severity: "P2" as const,
  category: "SECURITY",
  file: "src/main/java/example/ObjectArrayCodec.java",
  line: 177,
  title: "title",
  description: "description",
  evidence: ["evidence"],
  rule: "SECURITY-001",
  confidence: 0.8,
};

export function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    findings: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    rounds: 1,
    toolCalls: 0,
    audit: {
      toolCallLog: [],
      phaseLog: [],
      rejections: [],
      truncated: false,
      truncationReasons: [],
    },
    auditPath: "runs/vul4j/O/C/rep-1/audit.json",
    ...overrides,
  };
}

export function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    source: "vul4j",
    caseId: "VUL4J-1",
    configId: "E",
    rep: 1,
    model: "deepseek-v4-flash",
    verifier: "off",
    completedAt: "2026-09-23T06:52:42.017Z",
    baseline: snapshot(),
    effective: null,
    verifierPass: null,
    ...overrides,
  };
}
