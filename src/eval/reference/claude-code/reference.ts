import type { MatchCounts } from "../../analysis/contracts.js";
import type { MRCase } from "../../../instrument/contracts/mr-case.js";
import { judgeFindings, type JudgeChainResult } from "../../judge/chain.js";
import type { JudgeClient, MatchConfidenceThreshold } from "../../judge/contracts.js";
import type { ClaudeCodeReferenceRecord } from "./contracts.js";

/**
 * Claude Code 外部参照的 judge / 单列报告（#44）。
 *
 * 定位（ADR-0017 §4）：跨模型外部参照只单列；不进 S/A/B 主判定；token 语义
 * 跨模型不作等价，成本以 USD 记录。judge 复用与 E 相同的 judge 链（同一
 * judge 模型 / 阈值），确保质量口径一致。
 */

export interface JudgeClaudeCodeInput {
  readonly record: ClaudeCodeReferenceRecord;
  readonly mrCase: MRCase;
  readonly client: JudgeClient;
  readonly matchConfidenceThreshold?: MatchConfidenceThreshold;
}

export async function judgeClaudeCodeFindings(
  input: JudgeClaudeCodeInput,
): Promise<JudgeChainResult> {
  if (input.record.caseId !== input.mrCase.caseId) {
    throw new Error(
      `claude-code judge: record caseId ${JSON.stringify(input.record.caseId)} ` +
        `does not match mrCase caseId ${JSON.stringify(input.mrCase.caseId)}`,
    );
  }
  return judgeFindings({
    caseId: input.mrCase.caseId,
    findings: input.record.findings,
    truth: input.mrCase.truth,
    issueDescription: input.mrCase.issueDescription,
    diff: input.mrCase.diff,
    client: input.client,
    ...(input.matchConfidenceThreshold !== undefined
      ? { matchConfidenceThreshold: input.matchConfidenceThreshold }
      : {}),
  });
}

export interface ClaudeCodeColumnJudge {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly recall: number | null;
  readonly precision: number | null;
  readonly f1: number | null;
}

export interface ClaudeCodeColumn {
  readonly kind: "claude-code-column";
  readonly schemaVersion: 1;
  readonly cases: number;
  readonly findings: number;
  readonly zeroFindingRate: number | null;
  readonly totalCostUsd: number | null;
  readonly avgTurns: number | null;
  readonly permissionDenials: number | null;
  readonly actualModels: readonly string[];
  readonly judge: ClaudeCodeColumnJudge | null;
  readonly anomalies: readonly string[];
}

export interface BuildClaudeCodeColumnOptions {
  /** 与 records 按 case 对齐的 judge 行级计数（可由 judgeClaudeCodeFindings 产出） */
  readonly judgeCounts?: readonly MatchCounts[];
}

/** 单列聚合（纯函数；缺字段记 null，不写 0） */
export function buildClaudeCodeColumn(
  records: readonly ClaudeCodeReferenceRecord[],
  options: BuildClaudeCodeColumnOptions = {},
): ClaudeCodeColumn {
  const cases = records.length;
  const findings = records.reduce((sum, record) => sum + record.findings.length, 0);
  const zeroFindings = records.filter((record) => record.findings.length === 0).length;
  return {
    kind: "claude-code-column",
    schemaVersion: 1,
    cases,
    findings,
    zeroFindingRate: cases === 0 ? null : zeroFindings / cases,
    totalCostUsd: sumOrNull(records.map((record) => record.totalCostUsd)),
    avgTurns: meanOrNull(records.map((record) => record.numTurns)),
    permissionDenials: sumOrNull(records.map((record) => record.permissionDenials)),
    actualModels: [
      ...new Set(
        records.flatMap((record) => record.actualModels ?? []),
      ),
    ].sort(),
    judge: options.judgeCounts === undefined ? null : judgeColumn(options.judgeCounts),
    anomalies: records.flatMap((record) => record.anomalies),
  };
}

function judgeColumn(counts: readonly MatchCounts[]): ClaudeCodeColumnJudge {
  const tp = counts.reduce((sum, count) => sum + count.tp, 0);
  const fp = counts.reduce((sum, count) => sum + count.fp, 0);
  const fn = counts.reduce((sum, count) => sum + count.fn, 0);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const f1 =
    recall === null || precision === null || recall + precision === 0
      ? null
      : (2 * recall * precision) / (recall + precision);
  return { tp, fp, fn, recall, precision, f1 };
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  return values.length === 0 || values.some((value) => value === null)
    ? null
    : (values as readonly number[]).reduce((sum, value) => sum + value, 0);
}

function meanOrNull(values: readonly (number | null)[]): number | null {
  return values.length === 0 || values.some((value) => value === null)
    ? null
    : (values as readonly number[]).reduce((sum, value) => sum + value, 0) / values.length;
}

/** 单列 Markdown（确定性；明确不进 S/A/B、token 语义不作等价） */
export function renderClaudeCodeColumnMarkdown(column: ClaudeCodeColumn): string {
  const fmt = (value: number | null, digits = 3): string =>
    value === null ? "N/A" : value.toFixed(digits);
  const lines = [
    "# Claude Code 外部参照（单列）",
    "",
    "> 单列报告，不进 S/A/B 主判定；跨模型 token 语义不作等价，成本以 USD 记录。",
    "",
    "| 指标 | 值 |",
    "|---|---:|",
    `| cases | ${column.cases} |`,
    `| findings | ${column.findings} |`,
    `| zero-finding rate | ${fmt(column.zeroFindingRate)} |`,
    `| total cost (USD) | ${fmt(column.totalCostUsd, 6)} |`,
    `| avg turns | ${fmt(column.avgTurns)} |`,
    `| permission denials | ${column.permissionDenials ?? "N/A"} |`,
    `| actual models | ${column.actualModels.length === 0 ? "N/A" : column.actualModels.join(", ")} |`,
    "",
    "## Judge（同一 judge 链）",
    "",
    "| Recall | Precision | F1 | TP | FP | FN |",
    "|---:|---:|---:|---:|---:|---:|",
    column.judge === null
      ? "| N/A | N/A | N/A | N/A | N/A | N/A |"
      : `| ${fmt(column.judge.recall)} | ${fmt(column.judge.precision)} | ${fmt(column.judge.f1)} | ` +
        `${column.judge.tp} | ${column.judge.fp} | ${column.judge.fn} |`,
    "",
    `Anomalies: ${column.anomalies.length === 0 ? "none" : `${column.anomalies.length} (see record)`}`,
    "",
  ];
  return lines.join("\n");
}
