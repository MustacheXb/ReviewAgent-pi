/**
 * 配置 id 词汇契约（spec #1「五个实验配置 A–E」的历史读面）。
 *
 * #32 / ADR-0014（E-only 生产化）：A–D 研究配置（零工具 / 确定性预取 / 全仓
 * 注入 / 无账本工具驱动）已随评测装置根除——各配置行为差异的矩阵表
 * （ReviewConfig / CONFIGS）与外部参照伪配置位（REFERENCE_CONFIG_ID
 * "claude-code"）随研究线退役（全量记录见 Demo 线）；本契约仅保留 A–E
 * 词汇作为历史 RunRecord / MRCase.labels.allowedConfigs 等读面的类型宇宙。
 * 写面恒 "E"（服务端单源派生，协议 v3 无 configId 字段，ADR-0015）。
 */

/** 配置 id 词汇：历史 A–E 矩阵全集的读面；写面恒 "E"（内核单源派生） */
export type ConfigId = "A" | "B" | "C" | "D" | "E";
