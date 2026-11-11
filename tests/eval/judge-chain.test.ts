import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/instrument/contracts/finding.js";
import type { MRTruth } from "../../src/instrument/contracts/mr-case.js";
import type { JudgeAdjudication, JudgeClient, JudgeRequest } from "../../src/eval/judge/contracts.js";
import { judgeFindings } from "../../src/eval/judge/chain.js";
import { adjudication, match } from "./judge-helpers.js";

/**
 * judge 链（#40）行为测试：clean MR / 零 finding 不触达 judge；judged 时按
 * 置信度门槛与一对一占用折算 MatchCounts；judge 失败向上抛（runner 留痕，
 * 不静默回落 rule 口径——ADR-0017 N/A 纪律）。
 */

const TRUTH: MRTruth = {
  locations: [
    { file: "src/A.java", lineStart: 10, lineEnd: 12, defectNature: "SECURITY" },
    { file: "src/B.java", lineStart: 20, lineEnd: 20, defectNature: "RESOURCE" },
  ],
  fixPatch: "fix patch",
};

function finding(id: string, file = "src/A.java", line = 11): Finding {
  return {
    id,
    severity: "P2",
    category: "SECURITY",
    file,
    line,
    title: "issue",
    description: "description",
    evidence: ["evidence"],
    rule: "R1",
    confidence: 0.8,
  };
}

/** 可编程判官：记录收到的请求，回放脚本化裁定 */
function scriptedClient(replies: readonly (JudgeAdjudication | Error)[]): {
  readonly client: JudgeClient;
  readonly requests: readonly JudgeRequest[];
} {
  const requests: JudgeRequest[] = [];
  let index = 0;
  return {
    requests,
    client: {
      adjudicate: async (request) => {
        requests.push(structuredClone(request));
        const reply = replies[index];
        index += 1;
        if (reply === undefined) {
          throw new Error("script exhausted");
        }
        if (reply instanceof Error) {
          throw reply;
        }
        return structuredClone(reply);
      },
    },
  };
}

function baseInput(client: JudgeClient, overrides: Partial<Parameters<typeof judgeFindings>[0]> = {}) {
  return {
    caseId: "VUL4J-1",
    findings: [finding("F001")],
    truth: TRUTH,
    issueDescription: "CVE description",
    diff: "diff --git a/src/A.java b/src/A.java",
    client,
    ...overrides,
  };
}

describe("judgeFindings — 不触达 judge 的平凡分支", () => {
  it("clean MR（truth = null）：finding 全记 FP，judge 零调用", async () => {
    const { client, requests } = scriptedClient([]);
    const result = await judgeFindings(baseInput(client, { truth: null, findings: [finding("F1"), finding("F2")] }));
    expect(result.status).toBe("skipped-clean-mr");
    expect(result.counts).toEqual({ tp: 0, fp: 2, fn: 0 });
    expect(requests).toHaveLength(0);
  });

  it("零 finding：真值全记 FN，judge 零调用", async () => {
    const { client, requests } = scriptedClient([]);
    const result = await judgeFindings(baseInput(client, { findings: [] }));
    expect(result.status).toBe("skipped-no-findings");
    expect(result.counts).toEqual({ tp: 0, fp: 0, fn: 2 });
    expect(requests).toHaveLength(0);
  });
});

describe("judgeFindings — judged 分支", () => {
  it("把 finding / truth 卡片与 MR 上下文送入 judge，按裁定折算 TP/FP/FN", async () => {
    const { client, requests } = scriptedClient([
      adjudication([match({ finding: 0, truth: 0, confidence: "high" })]),
    ]);
    const result = await judgeFindings(baseInput(client, { findings: [finding("F1"), finding("F2", "src/X.java", 99)] }));
    expect(result.status).toBe("judged");
    // 2 findings / 2 truths，1 条命中 → tp 1, fp 1, fn 1
    expect(result.counts).toEqual({ tp: 1, fp: 1, fn: 1 });

    const request = requests[0];
    expect(request?.caseId).toBe("VUL4J-1");
    expect(request?.findings.map((card) => card.id)).toEqual(["F1", "F2"]);
    expect(request?.truths).toHaveLength(2);
    expect(request?.context).toEqual({
      issueDescription: "CVE description",
      diff: "diff --git a/src/A.java b/src/A.java",
      fixPatch: "fix patch",
    });
  });

  it("置信度门槛生效：默认 low 拒绝 none 条目，全部计 FP / FN", async () => {
    const { client } = scriptedClient([
      adjudication([match({ finding: 0, truth: 0, confidence: "none" })]),
    ]);
    const result = await judgeFindings(baseInput(client, { findings: [finding("F1")], truth: TRUTH }));
    expect(result.counts).toEqual({ tp: 0, fp: 1, fn: 2 });
  });

  it("显式门槛 none：truth 索引非 null 即命中（官方宽松口径）", async () => {
    const { client } = scriptedClient([
      adjudication([match({ finding: 0, truth: 0, confidence: "none" })]),
    ]);
    const result = await judgeFindings(
      baseInput(client, { findings: [finding("F1")], matchConfidenceThreshold: "none" }),
    );
    expect(result.counts).toEqual({ tp: 1, fp: 0, fn: 1 });
  });

  it("越界裁定的 anomaly 透传（有界失败，不整单报废）", async () => {
    const { client } = scriptedClient([adjudication([match({ finding: 9, truth: 0 })])]);
    const result = await judgeFindings(baseInput(client));
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toContain("out-of-range finding index");
    expect(result.counts).toEqual({ tp: 0, fp: 1, fn: 2 });
  });

  it("归一阶段丢弃畸形条目的 anomaly 与占用解析 anomaly 合并透传", async () => {
    const { client } = scriptedClient([
      {
        matches: [match({ finding: 0, truth: 0 })],
        summary: null,
        anomalies: ["dropped malformed match entry 2"],
      },
    ]);
    const result = await judgeFindings(baseInput(client));
    expect(result.anomalies).toEqual(["dropped malformed match entry 2"]);
  });
});

describe("judgeFindings — 失败纪律", () => {
  it("judge 调用失败向上抛（runner 留痕，不静默回落 rule 口径）", async () => {
    const { client } = scriptedClient([new Error("gateway 503")]);
    await expect(judgeFindings(baseInput(client))).rejects.toThrowError("gateway 503");
  });
});
