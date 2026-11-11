import type { EnvironmentManifest } from "../campaign/contracts.js";
import type {
  L2ArmMetrics,
  L2Coverage,
  L2PairedMetrics,
  L2PairedSet,
  L2Report,
  NoiseFloorReport,
  PairedDiff,
  PairedRatio,
  ThresholdReview,
} from "./contracts.js";
import {
  NOISE_FLOOR_REPORT_KIND,
  NOISE_FLOOR_REPORT_SCHEMA_VERSION,
} from "./contracts.js";

/**
 * L2 空对照校准噪声底报告（#42，ADR-0017 §5）：输入 `l2-report.json` +
 * `environment.json`，输出机读 JSON 与确定性 Markdown。
 *
 * 纪律：
 * - 校准只用于确认 / 调整 provisional 阈值，**不用于判定优化收益**——
 *   `conclusion.claimsAllowed` 恒 false；
 * - 只接受空对照校准（baseline / candidate 同 ref 双 arm），正式 campaign
 *   调用即 fail fast；
 * - 纯函数：零网络、零文件系统、无时钟；Markdown 字节稳定（`--report-only`
 *   可复算）；
 * - 建议不自动落为阈值：阈值变更须按 ADR-0017 §5 以补记固化。
 */

/** 单侧 95% 正态分位（比率守卫的空对照上界） */
const Z_ONE_SIDED_95 = 1.645;

/** CARC 主门的观测精度预算：目标 0.90 + 半宽 < CI 上界门 1.00 */
const CARC_PRECISION_BUDGET = 0.1;

/** CARC 空对照中心允许偏离 1.0 的告警带（系统臂/窗口偏差） */
const CARC_CENTER_TOLERANCE = 0.02;

/** 有界性上界建议留出的空对照余量比例（下一轮等价跑不因噪声越界） */
const BOUND_HEADROOM = 0.1;

export interface BuildNoiseFloorReportArgs {
  readonly l2: L2Report;
  readonly environment: EnvironmentManifest;
}

export function buildNoiseFloorReport(args: BuildNoiseFloorReportArgs): NoiseFloorReport {
  const { l2, environment } = args;
  if (l2.campaignType !== "calibration" || l2.calibrationRef === null) {
    throw new Error(
      "noise floor report: only an empty-control calibration (same code, dual arm, " +
        `campaignType = "calibration") can produce a noise floor (got ` +
        `${JSON.stringify(l2.campaignType)})`,
    );
  }
  return {
    kind: NOISE_FLOOR_REPORT_KIND,
    schemaVersion: NOISE_FLOOR_REPORT_SCHEMA_VERSION,
    campaignId: l2.campaignId,
    calibrationRef: l2.calibrationRef,
    campaignType: "calibration",
    outputDir: l2.outputDir,
    baseline: l2.baseline,
    candidate: l2.candidate,
    dataset: l2.dataset,
    sampling: l2.sampling,
    coverage: l2.coverage,
    environment: {
      git: environment.git,
      model: environment.model,
      judge: environment.judge,
      window: environment.window,
    },
    metrics: l2.metrics,
    bounds: l2.bounds,
    gates: l2.gates,
    thresholds: l2.thresholds,
    thresholdReview: reviewThresholds(l2),
    bootstrap: l2.bootstrap,
    conclusion: {
      noiseFloorMeasured: true,
      claimsAllowed: false,
      note:
        "空对照校准只测噪声底，不判定优化收益；阈值变更须按 ADR-0017 §5 " +
        "以补记固化，并重新跑校准。",
    },
  };
}

/** 阈值复核：按数据给出保留 / 调整建议（不改写阈值） */
function reviewThresholds(l2: L2Report): readonly ThresholdReview[] {
  const warm = l2.metrics.paired.warm;
  const t = l2.thresholds;
  const cases = l2.sampling.cases;
  return [
    reviewCarcTarget(warm.carcRatio, t.maxCarcRatio, cases),
    reviewRatioGuard("cost", "maxUncachedRatio", warm.uncachedRatio, t.maxUncachedRatio),
    reviewRatioGuard("cost", "maxOutputRatio", warm.outputRatio, t.maxOutputRatio),
    reviewRatioGuard("cost", "maxAttemptsRatio", warm.attemptsRatio, t.maxAttemptsRatio),
    reviewRatioGuard("cost", "maxRequestsRatio", warm.requestsRatio, t.maxRequestsRatio),
    reviewNonInferiority(warm, t.qualityNonInferiorityPp),
    reviewZeroFinding(warm.zeroFindingRateDiff, t.maxZeroFindingRateIncreasePp),
    reviewNegativeControl(l2, t.maxNegativeControlFpSigma),
    reviewCoverage(l2.coverage, t.minCoverage),
    reviewBound("maxAttemptedToolCalls", l2.bounds.maxAttemptedToolCalls, t.maxAttemptedToolCalls),
    reviewBound("maxRequests", l2.bounds.maxRequests, t.maxRequests),
    reviewBound("maxOutputTokens", l2.bounds.maxOutputTokens, t.maxOutputTokens),
  ];
}

/**
 * CARC 主门：空对照给出噪声半宽。0.90 目标要能被 CI 上界门（< 1.00）放行，
 * 半宽必须 < 10pp；否则 30 案不足以把「真实 0.90」与「无变化」区分开，
 * 建议扩样（CI 宽度约按 1/√N 收缩）。
 */
function reviewCarcTarget(
  ratio: PairedRatio,
  provisional: number,
  cases: number,
): ThresholdReview {
  if (ratio.pairs === 0 || ratio.mean === null || ratio.ci95 === null) {
    return reviewNotApplicable("cost", "maxCarcRatio", provisional, "空对照 CARC 配对数据不足");
  }
  const halfWidth = (ratio.ci95[1] - ratio.ci95[0]) / 2;
  const bias = ratio.mean - 1;
  const biasNote =
    Math.abs(bias) > CARC_CENTER_TOLERANCE
      ? `；注意空对照中心偏离 1.0 达 ${fmtPp(bias)}，存在臂/窗口系统偏差，须排查后再信阈值`
      : "";
  if (halfWidth < CARC_PRECISION_BUDGET) {
    return {
      gate: "cost",
      name: "maxCarcRatio",
      provisional,
      observed: ratio.mean,
      recommendation: "keep",
      suggested: null,
      suggestedCases: null,
      rationale:
        `空对照 CARC 比率 ci95 半宽 ${fmt3(halfWidth)} < 10pp：` +
        `${fmt3(provisional)} 目标 + 半宽 < 1.00，主门可达成${biasNote}`,
    };
  }
  const suggestedCases = Math.max(
    cases,
    Math.ceil(cases * (halfWidth / CARC_PRECISION_BUDGET) ** 2),
  );
  return {
    gate: "cost",
    name: "maxCarcRatio",
    provisional,
    observed: ratio.mean,
    recommendation: "gather-more",
    suggested: null,
    suggestedCases,
    rationale:
      `空对照 CARC 比率 ci95 半宽 ${fmt3(halfWidth)} ≥ 10pp：${fmt3(provisional)} 目标 + ` +
      `半宽 ≥ 1.00，当前样本量无法让真实 ${fmt3(provisional)} 通过 CI 上界门；` +
      `建议扩样到约 ${suggestedCases} 案（或明确降低主门目标）`,
  };
}

/**
 * 1.00 / 1.05 类比率守卫：空对照均值在边界附近时，任何正噪声都会让无变化
 * 的 candidate 假失败。用单侧 95% 上界（mean + 1.645·SE）作为建议下界，
 * 保留「上升即拦」语义；建议值不自动生效。
 */
function reviewRatioGuard(
  gate: "cost",
  name: string,
  ratio: PairedRatio,
  provisional: number,
): ThresholdReview {
  if (ratio.pairs === 0 || ratio.mean === null) {
    return reviewNotApplicable(gate, name, provisional, "配对数据不足");
  }
  const se =
    ratio.std === null || ratio.pairs <= 1 ? null : ratio.std / Math.sqrt(ratio.pairs);
  if (se === null) {
    return reviewNotApplicable(gate, name, provisional, "比率样本标准差不可用");
  }
  const upper95 = ratio.mean + Z_ONE_SIDED_95 * se;
  if (upper95 <= provisional) {
    return {
      gate,
      name,
      provisional,
      observed: ratio.mean,
      recommendation: "keep",
      suggested: null,
      suggestedCases: null,
      rationale:
        `空对照单侧 95% 上界 ${fmt3(upper95)} ≤ ${fmt3(provisional)}：` +
        `无变化不会被误判为回归`,
    };
  }
  const suggested = roundUpTo(upper95, 0.01);
  return {
    gate,
    name,
    provisional,
    observed: ratio.mean,
    recommendation: "adjust",
    suggested,
    suggestedCases: null,
    rationale:
      `空对照单侧 95% 上界 ${fmt3(upper95)} > ${fmt3(provisional)}：` +
      `空对照本身会触发假失败；建议放宽到 ${fmt3(suggested)}（仍拦回归，只在噪声带内）`,
  };
}

/** judge Recall / Precision 配对非劣：阈值必须覆盖空对照 CI 下界 */
function reviewNonInferiority(
  warm: L2PairedSet,
  provisional: number,
): ThresholdReview {
  const lowers = [warm.judgeRecallDiff, warm.judgePrecisionDiff]
    .map((diff) => (diff.ci95 === null ? null : diff.ci95[0]))
    .filter((value): value is number => value !== null);
  if (lowers.length === 0) {
    return reviewNotApplicable("quality", "qualityNonInferiorityPp", provisional, "judge 配对 CI 不可用");
  }
  const observed = Math.min(...lowers);
  if (observed >= -provisional) {
    return {
      gate: "quality",
      name: "qualityNonInferiorityPp",
      provisional,
      observed,
      recommendation: "keep",
      suggested: null,
      suggestedCases: null,
      rationale:
        `空对照质量配对 CI 下界 ${fmtPp(observed)} 落在 −${fmtPp(provisional)} 内：` +
        "无质量变化的 candidate 不会被误判",
    };
  }
  const suggested = roundUpTo(Math.abs(observed), 0.005);
  return {
    gate: "quality",
    name: "qualityNonInferiorityPp",
    provisional,
    observed,
    recommendation: "adjust",
    suggested,
    suggestedCases: null,
    rationale:
      `空对照噪声超出 −${fmtPp(provisional)}（CI 下界 ${fmtPp(observed)}）：` +
      `无质量变化的 candidate 也会假失败；建议放宽到 ${fmtPp(suggested)} 覆盖噪声`,
  };
}

function reviewZeroFinding(
  diff: PairedDiff,
  provisional: number,
): ThresholdReview {
  if (diff.pairs === 0 || diff.mean === null) {
    return reviewNotApplicable("quality", "maxZeroFindingRateIncreasePp", provisional, "配对数据不足");
  }
  if (diff.mean > provisional) {
    const suggested = roundUpTo(diff.mean, 0.005);
    return {
      gate: "quality",
      name: "maxZeroFindingRateIncreasePp",
      provisional,
      observed: diff.mean,
      recommendation: "adjust",
      suggested,
      suggestedCases: null,
      rationale:
        `空对照零 finding 率上升 ${fmtPp(diff.mean)} > ${fmtPp(provisional)}；` +
        `建议放宽到 ${fmtPp(suggested)}`,
    };
  }
  return {
    gate: "quality",
    name: "maxZeroFindingRateIncreasePp",
    provisional,
    observed: diff.mean,
    recommendation: "keep",
    suggested: null,
    suggestedCases: null,
    rationale: `空对照零 finding 率上升 ${fmtPp(diff.mean)} ≤ ${fmtPp(provisional)}`,
  };
}

/** clean MR 阴性对照：数据集无 clean MR → 明确 N/A，不假装通过 */
function reviewNegativeControl(l2: L2Report, provisional: number): ThresholdReview {
  if (l2.dataset.negativeControl === 0) {
    return reviewNotApplicable(
      "quality",
      "maxNegativeControlFpSigma",
      provisional,
      "数据集无 clean MR 阴性对照，本阈值本次不可校准",
    );
  }
  const baseline = l2.metrics.baseline.warm.quality.negativeControlFpPerCase;
  const diff = l2.metrics.paired.warm.negativeControlFpDiff;
  if (baseline === null || diff.mean === null) {
    return reviewNotApplicable("quality", "maxNegativeControlFpSigma", provisional, "阴性对照配对数据不足");
  }
  if (baseline.std === 0) {
    return {
      gate: "quality",
      name: "maxNegativeControlFpSigma",
      provisional,
      observed: diff.mean,
      recommendation: diff.mean <= 0 ? "keep" : "gather-more",
      suggested: null,
      suggestedCases: null,
      rationale:
        "空对照 baseline 阴性对照 FP 标准差为 0；σ 倍数无定义，建议补充 clean MR 重校准",
    };
  }
  const sigma = diff.mean / baseline.std;
  if (sigma > provisional) {
    const suggested = roundUpTo(sigma, 0.1);
    return {
      gate: "quality",
      name: "maxNegativeControlFpSigma",
      provisional,
      observed: sigma,
      recommendation: "adjust",
      suggested,
      suggestedCases: null,
      rationale: `空对照阴性对照 FP 差 ${fmt3(sigma)}σ > ${provisional}σ；建议放宽到 ${suggested}σ`,
    };
  }
  return {
    gate: "quality",
    name: "maxNegativeControlFpSigma",
    provisional,
    observed: sigma,
    recommendation: "keep",
    suggested: null,
    suggestedCases: null,
    rationale: `空对照阴性对照 FP 差 ${fmt3(sigma)}σ ≤ ${provisional}σ`,
  };
}

/** coverage 是数据完整性，不是噪声：不足只建议补跑，不放松门槛 */
function reviewCoverage(coverage: L2Coverage, provisional: number): ThresholdReview {
  if (coverage.ratio === null) {
    return reviewNotApplicable("quality", "minCoverage", provisional, "coverage 不可用");
  }
  if (coverage.ratio < provisional) {
    return {
      gate: "quality",
      name: "minCoverage",
      provisional,
      observed: coverage.ratio,
      recommendation: "gather-more",
      suggested: null,
      suggestedCases: null,
      rationale:
        `coverage ${fmt3(coverage.ratio)} < ${fmt3(provisional)} ` +
        `(${coverage.executed}/${coverage.planned})：数据不完整，阈值不放松，先补跑`,
    };
  }
  return {
    gate: "quality",
    name: "minCoverage",
    provisional,
    observed: coverage.ratio,
    recommendation: "keep",
    suggested: null,
    suggestedCases: null,
    rationale: `coverage ${fmt3(coverage.ratio)} ≥ ${fmt3(provisional)}`,
  };
}

/** 有界性绝对值上界：空对照观测超过 provisional 说明上限定得比现状还低 */
function reviewBound(
  name: "maxAttemptedToolCalls" | "maxRequests" | "maxOutputTokens",
  observed: number | null,
  provisional: number,
): ThresholdReview {
  if (observed === null) {
    return reviewNotApplicable("boundedness", name, provisional, "无 run 观测");
  }
  if (observed > provisional) {
    const suggested = observed + Math.max(1, Math.ceil(observed * BOUND_HEADROOM));
    return {
      gate: "boundedness",
      name,
      provisional,
      observed,
      recommendation: "adjust",
      suggested,
      suggestedCases: null,
      rationale:
        `空对照实测最大 ${observed} > provisional ${provisional}：` +
        `现阈值会让基线自身失败；建议上界 ${suggested}（实测 + ~10% 余量，` +
        `放宽为安全上限，不取消检查）`,
    };
  }
  return {
    gate: "boundedness",
    name,
    provisional,
    observed,
    recommendation: "keep",
    suggested: null,
    suggestedCases: null,
    rationale: `空对照实测最大 ${observed} ≤ provisional ${provisional}`,
  };
}

function reviewNotApplicable(
  gate: ThresholdReview["gate"],
  name: string,
  provisional: number,
  rationale: string,
): ThresholdReview {
  return {
    gate,
    name,
    provisional,
    observed: null,
    recommendation: "n/a",
    suggested: null,
    suggestedCases: null,
    rationale,
  };
}

/** 确定性 Markdown（无时间戳；同输入字节稳定） */
export function renderNoiseFloorMarkdown(report: NoiseFloorReport): string {
  const lines: string[] = [];
  lines.push(`# L2 空对照校准噪声底报告 ${report.campaignId}`, "");
  lines.push(
    "> 本报告只用于确认 / 调整 L2 provisional 阈值，**不得据此宣称优化收益**" +
      "（claimsAllowed = false）。",
  );
  lines.push(
    `> calibrationRef: \`${report.calibrationRef}\` · campaignType: \`${report.campaignType}\``,
    "",
  );

  lines.push("## 1. 身份与环境", "");
  lines.push("| 项 | 值 |", "|---|---|");
  lines.push(`| baseline ref | \`${report.baseline.ref}\` |`);
  lines.push(`| candidate ref | \`${report.candidate.ref}\` |`);
  lines.push(`| 被测模型 | \`${report.baseline.model}\` |`);
  lines.push(`| provider | ${report.environment.model.providerClass ?? "N/A"} |`);
  lines.push(
    `| judge | \`${report.environment.judge.model ?? "N/A"}\` · prompt ` +
      `\`${report.environment.judge.promptVersion ?? "N/A"}\` · ` +
      `temperature ${fmtNullable(report.environment.judge.temperature)} · ` +
      `top_p ${fmtNullable(report.environment.judge.topP)} |`,
  );
  lines.push(
    `| git | branch ${report.environment.git.branch ?? "N/A"} · commit ` +
      `${report.environment.git.commit ?? "N/A"} · tag ${report.environment.git.tag ?? "N/A"} |`,
  );
  lines.push(
    `| 时间窗 | ${report.environment.window.start ?? "N/A"} → ` +
      `${report.environment.window.end ?? "N/A"}（${report.environment.window.timezone ?? "N/A"}） |`,
  );
  lines.push(
    `| 数据集 | ${report.dataset.cases} 案 · clean MR ` +
      `${report.dataset.negativeControl === 0 ? "N/A（无 clean MR）" : report.dataset.negativeControl} · ` +
      `sha256 \`${report.dataset.hash}\` |`,
  );
  lines.push(
    `| 样本量 | ${report.sampling.cases} case × ${report.sampling.reps} reps × ` +
      `${report.sampling.arms} arms = ${report.sampling.planned} 单元 |`,
  );
  lines.push(
    `| coverage | ${fmtNullable(report.coverage.ratio)}（executed ${report.coverage.executed} / ` +
      `planned ${report.coverage.planned}，judged ${report.coverage.judged}，` +
      `failed ${report.coverage.failed}） |`,
  );
  lines.push(
    `| bootstrap | ${report.bootstrap.iterations} 次 · seed ${report.bootstrap.seed} · ` +
      `confidence ${report.bootstrap.confidence} |`,
    "",
  );

  lines.push("## 2. 配对统计（warm = rep2+ 主口径；cold = rep1 单列）", "");
  lines.push("| 指标 | warm mean | warm ci95 | cold mean | cold ci95 |", "|---|---:|---|---:|---|");
  for (const row of pairedRows(report.metrics.paired)) {
    lines.push(
      `| ${row.label} | ${fmtStat(row.warm)} | ${fmtCi(row.warm)} | ` +
        `${fmtStat(row.cold)} | ${fmtCi(row.cold)} |`,
    );
  }
  lines.push("");

  lines.push("## 3. 两臂绝对指标（warm = rep2+）", "");
  lines.push("| 指标 | baseline | candidate |", "|---|---:|---:|");
  for (const row of armRows(report.metrics.baseline.warm, report.metrics.candidate.warm)) {
    lines.push(`| ${row.label} | ${fmtStat(row.baseline)} | ${fmtStat(row.candidate)} |`);
  }
  lines.push("");

  lines.push("## 4. 观测上界（两臂冷热全查）", "");
  lines.push("| 指标 | 实测最大 | provisional |", "|---|---:|---:|");
  lines.push(
    `| attemptedToolCalls | ${fmtNullable(report.bounds.maxAttemptedToolCalls)} | ` +
      `${report.thresholds.maxAttemptedToolCalls} |`,
  );
  lines.push(
    `| requests | ${fmtNullable(report.bounds.maxRequests)} | ` +
      `${report.thresholds.maxRequests} |`,
  );
  lines.push(
    `| outputTokens | ${fmtNullable(report.bounds.maxOutputTokens)} | ` +
      `${report.thresholds.maxOutputTokens} |`,
  );
  lines.push(
    `| truncated runs | ${report.bounds.truncatedRuns} | ` +
      `truncated => truncationReasons non-empty |`,
    "",
  );

  lines.push("## 5. 阈值复核建议", "");
  lines.push("| 门 | 阈值 | provisional | observed | 建议 | suggested | 依据 |");
  lines.push("|---|---|---:|---:|---|---:|---|");
  for (const entry of report.thresholdReview) {
    lines.push(
      `| ${entry.gate} | ${entry.name} | ${fmt3(entry.provisional)} | ` +
        `${entry.observed === null ? "N/A" : fmt3(entry.observed)} | ` +
        `${entry.recommendation} | ${entry.suggested === null ? "—" : fmt3(entry.suggested)} | ` +
        `${entry.rationale} |`,
    );
  }
  lines.push("");

  lines.push("## 6. 结论与复算", "");
  lines.push("- 噪声底已测量；本报告**不是**优化收益判定，claimsAllowed 恒 false。");
  lines.push(
    `- 阈值变更须按 ADR-0017 §5 以补记固化；模型 / provider / judge / 提示词 / ` +
      `工具 schema 变更后重做校准。`,
  );
  lines.push(
    `- 复算（零网络）：\`pnpm campaign -- --report-only --out ${report.outputDir}\``,
  );
  lines.push("");
  return `${lines.join("\n")}`;
}

function pairedRows(paired: L2PairedMetrics): readonly {
  readonly label: string;
  readonly warm: PairedRatio | PairedDiff;
  readonly cold: PairedRatio | PairedDiff;
}[] {
  return [
    { label: "CARC ratio", warm: paired.warm.carcRatio, cold: paired.cold.carcRatio },
    { label: "uncached ratio", warm: paired.warm.uncachedRatio, cold: paired.cold.uncachedRatio },
    { label: "output ratio", warm: paired.warm.outputRatio, cold: paired.cold.outputRatio },
    {
      label: "totalTokens ratio",
      warm: paired.warm.totalTokensRatio,
      cold: paired.cold.totalTokensRatio,
    },
    {
      label: "cachedInput ratio",
      warm: paired.warm.cachedInputRatio,
      cold: paired.cold.cachedInputRatio,
    },
    { label: "attempts ratio", warm: paired.warm.attemptsRatio, cold: paired.cold.attemptsRatio },
    { label: "requests ratio", warm: paired.warm.requestsRatio, cold: paired.cold.requestsRatio },
    {
      label: "cacheHitRate diff",
      warm: paired.warm.cacheHitRateDiff,
      cold: paired.cold.cacheHitRateDiff,
    },
    {
      label: "judgeRecall diff",
      warm: paired.warm.judgeRecallDiff,
      cold: paired.cold.judgeRecallDiff,
    },
    {
      label: "judgePrecision diff",
      warm: paired.warm.judgePrecisionDiff,
      cold: paired.cold.judgePrecisionDiff,
    },
    {
      label: "zero-finding rate diff",
      warm: paired.warm.zeroFindingRateDiff,
      cold: paired.cold.zeroFindingRateDiff,
    },
    {
      label: "negative-control FP diff",
      warm: paired.warm.negativeControlFpDiff,
      cold: paired.cold.negativeControlFpDiff,
    },
  ];
}

function armRows(
  baseline: L2ArmMetrics["warm"],
  candidate: L2ArmMetrics["warm"],
): readonly { readonly label: string; readonly baseline: number | null; readonly candidate: number | null }[] {
  return [
    { label: "CARC", baseline: baseline.cost.carc?.mean ?? null, candidate: candidate.cost.carc?.mean ?? null },
    {
      label: "cachedInputTokens",
      baseline: baseline.cost.cachedInputTokens?.mean ?? null,
      candidate: candidate.cost.cachedInputTokens?.mean ?? null,
    },
    {
      label: "uncachedInputTokens",
      baseline: baseline.cost.uncachedInputTokens?.mean ?? null,
      candidate: candidate.cost.uncachedInputTokens?.mean ?? null,
    },
    {
      label: "outputTokens",
      baseline: baseline.cost.outputTokens?.mean ?? null,
      candidate: candidate.cost.outputTokens?.mean ?? null,
    },
    {
      label: "totalTokens",
      baseline: baseline.cost.totalTokens?.mean ?? null,
      candidate: candidate.cost.totalTokens?.mean ?? null,
    },
    {
      label: "cacheHitRate",
      baseline: baseline.cost.cacheHitRate?.mean ?? null,
      candidate: candidate.cost.cacheHitRate?.mean ?? null,
    },
    {
      label: "judgeRecall",
      baseline: baseline.quality.judgeRecall?.mean ?? null,
      candidate: candidate.quality.judgeRecall?.mean ?? null,
    },
    {
      label: "judgePrecision",
      baseline: baseline.quality.judgePrecision?.mean ?? null,
      candidate: candidate.quality.judgePrecision?.mean ?? null,
    },
    {
      label: "attemptedToolCalls",
      baseline: baseline.loop.attemptedToolCalls?.mean ?? null,
      candidate: candidate.loop.attemptedToolCalls?.mean ?? null,
    },
    {
      label: "requests",
      baseline: baseline.loop.requests?.mean ?? null,
      candidate: candidate.loop.requests?.mean ?? null,
    },
  ];
}

function fmtStat(value: { readonly mean: number | null } | number | null): string {
  if (value === null) {
    return "N/A";
  }
  if (typeof value === "number") {
    return fmt3(value);
  }
  return value.mean === null ? "N/A" : fmt3(value.mean);
}

function fmtCi(value: { readonly ci95: readonly [number, number] | null }): string {
  return value.ci95 === null
    ? "N/A"
    : `[${fmt3(value.ci95[0])}, ${fmt3(value.ci95[1])}]`;
}

function fmt3(value: number): string {
  return value.toFixed(3);
}

function fmtNullable(value: number | null): string {
  return value === null ? "N/A" : fmt3(value);
}

/** 百分点格式（0.03 → 3.0pp） */
function fmtPp(value: number): string {
  return `${(value * 100).toFixed(1)}pp`;
}

/** 向上取整到精度步长（确定性阈值建议） */
function roundUpTo(value: number, step: number): number {
  return Math.ceil(value / step - 1e-9) * step;
}
