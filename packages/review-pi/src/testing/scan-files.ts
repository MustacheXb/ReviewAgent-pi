import { readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";

/**
 * 递归收集目录下全部文件路径（哨兵纪律的落盘面扫描用——#7 起各进程级/契约
 * 测试同形实现，#31 收拢单源）。目录不存在 → 空数组（「零落盘」断言同径）。
 */
export function collectFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    let entries: readonly Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 竞态消失（清理中的目录）——已收集面为准
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  visit(root);
  return files;
}
