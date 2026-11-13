import type { Finding } from "../../../instrument/contracts/finding.js";
import {
  ClaudeCodeOutputError,
  type ClaudeCodeOutcome,
  type ClaudeCodeUsage,
} from "./contracts.js";

/**
 * Claude Code 输出归一（#44）：CLI `--output-format json` 的 stdout → 统一
 * Finding Schema + usage / cost / turns / denials；非法 / 截断 / 重复条目
 * 有界留痕（anomalies），不静默吞掉。
 */

const VALID_SEVERITIES: ReadonlySet<string> = new Set(["P0", "P1", "P2", "P3"]);

export interface NormalizedClaudeCodeFindings {
  readonly findings: readonly Finding[];
  readonly anomalies: readonly string[];
}

/** CLI 最终文本 → Finding[]（要求 JSON 数组；允许 markdown 围栏包裹） */
export function normalizeClaudeCodeFindings(text: string): NormalizedClaudeCodeFindings {
  const json = extractJsonArray(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw new ClaudeCodeOutputError(
      `Claude Code findings are not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ClaudeCodeOutputError("Claude Code findings must be a JSON array");
  }

  const findings: Finding[] = [];
  const anomalies: string[] = [];
  const seenIds = new Set<string>();
  for (const [index, entry] of parsed.entries()) {
    const normalized = normalizeEntry(entry, index, anomalies);
    if (normalized === null) {
      continue;
    }
    if (seenIds.has(normalized.id)) {
      anomalies.push(`entry ${index + 1}: duplicate finding id ${JSON.stringify(normalized.id)} dropped`);
      continue;
    }
    seenIds.add(normalized.id);
    findings.push(normalized);
  }
  return { findings, anomalies };
}

function normalizeEntry(
  entry: unknown,
  index: number,
  anomalies: string[],
): Finding | null {
  const where = `entry ${index + 1}`;
  if (!isRecord(entry)) {
    anomalies.push(`${where}: not an object, dropped`);
    return null;
  }
  const file = requireString(entry.file);
  if (file === null) {
    anomalies.push(`${where}: missing/invalid file, dropped`);
    return null;
  }
  const line = entry.line;
  if (typeof line !== "number" || !Number.isInteger(line) || line <= 0) {
    anomalies.push(`${where}: missing/invalid line, dropped`);
    return null;
  }
  const title = requireString(entry.title);
  if (title === null) {
    anomalies.push(`${where}: missing/invalid title, dropped`);
    return null;
  }

  const rawId = requireString(entry.id);
  const id = rawId ?? `CC-${index + 1}`;
  if (rawId === null) {
    anomalies.push(`${where}: missing id, assigned ${id}`);
  }
  const severity =
    typeof entry.severity === "string" && VALID_SEVERITIES.has(entry.severity)
      ? (entry.severity as Finding["severity"])
      : "P2";
  if (severity === "P2" && entry.severity !== "P2") {
    anomalies.push(`${where}: missing/invalid severity, defaulted P2`);
  }
  const evidence = Array.isArray(entry.evidence)
    ? entry.evidence.filter((item): item is string => typeof item === "string")
    : [];
  if (entry.evidence !== undefined && !Array.isArray(entry.evidence)) {
    anomalies.push(`${where}: evidence is not an array, defaulted []`);
  }
  const confidence =
    typeof entry.confidence === "number" &&
    Number.isFinite(entry.confidence) &&
    entry.confidence >= 0 &&
    entry.confidence <= 1
      ? entry.confidence
      : 0.5;
  if (!(confidence === entry.confidence)) {
    anomalies.push(`${where}: missing/out-of-range confidence, defaulted 0.5`);
  }

  return {
    id,
    severity,
    category: requireString(entry.category) ?? "UNKNOWN",
    file,
    line,
    title,
    description: typeof entry.description === "string" ? entry.description : "",
    evidence,
    rule: requireString(entry.rule) ?? "CLAUDE-CODE",
    confidence,
  };
}

/**
 * CLI stdout（`--output-format json`）→ outcome（不含由调用方注入的 CLI 版本 /
 * 请求模型）。
 *
 * `is_error`（含 max-turns 截断）不抛错：保留 usage / cost / turns / denials
 * 与截断/错误留痕，findings 记空集——否则验收要求的截断元数据会被丢弃。
 * 非 JSON / 缺 result（正常成功路径）仍上抛，不伪装成零 finding。
 */
export function parseClaudeCodeStdout(
  stdout: string,
): Omit<ClaudeCodeOutcome, "cliVersion" | "requestedModel" | "maxTurns"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new ClaudeCodeOutputError(
      `Claude Code CLI output is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ClaudeCodeOutputError("Claude Code CLI output must be a JSON object");
  }
  const subtype = typeof parsed.subtype === "string" ? parsed.subtype : null;
  const errorText = typeof parsed.result === "string" ? parsed.result : null;
  const isError = parsed.is_error === true;
  const truncated = subtype === "error_max_turns";
  if (isError) {
    return {
      findings: [],
      anomalies: [
        `CLI reported error (subtype ${JSON.stringify(subtype)})` +
          (truncated ? "; run truncated at max turns" : ""),
      ],
      actualModels: modelIds(parsed.modelUsage),
      numTurns: numberOrNull(parsed.num_turns),
      totalCostUsd: numberOrNull(parsed.total_cost_usd),
      usage: usageOf(parsed.usage),
      modelUsage: modelUsageOf(parsed.modelUsage),
      permissionDenials: permissionDenialCount(parsed.permission_denials),
      durationMs: numberOrNull(parsed.duration_ms),
      error: errorText ?? subtype,
      truncated,
      resultText: errorText ?? "",
    };
  }
  if (errorText === null) {
    throw new ClaudeCodeOutputError("Claude Code CLI output is missing the result text");
  }
  const normalized = normalizeClaudeCodeFindings(errorText);
  const anomalies = [...normalized.anomalies];
  if (subtype !== null && subtype !== "success") {
    anomalies.push(`CLI subtype ${JSON.stringify(subtype)} (not success)`);
  }
  return {
    findings: normalized.findings,
    anomalies,
    actualModels: modelIds(parsed.modelUsage),
    numTurns: numberOrNull(parsed.num_turns),
    totalCostUsd: numberOrNull(parsed.total_cost_usd),
    usage: usageOf(parsed.usage),
    modelUsage: modelUsageOf(parsed.modelUsage),
    permissionDenials: permissionDenialCount(parsed.permission_denials),
    durationMs: numberOrNull(parsed.duration_ms),
    error: null,
    truncated,
    resultText: errorText,
  };
}

function extractJsonArray(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start < 0 || end <= start) {
    throw new ClaudeCodeOutputError(
      "Claude Code result does not contain a JSON findings array",
    );
  }
  return candidate.slice(start, end + 1);
}

function usageOf(value: unknown): ClaudeCodeUsage | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    inputTokens: numberOrNull(value.input_tokens),
    cacheCreationInputTokens: numberOrNull(value.cache_creation_input_tokens),
    cacheReadInputTokens: numberOrNull(value.cache_read_input_tokens),
    outputTokens: numberOrNull(value.output_tokens),
  };
}

function modelUsageOf(
  value: unknown,
): Readonly<Record<string, ClaudeCodeUsage>> | null {
  if (!isRecord(value)) {
    return null;
  }
  const usage: Record<string, ClaudeCodeUsage> = {};
  for (const [model, entry] of Object.entries(value)) {
    if (!isRecord(entry)) {
      continue;
    }
    usage[model] = {
      inputTokens: numberOrNull(entry.inputTokens),
      cacheCreationInputTokens: numberOrNull(entry.cacheCreationInputTokens),
      cacheReadInputTokens: numberOrNull(entry.cacheReadInputTokens),
      outputTokens: numberOrNull(entry.outputTokens),
    };
  }
  return Object.keys(usage).length === 0 ? null : usage;
}

function modelIds(value: unknown): readonly string[] | null {
  if (!isRecord(value)) {
    return null;
  }
  const ids = Object.keys(value);
  return ids.length === 0 ? null : ids;
}

function permissionDenialCount(value: unknown): number | null {
  if (Array.isArray(value)) {
    return value.length;
  }
  return numberOrNull(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requireString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
