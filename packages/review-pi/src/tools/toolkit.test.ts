import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { createContextLedger } from "./ledger.js";
import { REVIEW_TOOL_ORDER } from "./registry.js";
import { DEFAULT_TOOL_RESULT_BUDGET_CHARS } from "./result-budget.js";
import { buildReviewToolkit } from "./toolkit.js";
import { repoFixturePath } from "../testing/repos.js";

// 七工具执行器行为测试（#6 P3a）：sample 合成仓库上验证输出形态、入参校验、
// 预算截断、Ledger 去重与只读纪律。账本恒为功能态（#32 / ADR-0014：
// inert 模式随 C/D 研究配置根除，E 审计恒投影 ledger 键）。

const SAMPLE = repoFixturePath("sample");
const RANKING = repoFixturePath("ranking");
const SAMPLE_DIFF = [
  "diff --git a/src/main/java/com/example/Beta.java b/src/main/java/com/example/Beta.java",
  "--- a/src/main/java/com/example/Beta.java",
  "+++ b/src/main/java/com/example/Beta.java",
  "@@ -5,4 +5,4 @@",
  " context",
  "+changed",
].join("\n");

function toolkit(overrides?: { diff?: string; resultBudgetChars?: number }) {
  return buildReviewToolkit({
    repoPath: SAMPLE,
    diff: overrides?.diff ?? SAMPLE_DIFF,
    ...(overrides?.resultBudgetChars !== undefined
      ? { resultBudgetChars: overrides.resultBudgetChars }
      : {}),
  });
}

test("get_diff：diff 原文带 header 行返回", async () => {
  const tk = toolkit();
  const result = await tk.executeTool("review.get_diff", {});
  expect(result).toBe(["MR unified diff:", ...SAMPLE_DIFF.split("\n")].join("\n"));
});

test("get_file：整读带行号前缀；区间读取带 Lines 头", async () => {
  // 渲染路径断言用独立 toolkit（同一账本内整读后子区间会命中引用，#56）
  const whole = await toolkit().executeTool("review.get_file", {
    path: "src/main/java/com/example/Alpha.java",
  });
  const lines = whole.split("\n");
  expect(lines[0]).toBe("File: src/main/java/com/example/Alpha.java");
  expect(lines[1]).toBe("Lines 1-18 of 18");
  expect(lines[2]).toBe(" 1 | package com.example;");
  expect(lines.at(-1)).toMatch(/^18 | \}$/);

  const slice = await toolkit().executeTool("review.get_file", {
    path: "src/main/java/com/example/Alpha.java",
    startLine: 11,
    endLine: 13,
  });
  expect(slice.split("\n")).toEqual([
    "File: src/main/java/com/example/Alpha.java",
    "Lines 11-13 of 18",
    "11 |     public int getBase() {",
    "12 |         return base;",
    "13 |     }",
  ]);
});

test("get_file：end 超文件尾 clamp 留痕；start 超尾为显式错误", async () => {
  const tk = toolkit();
  const clamped = await tk.executeTool("review.get_file", {
    path: "src/main/java/com/example/Alpha.java",
    startLine: 15,
    endLine: 99,
  });
  expect(clamped.split("\n")[1]).toBe(
    "Lines 15-18 of 18 (requested end line 99 clamped to end of file)",
  );
  await expect(
    tk.executeTool("review.get_file", {
      path: "src/main/java/com/example/Alpha.java",
      startLine: 99,
    }),
  ).rejects.toThrow(/requested start line 99 is beyond end of file .*18 lines/);
});

test("get_file：路径逃逸与缺失文件为有界错误（不泄漏绝对路径）", async () => {
  const tk = toolkit();
  await expect(tk.executeTool("review.get_file", { path: "C:/Windows/system32/config" })).rejects.toThrow(
    /must be repository-relative/,
  );
  await expect(tk.executeTool("review.get_file", { path: "/etc/passwd" })).rejects.toThrow(
    /must be repository-relative/,
  );
  await expect(tk.executeTool("review.get_file", { path: "../outside.txt" })).rejects.toThrow(
    /must stay inside the repository snapshot/,
  );
  // 错误消息有界：缺失文件归为统一消息且不含宿主机绝对路径
  const message = await tk
    .executeTool("review.get_file", { path: "no/such/file.java" })
    .then(
      () => "tool unexpectedly succeeded",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  expect(message).toBe(
    'review.get_file: file "no/such/file.java" cannot be read from the repository snapshot (not found or unreadable)',
  );
  expect(message).not.toContain(SAMPLE);
  expect(message).not.toMatch(/[A-Za-z]:[\\/]/);
});

test("get_file：startLine > endLine 与非法入参为显式错误", async () => {
  const tk = toolkit();
  await expect(
    tk.executeTool("review.get_file", { path: "a.java", startLine: 5, endLine: 2 }),
  ).rejects.toThrow(/must not exceed/);
  await expect(tk.executeTool("review.get_file", { path: "" })).rejects.toThrow(
    /argument "path" must be a non-empty string/,
  );
  await expect(
    tk.executeTool("review.get_file", { path: "a.java", startLine: 1.5 }),
  ).rejects.toThrow(/argument "startLine" must be a positive integer/);
});

test("get_symbol：sample 仓库命中形态与零命中留痕", async () => {
  const tk = toolkit();
  const result = await tk.executeTool("review.get_symbol", { symbol: "Alpha" });
  const lines = result.split("\n");
  // 类声明 + 同名构造器各计一次（名字级匹配，不区分种类）
  expect(lines[0]).toBe('Symbol "Alpha": 2 match(es) across 3 Java file(s)');
  expect(lines[1]).toBe("src/main/java/com/example/Alpha.java (package com.example)");
  expect(lines[2]).toBe("  L3 public class Alpha");
  // 成员签名随类型命中附带
  expect(result).toContain("L11 public int getBase()");
  expect(result).toContain("L7 public Alpha(int base)");

  const zero = await tk.executeTool("review.get_symbol", { symbol: "NoSuchSymbol" });
  expect(zero).toBe('Symbol "NoSuchSymbol": 0 match(es) across 3 Java file(s)');
});

test("find_references：声明/使用点形态（与 zoneb 原语同结果）", async () => {
  const tk = toolkit();
  const result = await tk.executeTool("review.find_references", { symbol: "getBase" });
  expect(result.split("\n")).toEqual([
    'References to "getBase" (name-level whole-word match, no type resolution): 2 match(es) across 2 file(s)',
    "  src/main/java/com/example/Alpha.java:11 [declaration] Alpha.getBase",
    "      public int getBase() {",
    "  src/main/java/com/example/Beta.java:6 [usage] Beta.combine",
    "      int value = alpha.getBase();",
  ]);
});

test("get_call_chain：sample 方法链形态与零命中", async () => {
  const tk = toolkit();
  const result = await tk.executeTool("review.get_call_chain", { symbol: "getBase" });
  expect(result).toContain('Call chain for "getBase" (name-level, up to 2 hops, no type resolution): 1 method declaration(s) matched');
  expect(result).toContain("Alpha.getBase - method at src/main/java/com/example/Alpha.java:11");
  expect(result).toContain("Callers (hop 1):");
  expect(result).toContain("Callees (hop 1):");

  const zero = await tk.executeTool("review.get_call_chain", { symbol: "noSuchMethod" });
  expect(zero).toBe(
    'Call chain for "noSuchMethod" (name-level, up to 2 hops, no type resolution): no method or constructor named "noSuchMethod" found across 3 Java file(s)',
  );
});

test("search_rule/search_history：空语料与命中形态", async () => {
  // 空语料在评测 override 下仍可暴露（生产 core-5 不暴露必然为空的检索工具）
  const empty = buildReviewToolkit({
    repoPath: SAMPLE,
    diff: SAMPLE_DIFF,
    toolProfileOverride: "extended-7",
  });
  // 空语料（t-series 真源形态：0 entries configured for this run）
  await expect(empty.executeTool("review.search_rule", { query: "autoType" })).resolves.toBe(
    'Rule search "autoType" (case-insensitive substring): rule corpus is empty (0 entries configured for this run)',
  );
  await expect(empty.executeTool("review.search_history", { query: "CVE-2017-18349" })).resolves.toBe(
    'History search "CVE-2017-18349" (case-insensitive substring): history corpus is empty (0 entries configured for this run)',
  );

  // 注入语料后：命中计数 + 条目渲染 + 大小写不敏感
  const withCorpus = buildReviewToolkit({
    repoPath: SAMPLE,
    diff: SAMPLE_DIFF,
    knowledge: {
      rules: [{ id: "R-1", title: "Null handling", text: "Check for null before dereference." }],
      history: [
        { id: "H-1", title: "NPE in Beta", text: "Historical NPE defect in Beta.combine." },
        { id: "H-2", title: "Unrelated", text: "Nothing to see." },
      ],
    },
  });
  await expect(withCorpus.executeTool("review.search_rule", { query: "null" })).resolves.toBe(
    [
      'Rule search "null" (case-insensitive substring): 1 of 1 rule(s) matched',
      "  [R-1] Null handling",
      "    Check for null before dereference.",
    ].join("\n"),
  );
  await expect(withCorpus.executeTool("review.search_history", { query: "npe" })).resolves.toContain(
    'History search "npe" (case-insensitive substring): 1 of 2 history record(s) matched',
  );
});

test("预算：默认 8000 字符；超预算行边界截断并留痕", async () => {
  expect(DEFAULT_TOOL_RESULT_BUDGET_CHARS).toBe(8_000);
  const tk = toolkit({ resultBudgetChars: 100 });
  const result = await tk.executeTool("review.get_file", {
    path: "src/main/java/com/example/Alpha.java",
  });
  const lines = result.split("\n");
  const notice = lines.at(-1) as string;
  expect(notice).toMatch(
    /^Tool result truncated: showing \d+ of 20 result lines \(tool result budget 100 chars exceeded; complete=false\)\./,
  );
  // 截断只发生在行边界：无 notice 的行都来自原文行集
  const original = (await toolkit().executeTool("review.get_file", {
    path: "src/main/java/com/example/Alpha.java",
  })).split("\n");
  expect(lines.slice(0, -1).every((line) => original.includes(line))).toBe(true);
});

test("get_file 截断提示：含 shown/total/budget，并给出可用的下一段行区间", async () => {
  const path = "src/main/java/com/example/Alpha.java";
  const tk = toolkit({ resultBudgetChars: 100 });
  const result = await tk.executeTool("review.get_file", { path });
  const lines = result.split("\n");
  const notice = lines.at(-1) as string;
  const parsed =
    /^Tool result truncated: showing (\d+) of (\d+) result lines \(tool result budget 100 chars exceeded; complete=false\)\. Continue with review\.get_file\(path="src\/main\/java\/com\/example\/Alpha\.java", startLine=(\d+), endLine=(\d+)\)\.$/.exec(
      notice,
    );
  if (parsed === null) {
    throw new Error(`unexpected truncation notice: ${notice}`);
  }
  const shown = Number(parsed[1]);
  const total = Number(parsed[2]);
  const nextStart = Number(parsed[3]);
  const nextEnd = Number(parsed[4]);
  // 头部两行（File / Lines）计入 shown；下一段从已送达内容的后一行开始
  expect(total).toBe(20);
  expect(nextStart).toBe(shown - 2 + 1);
  expect(nextEnd).toBeGreaterThanOrEqual(nextStart);
  expect(nextEnd).toBeLessThanOrEqual(18);

  // 建议区间可直接续读，且不被同一预算再次截断
  const continuation = await toolkit({ resultBudgetChars: 100 }).executeTool("review.get_file", {
    path,
    startLine: nextStart,
    endLine: nextEnd,
  });
  expect(continuation).not.toContain("Tool result truncated");
  expect(continuation.split("\n")[1]).toBe(`Lines ${nextStart}-${nextEnd} of 18`);
  expect(continuation).toContain(`${nextStart} | `);
});

test("find_references 截断：声明优先于使用点（不再只保留前缀）", async () => {
  // scale 的使用点在 Beta.java:7，声明在 Beta.java:11——前缀截断会先留下使用点
  const tk = toolkit({ resultBudgetChars: 240 });
  const result = await tk.executeTool("review.find_references", { symbol: "scale" });
  expect(result).toContain("[declaration]");
  expect(result).not.toContain("[usage]");
  expect(result.split("\n").at(-1)).toMatch(
    /^Tool result truncated: showing \d+ of \d+ result lines \(tool result budget 240 chars exceeded; complete=false\)\.$/,
  );
});

test("search_rule 截断：标题命中优先于正文命中；全部入选时保持语料序", async () => {
  const rules = [
    { id: "R-1", title: "Unrelated", text: "mentions needle in body" },
    { id: "R-2", title: "Needle handling", text: "unrelated body" },
  ];
  const ranked = buildReviewToolkit({
    repoPath: SAMPLE,
    diff: SAMPLE_DIFF,
    resultBudgetChars: 120,
    knowledge: { rules, history: [] },
  });
  const truncated = await ranked.executeTool("review.search_rule", { query: "needle" });
  expect(truncated).toContain("[R-2] Needle handling");
  expect(truncated).not.toContain("[R-1]");
  expect(truncated.split("\n").at(-1)).toMatch(
    /^Tool result truncated: showing \d+ of \d+ result lines \(tool result budget 120 chars exceeded; complete=false\)\.$/,
  );

  // 预算足够时两条都入选，且按语料原序输出（R-1 在 R-2 前）
  const full = buildReviewToolkit({
    repoPath: SAMPLE,
    diff: SAMPLE_DIFF,
    resultBudgetChars: 200,
    knowledge: { rules, history: [] },
  });
  const ordered = await full.executeTool("review.search_rule", { query: "needle" });
  expect(ordered.indexOf("[R-1]")).toBeGreaterThanOrEqual(0);
  expect(ordered.indexOf("[R-1]")).toBeLessThan(ordered.indexOf("[R-2]"));
  expect(ordered).not.toContain("Tool result truncated");
});

test("get_symbol 截断：类型声明优先于方法成员（不再只保留前缀）", async () => {
  // 文件序：AFirst（方法 Shared）在前，ZType（类型 Shared）在后；截断应保留类型
  const tk = buildReviewToolkit({
    repoPath: RANKING,
    diff: SAMPLE_DIFF,
    resultBudgetChars: 170,
  });
  const result = await tk.executeTool("review.get_symbol", { symbol: "Shared" });
  expect(result).toContain("src/main/java/com/example/ZType.java (package com.example)");
  expect(result).toContain("public class Shared");
  expect(result).not.toContain("AFirst.java");
  expect(result.split("\n").at(-1)).toMatch(
    /^Tool result truncated: showing \d+ of \d+ result lines \(tool result budget 170 chars exceeded; complete=false\)\.$/,
  );
});

test("get_call_chain 截断：hop 1 优先于 hop 2 / callee（不再只保留前缀）", async () => {
  const tk = buildReviewToolkit({
    repoPath: RANKING,
    diff: SAMPLE_DIFF,
    resultBudgetChars: 600,
  });
  const result = await tk.executeTool("review.get_call_chain", { symbol: "Shared" });
  // 块 2 的 hop 1 入选（前缀截断到不了这里）；hop 2 让位
  expect(result).toContain("Second.Shared - method");
  expect(result).toContain("CallerTwo.invokeSecond");
  expect(result).not.toContain("Callers (hop 2):");
  expect(result).not.toContain("no method-level callers identified at hop 1");
  expect(result.split("\n").at(-1)).toMatch(
    /^Tool result truncated: showing \d+ of \d+ result lines \(tool result budget 600 chars exceeded; complete=false\)\.$/,
  );
});

test("get_diff 截断：提示列出未展开文件并建议 get_file(path)", async () => {
  const diff = ["A", "B", "C"]
    .flatMap((name) => [
      `diff --git a/src/${name}.java b/src/${name}.java`,
      `--- a/src/${name}.java`,
      `+++ b/src/${name}.java`,
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ])
    .join("\n");
  const tk = toolkit({ diff, resultBudgetChars: 120 });
  const result = await tk.executeTool("review.get_diff", {});
  const notice = result.split("\n").at(-1) as string;
  expect(notice).toBe(
    'Tool result truncated: showing 7 of 19 diff lines (tool result budget 120 chars exceeded; complete=false). ' +
      'Not fully expanded files: src/B.java, src/C.java; continue with review.get_file(path="src/B.java").',
  );
});

test("get_diff 截断在文件内部：提示该文件可继续完整读取", async () => {
  const diff = ["A", "B"]
    .flatMap((name) => [
      `diff --git a/src/${name}.java b/src/${name}.java`,
      `--- a/src/${name}.java`,
      `+++ b/src/${name}.java`,
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ])
    .join("\n");
  // 预算够到第二个文件的 diff 头、但不够读完该文件 → 该文件列为未完全展开
  const tk = toolkit({ diff, resultBudgetChars: 170 });
  const result = await tk.executeTool("review.get_diff", {});
  expect(result).toContain(
    'Not fully expanded files: src/B.java; continue with review.get_file(path="src/B.java").',
  );
  expect(result).toContain("diff --git a/src/B.java");
});

test("Tool Profile：生产缺省 core-5；单语料映射；内部 override 可强制 extended-7", async () => {
  const base = toolkit();
  expect(base.toolProfile).toBe("core-5");
  expect(base.toolProfileSource).toBe("derived");
  expect(base.schemas.map((schema) => schema.name)).toEqual([
    "review.get_diff",
    "review.get_symbol",
    "review.get_file",
    "review.find_references",
    "review.get_call_chain",
  ]);

  const rule = buildReviewToolkit({
    repoPath: SAMPLE,
    diff: SAMPLE_DIFF,
    knowledge: { rules: [{ id: "R-1", title: "Rule", text: "body" }] },
  });
  expect(rule.toolProfile).toBe("core-5+rule");
  expect(rule.schemas.map((schema) => schema.name)).toContain("review.search_rule");
  expect(rule.schemas.map((schema) => schema.name)).not.toContain("review.search_history");

  const history = buildReviewToolkit({
    repoPath: SAMPLE,
    diff: SAMPLE_DIFF,
    knowledge: { history: [{ id: "H-1", title: "History", text: "body" }] },
  });
  expect(history.toolProfile).toBe("core-5+history");

  const both = buildReviewToolkit({
    repoPath: SAMPLE,
    diff: SAMPLE_DIFF,
    knowledge: {
      rules: [{ id: "R-1", title: "Rule", text: "body" }],
      history: [{ id: "H-1", title: "History", text: "body" }],
    },
  });
  expect(both.toolProfile).toBe("extended-7");

  // 内部 override：即便无语料也可强制 extended-7（评测消融缝）
  const override = buildReviewToolkit({
    repoPath: SAMPLE,
    diff: SAMPLE_DIFF,
    toolProfileOverride: "extended-7",
  });
  expect(override.toolProfile).toBe("extended-7");
  expect(override.toolProfileSource).toBe("override");
  expect(override.schemas).toHaveLength(7);

  // 非 profile 工具不可执行：core-5 下 search 工具不存在
  await expect(base.executeTool("review.search_rule", { query: "x" })).rejects.toThrow(
    /unknown tool "review.search_rule"/,
  );
  await expect(override.executeTool("review.search_rule", { query: "x" })).resolves.toContain(
    "corpus is empty",
  );
});

test("Tool Profile：同一 run 内固定；重复组装字节稳定且顺序为注册表子序列", () => {
  const first = toolkit();
  const second = toolkit();
  expect(first.toolProfile).toBe(second.toolProfile);
  expect(JSON.stringify(first.schemas)).toBe(JSON.stringify(second.schemas));
  const registry = REVIEW_TOOL_ORDER as readonly string[];
  let cursor = 0;
  for (const schema of first.schemas) {
    while (cursor < registry.length && registry[cursor] !== schema.name) {
      cursor += 1;
    }
    expect(cursor).toBeLessThan(registry.length);
    cursor += 1;
  }
});

test("Ledger 送达感知：精确重复命中引用、不同请求不命中、失败不登记", async () => {
  const tk = toolkit();
  const args = { path: "src/main/java/com/example/Alpha.java", startLine: 11, endLine: 13 };
  const first = await tk.executeTool("review.get_file", args);
  expect(first).toContain("Lines 11-13 of 18");
  // 精确重复（规范化请求标识相同）→ 引用而非原文（含请求/送达范围与 complete）
  await expect(tk.executeTool("review.get_file", args)).resolves.toBe(
    "Already loaded: ctx#001 (review.get_file src/main/java/com/example/Alpha.java:11-13; delivered lines 11-13 of requested lines 11-13; complete=true)",
  );
  // 不同区间（即使内容重叠）不命中——新登记
  const second = await tk.executeTool("review.get_file", {
    path: "src/main/java/com/example/Alpha.java",
    startLine: 11,
    endLine: 14,
  });
  expect(second).toContain("Lines 11-14 of 18");
  await expect(
    tk.executeTool("review.get_file", {
      path: "src/main/java/com/example/Alpha.java",
      startLine: 11,
      endLine: 14,
    }),
  ).resolves.toBe(
    "Already loaded: ctx#002 (review.get_file src/main/java/com/example/Alpha.java:11-14; delivered lines 11-14 of requested lines 11-14; complete=true)",
  );
  // 读取失败不登记（重试仍走真实读取路径，错误形态不变）
  await expect(tk.executeTool("review.get_file", { path: "no/such/file.java" })).rejects.toThrow(
    /cannot be read/,
  );
  await expect(tk.executeTool("review.get_file", { path: "no/such/file.java" })).rejects.toThrow(
    /cannot be read/,
  );
  // 快照形态（审计留痕口径：请求/送达范围 + complete + 命中计数）
  expect(
    tk.ledger.snapshot().map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      description: entry.description,
      requestedRange: entry.requestedRange,
      deliveredRange: entry.deliveredRange,
      complete: entry.complete,
      hitCount: entry.hitCount,
    })),
  ).toEqual([
    {
      id: "ctx#001",
      kind: "range",
      description: "review.get_file src/main/java/com/example/Alpha.java:11-13",
      requestedRange: { startLine: 11, endLine: 13 },
      deliveredRange: { startLine: 11, endLine: 13 },
      complete: true,
      hitCount: 1,
    },
    {
      id: "ctx#002",
      kind: "range",
      description: "review.get_file src/main/java/com/example/Alpha.java:11-14",
      requestedRange: { startLine: 11, endLine: 14 },
      deliveredRange: { startLine: 11, endLine: 14 },
      complete: true,
      hitCount: 1,
    },
  ]);
  // 命中统计：2 次命中；未命中 = 2 次首读 + 2 次失败读取
  const stats = tk.ledger.stats();
  expect(stats.ledgerHits).toBe(2);
  expect(stats.ledgerMisses).toBe(4);
  expect(stats.savedCharsEstimate).toBeGreaterThan(0);
});

test("Ledger 送达感知：整文件完整送达后子区间命中并标注覆盖关系", async () => {
  const tk = toolkit();
  const whole = { path: "src/main/java/com/example/Alpha.java" };
  await tk.executeTool("review.get_file", whole);
  await expect(
    tk.executeTool("review.get_file", { ...whole, startLine: 11, endLine: 13 }),
  ).resolves.toBe(
    "Already loaded: ctx#001 (review.get_file src/main/java/com/example/Alpha.java:11-13; delivered lines 1-end of requested lines 11-13; complete=true)",
  );
  // 起点越过文件尾：整文件送达不覆盖 → 未命中，真实读取照常报 beyond end of file
  await expect(
    tk.executeTool("review.get_file", { ...whole, startLine: 999 }),
  ).rejects.toThrow(/requested start line 999 is beyond end of file/);
});

test("Ledger 送达感知：endLine 越界 clamp 不覆盖原请求；实际送达子区间命中且 complete=false", async () => {
  const tk = toolkit();
  const clampedArgs = { path: "src/main/java/com/example/Alpha.java", startLine: 15, endLine: 99 };
  const clamped = await tk.executeTool("review.get_file", clampedArgs);
  expect(clamped).toContain("(requested end line 99 clamped to end of file)");
  // 同一 clamp 请求未被覆盖 → 未命中，重读同字节
  await expect(tk.executeTool("review.get_file", clampedArgs)).resolves.toBe(clamped);
  // 实际送达区间（15-18）命中，引用如实标注 complete=false
  await expect(
    tk.executeTool("review.get_file", {
      path: "src/main/java/com/example/Alpha.java",
      startLine: 15,
      endLine: 18,
    }),
  ).resolves.toBe(
    "Already loaded: ctx#001 (review.get_file src/main/java/com/example/Alpha.java:15-18; delivered lines 15-18 of requested lines 15-18; complete=false)",
  );
});

test("Ledger 送达感知：截断读取不冒充整文件；已送达子区间命中且 complete=false", async () => {
  const tk = toolkit({ resultBudgetChars: 100 });
  const whole = { path: "src/main/java/com/example/Alpha.java" };
  const truncated = await tk.executeTool("review.get_file", whole);
  expect(truncated).toContain("Tool result truncated");
  const entry = tk.ledger.snapshot()[0];
  expect(entry?.complete).toBe(false);
  const deliveredEnd = entry?.deliveredRange?.endLine;
  if (deliveredEnd === undefined || deliveredEnd === null) {
    throw new Error("expected a concrete delivered range on the truncated read");
  }
  expect(deliveredEnd).toBeLessThan(18);

  // 整文件请求未被完整覆盖 → 未命中，重新执行（输出与首次逐字节一致）
  await expect(tk.executeTool("review.get_file", whole)).resolves.toBe(truncated);
  // 已送达前缀内的子区间 → 命中；引用如实标注 complete=false
  await expect(
    tk.executeTool("review.get_file", { ...whole, startLine: 1, endLine: deliveredEnd }),
  ).resolves.toBe(
    `Already loaded: ctx#001 (review.get_file src/main/java/com/example/Alpha.java:1-${deliveredEnd}; delivered lines 1-${deliveredEnd} of requested lines 1-${deliveredEnd}; complete=false)`,
  );
});

test("Ledger 送达感知：整结果工具完整送达命中；截断结果不命中且重读字节不变", async () => {
  const tk = toolkit();
  await tk.executeTool("review.get_diff", {});
  await expect(tk.executeTool("review.get_diff", {})).resolves.toBe(
    "Already loaded: ctx#001 (review.get_diff; delivered whole result of requested whole result; complete=true)",
  );

  const small = toolkit({ resultBudgetChars: 20 });
  const truncated = await small.executeTool("review.get_diff", {});
  expect(truncated).toContain("Tool result truncated");
  await expect(small.executeTool("review.get_diff", {})).resolves.toBe(truncated);
  // 截断送达范围与 complete 进账本：不冒充整结果
  const entry = small.ledger.snapshot()[0];
  expect(entry?.complete).toBe(false);
  expect(entry?.deliveredRange).toBeNull();
  expect(entry?.shownResultLines).toBeGreaterThan(0);
  expect(entry?.totalResultLines).toBeGreaterThan(entry?.shownResultLines ?? 0);
});

test("Ledger 功能态：整读（file）与区间读（range）分属不同登记；get_diff 登记为 evidence", async () => {
  const tk = toolkit();
  await tk.executeTool("review.get_file", { path: "src/main/java/com/example/Alpha.java" });
  await tk.executeTool("review.get_diff", {});
  await expect(tk.executeTool("review.get_diff", {})).resolves.toBe(
    "Already loaded: ctx#002 (review.get_diff; delivered whole result of requested whole result; complete=true)",
  );
  expect(tk.ledger.snapshot().map((entry) => entry.kind)).toEqual(["file", "evidence"]);
  expect(tk.ledger.snapshot()[0]?.deliveredRange).toEqual({ startLine: 1, endLine: null });
});

test("Ledger 原语：未登记不命中；register 后命中引用格式（去重单源）", () => {
  const ledger = createContextLedger();
  const request = {
    kind: "file",
    resourceKey: "review.get_file x",
    description: "review.get_file x",
    requestedRange: { startLine: 1, endLine: null },
  } as const;
  expect(ledger.referenceIfLoaded(request)).toBeUndefined();
  ledger.register(request, {
    content: "body",
    deliveredRange: { startLine: 1, endLine: null },
    complete: true,
  });
  expect(ledger.referenceIfLoaded(request)).toBe(
    "Already loaded: ctx#001 (review.get_file x; delivered lines 1-end of requested lines 1-end; complete=true)",
  );
});

test("executeTool：未知名为有界错误；生产 schema 面固定 core-5", async () => {
  const tk = toolkit();
  await expect(tk.executeTool("review.nope", {})).rejects.toThrow(
    /unknown tool "review.nope" \(available: review.get_diff, /,
  );
  expect(tk.schemas.map((schema) => schema.name)).toEqual([
    "review.get_diff",
    "review.get_symbol",
    "review.get_file",
    "review.find_references",
    "review.get_call_chain",
  ]);
  // 内部 override 下 schema 面为 extended-7（评测消融）
  const extended = buildReviewToolkit({
    repoPath: SAMPLE,
    diff: SAMPLE_DIFF,
    toolProfileOverride: "extended-7",
  });
  expect(extended.schemas.map((schema) => schema.name)).toEqual([
    "review.get_diff",
    "review.get_symbol",
    "review.get_file",
    "review.find_references",
    "review.get_call_chain",
    "review.search_rule",
    "review.search_history",
  ]);
});

test("只读纪律：七工具全调用后仓库内容哈希不变", async () => {
  function snapshotDirHash(root: string): string {
    const hash = createHash("sha256");
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        const full = path.join(dir, entry.name);
        hash.update(entry.name);
        if (entry.isDirectory()) {
          hash.update("dir\n");
          visit(full);
        } else if (entry.isFile()) {
          hash.update(`file ${statSync(full).size}\n`);
          hash.update(readFileSync(full));
        }
      }
    };
    visit(root);
    return hash.digest("hex");
  }

  const before = snapshotDirHash(SAMPLE);
  const tk = buildReviewToolkit({
    repoPath: SAMPLE,
    diff: SAMPLE_DIFF,
    toolProfileOverride: "extended-7",
  });
  // 每个工具真实执行一轮（含搜索类与 diff；override 暴露全部七工具）
  await tk.executeTool("review.get_diff", {});
  await tk.executeTool("review.get_symbol", { symbol: "Alpha" });
  await tk.executeTool("review.get_file", { path: "src/main/java/com/example/Beta.java" });
  await tk.executeTool("review.find_references", { symbol: "getBase" });
  await tk.executeTool("review.get_call_chain", { symbol: "getBase" });
  await tk.executeTool("review.search_rule", { query: "null" });
  await tk.executeTool("review.search_history", { query: "npe" });
  expect(snapshotDirHash(SAMPLE)).toBe(before);
});
