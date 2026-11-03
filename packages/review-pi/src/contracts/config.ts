// 配置合同（测量常量面）。
//
// #32 / ADR-0014（E-only 生产化）：内核配置矩阵 A–D 已根除——直驱六阶段循环
// （A/B）、确定性预取（B）、全仓注入（C）随研究装置退役，内核只剩工具驱动
// agentLoop + Context Ledger 的生产形态。值域随之塌缩：
// - ConfigId = "E"（生产写面：v3 起服务端/CLI 派生恒 E，配置不是用户输入）；
// - HistoricalConfigId = A–E（读面：历史 RunRecord / 处置库仍可载 A–D 记录，
//   回溯锚字段名不变——identity 键序纪律见 experiment/run-record.ts）。

/** 配置 id（生产值域：E 单值——驱动配置由内核派生，不再是调用方输入） */
export type ConfigId = "E";

/** 生产配置 id（单源常量；与 v3 协议派生、CLI/rpc 装配共用） */
export const CONFIG_E = "E" as const satisfies ConfigId;

/** 历史配置 id（读面值域：A–E 矩阵时期的 RunRecord / 处置条目仍可读） */
export type HistoricalConfigId = "A" | "B" | "C" | "D" | "E";

/** 历史值域注册表（读取侧校验单源：disposition validatedConfigId 消费） */
export const HISTORICAL_CONFIG_IDS: readonly HistoricalConfigId[] = ["A", "B", "C", "D", "E"];
