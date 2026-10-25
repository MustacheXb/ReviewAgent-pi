/**
 * #31 测试助手：spawn 真 HTTP server（dist 编译入口，不经 bin 壳）+ 就绪
 * 轮询 + 关闭等待——restart.process / drain.process 两处同形实现的收拢单源。
 *
 * spawn 直指 dist 编译入口的理由（#30 实证）：bin 的非 rpc 分支是
 * spawnSync——对壳发信号只杀 bin 壳会留下 server 真身孤儿（Windows 孙进程
 * 幸存面）；直杀真身才是信号 / 崩溃语义。
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { CLI_COMPILED_ENTRY } from "../../bin/lib/cli-runtime.js";

export interface ReviewServerProcess {
  readonly baseUrl: string;
  /** 累计 stderr（哨兵扫描面） */
  readonly stderr: () => string;
  /** 发信号（崩溃语义用 SIGKILL；优雅退出用 SIGTERM——POSIX 门控） */
  readonly kill: (signal: NodeJS.Signals) => void;
  readonly waitForClose: (
    timeoutMs: number,
  ) => Promise<{ status: number | null; signal: NodeJS.Signals | null }>;
}

export interface SpawnReviewServerOptions {
  readonly repoRoot: string;
  readonly dataDir: string;
  readonly tokenFile: string;
  readonly port: number;
  /** stub 网关（REVIEWER_URL 注入面；fail-fast 用例给不可达回环即可——启动期只解析不连接） */
  readonly stubBaseUrl: string;
  /** 追加 node 旗标（fail-fast 面注入 --no-experimental-sqlite） */
  readonly extraNodeArgs?: readonly string[];
  /** 追加 server 旗标（--executor / --concurrency 等夹具面） */
  readonly extraServerArgs?: readonly string[];
  /** 环境变量注入面（哨兵 key 等必给项之上的增量） */
  readonly env?: Record<string, string>;
}

/** spawn 真 server 并收 stderr；close 结果缓存 + 等待者广播（waitForClose 幂等可重入） */
export function spawnReviewServer(options: SpawnReviewServerOptions): ReviewServerProcess {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      ...(options.extraNodeArgs ?? []),
      CLI_COMPILED_ENTRY,
      "server",
      "--auth-token-file",
      options.tokenFile,
      "--host",
      "127.0.0.1",
      "--port",
      String(options.port),
      "--data-dir",
      options.dataDir,
      ...(options.extraServerArgs ?? []),
    ],
    {
      cwd: options.repoRoot,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let closeInfo: { status: number | null; signal: NodeJS.Signals | null } | undefined;
  const closeWaiters: Array<(info: { status: number | null; signal: NodeJS.Signals | null }) => void> = [];
  child.on("close", (status, signal) => {
    closeInfo = { status, signal };
    for (const waiter of closeWaiters.splice(0)) {
      waiter(closeInfo);
    }
  });
  return {
    baseUrl: `http://127.0.0.1:${options.port}`,
    stderr: () => stderr,
    kill: (signal) => {
      child.kill(signal);
    },
    waitForClose(timeoutMs) {
      if (closeInfo !== undefined) {
        return Promise.resolve(closeInfo);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = closeWaiters.indexOf(settled);
          if (index !== -1) {
            closeWaiters.splice(index, 1);
          }
          reject(new Error(`server did not exit within ${timeoutMs}ms; stderr tail: ${stderr.slice(-500)}`));
        }, timeoutMs);
        const settled = (info: { status: number | null; signal: NodeJS.Signals | null }): void => {
          clearTimeout(timer);
          resolve(info);
        };
        closeWaiters.push(settled);
      });
    },
  };
}

/** 轮询 healthz 就绪（匿名 liveness；上限防挂） */
export async function waitForHealthz(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      // body 必须消费：未读 body 的 keep-alive 连接在 server 视角非 idle
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 200) {
        return;
      }
    } catch {
      // 未就绪（ECONNREFUSED）——继续轮询
    }
    if (Date.now() > deadline) {
      throw new Error(`server ${baseUrl} not healthy within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
