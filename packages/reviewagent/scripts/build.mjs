import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

/**
 * reviewagent 自包含构建（做法 A）：
 * 1. 构建 vendored pi 四包 dist；
 * 2. 构建 review-llm / review-pi dist；
 * 3. esbuild 双入口 bundle：CLI 入口 → dist/cli.mjs；worker 池线程体入口 →
 *    dist/review-worker.mjs（#31 P3b——server 形态缺省 worker 执行器，线程体
 *    是独立加载面：worker-pool 缺省入口解析按「cli.mjs 旁 review-worker.mjs」
 *    探测，两产物必须同目录落位）；
 * 4. @vscode/ripgrep / web-tree-sitter / tree-sitter-java 保持 external，
 *    由本包 dependencies 在安装时随 npm 正常安装。
 *
 * 产物由 package.json 的 prepack 触发，pnpm pack 后只包含 bin/dist/声明。
 */

const packageDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const cliEntry = path.join(repoRoot, "packages", "review-pi", "src", "cli", "main.ts");
const workerEntry = path.join(repoRoot, "packages", "review-pi", "src", "rpc", "worker-entry.ts");
const outDir = path.join(packageDir, "dist");
const outFile = path.join(outDir, "cli.mjs");
const workerOutFile = path.join(outDir, "review-worker.mjs");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? "null"}`);
  }
}

mkdirSync(outDir, { recursive: true });

run("pnpm", ["build:pi"]);
run("pnpm", ["--filter", "review-llm", "build"]);
run("pnpm", ["--filter", "review-pi", "build"]);

// 双入口共用同一构建面（同 externals / banner / target）：CLI 与 worker 线程体
// 的依赖闭包同源（worker-entry ⊂ cli 依赖面），差异只在入口
const sharedBuildOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@vscode/ripgrep", "openai", "tree-sitter-java", "web-tree-sitter"],
  banner: {
    js: [
      'import { createRequire as __reviewagentCreateRequire } from "node:module";',
      "const require = __reviewagentCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
};

await build({
  ...sharedBuildOptions,
  entryPoints: [cliEntry],
  outfile: outFile,
});

// worker 线程体（#31）：server 形态缺省 worker 池从本文件 spawn 线程——
// pool 的缺省入口解析探测 cli.mjs 旁的 review-worker.mjs
await build({
  ...sharedBuildOptions,
  entryPoints: [workerEntry],
  outfile: workerOutFile,
});

for (const produced of [outFile, workerOutFile]) {
  if (!existsSync(produced)) {
    throw new Error(`esbuild did not produce ${produced}`);
  }
}

copyFileSync(
  path.join(repoRoot, "THIRD-PARTY-NOTICES.md"),
  path.join(packageDir, "THIRD-PARTY-NOTICES.md"),
);

for (const produced of [outFile, workerOutFile]) {
  process.stdout.write(`reviewagent bundle: ${produced} (${statSync(produced).size} bytes)\n`);
}
