import type {
  JudgeClient as CampaignJudgeClient,
  JudgeOutcome,
  JudgeRequest as CampaignJudgeRequest,
} from "../campaign/contracts.js";
import { judgeFindings } from "./chain.js";
import type { JudgeClient, MatchConfidenceThreshold } from "./contracts.js";

/**
 * Campaign judge 适配器（#40）：把 campaign 的注入缝
 * `JudgeClient.judge(request)`（评测单元记录 + 真值）接到 judge 链。
 *
 * 语义边界：
 * - findings 取记录 baseline 快照（内核实际产出，不是 mrCase）；
 * - 真值取 mrCase.truth（clean MR = null → 阴性对照全 FP）；
 * - judge 失败向上抛——campaign runner 记 judge 阶段失败并落 `failed` 留痕，
 *   不静默回落 rule 口径。
 *
 * 身份守卫：记录 caseId 与 mrCase.caseId 不一致时 fail fast（防错配判分；
 * runner 正常路径由同一 unit 派生，理论上不可达）。
 */

export interface CampaignJudgeClientOptions {
  /** 底层 LLM-as-judge 客户端（真实 GptJudgeClient 或测试 fake） */
  readonly client: JudgeClient;
  /** 置信度门槛；缺省 "low"（none 恒拒绝） */
  readonly matchConfidenceThreshold?: MatchConfidenceThreshold;
}

export function createCampaignJudgeClient(
  options: CampaignJudgeClientOptions,
): CampaignJudgeClient {
  return {
    judge: async (request: CampaignJudgeRequest): Promise<JudgeOutcome> => {
      if (request.record.caseId !== request.mrCase.caseId) {
        throw new Error(
          `campaign judge: record caseId ${JSON.stringify(request.record.caseId)} ` +
            `does not match mrCase caseId ${JSON.stringify(request.mrCase.caseId)}`,
        );
      }
      const result = await judgeFindings({
        caseId: request.mrCase.caseId,
        findings: request.record.baseline.findings,
        truth: request.mrCase.truth,
        issueDescription: request.mrCase.issueDescription,
        diff: request.mrCase.diff,
        client: options.client,
        ...(options.matchConfidenceThreshold !== undefined
          ? { matchConfidenceThreshold: options.matchConfidenceThreshold }
          : {}),
      });
      return { counts: result.counts, anomalies: result.anomalies };
    },
  };
}
