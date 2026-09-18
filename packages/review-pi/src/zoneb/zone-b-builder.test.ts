import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";
import { buildZoneB } from "./zone-b-builder.js";

// Zone B 静态构造器（测量常量面）：Repo Identity + Repo Map + Package Structure +
// Symbol Index（按变更文件所在包圈定）+ Project Rules。
// 确定性：同一仓库状态 + 同一变更文件集合 → 字节级相同输出。

const SAMPLE = repoFixturePath("sample");

test("buildZoneB：样本仓库全量渲染（字节级锁定）", async () => {
  const { content, record } = await buildZoneB({
    repoPath: SAMPLE,
    changedFiles: ["src/main/java/com/example/Beta.java"],
    budgetChars: 16_000,
  });
  expect(content).toBe(
    [
      "Repository context (Zone B). Statically and deterministically constructed from the repository",
      "snapshot (zero-build, no LLM). Identical repository state and scope produce byte-identical output.",
      "",
      "## Repo identity",
      "Repo name: sample",
      "Java files: 3",
      "Build file: maven (pom.xml)",
      "",
      "## Repo map (directory tree of Java sources)",
      "",
      "src/main/java/com/example/",
      "  Alpha.java",
      "  Beta.java",
      "  Gamma.java",
      "",
      "## Package structure",
      "",
      "(default package) (1 file(s))",
      "  src/main/java/com/example/Gamma.java",
      "com.example (2 file(s))",
      "  src/main/java/com/example/Alpha.java",
      "  src/main/java/com/example/Beta.java",
      "",
      "## Symbol index (signature level, no method bodies)",
      "Scope: packages of changed files (com.example)",
      "Parse failures: none",
      "",
      "src/main/java/com/example/Alpha.java (package com.example)",
      "  L3 public class Alpha",
      "    L5 private int base",
      "    L7 public Alpha(int base)",
      "    L11 public int getBase()",
      "    L15 public int doubled()",
      "src/main/java/com/example/Beta.java (package com.example)",
      "  L3 public class Beta",
      "    L5 public int combine(Alpha alpha, int factor)",
      "    L10 private int scale(int input)",
      "",
      "## Project rules",
      "No project-specific rules are configured in POC1 (zero-build static construction;",
      "project rule sources are out of scope for this phase).",
    ].join("\n"),
  );
  expect(record).toEqual({
    layer: "zone-b",
    budgetChars: 16_000,
    contentChars: content.length,
    truncated: false,
    totalEntries: 5,
    shownEntries: 5,
  });
});

test("buildZoneB：小预算下各节按 block 边界截断并留痕（提示行含实际预算）", async () => {
  const { content, record } = await buildZoneB({
    repoPath: SAMPLE,
    changedFiles: ["src/main/java/com/example/Beta.java"],
    budgetChars: 100,
  });
  expect(record.truncated).toBe(true);
  expect(record.totalEntries).toBe(5);
  expect(record.shownEntries).toBe(0);
  // map 预算 floor(100*0.4)=40、package floor(100*0.2)=20、
  // symbol floor(100*(1-0.4-0.2))=40（乘法舍入后为 40；
  // 16000 档才会出现 6399 的浮点下取整现象，见 VUL4J-1 黄金测试）
  expect(content).toContain(
    "Repo map truncated: showing 0 of 1 directory entries (zone B repo-map budget 40 chars exceeded).",
  );
  expect(content).toContain(
    "Package structure truncated: showing 0 of 2 package entries (zone B package-structure budget 20 chars exceeded).",
  );
  expect(content).toContain(
    "Symbol index truncated: showing 0 of 2 file entries (zone B symbol-index budget 40 chars exceeded).",
  );
});

test("buildZoneB：变更文件不在快照中时按路径推导包名圈定 scope", async () => {
  const { content } = await buildZoneB({
    repoPath: SAMPLE,
    changedFiles: ["src/main/java/com/example/Delta.java"],
    budgetChars: 16_000,
  });
  expect(content).toContain("Scope: packages of changed files (com.example)");
});

test("buildZoneB：默认包变更文件圈定默认包 scope（默认包渲染为 (default package)）", async () => {
  const { content } = await buildZoneB({
    repoPath: SAMPLE,
    changedFiles: ["src/main/java/com/example/Gamma.java"],
    budgetChars: 16_000,
  });
  expect(content).toContain("Scope: packages of changed files ()");
  expect(content).toContain("src/main/java/com/example/Gamma.java (package (default package))");
  expect(content).toContain("  L1 public class Gamma");
  expect(content).toContain("    L3 public static String label()");
  expect(content).not.toContain("Alpha.java (package");
});

test("buildZoneB：无变更文件 → scope 为空、Symbol Index 显式说明", async () => {
  const { content, record } = await buildZoneB({
    repoPath: SAMPLE,
    changedFiles: [],
    budgetChars: 16_000,
  });
  expect(content).toContain("Scope: (no changed files provided)");
  expect(content).toContain("No Java files found in scope.");
  expect(record.totalEntries).toBe(3);
  expect(record.truncated).toBe(false);
});

const VUL4J_1_SNAPSHOT = fileURLToPath(
  new URL("../../../../.cache/datasets/vul4j-repos/VUL4J-1-f5903fa564", import.meta.url),
);

test.skipIf(!existsSync(VUL4J_1_SNAPSHOT))(
  "buildZoneB：VUL4J-1 快照与 t 系列审计黄金字节一致（本地快照存在时）",
  async () => {
    const { content, record } = await buildZoneB({
      repoPath: VUL4J_1_SNAPSHOT,
      changedFiles: ["src/main/java/com/alibaba/fastjson/serializer/ObjectArrayCodec.java"],
      budgetChars: 16_000,
    });
    expect(content).toBe(goldenFixture("zone-b-vul4j-1.txt"));
    expect(record.layer).toBe("zone-b");
    expect(record.budgetChars).toBe(16_000);
    expect(record.contentChars).toBe(14_754);
  },
);
