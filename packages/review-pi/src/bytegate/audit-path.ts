// P2 字节纪律门(#5)——auditPath 重定位(P0 采纳约定消费)。
//
// P0 采纳时 t-series 审计真源整树拷入本仓 runs/,RunRecord 体内的
// baseline.auditPath 仍指向 DSH 兄弟仓绝对路径(落盘原文,门不回写记录)。
// 本仓可移植运行约定:以路径中最后一个 "runs" 段为锚,尾部重接本仓 runs 根。

import path from "node:path";

/**
 * 把 RunRecord 记录的 DSH 绝对 auditPath 重定位到本仓 runs 根下。
 * 规则:路径按两种分隔符切分,取最后一个恰为 "runs" 的段,其后全部
 * 段(path.join)接在 runsRoot 之后。锚或尾部缺失 → 抛(fail fast,
 * 不允许静默指向错误真源)。
 */
export function relocateAuditPath(auditPath: string, runsRoot: string): string {
  const segments = auditPath.split(/[\\/]/).filter((segment) => segment !== "");
  const anchor = segments.lastIndexOf("runs");
  if (anchor === -1) {
    throw new Error(`auditPath has no "runs" path segment to relocate: ${auditPath}`);
  }
  const tail = segments.slice(anchor + 1);
  if (tail.length === 0) {
    throw new Error(`auditPath ends at the "runs" segment (no tail to relocate): ${auditPath}`);
  }
  return path.join(runsRoot, ...tail);
}
