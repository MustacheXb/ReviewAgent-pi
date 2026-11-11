import type { RunSnapshot } from "review-pi";
import type { RunResult } from "../../instrument/contracts/run.js";
import {
  ENVIRONMENT_REF,
  type CampaignPlan,
  type CampaignUnit,
  type EvalRunRecord,
} from "./contracts.js";

/**
 * 执行结果 → 评测单元记录（评测方案 §8.4）：RunRecord 形状 + 评测 sidecar。
 *
 * 调用侧是记录唯一写者（pi 内核 persistRecord=false），本映射是 root
 * RunResult → RunRecord 的评测侧等价物：与 review-pi 的 buildRunRecord 同形，
 * 但额外携带 `campaignId` / `arm` / `evalOnly` / `environmentRef`。审计轻量
 * 投影不落 requests（重放字节以 auditPath 为真源）。
 */

export interface EvalRunRecordArgs {
  readonly plan: CampaignPlan;
  readonly unit: CampaignUnit;
  readonly result: RunResult;
  readonly completedAt: string;
}

export function toEvalRunRecord(args: EvalRunRecordArgs): EvalRunRecord {
  return {
    source: args.unit.source,
    caseId: args.unit.caseId,
    configId: "E",
    rep: args.unit.rep,
    model: args.result.model ?? args.plan.model,
    verifier: "off",
    completedAt: args.completedAt,
    baseline: toRunSnapshot(args.result),
    effective: null,
    verifierPass: null,
    campaignId: args.plan.campaignId,
    arm: args.unit.arm,
    evalOnly: true,
    environmentRef: ENVIRONMENT_REF,
  };
}

function toRunSnapshot(result: RunResult): RunSnapshot {
  const audit = result.audit;
  return {
    findings: result.findings,
    usage: result.usage,
    rounds: result.rounds,
    toolCalls: result.toolCalls,
    audit: {
      toolCallLog: audit.toolCallLog,
      phaseLog: audit.phaseLog,
      rejections: audit.rejections,
      ...(audit.cacheBreaks.length > 0 ? { cacheBreaks: audit.cacheBreaks } : {}),
      truncated: audit.truncated,
      truncationReasons: audit.truncationReasons,
      ...(audit.ledger !== undefined ? { ledger: audit.ledger } : {}),
    },
    auditPath: result.auditPath ?? "",
    ...(result.domainWarning !== undefined ? { domainWarning: result.domainWarning } : {}),
  };
}

/** 单元键（记录 / judge 结果对账；E-only 下 source 恒 vul4j） */
export function unitKey(unit: {
  readonly caseId: string;
  readonly arm: EvalRunRecord["arm"];
  readonly rep: number;
}): string {
  return `${unit.caseId}|${unit.arm}|${unit.rep}`;
}
