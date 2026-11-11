import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { L2_REPORT_FILE } from "../l2/contracts.js";
import type { CampaignUnit, EvalRunRecord } from "./contracts.js";

/**
 * campaign 文件布局（评测方案 §6.6）：
 *
 * ```text
 * <outputDir>/
 *   plan.json
 *   cases.json                # 原始 cases 字节副本（dataset hash 可复核）
 *   environment.json
 *   failures.json             # 单元级失败留痕（零失败也写空数组）
 *   report.json               # 只读分析器 schema
 *   runs/<source>/<case>/<arm>/rep-<n>.json
 *   judge/<source>/<case>/<arm>/rep-<n>.json
 * ```
 *
 * `dashboard.md` 是后续产物（#46）；audit 随真实内核装配（#40）落盘到
 * `<outputDir>/audit`（pi 内核的 experiments 根 = outputDir），`l2-report.json`
 * 由双 arm 配对报告（#41）写入。
 *
 * JSON 落盘统一 `JSON.stringify(value, null, 2) + "\n"`（golden bytes 纪律）；
 * 路径段做 [A-Za-z0-9_.-] 白名单替换，防 caseId 携带路径分隔。
 */

const SAFE_SEGMENT = /[^A-Za-z0-9_.-]/g;

export function safePathSegment(value: string): string {
  const sanitized = value.replace(SAFE_SEGMENT, "_");
  return sanitized.length === 0 ? "_" : sanitized;
}

export function campaignRecordPath(outDir: string, record: EvalRunRecord): string {
  return path.join(
    outDir,
    "runs",
    safePathSegment(record.source),
    safePathSegment(record.caseId),
    record.arm,
    `rep-${record.rep}.json`,
  );
}

export function campaignJudgePath(outDir: string, unit: CampaignUnit): string {
  return path.join(
    outDir,
    "judge",
    safePathSegment(unit.source),
    safePathSegment(unit.caseId),
    unit.arm,
    `rep-${unit.rep}.json`,
  );
}

export function campaignPlanPath(outDir: string): string {
  return path.join(outDir, "plan.json");
}

export function campaignCasesPath(outDir: string): string {
  return path.join(outDir, "cases.json");
}

export function campaignEnvironmentPath(outDir: string): string {
  return path.join(outDir, "environment.json");
}

export function campaignFailuresPath(outDir: string): string {
  return path.join(outDir, "failures.json");
}

export function campaignReportPath(outDir: string): string {
  return path.join(outDir, "report.json");
}

/** L2 配对回归报告（#41；附录 B.1 形状，独立于 campaign 分节报告） */
export function campaignL2ReportPath(outDir: string): string {
  return path.join(outDir, L2_REPORT_FILE);
}

/**
 * 清空上一次运行的单元产物（同目录重跑的单源清理）：
 * `runs/` / `judge/` / `audit/` / `report.json` / `failures.json` 全删；
 * plan / cases / environment 由本次运行覆写。防陈旧记录混入新报告，或被
 * `--report-only` 当成有效证据重建（#39 审查发现：kernel 本次失败的单元会
 * 残留上次成功记录）；audit 是内核真跑的重放字节，也必须与记录同代（#40）。
 */
export async function resetCampaignOutput(outDir: string): Promise<void> {
  await Promise.all([
    rm(path.join(outDir, "runs"), { recursive: true, force: true }),
    rm(path.join(outDir, "judge"), { recursive: true, force: true }),
    rm(path.join(outDir, "audit"), { recursive: true, force: true }),
    rm(campaignReportPath(outDir), { force: true }),
    rm(campaignL2ReportPath(outDir), { force: true }),
    rm(campaignFailuresPath(outDir), { force: true }),
    // environment 在运行结束时才写；先删旧值，防本次中途失败后残留上次 provenance
    rm(campaignEnvironmentPath(outDir), { force: true }),
  ]);
}

/** 稳定 JSON 落盘（目录自动创建；尾部换行） */
export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** 原始文本落盘（cases 副本保留字节，dataset hash 可复核） */
export async function writeTextFile(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}

export async function readTextFile(file: string): Promise<string> {
  return readFile(file, "utf8");
}

export async function readJsonFile<T = unknown>(file: string): Promise<T> {
  const text = await readFile(file, "utf8");
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `campaign: ${file} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
