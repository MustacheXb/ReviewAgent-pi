import type { ReviewKernel } from "../../gate/review-kernel.js";
import type { Finding } from "../../instrument/contracts/finding.js";
import type { RunResult } from "../../instrument/contracts/run.js";
import { screenFindings } from "../analysis/screening.js";
import type { CampaignEnvironmentInput, JudgeClient } from "./contracts.js";

/**
 * 进程入口的显式 fake 依赖（`run-campaign --fake`）：确定性、零网络。
 *
 * 用途仅限 harness tracer bullet——证明「plan → 单元 → 记录 → 报告」路径
 * 成立；记录仍带 `evalOnly: true`，environment 的 judge/prompt 字段标
 * `fake`，不得作为真实测量结果引用。真实装配见 `src/eval/assembly`（#40）。
 */

/** fake 内核：有真值时按首个真值位置产出一条 finding；clean MR 产出空集 */
export function createFakeReviewKernel(): ReviewKernel {
  return {
    id: "pi",
    execute: async (request) => {
      const location = request.mrCase.truth?.locations[0];
      const findings: readonly Finding[] =
        location === undefined
          ? []
          : [
              {
                id: "F001",
                severity: "P2",
                category: location.defectNature,
                file: location.file,
                line: location.lineStart,
                title: "fake finding",
                description: "synthetic finding produced by the #39 campaign fake kernel",
                evidence: [location.file],
                rule: `${location.defectNature}-FAKE`,
                confidence: 0.8,
              },
            ];
      const result: RunResult = {
        caseId: request.unit.caseId,
        configId: "E",
        model: request.model,
        findings,
        usage: {
          inputTokens: 1000 + request.unit.rep * 100,
          outputTokens: 200,
          cacheReadTokens: 600,
          cacheWriteTokens: 0,
        },
        rounds: 2,
        toolCalls: findings.length,
        audit: {
          requests: [],
          toolCallLog:
            findings.length === 0
              ? []
              : [{ name: "review.get_file", argumentsJson: "{}", resultSummary: "fake" }],
          phaseLog: [{ round: 1, phase: "Change Understanding", requestCount: 2 }],
          rejections: [],
          cacheBreaks: [],
          truncated: false,
          truncationReasons: [],
        },
        auditPath: "",
      };
      return result;
    },
  };
}

/**
 * fake judge：真值在场时复用分析器的确定性 rule 粗筛口径（文件 / 行区间 /
 * 性质）；clean MR 的 finding 全部记 FP。真实 judge 链在 #40。
 */
export function createFakeJudgeClient(): JudgeClient {
  return {
    judge: async (request) => {
      if (request.mrCase.truth === null) {
        return {
          counts: { tp: 0, fp: request.record.baseline.findings.length, fn: 0 },
          anomalies: [],
        };
      }
      return {
        counts: screenFindings(request.record.baseline.findings, request.mrCase.truth),
        anomalies: [],
      };
    },
  };
}

/** fake environment provenance：未知字段一律 null（N/A，不写 0） */
export function fakeCampaignEnvironment(model: string): CampaignEnvironmentInput {
  return {
    evaluation: { branch: "eval/bench", calibrationRef: null },
    git: { branch: null, commit: null, tag: null },
    runtime: {
      node: process.version,
      os: `${process.platform}-${process.arch}`,
      machine: null,
    },
    model: {
      requestedId: model,
      actualDeployment: null,
      providerClass: null,
      baseUrlClass: null,
    },
    gateway: { cacheProbeBefore: null, cacheProbeAfter: null },
    judge: {
      model: "fake-judge-non-measurement",
      promptVersion: "fake#39-non-measurement",
      temperature: null,
      topP: null,
    },
    prompts: { zoneA: null, toolsSchema: null },
    claudeCode: {
      cliVersion: null,
      requestedModel: null,
      actualModels: null,
      maxTurns: null,
    },
    window: { start: null, end: null, timezone: null },
  };
}
