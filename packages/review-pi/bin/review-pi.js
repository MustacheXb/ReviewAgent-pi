#!/usr/bin/env node
/**
 * #7 review-pi 产品面 bin：薄到只做四件事——在位检查（内核构建产物存在）+
 * mtime 新鲜度门（产物过期即拒跑并给人话提示，不自动重编——与 DSH 线 bin
 * 的重编语义有意分家，见 bin/lib/cli-runtime.js）+ argv 透传 + 退出码透传。
 * 检视行为本体全部在内核（packages/review-pi dist/cli/main.js）。
 *
 * 退出码：拒跑 1 / 其余透传 CLI 主缝（成功 0 / 失败 1 / 截断 0）。
 */

import { spawnSync } from "node:child_process";

import { CLI_COMPILED_ENTRY, checkRuntimeArtifacts, renderRefusals } from "./lib/cli-runtime.js";

const check = checkRuntimeArtifacts();
if (!check.ok) {
  process.stderr.write(renderRefusals(check.refusals));
  process.exit(1);
}

const run = spawnSync(process.execPath, [CLI_COMPILED_ENTRY, ...process.argv.slice(2)], {
  stdio: "inherit",
});
if (run.error !== undefined) {
  process.stderr.write(`review-pi: failed to spawn the CLI runtime: ${run.error.message}\n`);
  process.exit(1);
}
process.exit(run.status ?? 1);
