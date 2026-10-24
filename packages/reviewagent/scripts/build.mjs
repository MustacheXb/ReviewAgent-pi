import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

/**
 * reviewagent 自包含构建（做法 A）：
 * 1. 构建 vendored pi 四包 dist；
 * 2. 构建 review-llm / review-pi dist；
 * 3. esbuild 把 CLI 入口 bundle 成 dist/cli.mjs；
 * 4. @vscode/ripgrep / web-tree-sitter / tree-sitter-java 保持 external，
 *    由本包 dependencies 在安装时随 npm 正常安装。
 *
 * 产物由 package.json 的 prepack 触发，pnpm pack 后只包含 bin/dist/声明。
 */

const packageDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const cliEntry = path.join(repoRoot, "packages", "review-pi", "src", "cli", "main.ts");
const outDir = path.join(packageDir, "dist");
const outFile = path.join(outDir, "cli.mjs");

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

await build({
  entryPoints: [cliEntry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: outFile,
  external: ["@vscode/ripgrep", "openai", "tree-sitter-java", "web-tree-sitter"],
  banner: {
    js: [
      'import { createRequire as __reviewagentCreateRequire } from "node:module";',
      "const require = __reviewagentCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});

if (!existsSync(outFile)) {
  throw new Error(`esbuild did not produce ${outFile}`);
}

copyFileSync(
  path.join(repoRoot, "THIRD-PARTY-NOTICES.md"),
  path.join(packageDir, "THIRD-PARTY-NOTICES.md"),
);

const size = statSync(outFile).size;
process.stdout.write(`reviewagent bundle: ${outFile} (${size} bytes)\n`);
