import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DISPOSITION_DECISIONS,
  type DispositionDecision,
  type DispositionRecord,
  errorMessage,
  nonEmptyString,
  validatedConfigId,
  validatedRep,
  validatedSource,
} from "./record.js";

/**
 * #15 处置库（append-only 存储）。
 *
 * - 布局：`<out>/<experimentId>/dispositions.json`——与 runs/ 同层（票面
 *   建议路径）；文件形态 = 2 空格缩进 JSON 数组 + 末尾换行（与 render.ts
 *   的 stdout 纪律同形，便于人工查看与 diff）；
 * - append-only 语义：已落库记录永不重写——追加 = 读旧数组 → 展开新数组
 *   `[...existing, record]` → 整文件原子重写（临时文件 + rename）；「同一
 *   finding 重复处置」不拒绝、不覆盖，追加新记录，读取视图按
 *   notedAt 最新者胜（kpi.ts latestDispositions）——人工改主意是正常路径；
 * - 读取侧 fail fast：文件在但不可解析 / 非数组 / 条目形状不符 → 人话错误
 *   带 entry 序号定位；文件不在 = 首写前的正常态 → 空数组（stats 面对
 *   「文件不存在」另做区分，见 command.ts）；
 * - 单写者假设：处置是人工 CLI 面向单人的动作，不做跨进程互斥（开放
 *   问题已记录）；原子重写保证单次落库自身不撕裂。
 *
 * 校验器单源：字符串/枚举/数值字段复用 record.ts 的共享校验器（run
 * record 读取面与处置库条目面同一套口径）；处置特有字段
 * （disposition/notedAt/note）在本文件。
 */

/** 处置库文件名（<out>/<experimentId>/ 下，与 runs/ 同层） */
export const DISPOSITION_STORE_FILENAME = "dispositions.json";

/** 处置库路径：<out>/<experimentId>/dispositions.json */
export function dispositionStorePath(outDir: string, experimentId: string): string {
  return path.join(outDir, experimentId, DISPOSITION_STORE_FILENAME);
}

/** 解析处置库文本 → 记录数组（外部数据面 fail fast，entry 序号定位） */
export function parseDispositionStore(
  text: string,
  storePath: string,
): readonly DispositionRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `disposition store ${storePath} is not valid JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`disposition store ${storePath}: expected a JSON array of disposition records`);
  }
  return parsed.map((entry, index) => toDispositionRecord(entry, index, storePath));
}

/** 读处置库：文件不在 = 首写前正常态 → 空数组；在则解析校验；读失败 → 人话包装（record.ts readRunRecordRef 同款） */
export async function loadDispositionStore(storePath: string): Promise<readonly DispositionRecord[]> {
  let text: string;
  try {
    text = await readFile(storePath, "utf8");
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    const message = errorMessage(error);
    throw new Error(`cannot read disposition store ${storePath}: ${message}`, { cause: error });
  }
  return parseDispositionStore(text, storePath);
}

/** 追加一条处置记录：读旧 → 展开新数组 → 原子重写 → 返回新视图 */
export async function appendDispositionToStore(
  storePath: string,
  record: DispositionRecord,
): Promise<readonly DispositionRecord[]> {
  const existing = await loadDispositionStore(storePath);
  const records = [...existing, record];
  await writeStoreFile(storePath, records);
  return records;
}

/** 整文件原子写：临时文件 + rename（不撕裂已落库记录）；失败 → 人话包装（writeRunRecord 同款） */
async function writeStoreFile(storePath: string, records: readonly DispositionRecord[]): Promise<void> {
  const tempPath = `${storePath}.tmp`;
  try {
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    await rename(tempPath, storePath);
  } catch (error) {
    const message = errorMessage(error);
    throw new Error(`failed to persist disposition store ${storePath}: ${message}`, { cause: error });
  }
}

/** 单条处置记录形状校验（条目级定位前缀 + 共享校验器） */
function toDispositionRecord(entry: unknown, index: number, storePath: string): DispositionRecord {
  const where = `disposition store ${storePath} entry #${index + 1}`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`${where}: expected a JSON object`);
  }
  const raw = entry as Record<string, unknown>;
  return {
    source: validatedSource(raw.source, where),
    caseId: nonEmptyString(raw.caseId, "caseId", where),
    configId: validatedConfigId(raw.configId, where),
    rep: validatedRep(raw.rep, where),
    model: nonEmptyString(raw.model, "model", where),
    findingId: nonEmptyString(raw.findingId, "findingId", where),
    disposition: validatedDisposition(raw.disposition, where),
    notedAt: validatedNotedAt(raw.notedAt, where),
    ...validatedNote(raw.note, where),
  };
}

/** 处置三值枚举校验（与 DISPOSITION_DECISIONS 契约单源） */
function validatedDisposition(disposition: unknown, where: string): DispositionDecision {
  if (
    typeof disposition !== "string" ||
    !DISPOSITION_DECISIONS.includes(disposition as DispositionDecision)
  ) {
    throw new Error(
      `${where}: field "disposition" ${JSON.stringify(disposition)} is not one of ${DISPOSITION_DECISIONS.join(", ")}`,
    );
  }
  return disposition as DispositionDecision;
}

/** notedAt：非空且可被 Date.parse 的 ISO 8601 时间戳 */
function validatedNotedAt(notedAt: unknown, where: string): string {
  const value = nonEmptyString(notedAt, "notedAt", where);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(
      `${where}: field "notedAt" ${JSON.stringify(value)} is not a parseable ISO 8601 timestamp`,
    );
  }
  return value;
}

/** note 在场必须非空文本；返回可展开片段（缺席省键） */
function validatedNote(note: unknown, where: string): { readonly note?: string } {
  if (note === undefined) {
    return {};
  }
  if (typeof note !== "string" || note.trim().length === 0) {
    throw new Error(`${where}: field "note" must be non-empty text when present`);
  }
  return { note };
}
