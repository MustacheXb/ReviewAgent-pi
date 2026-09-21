import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ReviewRunInput, ReviewRunResult, RunRecord as PiRunRecord } from "review-pi";
import type { UnitReviewRequest } from "../../src/experiment/review-kernel.js";
import { piKernel } from "../../src/experiment/pi-kernel.js";
import { experimentMainCase } from "./helpers.js";

/**
 * #8 P4a pi 内核适配器（桩 runReviewFn——零网络、零 pi 内核执行）：
 * ReviewKernel 执行缝的 pi 侧实现。断言面：
 * - 装配契约：unit/mrCase/model → ReviewRunInput（persistRecord: false——
 *   runner 是记录唯一写者；experimentRoot 拆 runsRoot/experimentId）；
 * - 映射契约：pi RunRecord.baseline → root RunResult（requests: []——
 *   重放字节以审计文件为真源；cacheBreaks 缺省补空数组）；
 * - source 守卫：pi 内核是 vul4j 线（pi 记录 source 硬编码），他源 fail fast。
 * 真 pi 内核经缝全链（离线 A–E + SSE fake）见 runner-pi-offline.test.ts。
 */

const EXPERIMENT_ROOT = path.join("C:", "tmp-runs", "pi-kernel-exp");
const FETCH_STUB: ReviewRunInput["fetch"] = async () => new Response("{}");

function vul4jUnitRequest(overrides: Partial<UnitReviewRequest> = {}): UnitReviewRequest {
  return {
    unit: { source: "vul4j", caseId: "VUL4J-1", configId: "D", rep: 2 },
    mrCase: experimentMainCase("VUL4J-1", {
      labels: { source: "vul4j", riskClass: "High", allowedConfigs: ["A", "B", "C", "D", "E"] },
    }),
    model: "deepseek-v4-flash",
    experimentRoot: EXPERIMENT_ROOT,
    ...overrides,
  };
}

/** 桩产物：pi RunRecord（结构真源同 packages/review-pi src/experiment/run-record.ts） */
function stubPiRecord(input: ReviewRunInput): PiRunRecord {
  const configId = input.configId ?? "B";
  return {
    source: "vul4j",
    caseId: input.caseId,
    configId,
    rep: input.rep,
    model: input.modelId ?? "deepseek-v4-flash",
    verifier: "off",
    completedAt: "2026-09-21T00:00:00.000Z",
    baseline: {
      findings: [
        {
          id: "F001",
          severity: "P2",
          category: "logic",
          file: "A.java",
          line: 3,
          title: "t",
          description: "d",
          evidence: ["A.java:3"],
          rule: "r",
          confidence: 0.9,
        },
      ],
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 },
      rounds: 1,
      toolCalls: 2,
      audit: { toolCallLog: [], phaseLog: [], rejections: [], truncated: false, truncationReasons: [] },
      auditPath: path.join(
        input.runsRoot,
        input.experimentId,
        "audit",
        "vul4j",
        input.caseId,
        configId,
        `rep-${input.rep}`,
        "audit",
        "run-1.json",
      ),
    },
    effective: null,
    verifierPass: null,
  };
}

describe("piKernel（#8 执行缝 pi 侧适配器）", () => {
  it("装配契约：unit/mrCase/model → ReviewRunInput（persistRecord:false、experimentRoot 拆分、传输层透传）", async () => {
    const seen: ReviewRunInput[] = [];
    const runReviewFn = async (input: ReviewRunInput): Promise<ReviewRunResult> => {
      seen.push(input);
      return {
        runId: "run-1",
        record: stubPiRecord(input),
        recordPath: "",
        auditPath: stubPiRecord(input).baseline.auditPath,
      };
    };
    const kernel = piKernel({
      apiKey: "offline-test-key",
      baseUrl: "https://gw.example/v1",
      fetch: FETCH_STUB,
      runReviewFn,
    });
    const request = vul4jUnitRequest();

    const result = await kernel.execute(request);

    expect(seen).toHaveLength(1);
    const input = seen[0];
    expect(input).toMatchObject({
      caseId: "VUL4J-1",
      repoPath: request.mrCase.repoPath,
      diff: request.mrCase.diff,
      issueDescription: request.mrCase.issueDescription,
      apiKey: "offline-test-key",
      baseUrl: "https://gw.example/v1",
      modelId: "deepseek-v4-flash",
      configId: "D",
      rep: 2,
      // 执行缝纪律：runner 是记录唯一写者，内核不落盘记录
      persistRecord: false,
    });
    expect(input?.fetch).toBe(FETCH_STUB);
    // experimentRoot 拆分：<runsRoot>/<experimentId>
    expect(input?.runsRoot).toBe(path.join("C:", "tmp-runs"));
    expect(input?.experimentId).toBe("pi-kernel-exp");

    // 映射契约：root RunResult（caseId/configId 来自 unit；model 来自 pi 记录）
    expect(result.caseId).toBe("VUL4J-1");
    expect(result.configId).toBe("D");
    expect(result.model).toBe("deepseek-v4-flash");
    expect(result.findings).toHaveLength(1);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 });
    expect(result.rounds).toBe(1);
    expect(result.toolCalls).toBe(2);
    // 重放字节以审计文件为真源：内存 audit 的 requests 为空（run-store 同先例）；
    // cacheBreaks 缺省补空数组（root RunAudit 必填、pi AuditLight 空时省键）
    expect(result.audit.requests).toEqual([]);
    expect(result.audit.cacheBreaks).toEqual([]);
    expect(result.audit.truncated).toBe(false);
    expect(result.auditPath).toBe(
      path.join(EXPERIMENT_ROOT, "audit", "vul4j", "VUL4J-1", "D", "rep-2", "audit", "run-1.json"),
    );
  });

  it("baseUrl 缺省不传（官方端点由 pi 内核缺省解析），cacheBreaks 有值时透传", async () => {
    const seen: ReviewRunInput[] = [];
    const runReviewFn = async (input: ReviewRunInput): Promise<ReviewRunResult> => {
      seen.push(input);
      const record = stubPiRecord(input);
      return {
        runId: "run-2",
        record: {
          ...record,
          baseline: {
            ...record.baseline,
            audit: {
              ...record.baseline.audit,
              cacheBreaks: [
                { requestIndex: 3, reason: "CONTEXT_REORDERED", zone: "B/C", divergeByteOffset: 42 },
              ],
            },
          },
        },
        recordPath: "",
        auditPath: record.baseline.auditPath,
      };
    };
    const kernel = piKernel({ apiKey: "offline-test-key", fetch: FETCH_STUB, runReviewFn });

    const result = await kernel.execute(vul4jUnitRequest());

    expect(seen[0]?.baseUrl).toBeUndefined();
    expect(result.audit.cacheBreaks).toEqual([
      { requestIndex: 3, reason: "CONTEXT_REORDERED", zone: "B/C", divergeByteOffset: 42 },
    ]);
  });

  it("source 守卫：pi 内核是 vul4j 线，他源单元 fail fast（pi 记录 source 硬编码）", async () => {
    const kernel = piKernel({
      apiKey: "offline-test-key",
      fetch: FETCH_STUB,
      runReviewFn: async () => {
        throw new Error("stub must not be called for non-vul4j sources");
      },
    });
    const request = vul4jUnitRequest({
      unit: { source: "defects4j", caseId: "Chart-1", configId: "A", rep: 1 },
    });
    await expect(kernel.execute(request)).rejects.toThrow(/vul4j/);
  });
});
