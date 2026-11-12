/**
 * Tool Profile 契约（#52 / ADR-0018 §3）。
 *
 * 由 run 内可用知识语料派生、run 内固定：
 * - 无语料 → core-5；
 * - 仅 rule → core-5+rule；仅 history → core-5+history；
 * - 两者皆有 → extended-7。
 * 生产入口不注入语料，因此生产缺省 core-5（有意的 Zone A 变更）。
 */

export type ToolProfile = "core-5" | "core-5+rule" | "core-5+history" | "extended-7";

/** 实际 profile 的来源：语料派生 / 评测内部覆盖 */
export type ToolProfileSource = "derived" | "override";
