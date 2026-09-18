import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { RunAudit } from "../contracts/run.js";
import { buildAuditFileContent, buildRunId, writeAuditFile, type AuditFileContent } from "./audit-writer.js";

// 审计投影（测量常量面）：AuditFileContent 字段集与键序与 DSH 线审计文件
// 逐键一致（t-series 审计为地面真源），requests[] = onPayload 序列化点捕获
// （model/effort/messages/tools/wireBody）。

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
};

/** 与 DSH 审计文件相同的 20 键序（prefetch 在场时） */
const AUDIT_KEYS_WITH_PREFETCH = [
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
  "prefetch",
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

function contentFixture(overrides?: {
  readonly prefetch?: readonly { readonly layer: "symbol"; readonly budgetChars: number; readonly contentChars: number; readonly truncated: boolean; readonly totalEntries: number; readonly shownEntries: number }[];
}): AuditFileContent {
  return buildAuditFileContent({
    runId: "20260914T180846.922-B-VUL4J-1",
    caseId: "VUL4J-1",
    configId: "B",
    model: "deepseek-v4-flash",
    effort: "default",
    startedAt: STARTED,
    finishedAt: FINISHED,
    rounds: 1,
    toolCalls: 0,
    usage: { inputTokens: 9579, outputTokens: 14484, cacheReadTokens: 24064 },
    findings: [],
    audit: EMPTY_AUDIT,
    ...(overrides?.prefetch !== undefined ? { prefetch: overrides.prefetch } : {}),
  });
}

describe("buildRunId", () => {
  test("毫秒时间戳 + 配置 + 用例，文件名安全", () => {
    expect(buildRunId(STARTED, "B", "VUL4J-1")).toBe("20260914T180846.922-B-VUL4J-1");
  });

  test("用例 id 中的文件名不安全字符替换为下划线", () => {
    expect(buildRunId(STARTED, "B", "VUL4J/1 x")).toBe("20260914T180846.922-B-VUL4J_1_x");
  });
});

describe("buildAuditFileContent", () => {
  test("字段集与键序与 DSH 审计文件一致（含 prefetch 扩展字段）", () => {
    const content = contentFixture({
      prefetch: [
        {
          layer: "symbol",
          budgetChars: 8000,
          contentChars: 100,
          truncated: false,
          totalEntries: 2,
          shownEntries: 2,
        },
      ],
    });
    expect(Object.keys(content)).toEqual([...AUDIT_KEYS_WITH_PREFETCH]);
  });

  test("非预取配置不携带 prefetch 键", () => {
    const content = contentFixture();
    expect(Object.keys(content)).toEqual([...AUDIT_KEYS_WITH_PREFETCH].filter((key) => key !== "prefetch"));
    expect("prefetch" in content).toBe(false);
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

/** 真实 t-series 审计文件（DSH 线地面真源；本机 runs/ 在场时才断言） */
const REAL_AUDIT_DIR = path.resolve(
  import.meta.dirname,
  "../../../../runs/phase2-dsh-t1/audit/vul4j/VUL4J-1/B/rep-1/audit",
);

describe("与 DSH 线审计文件同构（地面真源键序对照）", () => {
  test.skipIf(!existsSync(REAL_AUDIT_DIR))("键序与 t-series 审计逐键一致", () => {
    const fileName = readdirSync(REAL_AUDIT_DIR).find((name) => name.endsWith(".json"));
    expect(fileName).toBeDefined();
    const real = JSON.parse(readFileSync(path.join(REAL_AUDIT_DIR, fileName as string), "utf8"));
    const content = buildAuditFileContent({
      runId: "20260914T180846.922-B-VUL4J-1",
      caseId: "VUL4J-1",
      configId: "B",
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
        requests: [
          {
            model: "deepseek-v4-flash",
            effort: "default",
            messages: [{ role: "system", content: "A" }],
            tools: [],
            wireBody: "{}",
          },
        ],
      },
      prefetch: [
        {
          layer: "symbol",
          budgetChars: 8000,
          contentChars: 100,
          truncated: false,
          totalEntries: 2,
          shownEntries: 2,
        },
      ],
    });
    expect(Object.keys(content)).toEqual(Object.keys(real));
    expect(Object.keys(content.requests[0] ?? {})).toEqual(Object.keys(real.requests[0]));
  });
});
