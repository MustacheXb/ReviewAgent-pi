import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// 主动缓存探针的边界护栏（#58 AC）：只作仓内手动脚本 + runbook——
// 不进 CI、不进产品 bin、不绕过 resolveReviewerEndpoint 读密钥。

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function read(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

it("缓存探针为仓内手动脚本 + runbook，且不进入 CI", () => {
  const script = read("scripts/probe-gateway-cache.ts");
  expect(script).toContain("REVIEWER_API_KEY");
  expect(script).toContain("resolveReviewerEndpoint");
  // 密钥只经角色解析器进入 Authorization；脚本自身不直接读环境变量
  expect(script).not.toContain("process.env");

  const runbook = read("docs/runbooks/cache-contract-probe.md");
  expect(runbook).toContain("手动");
  expect(runbook).toContain("不进 CI");

  const ci = read(".github/workflows/ci.yml");
  expect(ci).not.toContain("probe-gateway-cache");
  expect(ci).not.toContain("probe:gateway-cache");
});

it("缓存探针不进入产品 bin 面", () => {
  const reviewPiPackage = JSON.parse(read("packages/review-pi/package.json")) as {
    bin?: Record<string, string>;
    exports?: Record<string, unknown>;
  };
  expect(reviewPiPackage.bin).toEqual({ "review-pi": "./bin/review-pi.js" });
  expect(JSON.stringify(reviewPiPackage.exports)).not.toContain("probe");

  const rootPackage = JSON.parse(read("package.json")) as {
    bin?: Record<string, string>;
    scripts: Record<string, string>;
  };
  expect(rootPackage.bin).toBeUndefined();
  expect(rootPackage.scripts["probe:gateway-cache"]).toContain("probe-gateway-cache");
});
