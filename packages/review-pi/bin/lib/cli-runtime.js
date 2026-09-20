/**
 * review-pi CLI 运行时产物面（#7 P3b）：bin 的「在位检查 + mtime 新鲜度门」
 * 腿表与人话拒跑文案。纯 node 内建零依赖——bin 在 dist 可信之前运行，
 * 不能 import 任何构建产物（判鲜语义见同目录 compile-freshness.js）。
 *
 * 腿表 = dist/cli/main.js 导入图必需的全部运行时产物：本包 CLI 镜像 +
 * review-llm（冻结仪器常量单源）+ vendored pi 四包（ai / agent / chord /
 * telemetry——经 node_modules default 条件消费 dist）。后者是 vendored
 * 源码形态（无 prepare、构建显式执行），缺席/过期时 Node 的模块解析会在
 * 导入期秒死——在位检查必须覆盖全腿，不能只看本包产物。
 *
 * 与 DSH 线 bin 的有意分家：陈旧即拒跑并给人话提示（DSH 线 bin 自动重编）。
 * 拒跑消息携带每腿的构建命令，重建动作永远留给用户显式执行。
 */

import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { isCompileStale } from "./compile-freshness.js";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = join(packageDir, "..", "..");

/** 本包 CLI 编译入口（spawn 目标） */
export const CLI_COMPILED_ENTRY = join(packageDir, "dist", "cli", "main.js");

/** 运行时产物腿（label / 入口 / 源树 / 构建命令） */
export function runtimeLegs() {
  const leg = (label, packageRelativeDir, buildCommand) => {
    const legPackageDir = join(repoRoot, "packages", packageRelativeDir);
    return {
      label,
      entry: join(legPackageDir, "dist", "index.js"),
      sourceRoots: [join(legPackageDir, "src")],
      buildCommand,
    };
  };
  return [
    // vendored pi 四包：root 脚本按依赖序一次构建（telemetry → chord → ai → agent）
    leg("pi-ai (vendored)", "ai", "pnpm build:pi"),
    leg("pi-agent-core (vendored)", "agent", "pnpm build:pi"),
    leg("chord (vendored)", "chord", "pnpm build:pi"),
    leg("pi-telemetry (vendored)", "telemetry", "pnpm build:pi"),
    // 冻结仪器常量单源（prepare 在 pnpm install 时构建；源改后需重建）
    leg("review-llm", "review-llm", "pnpm --filter review-llm build"),
    // 本包 CLI 镜像（tsconfig.build.json：src → dist，测试面已排除）
    {
      label: "review-pi CLI",
      entry: CLI_COMPILED_ENTRY,
      sourceRoots: [join(packageDir, "src")],
      buildCommand: "pnpm --filter review-pi build",
    },
  ];
}

/** 在位 + 判鲜检查：任一腿缺席/过期即拒跑（全腿报告，一次给全） */
export function checkRuntimeArtifacts() {
  const refusals = [];
  for (const leg of runtimeLegs()) {
    if (!existsSync(leg.entry)) {
      refusals.push({ kind: "missing", ...leg });
    } else if (isCompileStale(leg.entry, leg.sourceRoots)) {
      refusals.push({ kind: "stale", ...leg });
    }
  }
  return refusals.length === 0 ? { ok: true } : { ok: false, refusals };
}

/** 拒跑文案（stderr）：每腿一行归因 + 一行构建指引；路径 repo 相对 POSIX 形态 */
export function renderRefusals(refusals) {
  const lines = [];
  for (const refusal of refusals) {
    const shown = relative(repoRoot, refusal.entry).split(sep).join("/");
    const cause =
      refusal.kind === "missing"
        ? `构建产物缺席: ${shown}`
        : `产物过期（源树新于产物）: ${shown}`;
    lines.push(`review-pi: 拒跑——${cause}（腿: ${refusal.label}）`);
    lines.push(`  先${refusal.kind === "missing" ? "构建" : "重建"}: ${refusal.buildCommand}`);
  }
  return `${lines.join("\n")}\n`;
}
