import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 只读分析器边界守卫（#37 AC / ADR-0016 §2/§4）：
 * - 分析器目录零网络、零 LLM、零执行入口（纯读 RunRecord）；
 * - 生产入口（root src 非 eval 区 + review-pi 包）不得 import 分析器。
 *
 * 这是确定性 CI 的一部分：边界漂移在这里变红，而不是等评测面泄漏进生产。
 */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ANALYSIS_DIR = path.join(REPO_ROOT, "src", "eval", "analysis");

const FORBIDDEN_RUNTIME = [
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

describe("只读分析器边界", () => {
  it("分析器源码零网络 / 零 LLM / 零执行入口", () => {
    for (const file of listTsFiles(ANALYSIS_DIR)) {
      const source = readFileSync(file, "utf8");
      const relative = path.relative(REPO_ROOT, file);
      for (const token of FORBIDDEN_RUNTIME) {
        expect(source, `${relative} must not contain ${token}`).not.toContain(token);
      }
    }
  });

  it("分析器 import 只允许相对模块与 review-pi type-only", () => {
    const specifierPattern = /(?:from|import)\s+"([^"]+)"/g;
    for (const file of listTsFiles(ANALYSIS_DIR)) {
      const source = readFileSync(file, "utf8");
      const relative = path.relative(REPO_ROOT, file);
      for (const match of source.matchAll(specifierPattern)) {
        const specifier = match[1] ?? "";
        if (specifier.startsWith(".")) {
          continue;
        }
        const isTypeOnlyReviewPi =
          specifier === "review-pi" && /import\s+type\s+\{[^}]*\}\s+from\s+"review-pi"/s.test(source);
        expect(isTypeOnlyReviewPi, `${relative} imports ${JSON.stringify(specifier)}`).toBe(true);
      }
    }
  });

  it("生产入口不得 import 分析器（ADR-0016：评测面隔离）", () => {
    const roots = [path.join(REPO_ROOT, "src"), path.join(REPO_ROOT, "packages", "review-pi", "src")];
    for (const root of roots) {
      for (const file of listTsFiles(root)) {
        if (file.startsWith(ANALYSIS_DIR)) {
          continue;
        }
        const source = readFileSync(file, "utf8");
        expect(source, `${path.relative(REPO_ROOT, file)} imports eval/analysis`).not.toContain(
          "eval/analysis",
        );
      }
    }
  });
});
