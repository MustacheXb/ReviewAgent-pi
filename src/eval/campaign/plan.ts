import type { MRCase } from "../../instrument/contracts/mr-case.js";
import {
  CAMPAIGN_ARMS,
  CAMPAIGN_ARM_ORDERS,
  type CampaignArm,
  type CampaignCase,
  type CampaignPlan,
  type CampaignUnit,
} from "./contracts.js";

/**
 * Campaign plan 校验与执行单元展开（#39）：纯函数，零网络、零文件系统。
 *
 * 展开口径（评测方案 §6.3 / 滑窗纪律）：按 case → rep → arm 展开，同一
 * case / rep 的两条 arm 相邻执行——同窗口交错，避免 provider / 缓存时段
 * 漂移偏向任一臂。arm 顺序沿用 plan 声明（空对照校准可两条 arm 同 ref）。
 *
 * E-only 骨架约束：cases 只接受 `vul4j` 源且 `allowedConfigs` 含 E；
 * 真值形状按 MRCase 契约校验（`truth = null` = clean MR 阴性对照）。
 */

/** campaignId 安全路径段（字母数字开头；不允许路径分隔与纯点段） */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateCampaignPlan(value: unknown): asserts value is CampaignPlan {
  if (!isRecord(value)) {
    throw new Error("campaign plan must be an object");
  }
  requireNonEmptyString(value.campaignId, "campaignId", "campaign plan");
  if (!SAFE_PATH_SEGMENT.test(value.campaignId)) {
    throw new Error(
      `campaign plan: campaignId must be a safe path segment ` +
        `(letters/digits/._-, starting with a letter or digit; got ${JSON.stringify(value.campaignId)})`,
    );
  }
  requireNonEmptyString(value.baselineRef, "baselineRef", "campaign plan");
  requireNonEmptyString(value.candidateRef, "candidateRef", "campaign plan");
  requireNonEmptyString(value.casesFile, "casesFile", "campaign plan");
  requirePositiveInt(value.reps, "reps", "campaign plan");
  requireNonEmptyString(value.model, "model", "campaign plan");
  requireNonEmptyString(value.outputDir, "outputDir", "campaign plan");
  validateArms(value.arms);
  validateArmOrder(value);
}

function validateArmOrder(value: Record<string, unknown>): void {
  if (value.armOrder !== undefined) {
    if (
      typeof value.armOrder !== "string" ||
      !(CAMPAIGN_ARM_ORDERS as readonly string[]).includes(value.armOrder)
    ) {
      throw new Error(
        `campaign plan: armOrder must be one of ${CAMPAIGN_ARM_ORDERS.join(", ")} ` +
          `(got ${JSON.stringify(value.armOrder)})`,
      );
    }
  }
  if (value.armOrder === "randomized") {
    requirePositiveInt(value.armOrderSeed, "armOrderSeed", "campaign plan");
  } else if (value.armOrderSeed !== undefined) {
    requirePositiveInt(value.armOrderSeed, "armOrderSeed", "campaign plan");
  }
}

function validateArms(value: unknown): asserts value is readonly CampaignArm[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("campaign plan: arms must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const arm of value) {
    if (typeof arm !== "string" || !(CAMPAIGN_ARMS as readonly string[]).includes(arm)) {
      throw new Error(
        `campaign plan: arms contains unknown arm ${JSON.stringify(arm)} ` +
          `(allowed: ${CAMPAIGN_ARMS.join(", ")})`,
      );
    }
    if (seen.has(arm)) {
      throw new Error(`campaign plan: arms must not contain duplicates (got ${JSON.stringify(arm)})`);
    }
    seen.add(arm);
  }
}

export function validateCampaignCases(value: unknown): asserts value is readonly CampaignCase[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("campaign cases must be a non-empty array");
  }
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      throw new Error(`campaign cases[${index}] must be an object`);
    }
    const caseId = requireCaseId(entry.caseId, index);
    if (seen.has(caseId)) {
      throw new Error(`duplicate caseId ${JSON.stringify(caseId)} in campaign cases`);
    }
    seen.add(caseId);
    validateCampaignCase(entry, index);
  }
}

/**
 * caseId 同时是输出路径段（runs/<source>/<case>/<arm>）：只接受安全段，
 * 拒绝 "." / ".." / 路径分隔 / 前导点——不做静默改写（改写会让 a/b 与 a_b
 * 撞同一路径，或让 .. 逃出 case 目录）。
 */
function requireCaseId(value: unknown, index: number): string {
  requireNonEmptyString(value, `cases[${index}].caseId`, "campaign cases");
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(
      `campaign cases[${index}].caseId must be a safe path segment ` +
        `(letters/digits/._-, starting with a letter or digit; got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function validateCampaignCase(entry: Record<string, unknown>, index: number): void {
  requireNonEmptyString(entry.repoPath, `cases[${index}].repoPath`, "campaign cases");
  requireString(entry.diff, `cases[${index}].diff`, "campaign cases");
  requireString(entry.issueDescription, `cases[${index}].issueDescription`, "campaign cases");
  validateTruth(entry.truth, `cases[${index}].truth`);
  const labels = requireRecord(entry.labels, `cases[${index}].labels`, "campaign cases");
  if (labels.source !== "vul4j") {
    throw new Error(
      `campaign cases[${index}]: labels.source must be "vul4j" in the #39 skeleton ` +
        `(pi RunRecord.source is vul4j-only; clean-MR negative controls land with the ` +
        `real kernel in #40) — got ${JSON.stringify(labels.source)}`,
    );
  }
  if (!Array.isArray(labels.allowedConfigs) || !labels.allowedConfigs.includes("E")) {
    throw new Error(
      `campaign cases[${index}]: labels.allowedConfigs must include "E" (E-only campaign)`,
    );
  }
}

/**
 * cases 文本解析 + 校验（cases file 与 campaign 目录内 cases.json 副本共用）。
 * 非法 JSON / 形状错误 fail fast，错误消息带来源路径。
 */
export function parseCampaignCases(
  text: string,
  source = "campaign cases",
): readonly CampaignCase[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${source} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  validateCampaignCases(parsed);
  return parsed;
}

function validateTruth(value: unknown, where: string): void {
  if (value === null) {
    return;
  }
  if (!isRecord(value)) {
    throw new Error(`campaign ${where} must be null or a truth object`);
  }
  if (!Array.isArray(value.locations) || value.locations.length === 0) {
    throw new Error(`campaign ${where}.locations must be a non-empty array`);
  }
  for (const [index, location] of value.locations.entries()) {
    const entry = requireRecord(location, `${where}.locations[${index}]`, "campaign");
    requireNonEmptyString(entry.file, `${where}.locations[${index}].file`, "campaign");
    requireNonNegativeInt(entry.lineStart, `${where}.locations[${index}].lineStart`, "campaign");
    requireNonNegativeInt(entry.lineEnd, `${where}.locations[${index}].lineEnd`, "campaign");
    requireNonEmptyString(
      entry.defectNature,
      `${where}.locations[${index}].defectNature`,
      "campaign",
    );
  }
  requireString(value.fixPatch, `${where}.fixPatch`, "campaign");
}

/**
 * 展开执行单元：case（cases file 顺序）→ rep（1..reps）→ arm。
 * 同 case / rep 的两臂相邻，便于同窗口交错执行；`armOrder = randomized`
 * 时每个 case×rep 按种子确定性洗牌（同种子可复算），消除固定臂序偏差。
 */
export function expandUnits(
  plan: CampaignPlan,
  cases: readonly MRCase[],
): readonly CampaignUnit[] {
  validateCampaignPlan(plan);
  validateCampaignCases(cases);
  const units: CampaignUnit[] = [];
  for (const mrCase of cases) {
    for (let rep = 1; rep <= plan.reps; rep += 1) {
      for (const arm of armsFor(plan, mrCase.caseId, rep)) {
        units.push({ source: "vul4j", caseId: mrCase.caseId, arm, rep });
      }
    }
  }
  return units;
}

function armsFor(plan: CampaignPlan, caseId: string, rep: number): readonly CampaignArm[] {
  if (plan.armOrder !== "randomized") {
    return plan.arms;
  }
  const seed = hashSeed(
    `${plan.campaignId}|${plan.armOrderSeed ?? 0}|${caseId}|${rep}`,
  );
  return shuffle(plan.arms, mulberry32(seed));
}

/** FNV-1a 32-bit（稳定字符串 → 种子） */
function hashSeed(text: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/** mulberry32：确定性 32-bit PRNG（与 L2 bootstrap 同族算法） */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = result[index] as T;
    result[index] = result[swapIndex] as T;
    result[swapIndex] = current;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  field: string,
  where: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${where}: field ${JSON.stringify(field)} must be an object`);
  }
  return value;
}

function requireString(value: unknown, field: string, where: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${where}: field ${JSON.stringify(field)} must be a string`);
  }
}

function requireNonEmptyString(
  value: unknown,
  field: string,
  where: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where}: field ${JSON.stringify(field)} must be a non-empty string`);
  }
}

function requirePositiveInt(value: unknown, field: string, where: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${where}: field ${JSON.stringify(field)} must be a positive integer`);
  }
}

function requireNonNegativeInt(
  value: unknown,
  field: string,
  where: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${where}: field ${JSON.stringify(field)} must be a non-negative integer`);
  }
}
