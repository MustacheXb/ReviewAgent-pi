import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { DispositionCliArgs } from "../cli/args.js";
import { runDispositionCommand } from "./command.js";
import type { DispositionRecord } from "./record.js";
import { eRunRecordJson } from "./run-record-fixture.js";
import { appendDispositionToStore } from "./store.js";

// disposition 命令编排（#15，进程内）：记录处置与 KPI 两个用法面的全链
// 行为。stdout 契约对齐 cli/render.ts——单个 JSON 文档（ok 包络 + 2 空格
// 缩进 + 尾随换行）；错误一律 throw 人话（main 统一 stderr + exit 1）。
// 夹具用 E 形态 run record（生产入口验收样例，2026-10-19 决策评论；与
// bin.process.test.ts 共享单源 run-record-fixture.ts；真实 E 产物的
// 端到端锁见 e-artifact.test.ts）。

/** KPI 种子记录（E 形态锚） */
function storedRecord(
  findingId: string,
  disposition: DispositionRecord["disposition"],
  notedAt: string,
): DispositionRecord {
  return {
    source: "vul4j",
    caseId: "VUL4J-1",
    configId: "E",
    rep: 1,
    model: "deepseek-v4-flash",
    findingId,
    disposition,
    notedAt,
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-disposition-"));
  tempDirs.push(dir);
  return dir;
}

function writeRunRecord(dir: string): string {
  const filePath = path.join(dir, "run-record.json");
  writeFileSync(filePath, eRunRecordJson(), "utf8");
  return filePath;
}

describe("runDispositionCommand（记录面）", () => {
  test("记录处置：stdout 单 JSON（ok 包络 + 2 空格缩进 + 尾随换行）+ 落库 + 回溯锚齐备", async () => {
    const dir = tempDir();
    const runRecordPath = writeRunRecord(dir);
    const storePath = path.join(dir, "dispositions.json");

    const stdout = await runDispositionCommand({
      mode: "record",
      args: { run: runRecordPath, finding: "F100", decision: "accept", store: storePath },
    });

    // 呈现纪律锁形：ok 包络 + 2 空格缩进 + 尾随换行
    const outcome = JSON.parse(stdout);
    expect(stdout).toBe(`${JSON.stringify(outcome, null, 2)}\n`);
    expect(outcome).toMatchObject({
      ok: true,
      store: storePath,
      recordCount: 1,
      disposition: {
        source: "vul4j",
        caseId: "VUL4J-1",
        configId: "E",
        rep: 1,
        model: "deepseek-v4-flash",
        findingId: "F100",
        disposition: "accept",
      },
    });
    expect(typeof outcome.disposition.notedAt).toBe("string");
    expect(Number.isNaN(Date.parse(outcome.disposition.notedAt))).toBe(false);
    expect("note" in outcome.disposition).toBe(false);
    // 落库面：库文件里正是这条处置记录（append-only）
    expect(JSON.parse(readFileSync(storePath, "utf8"))).toEqual([outcome.disposition]);
  });

  test("note 透传；二次处置追加（recordCount 递增，既有记录保留）", async () => {
    const dir = tempDir();
    const runRecordPath = writeRunRecord(dir);
    const storePath = path.join(dir, "dispositions.json");

    await runDispositionCommand({
      mode: "record",
      args: { run: runRecordPath, finding: "F100", decision: "accept", store: storePath },
    });
    const stdout = await runDispositionCommand({
      mode: "record",
      args: {
        run: runRecordPath,
        finding: "F101",
        decision: "false-positive",
        note: "误报：测试夹具",
        store: storePath,
      },
    });

    const outcome = JSON.parse(stdout);
    expect(outcome.recordCount).toBe(2);
    expect(outcome.disposition.note).toBe("误报：测试夹具");
    const store = JSON.parse(readFileSync(storePath, "utf8"));
    expect(store).toHaveLength(2);
    expect(store[0].disposition).toBe("accept");
  });

  test("run record 缺席 / finding 不在其中 / JSON 损坏 → 人话错误（throw，交 main 落 stderr + exit 1）", async () => {
    const dir = tempDir();
    const storePath = path.join(dir, "dispositions.json");
    await expect(
      runDispositionCommand({
        mode: "record",
        args: { run: path.join(dir, "nope.json"), finding: "F100", decision: "accept", store: storePath },
      }),
    ).rejects.toThrow("run record file not found");

    const runRecordPath = writeRunRecord(dir);
    await expect(
      runDispositionCommand({
        mode: "record",
        args: { run: runRecordPath, finding: "F999", decision: "accept", store: storePath },
      }),
    ).rejects.toThrow('finding "F999" not found');

    writeFileSync(runRecordPath, "{oops", "utf8");
    await expect(
      runDispositionCommand({
        mode: "record",
        args: { run: runRecordPath, finding: "F100", decision: "accept", store: storePath },
      }),
    ).rejects.toThrow("not valid JSON");
  });
});

describe("runDispositionCommand（KPI 面）", () => {
  test("绝对口径 KPI：从落库数据直出单 JSON 文档（latest-wins 后 accepted/total）", async () => {
    const dir = tempDir();
    const storePath = path.join(dir, "dispositions.json");
    // F100 翻转（accept→reject）、F101 接受、F102 误报
    await appendDispositionToStore(storePath, storedRecord("F100", "accept", "2026-10-19T10:00:00.000Z"));
    await appendDispositionToStore(storePath, storedRecord("F100", "reject", "2026-10-19T11:00:00.000Z"));
    await appendDispositionToStore(storePath, storedRecord("F101", "accept", "2026-10-19T10:30:00.000Z"));
    await appendDispositionToStore(storePath, storedRecord("F102", "false-positive", "2026-10-19T10:45:00.000Z"));

    const stdout = await runDispositionCommand({ mode: "stats", args: { store: storePath } });
    const outcome = JSON.parse(stdout);
    expect(stdout).toBe(`${JSON.stringify(outcome, null, 2)}\n`);
    expect(outcome).toEqual({
      ok: true,
      store: storePath,
      accepted: 1,
      rejected: 1,
      falsePositive: 1,
      total: 3,
      acceptanceRate: 1 / 3,
    });
  });

  test("库文件缺席 → 人话错误（KPI 读错路径要炸出来，不静默 N/A）", async () => {
    await expect(
      runDispositionCommand({ mode: "stats", args: { store: path.join(tempDir(), "nope.json") } }),
    ).rejects.toThrow("disposition store not found");
  });

  test("空库文件（[]）→ total 0 + acceptanceRate null（空集 N/A）", async () => {
    const storePath = path.join(tempDir(), "dispositions.json");
    writeFileSync(storePath, "[]\n", "utf8");
    const stdout = await runDispositionCommand({ mode: "stats", args: { store: storePath } });
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      store: storePath,
      accepted: 0,
      rejected: 0,
      falsePositive: 0,
      total: 0,
      acceptanceRate: null,
    });
  });

  test("库损坏 → 人话错误", async () => {
    const storePath = path.join(tempDir(), "dispositions.json");
    writeFileSync(storePath, "{oops", "utf8");
    await expect(
      runDispositionCommand({ mode: "stats", args: { store: storePath } }),
    ).rejects.toThrow("not valid JSON");
  });
});
