import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { computeAcceptanceKpi } from "./kpi.js";
import {
  buildDispositionRecord,
  readRunRecordRef,
  referredRunRecordPath,
} from "./record.js";
import { appendDispositionToStore, dispositionStorePath, loadDispositionStore } from "./store.js";

/**
 * #15 真实 E 产物闭环（code-review Spec 项：「验收样例以 E 运行为准」
 * 不能只靠合成夹具自证）：消费 phase2-pi 真跑落盘的生产入口 E run
 * record（2026-10-19 决策评论），锁三件事——
 * 1. readRunRecordRef 吃得下真 E 记录（读取面与真实产物零漂移）；
 * 2. 回溯锚 referredRunRecordPath 能把处置记录重定位回真实 E 记录的
 *    实际路径（漂移锚点对真实目录布局成立）；
 * 3. 处置 → 落库 → KPI 全链由真 E 记录驱动（temp 处置库，绝不动 runs/）。
 *
 * 门控形态同仓先例（zoneb / run-record.test.ts 的「本地快照存在时」）：
 * runs/ 为 gitignored 本地产物，CI / 别机无此文件时整档跳过。
 */

const RUNS_ROOT = path.resolve(import.meta.dirname, "../../../../runs");
const REAL_E_RECORD = path.join(RUNS_ROOT, "phase2-pi", "runs", "vul4j", "VUL4J-38", "E", "rep-1.json");

/** 读真实 E 记录原文（仅在快照在场时被调用——skipIf 门控保证） */
function realRecordJson(): {
  readonly source: string;
  readonly caseId: string;
  readonly configId: string;
  readonly rep: number;
  readonly baseline: { readonly findings: readonly { readonly id: string }[] };
} {
  return JSON.parse(readFileSync(REAL_E_RECORD, "utf8"));
}

describe("真实 E 产物闭环（本地快照存在时）", () => {
  test.skipIf(!existsSync(REAL_E_RECORD))(
    "readRunRecordRef 吃下真 E run record：身份锚与 findings 投影逐字段一致",
    async () => {
      const raw = realRecordJson();
      const ref = await readRunRecordRef(REAL_E_RECORD);
      expect(ref.source).toBe(raw.source);
      expect(ref.caseId).toBe(raw.caseId);
      expect(ref.configId).toBe(raw.configId);
      expect(ref.rep).toBe(raw.rep);
      expect(ref.baseline.findings.map((finding) => finding.id)).toEqual(
        raw.baseline.findings.map((finding) => finding.id),
      );
    },
  );

  test.skipIf(!existsSync(REAL_E_RECORD))(
    "处置记录回溯锚重定位回真实 E 记录路径；外键 findingId 照常 fail fast",
    async () => {
      const ref = await readRunRecordRef(REAL_E_RECORD);
      const firstFindingId = ref.baseline.findings[0]?.id;
      expect(firstFindingId).toBeTruthy();
      const record = buildDispositionRecord({
        runRecord: ref,
        findingId: firstFindingId as string,
        decision: "accept",
        notedAt: new Date("2026-10-19T10:00:00.000Z"),
      });
      // 漂移锚：从处置记录出发应能拼回真实文件的实际路径
      expect(referredRunRecordPath(RUNS_ROOT, "phase2-pi", record)).toBe(REAL_E_RECORD);
      // 真 E 记录里不存在的 finding id → 人话错误（写入侧 fail fast 对真实数据成立）
      expect(() =>
        buildDispositionRecord({
          runRecord: ref,
          findingId: "F-not-in-real-record",
          decision: "accept",
          notedAt: new Date("2026-10-19T10:00:00.000Z"),
        }),
      ).toThrow(/F-not-in-real-record.*not found in run record/);
    },
  );

  test.skipIf(!existsSync(REAL_E_RECORD))(
    "真 E 记录驱动处置 → 落库 → KPI 全链（temp 处置库，不动 runs/）",
    async () => {
      const ref = await readRunRecordRef(REAL_E_RECORD);
      const firstFindingId = ref.baseline.findings[0]?.id as string;
      const record = buildDispositionRecord({
        runRecord: ref,
        findingId: firstFindingId,
        decision: "accept",
        notedAt: new Date("2026-10-19T10:00:00.000Z"),
        note: "真 E 产物闭环",
      });
      const storeDir = mkdtempSync(path.join(tmpdir(), "review-pi-e-artifact-"));
      try {
        const storePath = dispositionStorePath(storeDir, "e-artifact-test");
        const records = await appendDispositionToStore(storePath, record);
        expect(records).toHaveLength(1);
        // 回读即校验：真 E 身份锚完整穿过落库面
        const reloaded = await loadDispositionStore(storePath);
        expect(reloaded[0]).toEqual(record);
        expect(computeAcceptanceKpi(reloaded)).toEqual({
          accepted: 1,
          rejected: 0,
          falsePositive: 0,
          total: 1,
          acceptanceRate: 1,
        });
      } finally {
        rmSync(storeDir, { recursive: true, force: true });
      }
    },
  );
});
