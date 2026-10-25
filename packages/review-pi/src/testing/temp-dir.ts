/**
 * #30 测试助手：临时目录登记处（mkdtemp + 登记 + 统一清理）。
 *
 * 抽取动机：restart.process / store.contract / service.restart / idempotency
 * 等测试各自内联同款 `tempDirs 数组 + afterAll 循环 + Windows 句柄注释`——
 * 三份雷同即漂移温床（某份忘了 try/catch 就在 Windows 上间歇 FAIL）。
 * 存量测试文件（bin.process 等）不动，新测试面统一走本助手。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface TempDirRegistry {
  /** 建临时目录并登记（prefix 建议 `review-pi-<面>-` 形态，可辨识来源） */
  makeTempDir(prefix: string): string;
  /** 清空登记（afterAll / afterEach 调用；已清空幂等） */
  removeAll(): void;
}

export function createTempDirRegistry(): TempDirRegistry {
  const dirs: string[] = [];
  return {
    makeTempDir(prefix: string): string {
      const dir = mkdtempSync(path.join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    removeAll(): void {
      for (const dir of dirs.splice(0)) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Windows 句柄释放延迟（子进程死后 sqlite / 长连接文件）：tmp
          // 泄漏无害，不 FAIL suite
        }
      }
    },
  };
}
