import { analyzeRuns } from "../analysis/analyze.js";
import type { AnalysisReport, AnalysisRunInput, MatchCounts } from "../analysis/contracts.js";
import {
  CAMPAIGN_ARMS,
  CAMPAIGN_REPORT_KIND,
  CAMPAIGN_REPORT_SCHEMA_VERSION,
  type CampaignCase,
  type CampaignReport,
  type EvalRunRecord,
} from "./contracts.js";
import { unitKey } from "./records.js";

/**
 * campaign 报告构造（#39）：按 arm 分节复用 main 只读分析器的 `AnalysisReport`
 * schema，不复制指标逻辑。
 *
 * 为什么分节：分析器按 `source|caseId|configId|rep` 去重且不含 arm；两臂
 * 共享 `configId = E`，合并成一份报告会撞唯一键。分节后每臂的报告保持
 * 分析器原 schema（kind `run-record-analysis`）；双 arm 配对统计 / L2 门
 * 在 #41 消费两侧分节报告。
 */

export interface CampaignReportArgs {
  readonly campaignId: string;
  readonly records: readonly EvalRunRecord[];
  readonly judgeCounts: ReadonlyMap<string, MatchCounts>;
  readonly cases: readonly CampaignCase[];
}

export function buildCampaignReport(args: CampaignReportArgs): CampaignReport {
  const truthByCase = new Map(args.cases.map((mrCase) => [mrCase.caseId, mrCase.truth]));
  const arms = Object.fromEntries(
    CAMPAIGN_ARMS.flatMap((arm) => {
      const armRecords = args.records.filter((record) => record.arm === arm);
      return armRecords.length === 0
        ? []
        : [[arm, analyzeArm(armRecords, truthByCase, args.judgeCounts, args.cases.length)]];
    }),
  ) as CampaignReport["arms"];
  return {
    kind: CAMPAIGN_REPORT_KIND,
    schemaVersion: CAMPAIGN_REPORT_SCHEMA_VERSION,
    campaignId: args.campaignId,
    arms,
  };
}

function analyzeArm(
  records: readonly EvalRunRecord[],
  truthByCase: ReadonlyMap<string, CampaignCase["truth"]>,
  judgeCounts: ReadonlyMap<string, MatchCounts>,
  plannedCases: number,
): AnalysisReport {
  const runs: AnalysisRunInput[] = records.map((record) => {
    if (!truthByCase.has(record.caseId)) {
      throw new Error(
        `campaign report: record ${record.caseId}/${record.arm}/rep-${record.rep} ` +
          "references a case missing from cases.json",
      );
    }
    const truth = truthByCase.get(record.caseId) ?? null;
    const counts = judgeCounts.get(unitKey(record));
    return {
      record,
      truth,
      ...(counts !== undefined ? { judgeCounts: counts } : {}),
    };
  });
  return analyzeRuns({ runs, plannedCases });
}
