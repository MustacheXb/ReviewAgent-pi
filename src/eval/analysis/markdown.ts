import type { AnalysisReport, RunAnalysis, Stat } from "./contracts.js";

/**
 * 确定性 Markdown 报告（#51）：只消费 AnalysisReport，不读时钟、不读路径、
 * 不排序外部数据。null 统一显示 N/A（不冒充 0）；数值原样输出以保证字节稳定。
 */

const N_A = "N/A";

export function renderAnalysisMarkdown(report: AnalysisReport): string {
  const lines: string[] = [];
  lines.push("# Token 分析报告", "");
  lines.push(`- runs: ${report.summary.runCount}`);
  lines.push(`- cases: ${report.summary.caseCount}`);
  lines.push(`- currency: ${report.currency ?? N_A}`);
  lines.push(`- priceValidFrom: ${report.priceValidFrom ?? N_A}`);
  lines.push("");

  lines.push("## 四行主表", "", "| 指标 | mean | std | count |", "|---|---:|---:|---:|");
  lines.push(statRow("cachedInputTokens", report.summary.cost.cachedInputTokens));
  lines.push(statRow("uncachedInputTokens", report.summary.cost.uncachedInputTokens));
  lines.push(statRow("outputTokens", report.summary.cost.outputTokens));
  lines.push(statRow("CARC", report.summary.cost.carc));
  lines.push("");

  lines.push("## 辅助 token 指标", "", "| 指标 | mean | std | count |", "|---|---:|---:|---:|");
  lines.push(statRow("totalTokens", report.summary.cost.totalTokens));
  lines.push(statRow("cacheHitRate", report.summary.cost.cacheHitRate));
  lines.push(statRow("toolCostTokens", report.summary.cost.toolCostTokens));
  lines.push(statRow("retryCostTokens", report.summary.cost.retryCostTokens));
  lines.push(statRow("summaryCostTokens", report.summary.cost.summaryCostTokens));
  lines.push(statRow("currencyCost", report.summary.cost.currencyCost));
  lines.push("");

  const contracted = report.runs.flatMap((run) =>
    run.cacheContract === undefined ? [] : [{ run, contract: run.cacheContract }],
  );
  if (contracted.length > 0) {
    lines.push("## 缓存合同", "");
    lines.push("| run | provider | endpoint | requested | responded | usage fields | metering |", "|---|---|---|---|---|---|---|");
    for (const { run, contract } of contracted) {
      lines.push(
        `| ${run.caseId}/${run.configId}/rep-${run.rep} | ${contract.provider} | ${contract.endpointKind} | ` +
          `${contract.requestedModel} | ${contract.respondedModel} | ${contract.usageFieldFamily} | ${String(contract.cacheMetering)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## 循环与工具", "", "| 指标 | mean | std | count |", "|---|---:|---:|---:|");
  lines.push(statRow("requests", report.summary.loop.requests));
  lines.push(statRow("rounds", report.summary.loop.rounds));
  lines.push(statRow("attemptedToolCalls", report.summary.loop.attemptedToolCalls));
  lines.push(statRow("executedToolCalls", report.summary.loop.executedToolCalls));
  lines.push(statRow("skippedToolCalls", report.summary.loop.skippedToolCalls));
  lines.push("");

  lines.push("## 截断", "");
  lines.push(`- truncatedRuns: ${report.summary.truncation.truncatedRuns}`);
  for (const [reason, count] of Object.entries(report.summary.truncation.reasons)) {
    lines.push(`- ${reason}: ${count}`);
  }
  lines.push("");

  lines.push("## 逐 run", "");
  lines.push(
    "| run | cached | uncached | output | CARC | currencyCost | requests | attempted | executed | skipped | truncated |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  );
  for (const run of report.runs) {
    lines.push(runRow(run));
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function statRow(label: string, stat: Stat | null): string {
  if (stat === null) {
    return `| ${label} | ${N_A} | ${N_A} | 0 |`;
  }
  return `| ${label} | ${formatNumber(stat.mean)} | ${formatNumber(stat.std)} | ${stat.count} |`;
}

function runRow(run: RunAnalysis): string {
  const cells = [
    `${run.caseId}/${run.configId}/rep-${run.rep}`,
    nullable(run.cost.cachedInputTokens),
    formatNumber(run.cost.uncachedInputTokens),
    formatNumber(run.cost.outputTokens),
    formatNumber(run.cost.carc),
    nullable(run.cost.currencyCost),
    formatNumber(run.loop.requests),
    formatNumber(run.loop.attemptedToolCalls),
    formatNumber(run.loop.executedToolCalls),
    formatNumber(run.loop.skippedToolCalls),
    String(run.loop.truncated),
  ];
  return `| ${cells.join(" | ")} |`;
}

function nullable(value: number | null): string {
  return value === null ? N_A : formatNumber(value);
}

function formatNumber(value: number): string {
  return String(value);
}
