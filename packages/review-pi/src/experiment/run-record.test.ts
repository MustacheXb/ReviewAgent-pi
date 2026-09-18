import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { CacheBreakRecord, RunAudit, RunResult } from "../contracts/run.js";
import {
  buildRunRecord,
  runRecordPath,
  toAuditLight,
  toRunSnapshot,
  writeRunRecord,
  type RunRecord,
} from "./run-record.js";

// RunRecord 投影（测量常量面）：与根仓 run-store 产出的 DSH 记录同构
// （三级键序以 t-series 记录为地面真源），冻结 analyze 脚本原样消费。
// 落盘路径：<runsRoot>/<experimentId>/runs/vul4j/<caseId>/<configId>/rep-<N>.json。

const COMPLETED_AT = new Date("2026-09-14T18:09:20.100Z");

const AUDIT: RunAudit = {
  requests: [],
  toolCallLog: [],
  phaseLog: [{ round: 1, phase: "Change Understanding", requestCount: 1 }],
  rejections: [],
  cacheBreaks: [],
  truncated: false,
  truncationReasons: [],
  prefetch: [
    { layer: "zone-b", budgetChars: 16000, contentChars: 100, truncated: false, totalEntries: 1, shownEntries: 1 },
  ],
};

const RUN_RESULT: RunResult = {
  caseId: "VUL4J-1",
  configId: "B",
  model: "deepseek-v4-flash",
  findings: [],
  usage: { inputTokens: 9579, outputTokens: 14484, cacheReadTokens: 24064 },
  rounds: 1,
  toolCalls: 0,
  audit: AUDIT,
  auditPath: path.join(tmpdir(), "audit", "20260914T180846.922-B-VUL4J-1.json"),
};

const RECORD_KEYS = [
  "source",
  "caseId",
  "configId",
  "rep",
  "model",
  "verifier",
  "completedAt",
  "baseline",
  "effective",
  "verifierPass",
] as const;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-run-record-"));
  tempDirs.push(dir);
  return dir;
}

function recordFixture(): RunRecord {
  return buildRunRecord({
    source: "vul4j",
    caseId: "VUL4J-1",
    configId: "B",
    rep: 1,
    model: "deepseek-v4-flash",
    completedAt: COMPLETED_AT,
    result: RUN_RESULT,
  });
}

describe("toAuditLight", () => {
  test("键序与 DSH AuditLight 一致；空 cacheBreaks 省键，非空保留", () => {
    const light = toAuditLight(AUDIT);
    expect(Object.keys(light)).toEqual([
      "toolCallLog",
      "phaseLog",
      "rejections",
      "truncated",
      "truncationReasons",
      "prefetch",
    ]);

    const withBreaks = toAuditLight({
      ...AUDIT,
      cacheBreaks: [
        { requestIndex: 1, reason: "MODEL_CHANGED", zone: "MODEL", divergeByteOffset: 1 },
      ] as const satisfies readonly CacheBreakRecord[],
    });
    expect(Object.keys(withBreaks)).toContain("cacheBreaks");
    expect(withBreaks.cacheBreaks).toHaveLength(1);
  });
});

describe("toRunSnapshot", () => {
  test("RunResult → 快照（去 requests；auditPath 缺省空串）", () => {
    const snapshot = toRunSnapshot(RUN_RESULT);
    expect(Object.keys(snapshot)).toEqual(["findings", "usage", "rounds", "toolCalls", "audit", "auditPath"]);
    expect(snapshot.auditPath).toBe(RUN_RESULT.auditPath);
    expect("requests" in snapshot.audit).toBe(false);

    const withoutPath = toRunSnapshot({ ...RUN_RESULT, auditPath: undefined });
    expect(withoutPath.auditPath).toBe("");
  });
});

describe("buildRunRecord", () => {
  test("baseline-only 记录：键序与 DSH 记录一致，effective / verifierPass 恒 null", () => {
    const record = recordFixture();
    expect(Object.keys(record)).toEqual([...RECORD_KEYS]);
    expect(record.source).toBe("vul4j");
    expect(record.verifier).toBe("off");
    expect(record.completedAt).toBe("2026-09-14T18:09:20.100Z");
    expect(record.effective).toBeNull();
    expect(record.verifierPass).toBeNull();
    expect(Object.keys(record.baseline)).toEqual([
      "findings",
      "usage",
      "rounds",
      "toolCalls",
      "audit",
      "auditPath",
    ]);
  });
});

describe("runRecordPath / writeRunRecord", () => {
  test("路径：<runsRoot>/<experimentId>/runs/<source>/<caseId>/<configId>/rep-<N>.json", () => {
    const record = recordFixture();
    expect(runRecordPath("runs", "phase2-smoke", record)).toBe(
      path.join("runs", "phase2-smoke", "runs", "vul4j", "VUL4J-1", "B", "rep-1.json"),
    );
  });

  test("caseId 文件名不安全字符替换（点号保留，与根仓 RunStore 同则）", () => {
    const record = buildRunRecord({
      source: "vul4j",
      caseId: "case/with space",
      configId: "B",
      rep: 2,
      model: "deepseek-v4-flash",
      completedAt: COMPLETED_AT,
      result: { ...RUN_RESULT, caseId: "case/with space" },
    });
    expect(runRecordPath("runs", "phase2-smoke", record)).toContain(
      path.join("case_with_space", "B", "rep-2.json"),
    );
  });

  test("落盘 2 空格缩进 + 尾随换行，往返一致，且满足冻结消费方的形状要求", async () => {
    const record = recordFixture();
    const runsRoot = tempDir();
    const filePath = await writeRunRecord(runsRoot, "phase2-smoke", record);
    expect(filePath).toBe(runRecordPath(runsRoot, "phase2-smoke", record));
    const text = readFileSync(filePath, "utf8");
    expect(text).toBe(`${JSON.stringify(record, null, 2)}\n`);
    const parsed = JSON.parse(text);
    // 冻结消费方（collectExecRecords / isRunRecordShape）的硬性要求
    expect(typeof parsed.completedAt).toBe("string");
    expect(Number.isNaN(Date.parse(parsed.completedAt))).toBe(false);
    expect(typeof parsed.baseline.usage.inputTokens).toBe("number");
    expect(typeof parsed.baseline.usage.outputTokens).toBe("number");
    expect(Array.isArray(parsed.baseline.findings)).toBe(true);
  });
});

/** 真实 t-series 记录（DSH 线地面真源；本机 runs/ 在场时才断言） */
const REAL_RECORD = path.resolve(
  import.meta.dirname,
  "../../../../runs/phase2-dsh-t1/runs/vul4j/VUL4J-1/B/rep-1.json",
);

describe("与 DSH 线 RunRecord 同构（地面真源键序对照）", () => {
  test.skipIf(!existsSync(REAL_RECORD))("三级键序与 t-series 记录逐键一致", () => {
    const real = JSON.parse(readFileSync(REAL_RECORD, "utf8"));
    const record = recordFixture();
    expect(Object.keys(record)).toEqual(Object.keys(real));
    expect(Object.keys(record.baseline)).toEqual(Object.keys(real.baseline));
    expect(Object.keys(record.baseline.audit)).toEqual(Object.keys(real.baseline.audit));
  });
});
