#!/usr/bin/env node
/**
 * #7 review-pi 产品面 bin：薄到只做四件事——在位检查（内核构建产物存在）+
 * mtime 新鲜度门（产物过期即拒跑并给人话提示，不自动重编——与 DSH 线 bin
 * 的重编语义有意分家，见 bin/lib/cli-runtime.js）+ argv 透传 + 退出码透传。
 * 检视行为本体全部在内核（packages/review-pi dist/cli/main.js）。
 *
 * 退出码：拒跑 1 / 其余透传 CLI 主缝（成功 0 / 失败 1 / 截断 0；
 * rpc 长驻另有 130/143/129 信号码，spec #21 §1）。
 *
 * rpc 子命令（#24 S3）走异步 spawn + SIGINT/SIGTERM 转发：spawnSync 阻塞
 * 父进程、无法转发信号，长驻子进程的中断语义不可控。转发在 POSIX 上精确
 * （内核捕获信号后 drain 退出 130/143）；Windows 上 kill() 语义为硬杀
 * （无控制台信号），宿主优雅退出走 stdin EOF（client.ts stop() 同款）。
 * review / smoke / disposition 维持 spawnSync 零改动。
 */

import { spawn, spawnSync } from "node:child_process";

import { CLI_COMPILED_ENTRY, checkRuntimeArtifacts, renderRefusals } from "./lib/cli-runtime.js";

/** close 事件 code=null 且带信号（子进程未捕获即死）时按 128+信号号镜像 */
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

const check = checkRuntimeArtifacts();
if (!check.ok) {
  process.stderr.write(renderRefusals(check.refusals));
  process.exit(1);
}

const argv = process.argv.slice(2);

if (argv[0] === "rpc") {
  const child = spawn(process.execPath, [CLI_COMPILED_ENTRY, ...argv], { stdio: "inherit" });
  // 转发而非自行退出：等内核 drain（close）后按其退出码退——转发与子进程
  // 自身收到的信号（共享控制台场景）都到达时 drain 幂等，无双重退出风险
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  // SIGHUP 仅 POSIX（win32 无此信号，kill() 硬杀）：终端挂断时让内核按
  // 129 语义 drain，而非 bin 默认死亡留下服务端孤儿窗口
  if (process.platform !== "win32") {
    process.on("SIGHUP", () => child.kill("SIGHUP"));
  }
  child.on("error", (error) => {
    process.stderr.write(`reviewagent: failed to spawn the CLI runtime: ${error.message}\n`);
    process.exit(1);
  });
  child.on("close", (code, signal) => {
    process.exit(code ?? (signal !== null ? (SIGNAL_EXIT_CODES[signal] ?? 1) : 1));
  });
} else {
  const run = spawnSync(process.execPath, [CLI_COMPILED_ENTRY, ...argv], {
    stdio: "inherit",
  });
  if (run.error !== undefined) {
    process.stderr.write(`reviewagent: failed to spawn the CLI runtime: ${run.error.message}\n`);
    process.exit(1);
  }
  process.exit(run.status ?? 1);
}
