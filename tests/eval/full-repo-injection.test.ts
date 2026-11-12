import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FULL_REPO_BUDGET_CHARS,
  buildFullRepoInjection,
  loadRepoSnapshot,
} from "../../src/eval/ref/full-repo.js";

/**
 * C_ref 全仓注入 seam（#43）：确定性排序 / 80k 预算 / 整文件优先 /
 * 行级截断 / 显式截断提示 / FullRepoRecord。零网络、零 LLM。
 */

const SAMPLE = path.join(__dirname, "testdata", "full-repo", "sample");
const GOLDEN = path.join(__dirname, "testdata", "golden", "full-repo-sample.txt");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadRepoSnapshot", () => {
  it("只列 .java、排序 POSIX 路径，排除 .git / target / 非 Java", async () => {
    const snapshot = await loadRepoSnapshot(SAMPLE);
    expect(snapshot.javaFiles).toEqual([
      "src/main/java/com/example/Alpha.java",
      "src/main/java/com/example/Beta.java",
      "src/main/java/com/example/nested/Gamma.java",
    ]);
  });

  it("创建顺序不影响排序（Z → A → M 仍按路径序）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "full-repo-order-"));
    tempDirs.push(dir);
    for (const name of ["Zeta", "Alpha", "Mu"]) {
      const file = path.join(dir, "src", `${name}.java`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `class ${name} {}\n`, "utf8");
    }
    const snapshot = await loadRepoSnapshot(dir);
    expect(snapshot.javaFiles).toEqual(["src/Alpha.java", "src/Mu.java", "src/Zeta.java"]);
  });

  it("运行时创建 .git / target 目录也被排除", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "full-repo-skip-"));
    tempDirs.push(dir);
    for (const relative of [".git/x/Hidden.java", "target/Generated.java", "src/Keep.java"]) {
      const file = path.join(dir, ...relative.split("/"));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "class X {}\n", "utf8");
    }
    const snapshot = await loadRepoSnapshot(dir);
    expect(snapshot.javaFiles).toEqual(["src/Keep.java"]);
  });
});

describe("buildFullRepoInjection", () => {
  it("充足预算：与 golden bytes 逐字节一致，无截断提示", async () => {
    const snapshot = await loadRepoSnapshot(SAMPLE);
    const injection = await buildFullRepoInjection({
      repo: snapshot,
      budgetChars: 100_000,
    });
    const expected = (await readFile(GOLDEN, "utf8"))
      .replaceAll("\r\n", "\n")
      .replace(/\n$/, "");

    expect(injection.message).toEqual({ role: "user", content: expected });
    expect(injection.record).toEqual({
      budgetChars: 100_000,
      contentChars: expected.length,
      truncated: false,
      totalFiles: 3,
      shownFiles: 3,
      omittedFiles: [],
      partialFile: null,
    });
  });

  it("同仓重复构建字节稳定（确定性）", async () => {
    const snapshot = await loadRepoSnapshot(SAMPLE);
    const first = await buildFullRepoInjection({ repo: snapshot, budgetChars: 80_000 });
    const second = await buildFullRepoInjection({ repo: snapshot, budgetChars: 80_000 });
    expect(second).toEqual(first);
  });

  it("小预算：整文件优先 + 行级截断留痕 + 显式截断总提示", async () => {
    const snapshot = await loadRepoSnapshot(SAMPLE);
    const injection = await buildFullRepoInjection({ repo: snapshot, budgetChars: 500 });
    const content = injection.message.content;

    // Alpha 整装，Beta 整装；Gamma 装不下整文件 → 行级截断尾块或停止
    expect(content).toContain("## File: src/main/java/com/example/Alpha.java (5 lines)");
    expect(content).toContain("## File: src/main/java/com/example/Beta.java (5 lines)");
    const notice = content.split("\n").at(-1) as string;
    expect(notice).toMatch(
      /^Full repository context truncated: showing \d of 3 files \(budget 500 chars exceeded\)\./,
    );
    expect(notice).toMatch(/Gamma\.java/);
    expect(injection.record).toMatchObject({
      budgetChars: 500,
      truncated: true,
      totalFiles: 3,
    });
    expect(injection.record.shownFiles).toBeGreaterThanOrEqual(1);
    expect(injection.record.shownFiles).toBeLessThan(3);
    expect(injection.record.contentChars).toBe(content.length);
    // 预算守卫：超出预算只是截断提示的固定开销，规模有界
    expect(content.length).toBeLessThan(500 + 1_000);
  });

  it("默认预算为 80,000 chars", () => {
    expect(DEFAULT_FULL_REPO_BUDGET_CHARS).toBe(80_000);
  });

  it("尾文件行级截断也算 truncated，并带两侧显式提示", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "full-repo-partial-"));
    tempDirs.push(dir);
    const file = path.join(dir, "A.java");
    await writeFile(
      file,
      ["class A {", ...Array.from({ length: 10 }, (_, i) => `  int f${i} = ${i};`), "}"]
        .join("\n") + "\n",
      "utf8",
    );
    const snapshot = await loadRepoSnapshot(dir);
    const injection = await buildFullRepoInjection({ repo: snapshot, budgetChars: 320 });
    const content = injection.message.content;

    expect(content).toContain("(file truncated; full-repo budget exceeded)");
    expect(content).toMatch(/^Full repository context truncated: showing 1 of 1 files/m);
    expect(injection.record).toMatchObject({
      budgetChars: 320,
      truncated: true,
      totalFiles: 1,
      shownFiles: 1,
      omittedFiles: [],
      partialFile: "A.java",
    });
  });

  it("未注入文件清单进入 record（机读，不只藏在文本里）", async () => {
    const snapshot = await loadRepoSnapshot(SAMPLE);
    const injection = await buildFullRepoInjection({ repo: snapshot, budgetChars: 400 });

    expect(injection.record.omittedFiles).toEqual([
      "src/main/java/com/example/Beta.java",
      "src/main/java/com/example/nested/Gamma.java",
    ]);
    expect(injection.record.partialFile).toBeNull();
  });

  it("截断输出与 golden bytes 逐字节一致（预算 400）", async () => {
    const snapshot = await loadRepoSnapshot(SAMPLE);
    const injection = await buildFullRepoInjection({ repo: snapshot, budgetChars: 400 });
    const expected = (
      await readFile(
        path.join(__dirname, "testdata", "golden", "full-repo-sample-truncated-400.txt"),
        "utf8",
      )
    )
      .replaceAll("\r\n", "\n")
      .replace(/\n$/, "");

    expect(injection.message.content).toBe(expected);
  });

  it("空仓库：显式零文件留痕，不静默丢弃", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "full-repo-empty-"));
    tempDirs.push(dir);
    const snapshot = await loadRepoSnapshot(dir);
    const injection = await buildFullRepoInjection({
      repo: snapshot,
      budgetChars: DEFAULT_FULL_REPO_BUDGET_CHARS,
    });

    expect(injection.record).toEqual({
      budgetChars: 80_000,
      contentChars: injection.message.content.length,
      truncated: false,
      totalFiles: 0,
      shownFiles: 0,
      omittedFiles: [],
      partialFile: null,
    });
    expect(injection.message.content).toContain("No Java files found in the repository snapshot.");
  });
});
