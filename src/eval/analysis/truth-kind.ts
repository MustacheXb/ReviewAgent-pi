import type { TruthKind } from "./contracts.js";

/** 真值可得性判定（输入校验与逐 run 分析共用的单源；接受未校验的 JSON 值） */
export function truthKindOf(truth: unknown): TruthKind {
  return truth === undefined ? "unknown" : truth === null ? "clean" : "provided";
}
