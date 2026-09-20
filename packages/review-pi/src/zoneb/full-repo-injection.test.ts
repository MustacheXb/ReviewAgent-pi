import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";
import { VUL4J_1_SNAPSHOT } from "../testing/vul4j1-script.js";
import { loadRepoContext } from "./repo-context.js";
import {
  DEFAULT_FULL_REPO_BUDGET_CHARS,
  buildFullRepoInjection,
} from "./full-repo-injection.js";

// config C 全仓注入测试（#6 P3a）：预算守卫（前锋装填 + 行级截断留痕 +
// 截断总提示）与确定性；VUL4J-1 快照上与 DSH t-series C 审计真源逐字节
// 对齐（快照缺席跳过）。

test("小预算：前锋装填 + 行级截断尾块 + 截断总提示（留痕可见）", async () => {
  const repo = await loadRepoContext(repoFixturePath("sample"));
  // sample = 3 个 Java 文件；预算压到只装得下第一个文件的一部分
  const injection = await buildFullRepoInjection({ repo, budgetChars: 600 });
  const { message, record } = injection;
  expect(message.role).toBe("user");

  const content = message.content;
  expect(content).toContain("Full repository context (config C).");
  // 第一个文件（排序路径序 = Alpha）整装或截断装入
  expect(content).toContain("## File: src/main/java/com/example/Alpha.java");
  // 截断总提示 + 未注入清单（Beta/Gamma 列名）
  const tail = content.split("\n").at(-1) as string;
  expect(tail).toMatch(
    /^Full repository context truncated: showing 1 of 3 files \(budget 600 chars exceeded\)\. Files not included: src\/main\/java\/com\/example\/(Beta|Gamma)\.java, src\/main\/java\/com\/example\/(Beta|Gamma)\.java$/,
  );
  expect(record).toEqual({
    budgetChars: 600,
    contentChars: content.length,
    truncated: true,
    totalFiles: 3,
    shownFiles: 1,
  });
  // 预算守卫：内容超出预算的规模有界（截断提示行 + 行级尾块留痕不计入装填）
  expect(content.length).toBeGreaterThan(600);
});

test("充足预算：全部装入、无截断提示、record 截断位为 false", async () => {
  const repo = await loadRepoContext(repoFixturePath("sample"));
  const { message, record } = await buildFullRepoInjection({ repo, budgetChars: 100_000 });
  expect(message.content).toContain("## File: src/main/java/com/example/Alpha.java");
  expect(message.content).toContain("## File: src/main/java/com/example/Beta.java");
  expect(message.content).toContain("## File: src/main/java/com/example/Gamma.java");
  expect(message.content).not.toContain("Full repository context truncated:");
  expect(message.content).not.toContain("(file truncated; full-repo budget exceeded)");
  expect(record).toEqual({
    budgetChars: 100_000,
    contentChars: message.content.length,
    truncated: false,
    totalFiles: 3,
    shownFiles: 3,
  });
});

test("默认预算 80K；空仓库为显式零文件留痕", async () => {
  expect(DEFAULT_FULL_REPO_BUDGET_CHARS).toBe(80_000);
  // 空仓库：一个不含 Java 的目录（testdata/golden 目录本身）
  const repo = await loadRepoContext(repoFixturePath("../golden"));
  const { message, record } = await buildFullRepoInjection({
    repo,
    budgetChars: DEFAULT_FULL_REPO_BUDGET_CHARS,
  });
  expect(message.content).toBe(
    [
      "Full repository context (config C). Deterministically injected from the repository snapshot",
      "(zero-build, no LLM). Java source files are listed in sorted path order; budget truncation is explicit.",
      "No Java files found in the repository snapshot.",
    ].join("\n"),
  );
  expect(record).toEqual({
    budgetChars: 80_000,
    contentChars: message.content.length,
    truncated: false,
    totalFiles: 0,
    shownFiles: 0,
  });
});

test.skipIf(!existsSync(VUL4J_1_SNAPSHOT))(
  "VUL4J-1 真源对齐：80K 预算产出与 DSH C 审计逐字节一致",
  async () => {
    const repo = await loadRepoContext(VUL4J_1_SNAPSHOT);
    const { message, record } = await buildFullRepoInjection({
      repo,
      budgetChars: DEFAULT_FULL_REPO_BUDGET_CHARS,
    });
    // t-series C/rep-1 req0 messages[2]（fullRepo user 消息）逐字节一致
    expect(message.content).toBe(goldenFixture("fullrepo-content-vul4j-1.txt"));
    expect(record).toEqual({
      budgetChars: 80_000,
      contentChars: 81_314,
      truncated: true,
      totalFiles: 2_035,
      shownFiles: 7,
    });
  },
  300_000,
);
