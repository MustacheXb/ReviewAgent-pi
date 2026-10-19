import { REVIEW_MODEL_ID } from "../provider/pi-client.js";

/**
 * #15 测试共享夹具：E 形态 run record JSON（生产入口 config E，
 * 2026-10-19 决策评论；真 Finding 形状）。
 *
 * command.test.ts（进程内面）与 cli/bin.process.test.ts（进程面）共用——
 * 两处曾逐字复制（code-review 去重项），单源在此。同仓先例：
 * provider/fake-fetch.ts（非测试模块承载测试替身，经消费方覆盖）。
 * 注意：真实 E 产物的端到端锁另有 e-artifact.test.ts（本地快照存在时），
 * 本夹具只服务纯离线路径。
 */
export function eRunRecordJson(): string {
  const finding = (id: string, severity: string) => ({
    id,
    severity,
    category: "correctness",
    file: "A.java",
    line: 42,
    title: `${id} title`,
    description: `${id} description`,
    evidence: ["A.java:42"],
    rule: "test-rule",
    confidence: 0.5,
  });
  return JSON.stringify(
    {
      source: "vul4j",
      caseId: "VUL4J-1",
      configId: "E",
      rep: 1,
      model: REVIEW_MODEL_ID,
      verifier: "off",
      completedAt: "2026-10-19T08:00:00.000Z",
      baseline: {
        findings: [finding("F100", "P1"), finding("F101", "P2")],
        usage: { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 0 },
        rounds: 1,
        toolCalls: 4,
        audit: { toolCallLog: [], phaseLog: [], rejections: [], truncated: false, truncationReasons: [] },
        auditPath: "audit.json",
      },
      effective: null,
      verifierPass: null,
    },
    null,
    2,
  );
}
