import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { DispositionCliArgs, DispositionRecordArgs, DispositionStatsArgs } from "../cli/args.js";
import { renderJsonDocument } from "../cli/render.js";
import { computeAcceptanceKpi } from "./kpi.js";
import { buildDispositionRecord, errorMessage, readRunRecordRef } from "./record.js";
import { appendDispositionToStore, loadDispositionStore } from "./store.js";

/**
 * #15 disposition 命令编排（进程内，由 cli/main.ts 分发）：记录处置与
 * KPI 两个用法面。本命令无网络：不解析凭据、不读环境变量（与 review/
 * smoke 的实质差异——main 在 .env.local 装载面之前就分流到此处）。
 *
 * 返回 stdout 文档文本（呈现纪律对齐 cli/render.ts：单个 JSON 文档——
 * ok 包络 + 2 空格缩进 + 尾随换行），由 main 整写 stdout；错误一律 throw
 * 人话 → main 统一 stderr + exit 1。路径相对 cwd 解析（同 review 命令）。
 *
 * 记录面：--run 读 run record（readRunRecordRef 校验形状）→ findingId ∈
 * baseline.findings 校验（buildDispositionRecord）→ append-only 落库。
 * KPI 面（--stats）：处置库缺席 → 人话错误（读错路径要炸出来，不静默
 * N/A；空库文件 [] 才是显式空集 → total 0 + null）→ computeAcceptanceKpi
 * 绝对口径直出。
 */

/** 记录面：读 run record → 校验 → 追加落库 → 呈现落库结果 */
async function recordDisposition(args: DispositionRecordArgs): Promise<string> {
  const runRecord = await readRunRecordRef(resolve(args.run));
  const record = buildDispositionRecord({
    runRecord,
    findingId: args.finding,
    decision: args.decision,
    notedAt: new Date(),
    ...(args.note !== undefined ? { note: args.note } : {}),
  });
  const storePath = resolve(args.store);
  const records = await appendDispositionToStore(storePath, record);
  return renderJsonDocument({ ok: true, store: storePath, recordCount: records.length, disposition: record });
}

/** KPI 面：读处置库 → 绝对口径聚合 → 呈现单 JSON 文档 */
async function statsDisposition(args: DispositionStatsArgs): Promise<string> {
  const storePath = resolve(args.store);
  if (!(await fileExists(storePath))) {
    throw new Error(
      `disposition store not found: ${storePath} (no dispositions recorded yet — record one first with \`review-pi disposition --run ...\`, or check the --store/--out path)`,
    );
  }
  const kpi = computeAcceptanceKpi(await loadDispositionStore(storePath));
  return renderJsonDocument({ ok: true, store: storePath, ...kpi });
}

/** 执行一次 disposition 命令；返回 stdout 文档（失败 throw 人话） */
export async function runDispositionCommand(args: DispositionCliArgs): Promise<string> {
  return args.mode === "record" ? recordDisposition(args.args) : statsDisposition(args.args);
}

/** 文件在否：仅「不存在」（ENOENT）算否——其余 stat 失败（如 EACCES）照实炸出，不误诊为「库不在」 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw new Error(`cannot stat disposition store ${filePath}: ${errorMessage(error)}`, { cause: error });
  }
}
