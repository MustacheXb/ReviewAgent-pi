import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/instrument/contracts/finding.js";
import type { MRCase } from "../../src/instrument/contracts/mr-case.js";
import type { EvalRunRecord } from "../../src/eval/campaign/contracts.js";
import type { JudgeAdjudication, JudgeClient } from "../../src/eval/judge/contracts.js";
import { createCampaignJudgeClient } from "../../src/eval/judge/campaign-adapter.js";
import { adjudication, match } from "./judge-helpers.js";

/**
 * campaign judge 适配器（#40）：campaign 注入缝 `JudgeClient.judge(request)`
 * → 既有 E 记录 finding + case 真值 → MatchCounts。离线、零网络。
 */

function finding(id: string): Finding {
  return {
    id,
    severity: "P2",
    category: "SECURITY",
    file: "src/A.java",
    line: 11,
    title: "issue",
    description: "description",
    evidence: ["evidence"],
    rule: "R1",
    confidence: 0.8,
  };
}

function mrCase(overrides: Partial<MRCase> = {}): MRCase {
  return {
    caseId: "VUL4J-1",
    repoPath: ".cache/datasets/vul4j-repos/VUL4J-1-f5903fa564",
    diff: "diff --git a/src/A.java b/src/A.java",
    issueDescription: "CVE-2017-18349",
    truth: {
      locations: [{ file: "src/A.java", lineStart: 10, lineEnd: 12, defectNature: "SECURITY" }],
      fixPatch: "fix patch",
    },
    labels: { source: "vul4j", riskClass: "High", allowedConfigs: ["E"] },
    ...overrides,
  };
}

function evalRecord(findings: readonly Finding[]): EvalRunRecord {
  return {
    source: "vul4j",
    caseId: "VUL4J-1",
    configId: "E",
    rep: 1,
    model: "deepseek-v4-flash",
    verifier: "off",
    completedAt: "2026-11-11T00:00:00.000Z",
    baseline: {
      findings,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 },
      rounds: 1,
      toolCalls: 1,
      audit: {
        toolCallLog: [],
        phaseLog: [],
        rejections: [],
        truncated: false,
        truncationReasons: [],
      },
      auditPath: "",
    },
    effective: null,
    verifierPass: null,
    campaignId: "p1-smoke",
    arm: "baseline",
    evalOnly: true,
    environmentRef: "environment.json",
  };
}

function scriptedClient(replies: readonly JudgeAdjudication[]): {
  readonly client: JudgeClient;
  readonly calls: number[];
} {
  const calls: number[] = [];
  let index = 0;
  return {
    calls,
    client: {
      adjudicate: async () => {
        calls.push(index);
        const reply = replies[index];
        index += 1;
        if (reply === undefined) {
          throw new Error("script exhausted");
        }
        return reply;
      },
    },
  };
}

function request(mrCaseValue: MRCase = mrCase(), record = evalRecord([finding("F001")])) {
  return {
    campaignId: "p1-smoke",
    arm: "baseline" as const,
    rep: 1,
    mrCase: mrCaseValue,
    record,
  };
}

describe("createCampaignJudgeClient — 语义映射", () => {
  it("有真值 + finding：judge 裁定折算 MatchCounts", async () => {
    const scripted = scriptedClient([adjudication([match({ finding: 0, truth: 0 })])]);
    const judge = createCampaignJudgeClient({ client: scripted.client });
    await expect(judge.judge(request())).resolves.toEqual({
      counts: { tp: 1, fp: 0, fn: 0 },
      anomalies: [],
    });
    expect(scripted.calls).toHaveLength(1);
  });

  it("clean MR（truth = null）：finding 全记 FP，judge 零调用（阴性对照口径）", async () => {
    const scripted = scriptedClient([]);
    const judge = createCampaignJudgeClient({ client: scripted.client });
    const result = await judge.judge(
      request(mrCase({ truth: null }), evalRecord([finding("F001"), finding("F002")])),
    );
    expect(result).toEqual({ counts: { tp: 0, fp: 2, fn: 0 }, anomalies: [] });
    expect(scripted.calls).toHaveLength(0);
  });

  it("零 finding：真值全记 FN，judge 零调用", async () => {
    const scripted = scriptedClient([]);
    const judge = createCampaignJudgeClient({ client: scripted.client });
    await expect(judge.judge(request(mrCase(), evalRecord([])))).resolves.toEqual({
      counts: { tp: 0, fp: 0, fn: 1 },
      anomalies: [],
    });
    expect(scripted.calls).toHaveLength(0);
  });

  it("judge 失败向上抛（campaign runner 记 judge 阶段失败）", async () => {
    const judge = createCampaignJudgeClient({
      client: {
        adjudicate: async () => {
          throw new Error("judge gateway down");
        },
      },
    });
    await expect(judge.judge(request())).rejects.toThrowError("judge gateway down");
  });

  it("judge 有界失败留痕（anomalies）透传，不被丢弃", async () => {
    const scripted = scriptedClient([
      {
        matches: [match({ finding: 0, truth: 0 })],
        summary: null,
        anomalies: ["dropped malformed match entry 2 (invalid shape/index/confidence)"],
      },
    ]);
    const judge = createCampaignJudgeClient({ client: scripted.client });
    const outcome = await judge.judge(request());
    expect(outcome.counts).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(outcome.anomalies).toEqual([
      "dropped malformed match entry 2 (invalid shape/index/confidence)",
    ]);
  });
});

describe("createCampaignJudgeClient — 身份守卫", () => {
  it("记录 caseId 与 mrCase.caseId 不一致时 fail fast（防错配判分）", async () => {
    const scripted = scriptedClient([]);
    const judge = createCampaignJudgeClient({ client: scripted.client });
    const record = { ...evalRecord([finding("F001")]), caseId: "VUL4J-2" };
    await expect(judge.judge(request(mrCase(), record))).rejects.toThrowError(
      /does not match mrCase caseId/,
    );
    expect(scripted.calls).toHaveLength(0);
  });
});
