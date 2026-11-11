import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 评测面边界守卫（#37 / #39 AC / ADR-0016 §2/§4/§8）：
 * - 只读分析器零网络、零 LLM、零执行入口（纯读 RunRecord）；
 * - campaign runner 零网络、零真实执行入口（只经注入的 ReviewKernel 缝；
 *   真实网关 / judge 装配在 #40，fake 默认离线）；
 * - 生产入口（root src 非 eval 区 + review-pi 包）不得 import 评测面。
 *
 * 这是确定性 CI 的一部分：边界漂移在这里变红，而不是等评测面泄漏进生产。
 */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVAL_DIR = path.join(REPO_ROOT, "src", "eval");
const ANALYSIS_DIR = path.join(EVAL_DIR, "analysis");
const CAMPAIGN_DIR = path.join(EVAL_DIR, "campaign");

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

  it("生产入口不得 import 评测面（ADR-0016：评测面隔离）", () => {
    const roots = [path.join(REPO_ROOT, "src"), path.join(REPO_ROOT, "packages", "review-pi", "src")];
    for (const root of roots) {
      for (const file of listTsFiles(root)) {
        if (file.startsWith(EVAL_DIR)) {
          continue;
        }
        const source = readFileSync(file, "utf8");
        const relative = path.relative(REPO_ROOT, file);
        for (const plane of ["eval/analysis", "eval/campaign"]) {
          expect(source, `${relative} imports ${plane}`).not.toContain(plane);
        }
      }
    }
  });
});
