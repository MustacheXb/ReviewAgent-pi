import { expect, test } from "vitest";
import type { LedgerDelivery, LedgerEntry, LedgerRequest } from "../contracts/ledger.js";
import { createContextLedger } from "./ledger.js";

// 送达感知 Context Ledger（#56 / ADR-0018 §4）：只断言账本接口的外部可观察
// 行为——命中/未命中、引用文本、快照字段与统计；不窥探内部索引结构。

const CLOCK = [0, 1, 2, 3, 4].map((tick) => `2026-11-12T00:00:0${tick}.000Z`);

function clock(): { readonly now: () => string } {
  let tick = 0;
  return {
    now: () => {
      const value = CLOCK[Math.min(tick, CLOCK.length - 1)]!;
      tick += 1;
      return value;
    },
  };
}

/** get_file 请求：range 为 1-based 闭区间；endLine=null 表示到文件尾 */
function fileRequest(
  path: string,
  startLine: number | null,
  endLine: number | null,
): LedgerRequest {
  const whole = startLine === null && endLine === null;
  const range = { startLine: startLine ?? 1, endLine };
  return {
    kind: whole ? "file" : "range",
    resourceKey: `review.get_file ${path}`,
    description: whole
      ? `review.get_file ${path}`
      : `review.get_file ${path}:${range.startLine}-${endLine ?? "end"}`,
    requestedRange: range,
  };
}

function wholeResultRequest(resourceKey: string, kind: LedgerRequest["kind"]): LedgerRequest {
  return { kind, resourceKey, description: resourceKey, requestedRange: null };
}

function delivery(
  content: string,
  deliveredRange: LedgerDelivery["deliveredRange"],
  complete = true,
  totalLines?: number,
): LedgerDelivery {
  return {
    content,
    deliveredRange,
    complete,
    ...(totalLines !== undefined ? { totalLines } : {}),
  };
}

function entryById(entries: readonly LedgerEntry[], id: string): LedgerEntry {
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw new Error(`missing ledger entry ${id}`);
  }
  return entry;
}

test("完全相同请求第二次返回引用：引用含请求范围、送达范围与 complete", () => {
  const ledger = createContextLedger({ now: clock().now });
  const request = fileRequest("src/Foo.java", 100, 180);

  expect(ledger.referenceIfLoaded(request)).toBeUndefined();
  ledger.register(request, delivery("x".repeat(500), { startLine: 100, endLine: 180 }));

  expect(ledger.referenceIfLoaded(request)).toBe(
    "Already loaded: ctx#001 (review.get_file src/Foo.java:100-180; delivered lines 100-180 of requested lines 100-180; complete=true)",
  );
  // 未命中在查询时计数（失败读取也算一次未命中）
  expect(ledger.stats()).toEqual({ ledgerHits: 1, ledgerMisses: 1, savedCharsEstimate: 500 });
});

test("整文件完整送达后子区间命中：引用标注送达范围包含请求范围", () => {
  const ledger = createContextLedger({ now: clock().now });
  const whole = fileRequest("src/Foo.java", null, null);
  ledger.register(whole, delivery("y".repeat(1_800), { startLine: 1, endLine: null }, true, 18));

  expect(ledger.referenceIfLoaded(fileRequest("src/Foo.java", 11, 13))).toBe(
    "Already loaded: ctx#001 (review.get_file src/Foo.java:11-13; delivered lines 1-end of requested lines 11-13; complete=true)",
  );
});

test("整文件送达后的请求仍受资源总行数约束：起点越界不命中（不谎报已加载）", () => {
  const ledger = createContextLedger({ now: clock().now });
  const whole = fileRequest("src/Foo.java", null, null);
  ledger.register(whole, delivery("y".repeat(1_800), { startLine: 1, endLine: null }, true, 18));

  // 起点超出文件尾：未覆盖 → 未命中（真实读取会抛 beyond end of file）
  expect(ledger.referenceIfLoaded(fileRequest("src/Foo.java", 999, null))).toBeUndefined();
  // 终点超出文件尾：同样不命中（clamp 语义由真实读取留痕）
  expect(ledger.referenceIfLoaded(fileRequest("src/Foo.java", 10, 99))).toBeUndefined();
});

test("未覆盖区间不命中：截断送达不冒充整文件，覆盖子区间仍可命中且标注 complete=false", () => {
  const ledger = createContextLedger({ now: clock().now });
  const whole = fileRequest("src/Foo.java", null, null);
  // 整文件请求被截断：只送达 1-50，complete=false
  ledger.register(whole, delivery("z".repeat(900), { startLine: 1, endLine: 50 }, false));

  // 整文件请求未被覆盖 → 未命中（不谎报「已加载」）
  expect(ledger.referenceIfLoaded(whole)).toBeUndefined();
  // 已送达前缀之外 → 未命中
  expect(ledger.referenceIfLoaded(fileRequest("src/Foo.java", 40, 60))).toBeUndefined();
  // 已完整覆盖的子区间 → 命中，引用如实标注 complete=false
  expect(ledger.referenceIfLoaded(fileRequest("src/Foo.java", 10, 20))).toBe(
    "Already loaded: ctx#001 (review.get_file src/Foo.java:10-20; delivered lines 1-50 of requested lines 10-20; complete=false)",
  );
});

test("整结果工具：完整送达命中；截断结果既不命中整体也不命中「子区间」（无范围参数）", () => {
  const ledger = createContextLedger({ now: clock().now });
  const diff = wholeResultRequest("review.get_diff", "evidence");
  ledger.register(diff, delivery("diff-body", null));

  expect(ledger.referenceIfLoaded(diff)).toBe(
    "Already loaded: ctx#001 (review.get_diff; delivered whole result of requested whole result; complete=true)",
  );

  const symbol = wholeResultRequest('review.get_symbol "Alpha"', "symbol");
  ledger.register(symbol, delivery("symbol-lines", { startLine: 1, endLine: 20 }, false));
  expect(ledger.referenceIfLoaded(symbol)).toBeUndefined();
});

test("未覆盖重读登记新条目：快照保留请求/送达范围、内容哈希、字符数与命中计数", () => {
  const ledger = createContextLedger({ now: clock().now });
  const first = fileRequest("src/Foo.java", 11, 13);
  ledger.register(first, delivery("first-content", { startLine: 11, endLine: 13 }));
  // 不同区间（即使内容重叠）→ 新条目，不合并
  const second = fileRequest("src/Foo.java", 11, 14);
  ledger.register(second, delivery("second-content", { startLine: 11, endLine: 14 }));

  const entries = ledger.snapshot();
  expect(entries.map((entry) => entry.id)).toEqual(["ctx#001", "ctx#002"]);
  expect(entries[0]).toMatchObject({
    kind: "range",
    description: "review.get_file src/Foo.java:11-13",
    requestedRange: { startLine: 11, endLine: 13 },
    deliveredRange: { startLine: 11, endLine: 13 },
    complete: true,
    charCount: "first-content".length,
    hitCount: 0,
  });
  expect(entries[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  // 身份键含 kind + 规范化参数 + 请求范围 + 内容哈希
  expect(entries[0]?.key).toContain("review.get_file src/Foo.java");
  expect(entries[0]?.key).toContain(entries[0]?.contentHash);
  expect(entries[0]?.key).not.toBe(entries[1]?.key);
});

test("命中计数与最后命中时间：每次命中累加，时间来自注入时钟", () => {
  const injected = clock();
  const ledger = createContextLedger({ now: injected.now });
  const request = wholeResultRequest("review.get_diff", "evidence");
  ledger.register(request, delivery("body", null));

  ledger.referenceIfLoaded(request);
  ledger.referenceIfLoaded(request);

  const entry = entryById(ledger.snapshot(), "ctx#001");
  expect(entry.hitCount).toBe(2);
  expect(entry.lastHitAt).toBe(CLOCK[1]);
});

test("savedCharsEstimate：精确重复按原文长度计；覆盖子区间按行数比例估算", () => {
  const ledger = createContextLedger({ now: clock().now });
  const whole = fileRequest("src/Foo.java", null, null);
  ledger.register(whole, delivery("w".repeat(1_000), { startLine: 1, endLine: 100 }));

  ledger.referenceIfLoaded(fileRequest("src/Foo.java", 1, 100)); // 精确重复
  expect(ledger.stats().savedCharsEstimate).toBe(1_000);

  ledger.referenceIfLoaded(fileRequest("src/Foo.java", 1, 50)); // 一半区间
  expect(ledger.stats().savedCharsEstimate).toBe(1_500);
});

test("savedCharsEstimate：endLine=null 的整文件送达按总行数折算，不按 100% 计", () => {
  const ledger = createContextLedger({ now: clock().now });
  const whole = fileRequest("src/Foo.java", null, null);
  ledger.register(whole, delivery("z".repeat(1_800), { startLine: 1, endLine: null }, true, 18));

  ledger.referenceIfLoaded(fileRequest("src/Foo.java", 1, 9)); // 18 行中的 9 行
  expect(ledger.stats().savedCharsEstimate).toBe(900);
});
