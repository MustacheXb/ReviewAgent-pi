// P3a 工具方言登记（#6）——C/D/E 工具面 wire 序列化的内核身份差异单列清单。
//
// 纪律：工具方言不与 A/B 字节门（wire-parity.ts 的
// REGISTERED_WIRE_DIFFERENCES）混流——C/D/E 对照口径是「语义一致而非字节
// 一致」，差异按内核效应单列呈现。本表是工具面的登记真源；A/B 继承面
// （STREAM_FLAG 等传输方言）由语义门比较器（semantic-parity.ts）独立归一，
// 不回写 A/B 清单。
//
// 登记形态沿用 wire-parity 先例：类别 + 触发面 + 依据，增删都是显式决策。

/** 工具 wire 方言差异类别（白名单；增删须同步登记依据） */
export const REGISTERED_TOOL_DIFFERENCE_CATEGORIES = [
  "TOOL_STRICT_FLAG",
  "TOOL_CHOICE_ABSENT",
  "TOOL_CALL_ARGUMENTS_RESERIALIZATION",
  "TOOL_ARGUMENT_VALIDATION",
] as const;

export type ToolDifferenceCategory = (typeof REGISTERED_TOOL_DIFFERENCE_CATEGORIES)[number];

/**
 * 触发面：wire-structural = wire 请求体上的结构性差异，带工具的请求每条
 * 必触发（语义门死登记检查口径）；wire-data-conditional = wire 上仅在数据
 * 形状出现时触发（arguments 字节形态恰同则不触发，记录级不强求）；
 * behavioral = 行为性差异（错误路径 / 入参容忍度），不进正常请求字节面——
 * 真源语料全走合法路径，重放不触发，其存在性由单元测试把守。
 */
export type ToolDifferenceFiringScope =
  | "wire-structural"
  | "wire-data-conditional"
  | "behavioral";

/** 登记依据（显式决策记录：为什么这是内核身份差异而非测量常量漂移） */
export interface ToolDifferenceRegistration {
  readonly category: ToolDifferenceCategory;
  readonly firingScope: ToolDifferenceFiringScope;
  readonly rationale: string;
}

export const REGISTERED_TOOL_DIFFERENCES: readonly ToolDifferenceRegistration[] = [
  {
    category: "TOOL_STRICT_FLAG",
    firingScope: "wire-structural",
    rationale:
      "pi 内核 openai-completions 工具序列化追加 strict 键（deepseek compat 未置 " +
      "supportsStrictMode:false → strict: strict ?? false 恒出场，vendored " +
      "openai-completions.ts 实证）；DSH 线 wire 无该键。语义无差：strict 是 SDK " +
      "对 JSON Schema 采样的提示标志，不影响工具面定义。",
  },
  {
    category: "TOOL_CHOICE_ABSENT",
    firingScope: "wire-structural",
    rationale:
      "DSH 线 wire 恒带 tool_choice:\"auto\"；pi 内核仅在显式传入 toolChoice 时 " +
      "序列化该键（agentLoop 路径不传 → 键缺席）。语义无差：\"auto\" 与缺席同为 " +
      "「模型自主决定是否调用工具」缺省语义。",
  },
  {
    category: "TOOL_CALL_ARGUMENTS_RESERIALIZATION",
    firingScope: "wire-data-conditional",
    rationale:
      "assistant tool_calls 的 arguments 字节形态：DSH 线记录模型原文（流式增量 " +
      "拼接，带空格的非紧凑 JSON）；pi 内核解析后重序列化（JSON.stringify 紧凑 " +
      "形态）。语义等价口径 = 解析值深比较（两侧字节恰同时不触发）。同因波及 " +
      "审计 toolCallLog.argumentsJson（pi 侧紧凑 / DSH 模型原文），同口径归一。",
  },
  {
    category: "TOOL_ARGUMENT_VALIDATION",
    firingScope: "behavioral",
    rationale:
      "入参校验方言：pi 内核 validateToolArguments 严格拒未知键（pi-ai schema " +
      "additionalProperties:false）；DSH 线容忍未知键静默忽略。对冲 = AgentTool " +
      "prepareArguments 剥未知键（对齐 DSH 容忍语义）——正常路径两侧等价；差异 " +
      "只在参数校验失败的错误消息形态（pi immediate 错误路径 vs DSH 容忍继续）， " +
      "属错误路径方言，不进正常请求字节面。",
  },
];

/** wire 结构性登记类别（带工具请求每条必触发；语义门死登记检查口径） */
export const STRUCTURAL_TOOL_DIFFERENCE_CATEGORIES: readonly ToolDifferenceCategory[] =
  REGISTERED_TOOL_DIFFERENCES.filter(
    (registration) => registration.firingScope === "wire-structural",
  ).map((registration) => registration.category);
