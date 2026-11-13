import type { EnvironmentManifest } from "../campaign/contracts.js";
import {
  DEFAULT_L3_GATE_THRESHOLDS,
  L3_REPORT_KIND,
  L3_REPORT_SCHEMA_VERSION,
  type L3Column,
  type L3Coverage,
  type L3EnvironmentStatus,
  type L3GateResult,
  type L3GateThresholds,
  type L3Gates,
  type L3Report,
  type L3ReportInput,
  type L3SignOff,
} from "./contracts.js";

/**
 * L3 三列报告 / 宣称门（#45）：纯函数，零网络、零文件系统、无时钟。
 *
 * 纪律：
 * - E / C_ref / Claude Code 三列单列，不进 S/A/B；
 * - C_ref `totalTokens` 只作参考分母，不进任何门；
 * - 跨模型 token 语义不作等价；成本门优先 USD，同模型且 USD N/A 时才用
 *   totalTokens 代理并显式标注；
 * - `claimsAllowed` 需要：三列报告 + 完整 environment + 产品签字 + 全门通过；
 *   缺任一项一律 false，不输出对外宣称模板。
 */

export function buildL3Report(input: L3ReportInput): L3Report {
  const thresholds: L3GateThresholds = { ...DEFAULT_L3_GATE_THRESHOLDS };
  const environment = checkEnvironment(input.environment);
  const gates: L3Gates = {
    comparability: evaluateComparability(input, thresholds),
    quality: evaluateQuality(input, thresholds),
    cost: evaluateCost(input, thresholds),
    cache: evaluateCache(input, thresholds),
    coverage: evaluateCoverage(input, thresholds),
    environment: environmentGate(environment),
    signOff: evaluateSignOff(input.signOff, input.generatedAt),
  };
  const claimsAllowed = Object.values(gates).every((gate) => gate.pass);
  return {
    kind: L3_REPORT_KIND,
    schemaVersion: L3_REPORT_SCHEMA_VERSION,
    campaignId: input.campaignId,
    generatedAt: input.generatedAt,
    columns: input.columns,
    environment,
    manifest: input.environment,
    referenceDenominator: referenceDenominatorOf(input.columns),
    gates,
    claimsAllowed,
    allowedClaim: claimsAllowed ? buildAllowedClaim(input) : null,
    limitations: limitationsOf(input),
    thresholds,
  };
}

function gateResult(
  pass: boolean,
  rule: string,
  detail: string,
): L3GateResult {
  return { pass, rule, detail };
}

function evaluateComparability(
  input: L3ReportInput,
  t: L3GateThresholds,
): L3GateResult {
  const columns = [input.columns.e, input.columns.cRef, input.columns.claudeCode];
  const failures: string[] = [];
  const cases = columns.map((column) => column.cases);
  if (new Set(cases).size !== 1) {
    failures.push(`cases differ (${cases.join(" / ")})`);
  }
  if (cases.some((value) => value < t.minCases)) {
    failures.push(`cases below minCases ${t.minCases} (${cases.join(" / ")})`);
  }
  const reps = columns.map((column) =>
    column.cases > 0 ? column.runs / column.cases : null,
  );
  if (new Set(reps).size !== 1 || reps.some((rep) => rep === null)) {
    failures.push(`reps/run ratio differ (${reps.map((rep) => fmt(rep)).join(" / ")})`);
  }
  if (reps.some((rep) => rep === null || rep < t.minReps)) {
    failures.push(`reps below minReps ${t.minReps} (${reps.map((rep) => fmt(rep)).join(" / ")})`);
  }
  const budgets = [input.columns.e.budget, input.columns.claudeCode.budget];
  if (budgets[0] !== budgets[1]) {
    failures.push(`harness budget differs (${budgets.join(" vs ")})`);
  }
  const models = columns.map((column) => column.model);
  if (new Set(models).size !== 1 || models.some((model) => model === null)) {
    failures.push(`harness models differ (${models.map((model) => model ?? "N/A").join(" / ")})`);
  }
  return gateResult(
    failures.length === 0,
    `same cases >= ${t.minCases} / reps >= ${t.minReps} / models / E-vs-Claude harness budget`,
    failures.length === 0
      ? `cases ${cases[0]}, reps ${fmt(reps[0] ?? null)}, budget ${budgets[0]}, ` +
          `model ${models[0]}`
      : failures.join("; "),
  );
}

function evaluateQuality(
  input: L3ReportInput,
  t: L3GateThresholds,
): L3GateResult {
  const e = input.columns.e.quality;
  const c = input.columns.claudeCode.quality;
  if (e.recall === null || c.recall === null) {
    return gateResult(false, "E recall/precision vs Claude Code", "quality N/A");
  }
  const recallRatio = c.recall === 0 ? null : e.recall / c.recall;
  const precisionRatio =
    e.precision === null || c.precision === null || c.precision === 0
      ? null
      : e.precision / c.precision;
  const recallPass = recallRatio !== null && recallRatio >= t.recallVsClaude;
  const precisionPass =
    precisionRatio !== null && precisionRatio >= t.precisionVsClaude;
  return gateResult(
    recallPass && precisionPass,
    `E recall >= Claude x${t.recallVsClaude} && precision >= Claude x${t.precisionVsClaude}`,
    `recall ratio ${fmt(recallRatio)} (${fmt(e.recall)} vs ${fmt(c.recall)}), ` +
      `precision ratio ${fmt(precisionRatio)} (${fmt(e.precision)} vs ${fmt(c.precision)})`,
  );
}

function evaluateCost(
  input: L3ReportInput,
  t: L3GateThresholds,
): L3GateResult {
  const e = input.columns.e.cost.billedCostUsd;
  const c = input.columns.claudeCode.cost.billedCostUsd;
  if (e === null || c === null) {
    return gateResult(
      false,
      `E billed USD <= Claude x${t.costVsClaude}`,
      `USD N/A（E ${e === null ? "N/A" : fmtUsd(e)} / Claude ` +
        `${c === null ? "N/A" : fmtUsd(c)}）；不能以 totalTokens 代替成本结论`,
    );
  }
  if (c <= 0) {
    return gateResult(false, `E billed USD <= Claude x${t.costVsClaude}`, "Claude USD 0");
  }
  const ratio = e / c;
  return gateResult(
    ratio <= t.costVsClaude,
    `E billed USD <= Claude x${t.costVsClaude}`,
    `USD ratio ${fmt(ratio)} (${fmtUsd(e)} vs ${fmtUsd(c)}); ` +
      "两侧均须按同一 USD / 统一价目口径",
  );
}

function evaluateCache(
  input: L3ReportInput,
  t: L3GateThresholds,
): L3GateResult {
  const rate = input.columns.e.cost.cacheHitRateMean;
  return gateResult(
    rate !== null && rate >= t.minCacheHitRate,
    `E cacheHitRate >= ${t.minCacheHitRate}`,
    rate === null ? "E cacheHitRate N/A" : `E cacheHitRate ${fmt(rate)}`,
  );
}

function evaluateCoverage(
  input: L3ReportInput,
  t: L3GateThresholds,
): L3GateResult {
  const columns = [
    input.columns.e,
    input.columns.cRef,
    input.columns.claudeCode,
  ];
  const failures = columns
    .filter(
      (column) => column.coverage.ratio === null || column.coverage.ratio < t.minCoverage,
    )
    .map(
      (column) =>
        `${column.label} ${fmt(column.coverage.ratio)} ` +
        `(${column.coverage.judged}/${column.coverage.planned}, failed ${column.coverage.failed})`,
    );
  return gateResult(
    failures.length === 0,
    `all columns coverage >= ${t.minCoverage}`,
    failures.length === 0
      ? columns.map((column) => `${column.label} ${fmt(column.coverage.ratio)}`).join(", ")
      : failures.join("; "),
  );
}

function environmentGate(status: L3EnvironmentStatus): L3GateResult {
  return gateResult(
    status.complete,
    "environment.json complete",
    status.complete ? "all required fields present" : `missing ${status.missing.join(", ")}`,
  );
}

function evaluateSignOff(
  signOff: L3SignOff | null,
  generatedAt: string,
): L3GateResult {
  if (signOff === null) {
    return gateResult(false, "product sign-off present", "no sign-off");
  }
  if (signOff.scope !== "external-claim") {
    return gateResult(false, "product sign-off present", `scope ${signOff.scope}`);
  }
  if (signOff.signedBy.trim() === "" || signOff.signedAt.trim() === "") {
    return gateResult(false, "product sign-off present", "signedBy/signedAt empty");
  }
  if (
    signOff.expiresAt !== undefined &&
    signOff.expiresAt !== null &&
    signOff.expiresAt < generatedAt
  ) {
    return gateResult(false, "product sign-off present", `expired at ${signOff.expiresAt}`);
  }
  return gateResult(
    true,
    "product sign-off present",
    `signed by ${signOff.signedBy} at ${signOff.signedAt}`,
  );
}

/** environment 完整性：L3 宣称所需字段必须非 null / 非空 */
export function checkEnvironment(manifest: EnvironmentManifest): L3EnvironmentStatus {
  const missing: string[] = [];
  requireString(manifest.campaignId, "campaignId", missing);
  requireString(manifest.evaluation.branch, "evaluation.branch", missing);
  requireString(manifest.evaluation.campaign, "evaluation.campaign", missing);
  requireString(manifest.git.branch, "git.branch", missing);
  requireString(manifest.git.commit, "git.commit", missing);
  requireString(manifest.runtime.node, "runtime.node", missing);
  requireString(manifest.runtime.os, "runtime.os", missing);
  requireString(manifest.model.requestedId, "model.requestedId", missing);
  requireString(manifest.model.providerClass, "model.providerClass", missing);
  requireString(manifest.model.baseUrlClass, "model.baseUrlClass", missing);
  requireString(manifest.judge.model, "judge.model", missing);
  requireString(manifest.judge.promptVersion, "judge.promptVersion", missing);
  requireNonNull(manifest.judge.temperature, "judge.temperature", missing);
  requireNonNull(manifest.judge.topP, "judge.topP", missing);
  requireString(manifest.prompts.zoneA, "prompts.zoneA", missing);
  requireString(manifest.prompts.toolsSchema, "prompts.toolsSchema", missing);
  requireString(manifest.window.start, "window.start", missing);
  requireString(manifest.window.end, "window.end", missing);
  requireString(manifest.window.timezone, "window.timezone", missing);
  requireString(manifest.dataset.casesFile, "dataset.casesFile", missing);
  if (manifest.dataset.caseCount <= 0) {
    missing.push("dataset.caseCount");
  }
  requireString(manifest.dataset.hash, "dataset.hash", missing);
  requireString(manifest.claudeCode.cliVersion, "claudeCode.cliVersion", missing);
  if (
    manifest.claudeCode.actualModels === null ||
    manifest.claudeCode.actualModels.length === 0
  ) {
    missing.push("claudeCode.actualModels");
  } else if (!manifest.claudeCode.actualModels.includes(manifest.model.requestedId)) {
    missing.push("claudeCode.actualModels(model.requestedId)");
  }
  if (
    manifest.claudeCode.requestedModel !== null &&
    manifest.claudeCode.requestedModel !== manifest.model.requestedId
  ) {
    missing.push("claudeCode.requestedModel(model.requestedId)");
  }
  return { complete: missing.length === 0, missing };
}

function referenceDenominatorOf(
  columns: L3ReportInput["columns"],
): L3Report["referenceDenominator"] {
  const e = columns.e.cost.totalTokensMean;
  const c = columns.cRef.cost.totalTokensMean;
  return {
    eOverCRefTotalTokens: e !== null && c !== null && c > 0 ? e / c : null,
    note: "C_ref totalTokens 仅作 L3 参考分母；不进入任何门，不单独构成结论。",
  };
}

function limitationsOf(input: L3ReportInput): readonly string[] {
  const columns = [input.columns.e, input.columns.cRef, input.columns.claudeCode];
  const models = columns.map((column) => column.model);
  const sameModel =
    models[0] !== null && models.every((model) => model === models[0]);
  const caseCounts = new Set(columns.map((column) => column.cases));
  const limitations = [
    "三列只作 L3 定位 / 宣称，不进入 S/A/B 主判定。",
    "C_ref totalTokens 仅参考分母，不进入任何门。",
    sameModel
      ? "E 与 Claude Code 使用同一模型，token 口径可对照；不得外推跨模型结论。"
      : "跨模型 token 语义不作等价；成本以 USD / 统一价目为准。",
    "原始 runs / audit / wireBody 外置；摘要报告才入库。",
  ];
  if (caseCounts.size !== 1) {
    limitations.push(
      `三列样本量不一致（E ${input.columns.e.cases} / C_ref ${input.columns.cRef.cases} / ` +
        `Claude Code ${input.columns.claudeCode.cases}），不作严格配对结论。`,
    );
  }
  if (columns.some((column) => column.failures.length > 0)) {
    limitations.push("存在列级 failures，逐项见 coverage / failures；不静默丢弃。");
  }
  return limitations;
}

function buildAllowedClaim(input: L3ReportInput): string {
  const e = input.columns.e;
  const c = input.columns.claudeCode;
  const recallRatio =
    e.quality.recall !== null && c.quality.recall !== null && c.quality.recall > 0
      ? pct(e.quality.recall / c.quality.recall)
      : "N/A";
  const precisionRatio =
    e.quality.precision !== null &&
    c.quality.precision !== null &&
    c.quality.precision > 0
      ? pct(e.quality.precision / c.quality.precision)
      : "N/A";
  const cost =
    e.cost.billedCostUsd !== null &&
    c.cost.billedCostUsd !== null &&
    c.cost.billedCostUsd > 0
      ? `${fmtUsd(e.cost.billedCostUsd)}（Claude Code 的 ${pct(
          e.cost.billedCostUsd / c.cost.billedCostUsd,
        )}）`
      : "N/A（USD 缺失，不以 totalTokens 代替成本结论）";
  return (
    `在 ${e.cases} 案、同一 judge（${input.environment.judge.model ?? "N/A"}）下：` +
    `E judge Recall = ${fmt(e.quality.recall)}（Claude Code 的 ${recallRatio}），` +
    `Precision = ${fmt(e.quality.precision)}（Claude Code 的 ${precisionRatio}）；` +
    `计费成本 = ${cost}。C_ref totalTokens 仅参考分母；跨模型 token 不作等价。`
  );
}

/** 确定性 Markdown（无时钟；由 generatedAt 输入决定） */
export function renderL3ReportMarkdown(report: L3Report): string {
  const lines: string[] = [];
  lines.push(`# L3 三列定位报告 ${report.campaignId}`, "");
  lines.push(
    `> generatedAt: ${report.generatedAt} · kind: \`${report.kind}\` · ` +
      `claimsAllowed = ${report.claimsAllowed}`,
  );
  if (!report.claimsAllowed) {
    lines.push(
      "> claimsAllowed = false：本报告只作单列事实与门判定审计明细，" +
        "不构成对外相对结论。",
    );
  }
  lines.push("", "## 1. 环境完整性", "");
  lines.push(`- complete: **${report.environment.complete}**`);
  if (!report.environment.complete) {
    lines.push(`- missing: ${report.environment.missing.join(", ")}`);
  }
  lines.push(
    `- model: \`${report.manifest.model.requestedId}\`（${report.manifest.model.providerClass ?? "N/A"}）`,
  );
  lines.push(
    `- judge: \`${report.manifest.judge.model ?? "N/A"}\` · prompt ` +
      `\`${report.manifest.judge.promptVersion ?? "N/A"}\``,
  );
  lines.push(
    `- window: ${report.manifest.window.start ?? "N/A"} → ${report.manifest.window.end ?? "N/A"} ` +
      `(${report.manifest.window.timezone ?? "N/A"})`,
  );
  lines.push(
    `- dataset: \`${report.manifest.dataset.casesFile}\` · ${report.manifest.dataset.caseCount} 案 · ` +
      `sha256 \`${report.manifest.dataset.hash}\``,
  );
  lines.push(
    `- Claude Code CLI: \`${report.manifest.claudeCode.cliVersion ?? "N/A"}\` · ` +
      `actual ${report.manifest.claudeCode.actualModels?.join(", ") ?? "N/A"} · ` +
      `maxTurns ${report.manifest.claudeCode.maxTurns ?? "ceiling"}`,
  );
  lines.push("");

  lines.push("## 2. 三列对比", "");
  lines.push("| 指标 | E | C_ref | Claude Code |");
  lines.push("|---|---:|---:|---:|");
  const cols = [report.columns.e, report.columns.cRef, report.columns.claudeCode];
  row(lines, "model", cols, (c) => c.model ?? "N/A");
  row(lines, "cases", cols, (c) => String(c.cases));
  row(lines, "runs", cols, (c) => String(c.runs));
  row(lines, "coverage", cols, (c) => fmt(c.coverage.ratio));
  row(lines, "harness budget", cols, (c) => c.budget);
  row(lines, "judge Recall", cols, (c) => fmt(c.quality.recall));
  row(lines, "judge Precision", cols, (c) => fmt(c.quality.precision));
  row(lines, "judge F1", cols, (c) => fmt(c.quality.f1));
  row(lines, "CARC mean", cols, (c) => fmtInt(c.cost.carcMean));
  row(lines, "totalTokens mean", cols, (c) => fmtInt(c.cost.totalTokensMean));
  row(lines, "cacheHitRate", cols, (c) => fmt(c.cost.cacheHitRateMean));
  row(lines, "billed USD", cols, (c) => fmtUsdNullable(c.cost.billedCostUsd));
  row(lines, "turns mean", cols, (c) => fmt(c.harness?.turnsMean ?? null));
  row(lines, "duration mean (s)", cols, (c) =>
    c.harness?.durationMsMean === null || c.harness?.durationMsMean === undefined
      ? "N/A"
      : (c.harness.durationMsMean / 1000).toFixed(1),
  );
  row(lines, "permission denials", cols, (c) =>
    c.harness?.permissionDenials === null || c.harness?.permissionDenials === undefined
      ? "N/A"
      : String(c.harness.permissionDenials),
  );
  row(lines, "failures", cols, (c) => String(c.failures.length));
  lines.push("");

  lines.push("### coverage / failures 明细", "");
  for (const column of cols) {
    lines.push(
      `- **${column.label}** coverage: planned ${column.coverage.planned} / ` +
        `executed ${column.coverage.executed} / judged ${column.coverage.judged} / ` +
        `failed ${column.coverage.failed} = ${fmt(column.coverage.ratio)}`,
    );
    for (const failure of column.failures) {
      lines.push(`  - failure: ${failure}`);
    }
    if (column.failures.length === 0) {
      lines.push("  - failures: none");
    }
  }
  lines.push("");

  lines.push("## 3. C_ref 参考分母", "");
  lines.push(
    `- E / C_ref totalTokens = **${fmt(
      report.referenceDenominator.eOverCRefTotalTokens,
    )}**`,
  );
  lines.push(`- ${report.referenceDenominator.note}`, "");

  lines.push("## 4. 门判定", "");
  lines.push("| 门 | pass | rule | detail |");
  lines.push("|---|---|---|---|");
  for (const [name, gate] of Object.entries(report.gates)) {
    lines.push(`| ${name} | ${gate.pass} | ${gate.rule} | ${gate.detail} |`);
  }
  lines.push("");

  lines.push("## 5. 宣称", "");
  lines.push(`- claimsAllowed = **${report.claimsAllowed}**`);
  if (report.allowedClaim !== null) {
    lines.push(`- allowed claim: ${report.allowedClaim}`);
  } else {
    lines.push("- allowed claim: N/A（未满足报告 + environment + 产品签字 + 全门）");
  }
  lines.push("", "### 限制");
  for (const limitation of report.limitations) {
    lines.push(`- ${limitation}`);
  }
  lines.push("", "## 6. 归档", "");
  lines.push("- 摘要报告入库；原始 runs / audit / wireBody 外置（gitignored）。");
  lines.push("- 三列不进 S/A/B；C_ref totalTokens 仅参考分母。");
  lines.push("");
  return lines.join("\n");
}

function row(
  lines: string[],
  label: string,
  columns: readonly L3Column[],
  value: (column: L3Column) => string,
): void {
  lines.push(`| ${label} | ${columns.map(value).join(" | ")} |`);
}

function requireString(
  value: string | null,
  field: string,
  missing: string[],
): void {
  if (value === null || value.trim() === "") {
    missing.push(field);
  }
}

function requireNonNull(
  value: number | null,
  field: string,
  missing: string[],
): void {
  if (value === null) {
    missing.push(field);
  }
}

function fmt(value: number | null): string {
  return value === null ? "N/A" : value.toFixed(3);
}

function fmtInt(value: number | null): string {
  if (value === null) {
    return "N/A";
  }
  const rounded = String(Math.round(value));
  return rounded.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function fmtUsd(value: number): string {
  return `$${value.toFixed(3)}`;
}

function fmtUsdNullable(value: number | null): string {
  return value === null ? "N/A" : fmtUsd(value);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

// coverage 类型仅为契约文档保留导入（Markdown 直接读字段）
export type { L3Coverage };
