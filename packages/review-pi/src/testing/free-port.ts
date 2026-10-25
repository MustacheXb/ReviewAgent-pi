/**
 * #30 测试助手：借端口法拿空闲端口（bind 0 → 读真分配值 → 释放；容忍
 * 微小竞态——释放与真 bind 间他人抢走的概率极低，抢到则 bind 报
 * EADDRINUSE fail fast，测试重跑即过）。
 *
 * 抽取动机：restart.process.test 与 server-pack-smoke.e2e 各自内联同款
 * net 探针——收拢单源。
 */

import { createServer } from "node:net";

export function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.once("error", reject);
  });
}
