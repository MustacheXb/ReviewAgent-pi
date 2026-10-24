import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, test } from "vitest";

// #28 边界测试（ADR-0013 决策 6：拓扑 B——HTTP 面落 review-pi `src/server/`
// 子树，不建独立包，内核隔离靠边界测试）：server 子树只经 rpc 端口面
// （executor / service / protocol / context）与 runReview 稳定面接触内核，
// 不触碰 harness / session / chord / 工具链 / 实验件——内核重写或重构时
// server 面是零改动证人。
//
// 口径：静态扫描 src/server/ 生产文件（.test.ts 除外——测试自由装配替身）
// 的 import 声明，目标必须落在白名单内。白名单缺席即拒绝（新增内核目录
// 自动被挡，不靠枚举黑名单）。

const serverDir = fileURLToPath(new URL(".", import.meta.url));
const srcRoot = path.resolve(serverDir, "..");

/** server 子树允许依赖的 src 内目标（目录前缀或单文件） */
const ALLOWED_IMPORT_TARGETS: readonly string[] = [
  "rpc", // 端口面：executor / service / protocol / context / main（RpcServerInfo）/ client（RpcResponseError）
  "contracts", // 配置矩阵真源
  "shared", // paths / env-local 等平台无关件
  "provider/reviewer-endpoint", // REVIEWER_* 启动期解析（单文件——不透 pi-client）
  "cli/args", // ServerCliArgs（类型面——与 rpc/main import RpcCliArgs 同款先例）
  "server", // 子树自身
];

function listProductionFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listProductionFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

/** import 说明符（from "..." / import "..."）→ 解析到 src 相对目标（node: / 裸包名原样） */
function collectImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function resolveSpecifier(fromFile: string, specifier: string): string {
  if (!specifier.startsWith(".")) {
    return specifier; // node: 内置 / 裸包名
  }
  const resolved = path.normalize(path.join(path.dirname(fromFile), specifier));
  const relative = path.relative(srcRoot, resolved).replaceAll("\\", "/");
  return relative.replace(/\.js$/, ""); // 编译目标 .js ↔ 源 .ts 同基名
}

test("server 子树 import 面白名单：生产文件零越界（内核只经 rpc 端口面接触）", () => {
  const files = listProductionFiles(serverDir);
  expect(files.length).toBeGreaterThan(0);

  const violations: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const specifier of collectImportSpecifiers(source)) {
      const target = resolveSpecifier(file, specifier);
      if (target.startsWith("node:")) {
        continue; // node 内置无限制
      }
      if (target.includes("/")) {
        // 子路径形态：白名单目录前缀，或白名单单文件（provider/cli 的窄口）
        const allowed =
          ALLOWED_IMPORT_TARGETS.some((prefix) => target.startsWith(`${prefix}/`)) ||
          ALLOWED_IMPORT_TARGETS.includes(target);
        if (!allowed) {
          violations.push(`${path.relative(srcRoot, file)} → ${target}`);
        }
      } else {
        // 裸包名（非 node:）：server 子树不引入任何 npm 运行时依赖
        violations.push(`${path.relative(srcRoot, file)} → ${target} (bare package)`);
      }
    }
  }
  expect(violations).toEqual([]);
});

test("白名单本身锁定端口面（清单漂移要有意识决策——防静默放宽）", () => {
  // 关键禁件直证：这些 src 顶层目录一旦出现在白名单，即违背 ADR-0013 决策 6
  for (const forbidden of [
    "run", // runReview 编排——server 只经 rpc/executor 端口
    "loop",
    "zonea",
    "zoneb",
    "tools",
    "finding",
    "codeintel",
    "bytegate",
    "experiment",
    "disposition",
    "audit",
    "gate",
    "presentation",
    "cli/main", // CLI 装配面（cli/args 类型面除外）
  ]) {
    expect(ALLOWED_IMPORT_TARGETS).not.toContain(forbidden);
  }
});
