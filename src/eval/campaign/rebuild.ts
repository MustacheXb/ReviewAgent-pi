import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { MatchCounts } from "../analysis/contracts.js";
import {
  CAMPAIGN_ARMS,
  ENVIRONMENT_REF,
  type CampaignCase,
  type CampaignPlan,
  type CampaignReport,
  type EvalRunRecord,
  type JudgeRecord,
} from "./contracts.js";
import { hashCasesText } from "./environment.js";
import { parseCampaignCases, validateCampaignPlan } from "./plan.js";
import { unitKey } from "./records.js";
import { buildCampaignReport } from "./report.js";
import {
  campaignCasesPath,
  campaignEnvironmentPath,
  campaignPlanPath,
  campaignReportPath,
  readJsonFile,
  readTextFile,
  writeJsonFile,
} from "./store.js";

/**
 * `--report-only`（#39）：只读 campaign 输出目录，从 plan / cases / 单元记录 /
 * judge 留痕重建报告并覆写 `report.json`。不执行内核或 judge，零网络。
 *
 * 完整性守卫（fail fast，不生成伪报告）：
 * - cases.json 与 environment.json 的 dataset hash / caseCount 必须一致；
 * - 每条记录必须属于本 campaign、参跑 arm、已声明 case、rep 上界内；
 * - judge 留痕必须能对上一条单元记录（孤儿 judge 记录视为输出损坏）；
 * - 没有单元记录时拒绝重建。
 */

export interface RebuildCampaignReportOptions {
  /** campaign 输出目录（含 plan.json / cases.json / runs/ / judge/） */
  readonly outDir: string;
}

export async function rebuildCampaignReport(
  options: RebuildCampaignReportOptions,
): Promise<CampaignReport> {
  const { outDir } = options;
  const planRaw = await readJsonFile<unknown>(campaignPlanPath(outDir));
  validateCampaignPlan(planRaw);
  const plan = planRaw;

  const casesText = await readTextFile(campaignCasesPath(outDir));
  const cases = parseCampaignCases(casesText, `campaign report-only: ${campaignCasesPath(outDir)}`);
  const caseIds = new Set(cases.map((mrCase) => mrCase.caseId));

  await verifyEnvironment(outDir, plan, cases, casesText);

  const records = await readRecords(outDir, plan, caseIds);
  const judgeCounts = await readJudgeCounts(outDir, plan, caseIds, records);
  const report = buildCampaignReport({
    campaignId: plan.campaignId,
    records,
    judgeCounts,
    cases,
  });
  await writeJsonFile(campaignReportPath(outDir), report);
  return report;
}

async function verifyEnvironment(
  outDir: string,
  plan: CampaignPlan,
  cases: readonly CampaignCase[],
  casesText: string,
): Promise<void> {
  const environment = await readOptionalJson(campaignEnvironmentPath(outDir));
  if (environment === null) {
    throw new Error(
      "campaign report-only: environment.json is required — a report without " +
        "provenance cannot be used as evaluation evidence (design §6.6/§8.5)",
    );
  }
  if (!isRecord(environment)) {
    throw new Error("campaign report-only: environment.json must be an object");
  }
  if (environment.campaignId !== plan.campaignId) {
    throw new Error(
      "campaign report-only: environment.json campaignId " +
        `${JSON.stringify(environment.campaignId)} does not match plan.json ` +
        `${JSON.stringify(plan.campaignId)}`,
    );
  }
  if (!isRecord(environment.dataset)) {
    throw new Error("campaign report-only: environment.json dataset must be an object");
  }
  const dataset = environment.dataset;
  if (dataset.caseCount !== cases.length) {
    throw new Error(
      `campaign report-only: cases.json has ${cases.length} cases but ` +
        `environment.json dataset.caseCount is ${JSON.stringify(dataset.caseCount)}`,
    );
  }
  const actualHash = hashCasesText(casesText);
  if (dataset.hash !== actualHash) {
    throw new Error(
      "campaign report-only: cases.json hash does not match environment.json " +
        `dataset.hash (expected ${String(dataset.hash)}, actual ${actualHash}) — ` +
        "records and cases disagree",
    );
  }
}

async function readRecords(
  outDir: string,
  plan: CampaignPlan,
  caseIds: ReadonlySet<string>,
): Promise<readonly EvalRunRecord[]> {
  const files = await listJsonFiles(path.join(outDir, "runs"));
  if (files.length === 0) {
    throw new Error(
      `campaign report-only: no unit records found under ${path.join(outDir, "runs")}`,
    );
  }
  const records: EvalRunRecord[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const value = await readJsonFile(file);
    assertEvalRunRecord(value, plan, caseIds, file);
    const key = unitKey(value);
    if (seen.has(key)) {
      throw new Error(`campaign report-only: duplicate unit record for ${key} (${file})`);
    }
    seen.add(key);
    records.push(value);
  }
  return records;
}

async function readJudgeCounts(
  outDir: string,
  plan: CampaignPlan,
  caseIds: ReadonlySet<string>,
  records: readonly EvalRunRecord[],
): Promise<ReadonlyMap<string, MatchCounts>> {
  const recordKeys = new Set(records.map((record) => unitKey(record)));
  const files = await listJsonFiles(path.join(outDir, "judge"));
  const counts = new Map<string, MatchCounts>();
  const seen = new Set<string>();
  for (const file of files) {
    const value = await readJsonFile(file);
    assertJudgeRecord(value, plan, caseIds, file);
    const key = unitKey(value);
    if (seen.has(key)) {
      throw new Error(`campaign report-only: duplicate judge record for ${key} (${file})`);
    }
    seen.add(key);
    if (!recordKeys.has(key)) {
      throw new Error(
        `campaign report-only: judge record for ${key} has no matching unit record (${file})`,
      );
    }
    if (value.status === "judged") {
      counts.set(key, value.counts);
    }
  }
  return counts;
}

function assertEvalRunRecord(
  value: unknown,
  plan: CampaignPlan,
  caseIds: ReadonlySet<string>,
  where: string,
): asserts value is EvalRunRecord {
  if (!isRecord(value)) {
    throw new Error(`campaign report-only: ${where} must be a unit record object`);
  }
  if (value.source !== "vul4j" || value.configId !== "E") {
    throw new Error(
      `campaign report-only: ${where} must be an E-only vul4j record ` +
        `(got source ${JSON.stringify(value.source)}, configId ${JSON.stringify(value.configId)})`,
    );
  }
  if (value.campaignId !== plan.campaignId) {
    throw new Error(
      `campaign report-only: ${where} campaignId ${JSON.stringify(value.campaignId)} ` +
        `does not match plan.json ${JSON.stringify(plan.campaignId)}`,
    );
  }
  if (value.evalOnly !== true || value.environmentRef !== ENVIRONMENT_REF) {
    throw new Error(
      `campaign report-only: ${where} is missing the eval-only sidecar ` +
        "(evalOnly: true, environmentRef: \"environment.json\")",
    );
  }
  if (typeof value.arm !== "string" || !(plan.arms as readonly string[]).includes(value.arm)) {
    throw new Error(
      `campaign report-only: ${where} arm ${JSON.stringify(value.arm)} is not in plan.json arms`,
    );
  }
  if (typeof value.caseId !== "string" || !caseIds.has(value.caseId)) {
    throw new Error(
      `campaign report-only: ${where} references a case missing from cases.json ` +
        `(${JSON.stringify(value.caseId)})`,
    );
  }
  if (
    typeof value.rep !== "number" ||
    !Number.isInteger(value.rep) ||
    value.rep < 1 ||
    value.rep > plan.reps
  ) {
    throw new Error(
      `campaign report-only: ${where} rep ${JSON.stringify(value.rep)} is outside 1..${plan.reps}`,
    );
  }
}

function assertJudgeRecord(
  value: unknown,
  plan: CampaignPlan,
  caseIds: ReadonlySet<string>,
  where: string,
): asserts value is JudgeRecord {
  assertJudgeIdentity(value, plan, caseIds, where);
  if (value.status === "judged") {
    assertJudgeCounts(value.counts, where);
    assertJudgeAnomalies(value.anomalies, where);
    return;
  }
  if (value.status === "failed") {
    if (typeof value.error !== "string") {
      throw new Error(`campaign report-only: judge record ${where} failed record needs an error`);
    }
    return;
  }
  throw new Error(
    `campaign report-only: judge record ${where} status must be "judged" or "failed"`,
  );
}

function assertJudgeIdentity(
  value: unknown,
  plan: CampaignPlan,
  caseIds: ReadonlySet<string>,
  where: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`campaign report-only: judge record ${where} must be an object`);
  }
  if (value.campaignId !== plan.campaignId) {
    throw new Error(
      `campaign report-only: judge record ${where} campaignId ` +
        `${JSON.stringify(value.campaignId)} does not match plan.json`,
    );
  }
  if (value.source !== "vul4j") {
    throw new Error(`campaign report-only: judge record ${where} source must be "vul4j"`);
  }
  if (typeof value.caseId !== "string" || !caseIds.has(value.caseId)) {
    throw new Error(
      `campaign report-only: judge record ${where} references a case missing from cases.json`,
    );
  }
  if (typeof value.arm !== "string" || !(CAMPAIGN_ARMS as readonly string[]).includes(value.arm)) {
    throw new Error(`campaign report-only: judge record ${where} has unknown arm`);
  }
  if (
    typeof value.rep !== "number" ||
    !Number.isInteger(value.rep) ||
    value.rep < 1 ||
    value.rep > plan.reps
  ) {
    throw new Error(`campaign report-only: judge record ${where} has invalid rep`);
  }
}

function assertJudgeCounts(value: unknown, where: string): asserts value is MatchCounts {
  if (!isRecord(value)) {
    throw new Error(`campaign report-only: judge record ${where} counts must be an object`);
  }
  for (const field of ["tp", "fp", "fn"] as const) {
    const count = value[field];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      throw new Error(
        `campaign report-only: judge record ${where} counts.${field} must be a non-negative integer`,
      );
    }
  }
}

/** judge 有界失败留痕（#40）：缺省兼容旧记录；在场必须是字符串数组 */
function assertJudgeAnomalies(value: unknown, where: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(
      `campaign report-only: judge record ${where} anomalies must be an array of strings`,
    );
  }
}

async function readOptionalJson(file: string): Promise<unknown | null> {
  try {
    return await readJsonFile(file);
  } catch (error) {
    if (isEnoent(error)) {
      return null;
    }
    throw error;
  }
}

async function listJsonFiles(root: string): Promise<readonly string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }
    throw error;
  }
  const sorted = [...entries].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const files: string[] = [];
  for (const entry of sorted) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(full);
    }
  }
  return files;
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
