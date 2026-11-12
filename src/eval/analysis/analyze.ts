import type { CacheContract } from "review-pi";
import { buildL1, buildSummary } from "./aggregate.js";
import type {
  AnalysisInput,
  AnalysisPriceTable,
  AnalysisReport,
  AnalysisRunInput,
  RunAnalysis,
} from "./contracts.js";
import {
  ANALYSIS_REPORT_KIND,
  ANALYSIS_REPORT_SCHEMA_VERSION,
  DEFAULT_TOOL_COST_PRICING,
  type ToolCostPricing,
} from "./contracts.js";
import { computePrf } from "./quality.js";
import { screenFindings } from "./screening.js";
import { computeRunCost, computeToolCostTokens, computeRetryCostTokens } from "./tokens.js";
import { truthKindOf } from "./truth-kind.js";
import { ANALYSIS_CONFIG_IDS, validateAnalysisInput } from "./validate.js";

/**
 * 只读 RunRecord 分析器主入口（#37）：纯函数，输入 run 记录 + 可选真值 /
 * judge 结果，输出标准化报告 JSON。不执行配置、不调用 LLM、不读网关。
 *
 * 聚合口径（评测方案 §5.3 / §6.3）：跨 case 每案等权——先 case 内跨 rep
 * 平均，再跨 case 求均值 ± 样本标准差。冷热分档与配对统计属于 eval/bench
 * 的 campaign 面，不在本 P0 分析器内实现。
 */
export function analyzeRuns(input: AnalysisInput): AnalysisReport {
  validateAnalysisInput(input);
  const pricing = input.toolCost ?? DEFAULT_TOOL_COST_PRICING;
  const priceTable = input.priceTable ?? null;
  const inputs = sortRuns(input.runs);
  const runs = inputs.map((run) => analyzeRun(run, pricing, priceTable));
  return {
    kind: ANALYSIS_REPORT_KIND,
    schemaVersion: ANALYSIS_REPORT_SCHEMA_VERSION,
    currency: input.priceTable?.currency ?? null,
    priceValidFrom: input.priceTable?.priceValidFrom ?? null,
    runs,
    summary: buildSummary(runs),
    l1: buildL1(runs, inputs, input.plannedCases),
  };
}

/** 确定性排序：caseId → source → configId（A–E）→ rep；报告 bytes 与输入顺序无关 */
function sortRuns(runs: readonly AnalysisRunInput[]): readonly AnalysisRunInput[] {
  return [...runs].sort((left, right) => {
    const byCase = compare(left.record.caseId, right.record.caseId);
    if (byCase !== 0) {
      return byCase;
    }
    const bySource = compare(left.record.source, right.record.source);
    if (bySource !== 0) {
      return bySource;
    }
    const byConfig =
      ANALYSIS_CONFIG_IDS.indexOf(left.record.configId) -
      ANALYSIS_CONFIG_IDS.indexOf(right.record.configId);
    if (byConfig !== 0) {
      return byConfig;
    }
    return left.record.rep - right.record.rep;
  });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function analyzeRun(
  run: AnalysisRunInput,
  pricing: ToolCostPricing,
  priceTable: AnalysisPriceTable | null,
): RunAnalysis {
  // P0 只分析 baseline 快照（生产 verifier off 档）；effective 复核档不在
  // 本分析器范围（历史 A–D 记录 effective 恒 null，缺席不影响读取）。
  const { record } = run;
  const { baseline } = record;
  const requests = baseline.audit.phaseLog.reduce((sum, phase) => sum + phase.requestCount, 0);
  const findingCount = baseline.findings.length;
  const truth = truthKindOf(run.truth);
  const rule =
    run.truth === undefined || run.truth === null
      ? null
      : computePrf(screenFindings(baseline.findings, run.truth));
  const judge = run.judgeCounts === undefined ? null : computePrf(run.judgeCounts);
  const toolCostTokens = computeToolCostTokens(baseline.audit.toolCallLog, pricing);
  const attemptedToolCalls = baseline.audit.toolCallLog.length;
  const executedToolCalls = baseline.toolCalls;
  const cacheContract = contractWithPrices(baseline.audit.cacheContract, priceTable);
  const retryCostTokens =
    run.retryCostTokens !== undefined
      ? run.retryCostTokens
      : computeRetryCostTokens(baseline.audit.retry);
  return {
    source: record.source,
    caseId: record.caseId,
    configId: record.configId,
    rep: record.rep,
    model: record.model,
    completedAt: record.completedAt,
    ...(cacheContract !== undefined ? { cacheContract } : {}),
    cost: computeRunCost(
      baseline.usage,
      toolCostTokens,
      retryCostTokens,
      run.summaryCostTokens ?? null,
      priceTable,
    ),
    loop: {
      requests,
      rounds: baseline.rounds,
      attemptedToolCalls,
      executedToolCalls,
      skippedToolCalls: Math.max(0, attemptedToolCalls - executedToolCalls),
      truncated: baseline.audit.truncated,
      truncationReasons: [...baseline.audit.truncationReasons],
    },
    quality: {
      findingCount,
      zeroFindings: findingCount === 0,
      truth,
      rule,
      judge,
    },
  };
}

/**
 * 报告层价目附加（#58）：运行期审计只含可观测事实；分析命令提供静态价目表
 * 时把价目三元组 / 币种 / 生效时间附加到报告的 cacheContract 上（审计不读
 * 价目文件）；缺价目表则保持合同原样（省键）。
 */
function contractWithPrices(
  contract: CacheContract | undefined,
  priceTable: AnalysisPriceTable | null,
): CacheContract | undefined {
  if (contract === undefined || priceTable === null) {
    return contract;
  }
  return {
    ...contract,
    cacheHitPrice: priceTable.cacheHitPrice,
    cacheMissPrice: priceTable.cacheMissPrice,
    ...(priceTable.cacheWritePrice !== undefined
      ? { cacheWritePrice: priceTable.cacheWritePrice }
      : {}),
    currency: priceTable.currency,
    priceValidFrom: priceTable.priceValidFrom,
  };
}
