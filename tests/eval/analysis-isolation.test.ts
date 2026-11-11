import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 评测面边界守卫（#37 / #39 / #40 AC / ADR-0016 §2/§4/§8）：
 * - 只读分析器零网络、零 LLM、零执行入口（纯读 RunRecord）；
 * - campaign runner 零网络、零真实执行入口（只经注入的 ReviewKernel /
 *   JudgeClient 缝；真实网关 / judge 装配在 src/eval/assembly，fake 默认离线）；
 * - 真实装配面（eval/judge + eval/assembly）由进程入口在环境变量门控后调用；
 * - 生产入口（root src 非 eval 区 + review-pi 包）不得 import 任何评测面。
 *
 * 这是确定性 CI 的一部分：边界漂移在这里变红，而不是等评测面泄漏进生产。
 */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVAL_DIR = path.join(REPO_ROOT, "src", "eval");
const ANALYSIS_DIR = path.join(EVAL_DIR, "analysis");
const CAMPAIGN_DIR = path.join(EVAL_DIR, "campaign");
const JUDGE_DIR = path.join(EVAL_DIR, "judge");
const ASSEMBLY_DIR = path.join(EVAL_DIR, "assembly");

const FORBIDDEN_ANALYSIS_RUNTIME = [
  "node:http",
  "node:https",
  "node:net",
  "node:dns",
  "node:fs",
  "node:child_process",
  "node:os",
  "XMLHttpRequest",
  "fetch(",
  "import(",
  "runReview",
  "judgeRun",
  "review-llm",
];

/** campaign 需要 fs / crypto 落盘；仍禁止网络与真实执行入口 */
const FORBIDDEN_CAMPAIGN_RUNTIME = [
  "node:http",
  "node:https",
  "node:net",
  "node:dns",
  "node:child_process",
  "XMLHttpRequest",
  "fetch(",
  "import(",
  "runReview",
  "judgeRun",
  "review-llm",
  "pi-kernel",
];

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function assertNoRuntime(root: string, forbidden: readonly string[]): void {
  for (const file of listTsFiles(root)) {
    const source = readFileSync(file, "utf8");
    const relative = path.relative(REPO_ROOT, file);
    for (const token of forbidden) {
      expect(source, `${relative} must not contain ${token}`).not.toContain(token);
    }
  }
}

function assertImportShape(root: string, allowNodeBuiltins: boolean): void {
  const specifierPattern = /(?:from|import)\s+"([^"]+)"/g;
  for (const file of listTsFiles(root)) {
    const source = readFileSync(file, "utf8");
    const relative = path.relative(REPO_ROOT, file);
    for (const match of source.matchAll(specifierPattern)) {
      const specifier = match[1] ?? "";
      if (specifier.startsWith(".")) {
        continue;
      }
      if (allowNodeBuiltins && specifier.startsWith("node:")) {
        continue;
      }
      const isTypeOnlyReviewPi =
        specifier === "review-pi" && /import\s+type\s+\{[^}]*\}\s+from\s+"review-pi"/s.test(source);
      expect(isTypeOnlyReviewPi, `${relative} imports ${JSON.stringify(specifier)}`).toBe(true);
    }
  }
}

describe("评测面边界", () => {
  it("只读分析器源码零网络 / 零 LLM / 零执行入口", () => {
    assertNoRuntime(ANALYSIS_DIR, FORBIDDEN_ANALYSIS_RUNTIME);
  });

  it("只读分析器 import 只允许相对模块与 review-pi type-only", () => {
    assertImportShape(ANALYSIS_DIR, false);
  });

  it("campaign runner 源码零网络 / 零真实执行入口（fs 落盘除外）", () => {
    assertNoRuntime(CAMPAIGN_DIR, FORBIDDEN_CAMPAIGN_RUNTIME);
  });

  it("campaign runner import 只允许相对模块、node 内置与 review-pi type-only", () => {
    assertImportShape(CAMPAIGN_DIR, true);
  });

  it("campaign 核心不得 import judge / assembly（真实装配只在进程入口）", () => {
    const specifierPattern = /(?:from|import)\s+"([^"]+)"/g;
    for (const file of listTsFiles(CAMPAIGN_DIR)) {
      const source = readFileSync(file, "utf8");
      const relative = path.relative(REPO_ROOT, file);
      for (const match of source.matchAll(specifierPattern)) {
        const specifier = match[1] ?? "";
        if (!specifier.startsWith(".")) {
          continue;
        }
        const resolved = path.resolve(path.dirname(file), specifier);
        for (const [plane, dir] of [
          ["eval/judge", JUDGE_DIR],
          ["eval/assembly", ASSEMBLY_DIR],
        ] as const) {
          expect(resolved.startsWith(dir), `${relative} imports ${plane}`).toBe(false);
        }
      }
    }
  });

  it("judge / assembly 目录在评测面落位（真实装配面存在）", () => {
    for (const dir of [JUDGE_DIR, ASSEMBLY_DIR]) {
      expect(listTsFiles(dir).length).toBeGreaterThan(0);
    }
  });

  it("生产入口不得 import 评测面（ADR-0016：评测面隔离）", () => {
    const roots = [path.join(REPO_ROOT, "src"), path.join(REPO_ROOT, "packages", "review-pi", "src")];
    for (const root of roots) {
      for (const file of listTsFiles(root)) {
        if (file.startsWith(EVAL_DIR)) {
          continue;
        }
        const source = readFileSync(file, "utf8");
        const relative = path.relative(REPO_ROOT, file);
        for (const plane of ["eval/analysis", "eval/campaign", "eval/judge", "eval/assembly"]) {
          expect(source, `${relative} imports ${plane}`).not.toContain(plane);
        }
      }
    }
  });
});
