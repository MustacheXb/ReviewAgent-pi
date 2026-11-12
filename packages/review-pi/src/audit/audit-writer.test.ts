import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { RunAudit } from "../contracts/run.js";
import { CONFIG_E } from "../contracts/config.js";
import { buildAuditFileContent, buildRunId, writeAuditFile, type AuditFileContent } from "./audit-writer.js";

// 审计投影（测量常量面）：AuditFileContent 字段集与键序与 DSH 线审计文件
// 逐键一致（E 主相位序列为真源口径），requests[] = onPayload 序列化点捕获
// （model/effort/messages/tools/wireBody）。历史 B/C 尾键（prefetch /
// fullRepo）已随研究装置根除（#32 / ADR-0014）——键序冻结面由本文件的
// 字面 AUDIT_PREFIX_KEYS 列表单源锁定（t-series runs/ 对照随研究线退役）。

const STARTED = new Date("2026-09-14T18:08:46.922Z");
const FINISHED = new Date("2026-09-14T18:09:20.100Z");

const EMPTY_AUDIT: RunAudit = {
  requests: [],
  toolCallLog: [],
  phaseLog: [],
  rejections: [],
  cacheBreaks: [],
  truncated: false,
  truncationReasons: [],
  stopReason: "MODEL_COMPLETE",
};

/** 键序冻结面（E 审计文件的前缀键序；ledger / mrBoundary 为条件尾键，
 * stopReason 恒写；#58 cacheContract 为追加在 stopReason 之后的可选尾键） */
const AUDIT_PREFIX_KEYS = [
  "runId",
  "caseId",
  "configId",
  "model",
  "effort",
  "startedAt",
  "finishedAt",
  "durationMs",
  "rounds",
  "toolCalls",
  "truncated",
  "truncationReasons",
  "usage",
  "findings",
  "phaseLog",
  "rejections",
  "cacheBreaks",
  "requests",
  "toolCallLog",
] as const;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-audit-"));
  tempDirs.push(dir);
  return dir;
}

function contentFixture(): AuditFileContent {
  return buildAuditFileContent({
    runId: `20260914T180846.922-${CONFIG_E}-VUL4J-1`,
    caseId: "VUL4J-1",
    configId: CONFIG_E,
    model: "deepseek-v4-flash",
    effort: "default",
    startedAt: STARTED,
    finishedAt: FINISHED,
    rounds: 1,
    toolCalls: 0,
    usage: { inputTokens: 9579, outputTokens: 14484, cacheReadTokens: 24064 },
    findings: [],
    audit: EMPTY_AUDIT,
  });
}

describe("buildRunId", () => {
  test("毫秒时间戳 + 配置 + 用例，文件名安全", () => {
    expect(buildRunId(STARTED, CONFIG_E, "VUL4J-1")).toBe("20260914T180846.922-E-VUL4J-1");
  });

  test("用例 id 中的文件名不安全字符替换为下划线", () => {
    expect(buildRunId(STARTED, CONFIG_E, "VUL4J/1 x")).toBe("20260914T180846.922-E-VUL4J_1_x");
  });
});

describe("buildAuditFileContent", () => {
  test("字段集与键序冻结（E 审计文件完整键序；stopReason 恒写于尾部）", () => {
    const content = contentFixture();
    expect(Object.keys(content)).toEqual([...AUDIT_PREFIX_KEYS, "stopReason"]);
    expect(content.stopReason).toBe("MODEL_COMPLETE");
  });

  test("cacheContract（#58）：可选尾键追加在 stopReason 之后，历史键序不变", () => {
    const withContract = buildAuditFileContent({
      runId: `20260914T180846.922-${CONFIG_E}-VUL4J-1`,
      caseId: "VUL4J-1",
      configId: CONFIG_E,
      model: "deepseek-v4-flash",
      effort: "default",
      startedAt: STARTED,
      finishedAt: FINISHED,
      rounds: 1,
      toolCalls: 0,
      usage: { inputTokens: 9579, outputTokens: 14484, cacheReadTokens: 24064 },
      findings: [],
      audit: {
        ...EMPTY_AUDIT,
        cacheContract: {
          provider: "deepseek",
          endpointKind: "chat-completions",
          requestedModel: "deepseek-v4-flash",
          respondedModel: "deepseek-v4-flash",
          deploymentVersion: "unknown",
          usageFieldFamily: "deepseek-native",
          cacheMetering: true,
          cacheBlockTokens: "unknown",
          cacheWarmupMs: "unknown",
          providerAffinityRequired: "unknown",
          measuredAt: "2026-11-12T00:00:00.000Z",
        },
      },
    });
    expect(Object.keys(withContract)).toEqual([
      ...AUDIT_PREFIX_KEYS,
      "stopReason",
      "cacheContract",
    ]);
  });

  test("mrBoundary（#12 护栏留痕）：只在传入时在场，键序在 stopReason 之前（ledger 之后）", () => {
    // 界内（不传 mrBoundary）：键缺席——护栏零介入的投影面证明
    const bare = contentFixture();
    expect("mrBoundary" in bare).toBe(false);
    expect(Object.keys(bare).at(-1)).toBe("stopReason");

    // 降级（传入 mrBoundary）：度量值与决策留痕，尾键扩展不扰动冻结前缀
    const degraded = buildAuditFileContent({
      runId: `20260914T180846.922-${CONFIG_E}-VUL4J-1`,
      caseId: "VUL4J-1",
      configId: CONFIG_E,
      model: "deepseek-v4-flash",
      effort: "default",
      startedAt: STARTED,
      finishedAt: FINISHED,
      rounds: 1,
      toolCalls: 0,
      usage: { inputTokens: 9579, outputTokens: 14484, cacheReadTokens: 24064 },
      findings: [],
      audit: EMPTY_AUDIT,
      ledger: [],
      mrBoundary: { files: 11, changedLines: 22, degraded: true, reason: "too-many-files" },
    });
    const keys = Object.keys(degraded);
    expect(keys.slice(0, -1)).toEqual([...AUDIT_PREFIX_KEYS, "ledger", "mrBoundary"]);
    expect(keys.at(-1)).toBe("stopReason");
    expect(degraded.mrBoundary).toEqual({
      files: 11,
      changedLines: 22,
      degraded: true,
      reason: "too-many-files",
    });
  });

  test("ledgerStats（#56）：有账本查询时在场，键序在 ledger 之后、mrBoundary 之前", () => {
    const content = buildAuditFileContent({
      runId: `20260914T180846.922-${CONFIG_E}-VUL4J-1`,
      caseId: "VUL4J-1",
      configId: CONFIG_E,
      model: "deepseek-v4-flash",
      effort: "default",
      startedAt: STARTED,
      finishedAt: FINISHED,
      rounds: 1,
      toolCalls: 1,
      usage: { inputTokens: 9579, outputTokens: 14484, cacheReadTokens: 24064 },
      findings: [],
      audit: {
        ...EMPTY_AUDIT,
        ledgerStats: { ledgerHits: 1, ledgerMisses: 2, savedCharsEstimate: 30 },
      },
      ledger: [],
      mrBoundary: { files: 11, changedLines: 22, degraded: true, reason: "too-many-files" },
    });
    expect(Object.keys(content)).toEqual([
      ...AUDIT_PREFIX_KEYS,
      "ledger",
      "ledgerStats",
      "mrBoundary",
      "stopReason",
    ]);
    expect(content.ledgerStats).toEqual({
      ledgerHits: 1,
      ledgerMisses: 2,
      savedCharsEstimate: 30,
    });
  });

  test("元数据换算：ISO 时间戳与 durationMs", () => {
    const content = contentFixture();
    expect(content.startedAt).toBe("2026-09-14T18:08:46.922Z");
    expect(content.finishedAt).toBe("2026-09-14T18:09:20.100Z");
    expect(content.durationMs).toBe(FINISHED.getTime() - STARTED.getTime());
  });
});

describe("writeAuditFile", () => {
  test("落盘 <auditDir>/<runId>.json，2 空格缩进 + 尾随换行，往返一致", async () => {
    const content = contentFixture();
    const dir = tempDir();
    const auditDir = path.join(dir, "nested", "audit");
    const filePath = await writeAuditFile(auditDir, content);
    expect(path.isAbsolute(filePath)).toBe(true);
    expect(filePath).toBe(path.join(auditDir, `${content.runId}.json`));
    const text = readFileSync(filePath, "utf8");
    expect(text).toBe(`${JSON.stringify(content, null, 2)}\n`);
    expect(JSON.parse(text)).toEqual(content);
  });
});
