import type { LlmUsage } from "../../src/instrument/contracts/llm-client.js";

/** 测试辅助：构造 LlmUsage（P4b #9 自退役的 llm-script.ts 平移唯存函数） */
export function usage(inputTokens: number, outputTokens: number, extra: Partial<LlmUsage> = {}): LlmUsage {
  return { inputTokens, outputTokens, ...extra };
}
