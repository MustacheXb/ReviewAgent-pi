import {
  DEFAULT_L2_GATE_THRESHOLDS,
  type L2GateEvaluation,
  type L2GateInput,
  type L2GateResult,
  type L2GateThresholds,
  type L2Gates,
  type PairedDiff,
  type PairedRatio,
} from "./contracts.js";

/**
 * L2 门判定（#41）：成本 / 质量非劣 / 有界性 / 可复现四门，全部输入输出都是
 * 纯数据（无 IO、无网络）。阈值 initial provisional（ADR-0017 §3），可整体
 * 覆盖以支持 #42 校准后的阈值固化与变化点测试。
 *
 * 不足数据不放行：任何主门指标为 N/A（pairs = 0 / CI 缺失 / coverage 未知）
 * 一律判 fail 并在 detail 写明原因——「没测到」不能被当成「通过」。
 */

export function evaluateL2Gates(input: L2GateInput): L2GateEvaluation {
  const thresholds: L2GateThresholds = {
    ...DEFAULT_L2_GATE_THRESHOLDS,
    ...input.thresholds,
  };
  const gates: L2Gates = {
    cost: evaluateCost(input.paired, thresholds),
    quality: evaluateQuality(input, thresholds),
    boundedness: evaluateBoundedness(input.runs, thresholds),
    reproducibility: evaluateReproducibility(input.repro),
  };
  return {
    gates,
    claimsAllowed: claimsAllowedOf(gates, input.baselineRef, input.candidateRef),
    thresholds,
  };
}

/**
 * `claimsAllowed` = 四门全过且 baseline / candidate ref 不同。同 ref 的空对照
 * 校准即使偶然出现成本下降也不得据此宣称收益（ADR-0017 §5）；对外宣称仍需
 * L3 报告 + environment.json + 产品签字（§4）。
 */
export function claimsAllowedOf(
  gates: L2Gates,
  baselineRef: string,
  candidateRef: string,
): boolean {
  return (
    baselineRef !== candidateRef &&
    gates.cost.pass &&
    gates.quality.pass &&
    gates.boundedness.pass &&
    gates.reproducibility.pass
  );
}

function evaluateCost(paired: L2GateInput["paired"], t: L2GateThresholds): L2GateResult {
  const failures: string[] = [];
  const parts: string[] = [];

  const carc = paired.carcRatio;
  const carcMean = requireRatio(carc, "CARC", failures);
  const carcCi = requireCi(carc, "CARC", failures);
  if (carcMean !== null && carcMean > t.maxCarcRatio) {
    failures.push(`CARC ratio ${fmt(carcMean)} > maxCarcRatio ${fmt(t.maxCarcRatio)}`);
  }
  if (carcCi !== null && !(carcCi[1] < t.maxCarcRatioCiUpper)) {
    failures.push(
      `CARC ci95 upper ${fmt(carcCi[1])} not < ${fmt(t.maxCarcRatioCiUpper)}`,
    );
  }
  if (carcMean !== null) {
    parts.push(`CARC ${fmt(carcMean)} (ci95 ${fmtCi(carcCi)})`);
  }

  const decompositions: readonly [PairedRatio, string, number][] = [
    [paired.uncachedRatio, "uncached", t.maxUncachedRatio],
    [paired.outputRatio, "output", t.maxOutputRatio],
    [paired.attemptsRatio, "attemptedToolCalls", t.maxAttemptsRatio],
    [paired.requestsRatio, "requests", t.maxRequestsRatio],
  ];
  for (const [ratio, label, limit] of decompositions) {
    const value = requireRatio(ratio, label, failures);
    if (value === null) {
      continue;
    }
    if (value > limit) {
      failures.push(`${label} ratio ${fmt(value)} > ${fmt(limit)}`);
    }
    parts.push(`${label} ${fmt(value)}`);
  }

  return gateResult(
    failures,
    `carcRatio <= ${fmt(t.maxCarcRatio)} && ci95 upper < ${fmt(t.maxCarcRatioCiUpper)} && ` +
      `uncached <= ${fmt(t.maxUncachedRatio)} && output <= ${fmt(t.maxOutputRatio)} && ` +
      `attempts <= ${fmt(t.maxAttemptsRatio)} && requests <= ${fmt(t.maxRequestsRatio)}`,
    parts.join(", "),
  );
}

function evaluateQuality(input: L2GateInput, t: L2GateThresholds): L2GateResult {
  const failures: string[] = [];
  const parts: string[] = [];

  checkNonInferiority(
    "judgeRecall",
    input.paired.judgeRecallDiff,
    t.qualityNonInferiorityPp,
    failures,
    parts,
  );
  checkNonInferiority(
    "judgePrecision",
    input.paired.judgePrecisionDiff,
    t.qualityNonInferiorityPp,
    failures,
    parts,
  );
  checkZeroFindingRate(
    input.paired.zeroFindingRateDiff,
    t.maxZeroFindingRateIncreasePp,
    failures,
    parts,
  );
  checkNegativeControl(input, t, failures, parts);
  checkCoverage(input.coverage, t.minCoverage, failures, parts);

  return gateResult(
    failures,
    `judgeRecall/Precision ci95 lower >= -${fmtPp(t.qualityNonInferiorityPp)} && ` +
      `zero-finding <= +${fmtPp(t.maxZeroFindingRateIncreasePp)} && ` +
      `negativeControlFp <= baseline + ${fmt(t.maxNegativeControlFpSigma)}σ && ` +
      `coverage >= ${fmt(t.minCoverage)}`,
    parts.join(", "),
  );
}

/** judge Recall / Precision 配对非劣：CI 下界不得低于 −maxDrop */
function checkNonInferiority(
  label: string,
  diff: PairedDiff,
  maxDrop: number,
  failures: string[],
  parts: string[],
): void {
  if (requireDiff(diff, label, failures) === null) {
    return;
  }
  const lower = ciLower(diff.ci95);
  if (lower === null) {
    failures.push(`${label} ci95 is N/A`);
  } else if (lower < -maxDrop) {
    failures.push(`${label} ci95 lower ${fmtPp(lower)} < -${fmtPp(maxDrop)}`);
  } else {
    parts.push(`${label} lower ${fmtPp(lower)}`);
  }
}

/** 零 finding 率相对 baseline 的上升不得超过 maxIncrease */
function checkZeroFindingRate(
  diff: PairedDiff,
  maxIncrease: number,
  failures: string[],
  parts: string[],
): void {
  if (requireDiff(diff, "zero-finding rate", failures) === null || diff.mean === null) {
    return;
  }
  if (diff.mean > maxIncrease) {
    failures.push(`zero-finding rate +${fmtPp(diff.mean)} > ${fmtPp(maxIncrease)}`);
  } else {
    parts.push(`zero-finding ${fmtPp(diff.mean)}`);
  }
}

/** clean MR 阴性对照：候选 FP 不得超过 baseline + maxSigma × σ。
 * 数据集声明了 clean MR 却拿不到配对数据 → 不足数据不放行；数据集本身无
 * clean MR（negativeControlCases = 0）→ 明确记 N/A。 */
function checkNegativeControl(
  input: L2GateInput,
  t: L2GateThresholds,
  failures: string[],
  parts: string[],
): void {
  if (input.negativeControlCases === 0) {
    parts.push("negative control N/A (dataset has no clean MR cases)");
    return;
  }
  const baseline = input.baseline.quality.negativeControlFpPerCase;
  if (baseline === null) {
    failures.push(
      `negative control N/A despite ${input.negativeControlCases} clean MR case(s)`,
    );
    return;
  }
  const diff = input.paired.negativeControlFpDiff;
  if (diff.mean === null) {
    failures.push("negative control paired FP is N/A");
    return;
  }
  const allowance = baseline.std * t.maxNegativeControlFpSigma;
  if (diff.mean > allowance) {
    failures.push(
      `negative control FP +${fmt(diff.mean)} > ` +
        `${fmt(t.maxNegativeControlFpSigma)}σ (${fmt(allowance)})`,
    );
  } else {
    parts.push(
      `negative control FP +${fmt(diff.mean)} <= ${fmt(t.maxNegativeControlFpSigma)}σ`,
    );
  }
}

/** coverage 不得低于 minCoverage；未知 coverage 不放行 */
function checkCoverage(
  coverage: L2GateInput["coverage"],
  minCoverage: number,
  failures: string[],
  parts: string[],
): void {
  if (coverage.ratio === null) {
    failures.push("coverage is N/A");
  } else if (coverage.ratio < minCoverage) {
    failures.push(
      `coverage ${fmt(coverage.ratio)} < ${fmt(minCoverage)} ` +
        `(${coverage.executed}/${coverage.planned}, failed ${coverage.failed})`,
    );
  } else {
    parts.push(`coverage ${fmt(coverage.ratio)}`);
  }
}

function evaluateBoundedness(
  runs: L2GateInput["runs"],
  t: L2GateThresholds,
): L2GateResult {
  const violations: string[] = [];
  for (const run of runs) {
    if (run.loop.attemptedToolCalls > t.maxAttemptedToolCalls) {
      violations.push(
        `${run.caseId}/rep-${run.rep}: attemptedToolCalls ${run.loop.attemptedToolCalls} ` +
          `> ${t.maxAttemptedToolCalls}`,
      );
    }
    if (run.loop.requests > t.maxRequests) {
      violations.push(
        `${run.caseId}/rep-${run.rep}: requests ${run.loop.requests} > ${t.maxRequests}`,
      );
    }
    if (run.cost.outputTokens > t.maxOutputTokens) {
      violations.push(
        `${run.caseId}/rep-${run.rep}: outputTokens ${run.cost.outputTokens} > ` +
          `${t.maxOutputTokens}`,
      );
    }
    if (run.loop.truncated && run.loop.truncationReasons.length === 0) {
      violations.push(`${run.caseId}/rep-${run.rep}: truncated without truncation reasons`);
    }
  }
  return gateResult(
    violations,
    `attemptedToolCalls <= ${t.maxAttemptedToolCalls} && requests <= ${t.maxRequests} && ` +
      `outputTokens <= ${t.maxOutputTokens} && truncated => truncationReasons non-empty`,
    `${runs.length} runs within bounds`,
  );
}

/**
 * 可复现门：单元记录必须带审计引用（pi 内核以 auditPath 为重放真源）且
 * 无 cache break。审计文件的可重放性与 golden bytes 字节稳定性由
 * `--report-only` 往返测试保障（本模块零文件系统，不做落盘读取）。
 */
function evaluateReproducibility(repro: L2GateInput["repro"]): L2GateResult {
  const violations: string[] = [];
  if (repro.length === 0) {
    violations.push("no records to verify");
  }
  for (const sample of repro) {
    if (sample.auditPath.trim() === "") {
      violations.push(`${sample.caseId}/${sample.arm}/rep-${sample.rep}: auditPath is empty`);
    }
    if (sample.cacheBreaks !== 0) {
      violations.push(
        `${sample.caseId}/${sample.arm}/rep-${sample.rep}: ${sample.cacheBreaks} cache break(s)`,
      );
    }
  }
  return gateResult(
    violations,
    "auditPath present && cacheBreaks == 0 (audit replay / golden bytes covered by report-only round-trip test)",
    `${repro.length} records with audit references, 0 cache breaks`,
  );
}

function gateResult(failures: readonly string[], rule: string, passDetail: string): L2GateResult {
  if (failures.length === 0) {
    return { pass: true, rule, detail: passDetail };
  }
  const shown = failures.slice(0, 5).join("; ");
  const more = failures.length > 5 ? ` (+${failures.length - 5} more)` : "";
  return { pass: false, rule, detail: `${shown}${more}` };
}

/** 比率门要求的数值：缺失 → 记失败并返回 null */
function requireRatio(
  ratio: PairedRatio,
  label: string,
  failures: string[],
): number | null {
  if (ratio.pairs === 0 || ratio.mean === null) {
    failures.push(`${label} ratio N/A (pairs=0)`);
    return null;
  }
  return ratio.mean;
}

function requireCi(
  ratio: PairedRatio,
  label: string,
  failures: string[],
): readonly [number, number] | null {
  if (ratio.ci95 === null) {
    failures.push(`${label} ci95 N/A`);
    return null;
  }
  return ratio.ci95;
}

function requireDiff(
  diff: PairedDiff,
  label: string,
  failures: string[],
): PairedDiff | null {
  if (diff.pairs === 0 || diff.mean === null) {
    failures.push(`${label} diff N/A (pairs=0)`);
    return null;
  }
  return diff;
}

function ciLower(ci: readonly [number, number] | null): number | null {
  return ci === null ? null : ci[0];
}

function fmt(value: number): string {
  return value.toFixed(3);
}

/** 百分点格式（0.03 → 3.0pp） */
function fmtPp(value: number): string {
  return `${(value * 100).toFixed(1)}pp`;
}

function fmtCi(ci: readonly [number, number] | null): string {
  return ci === null ? "N/A" : `${fmt(ci[0])}–${fmt(ci[1])}`;
}
