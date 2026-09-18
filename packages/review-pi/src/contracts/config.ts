// 实验配置矩阵（测量常量面：configId 语义与 DSH 线 / 冻结判定链共享）。
// P1a 全链仅驱动 config B（零工具 + 确定性预取）；矩阵全量平移以保持
// configId 语义完整（RunRecord 消费方按此分组）。

export type ConfigId = "A" | "B" | "C" | "D" | "E";

export interface ReviewConfig {
  readonly configId: ConfigId;
  /** A/B = false（零工具）；C/D/E = true */
  readonly toolsEnabled: boolean;
  /** B = true：固定管线确定性预取（Diff → Symbol → Reference → Call Chain） */
  readonly prefetch: boolean;
  /** C = true：全仓注入 */
  readonly fullRepo: boolean;
  /** D/E = true：Zone A 稳定前缀纪律 */
  readonly stablePrefix: boolean;
  /** E = true：Context Ledger + Append-only */
  readonly ledger: boolean;
}

export const CONFIGS: Readonly<Record<ConfigId, ReviewConfig>> = {
  A: { configId: "A", toolsEnabled: false, prefetch: false, fullRepo: false, stablePrefix: false, ledger: false },
  B: { configId: "B", toolsEnabled: false, prefetch: true, fullRepo: false, stablePrefix: false, ledger: false },
  C: { configId: "C", toolsEnabled: true, prefetch: false, fullRepo: true, stablePrefix: false, ledger: false },
  D: { configId: "D", toolsEnabled: true, prefetch: false, fullRepo: false, stablePrefix: true, ledger: false },
  E: { configId: "E", toolsEnabled: true, prefetch: false, fullRepo: false, stablePrefix: true, ledger: true },
};
