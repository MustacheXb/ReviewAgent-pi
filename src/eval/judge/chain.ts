import type { Finding } from "../../instrument/contracts/finding.js";
import type { MRTruth } from "../../instrument/contracts/mr-case.js";
import type { MatchCounts } from "../analysis/contracts.js";
import {
  DEFAULT_MATCH_CONFIDENCE_THRESHOLD,
  findingToCard,
  truthToCards,
  type JudgeClient,
  type MatchConfidenceThreshold,
} from "./contracts.js";
import { resolveAdjudication } from "./resolve.js";

/**
 * Judge 链（#40，eval-only）：一次 E run 的 findings × 真值 → LLM-as-judge
 * 语义裁定 → TP / FP / FN。
 *
 * 平凡分支不触达 judge（与官方脚本同口径）：
 * - clean MR（truth = null）：阴性对照，所有 finding 记 FP；
 * - 零 finding：所有真值记 FN。
 *
 * 失败纪律（ADR-0017 N/A）：judge 调用失败向上抛——campaign runner 记 judge
 * 阶段失败、该单元 judge 列记 N/A，不静默回落到 rule 口径（回落会把「judge
 * 不可用」伪装成有效质量数据）。
 *
 * 越界 / 重复占用条目由 resolveAdjudication 丢弃并记 anomaly（有界失败，
 * 不整单报废）；anomaly 透传给调用方留痕。
 */

export type JudgeChainStatus = "judged" | "skipped-clean-mr" | "skipped-no-findings";

export interface JudgeChainInput {
  readonly caseId: string;
  readonly findings: readonly Finding[];
  /** clean MR 阴性对照为 null */
  readonly truth: MRTruth | null;
  readonly issueDescription: string;
  readonly diff: string;
  readonly client: JudgeClient;
  /** 置信度门槛；缺省 "low"（none 恒拒绝） */
  readonly matchConfidenceThreshold?: MatchConfidenceThreshold;
}

export interface JudgeChainResult {
  readonly status: JudgeChainStatus;
  readonly counts: MatchCounts;
  /** 有界失败留痕（越界索引 / 重复占用被丢弃的裁定条目） */
  readonly anomalies: readonly string[];
}

export async function judgeFindings(input: JudgeChainInput): Promise<JudgeChainResult> {
  if (input.truth === null) {
    return {
      status: "skipped-clean-mr",
      counts: { tp: 0, fp: input.findings.length, fn: 0 },
      anomalies: [],
    };
  }
  if (input.findings.length === 0) {
    return {
      status: "skipped-no-findings",
      counts: { tp: 0, fp: 0, fn: input.truth.locations.length },
      anomalies: [],
    };
  }

  const adjudication = await input.client.adjudicate({
    caseId: input.caseId,
    findings: input.findings.map(findingToCard),
    truths: truthToCards(input.truth),
    context: {
      issueDescription: input.issueDescription,
      diff: input.diff,
      fixPatch: input.truth.fixPatch,
    },
  });
  const resolution = resolveAdjudication(
    adjudication,
    input.findings.length,
    input.truth.locations.length,
    input.matchConfidenceThreshold ?? DEFAULT_MATCH_CONFIDENCE_THRESHOLD,
  );
  const tp = resolution.matches.length;
  return {
    status: "judged",
    counts: {
      tp,
      fp: input.findings.length - tp,
      fn: input.truth.locations.length - tp,
    },
    // 归一阶段（畸形条目）与占用解析阶段（越界 / 重复占用）的留痕合并
    anomalies: [...(adjudication.anomalies ?? []), ...resolution.anomalies],
  };
}
