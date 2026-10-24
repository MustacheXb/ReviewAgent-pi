#!/usr/bin/env node
/**
 * reviewagent 产品面 bin：加载自包含 bundle。
 *
 * bundle 内联 review-pi / review-llm / vendored pi 四包；仅
 * @vscode/ripgrep、web-tree-sitter、tree-sitter-java 以 npm 依赖随包安装，
 * 避免发布或解析 @earendil-works/pi-* 名称。
 */

import("../dist/cli.mjs").catch((error) => {
  process.stderr.write(
    `reviewagent: failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
