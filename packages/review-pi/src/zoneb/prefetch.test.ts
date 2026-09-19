import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DEFAULT_PREFETCH_BUDGETS } from "../contracts/prefetch.js";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";
import { buildZoneB } from "./zone-b-builder.js";
import { buildPrefetchContext } from "./prefetch.js";

// config B 确定性预取管线（测量常量面）：Diff → Symbol → Reference → Call Chain 固定顺序。
// Zone B 插在 system 与初始 user 之间；三层追加 user 消息；全程零 LLM、零工具调用；
// 同一仓库 + 同一 diff → 字节级相同的注入内容。

const SAMPLE = repoFixturePath("sample");
const BETA_FILE = "src/main/java/com/example/Beta.java";

const BETA_DIFF = [
  `diff --git a/${BETA_FILE} b/${BETA_FILE}`,
  `--- a/${BETA_FILE}`,
  `+++ b/${BETA_FILE}`,
  "@@ -5,4 +5,4 @@",
  " context",
  "+changed",
].join("\n");

test("buildPrefetchContext：样本仓库四层注入（zone-b 消息 + 三层消息 + 记账）", async () => {
  const { zoneBMessage, layerMessages, records } = await buildPrefetchContext({
    repoPath: SAMPLE,
    diff: BETA_DIFF,
    budgets: DEFAULT_PREFETCH_BUDGETS,
  });

  const zoneB = await buildZoneB({
    repoPath: SAMPLE,
    changedFiles: [BETA_FILE],
    budgetChars: DEFAULT_PREFETCH_BUDGETS.zoneBBudgetChars,
  });
  expect(zoneBMessage).toEqual({ role: "user", content: zoneB.content });

  expect(layerMessages.map((message) => message.role)).toEqual(["user", "user", "user"]);
  expect(layerMessages[0]?.content).toBe(
    [
      "Prefetched context (1 of 3) - Symbol layer.",
      "Deterministic prefetch pipeline: Diff -> Symbol -> Reference -> Call Chain.",
      "Changed symbols at signature level (types and members intersecting the diff hunks; no method bodies).",
      "",
      `${BETA_FILE} (changed lines: 5-8)`,
      "  L3 public class Beta",
      "    L5 public int combine(Alpha alpha, int factor)",
    ].join("\n"),
  );
  expect(layerMessages[1]?.content).toBe(
    [
      "Prefetched context (2 of 3) - Reference layer.",
      "Deterministic prefetch pipeline: Diff -> Symbol -> Reference -> Call Chain.",
      "Name-level word matches of changed symbols across all Java sources (lexical, no type resolution).",
      "",
      'Symbol "combine": 1 match(es)',
      `  ${BETA_FILE}:5:     public int combine(Alpha alpha, int factor) {`,
    ].join("\n"),
  );
  expect(layerMessages[2]?.content).toBe(
    [
      "Prefetched context (3 of 3) - Call chain layer.",
      "Deterministic prefetch pipeline: Diff -> Symbol -> Reference -> Call Chain.",
      "Name-level call chains up to 2 hops around changed methods (lexical, no type resolution).",
      "",
      `Beta.combine - method at ${BETA_FILE}:5`,
      "  Callers (hop 1):",
      "    (none)",
      "  Callers (hop 2):",
      "    (no method-level callers identified at hop 1)",
      "  Callees (hop 1):",
      `    getBase - ${BETA_FILE}:6`,
      `    scale - ${BETA_FILE}:7`,
    ].join("\n"),
  );

  expect(records).toHaveLength(4);
  expect(records.map((record) => record.layer)).toEqual([
    "zone-b",
    "symbol",
    "reference",
    "call-chain",
  ]);
  expect(records[0]).toEqual(zoneB.record);
  expect(records.slice(1).map((record) => record.truncated)).toEqual([false, false, false]);
  expect(records.slice(1).map((record) => record.shownEntries)).toEqual([1, 1, 1]);
  expect(records.slice(1).map((record) => record.budgetChars)).toEqual([8_000, 6_000, 6_000]);
  for (const [index, record] of records.slice(1).entries()) {
    expect(record.contentChars).toBe(layerMessages[index]?.content.length);
  }
});

test("buildPrefetchContext：小预算下三层按 block 边界截断并留痕", async () => {
  const { layerMessages, records } = await buildPrefetchContext({
    repoPath: SAMPLE,
    diff: BETA_DIFF,
    budgets: { zoneBBudgetChars: 16_000, symbolLayerBudgetChars: 50, referenceLayerBudgetChars: 50, callChainLayerBudgetChars: 50 },
  });
  expect(layerMessages[0]?.content).toContain(
    "Symbol layer truncated: showing 0 of 1 file entries (budget 50 chars exceeded).",
  );
  expect(layerMessages[1]?.content).toContain(
    "Reference layer truncated: showing 0 of 1 symbol entries (budget 50 chars exceeded).",
  );
  expect(layerMessages[2]?.content).toContain(
    "Call chain layer truncated: showing 0 of 1 chain entries (budget 50 chars exceeded).",
  );
  expect(records.slice(1).map((record) => record.truncated)).toEqual([true, true, true]);
  expect(records.slice(1).map((record) => record.shownEntries)).toEqual([0, 0, 0]);
});

const VUL4J_1_SNAPSHOT = fileURLToPath(
  new URL("../../../../.cache/datasets/vul4j-repos/VUL4J-1-f5903fa564", import.meta.url),
);

test.skipIf(!existsSync(VUL4J_1_SNAPSHOT))(
  "buildPrefetchContext：VUL4J-1 快照四层注入与 t 系列审计黄金字节一致（本地快照存在时）",
  async () => {
    const { zoneBMessage, layerMessages } = await buildPrefetchContext({
      repoPath: VUL4J_1_SNAPSHOT,
      diff: goldenFixture("vul4j-1.diff"),
      budgets: DEFAULT_PREFETCH_BUDGETS,
    });
    expect(zoneBMessage.content).toBe(goldenFixture("zone-b-vul4j-1.txt"));
    expect(layerMessages[0]?.content).toBe(goldenFixture("prefetch-1-vul4j-1.txt"));
    expect(layerMessages[1]?.content).toBe(goldenFixture("prefetch-2-vul4j-1.txt"));
    expect(layerMessages[2]?.content).toBe(goldenFixture("prefetch-3-vul4j-1.txt"));
  },
  // 全量套件下本测试与 review-run / analyze-consumption 的 E2E 并行跑
  // 同一 fastjson 快照，磁盘争用可远超包级 120s 上限（曾实测单跑即 131s），
  // 显式放宽（与 run/*.test.ts 重型用例同法）
  300_000,
);
