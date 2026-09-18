import type { LlmMessage } from "../contracts/llm.js";

// MR 初始 user 消息构造（测量常量面：消息格式与 DSH 线逐字节一致）。
//
// 字节真源：DSH 线 t-series requests[0].messages[2]
// （testdata/golden/mr-message-vul4j-1.txt），由 src/loop/messages.test.ts 断言。
export function buildInitialUserMessage(
  caseId: string,
  issueDescription: string,
  diff: string,
): string {
  // DSH 线语义：判空看 trim，注入看原文（前后空白保留）。
  const description = issueDescription.trim().length > 0 ? issueDescription : "(none)";
  return [
    "Merge request under review.",
    "",
    `Case ID: ${caseId}`,
    "Issue description:",
    description,
    "",
    "Unified diff:",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

/**
 * 初始上下文消息（system 之外的全部）：Zone B → MR user → 预取层。
 * 消息序与 t-series req0 逐条一致（system 经 pi-ai Context.systemPrompt 通道，
 * 序列化时映射为 messages[0]）。
 */
export function buildInitialContextMessages(args: {
  readonly zoneB?: LlmMessage;
  readonly mrUserContent: string;
  readonly prefetch?: readonly LlmMessage[];
}): readonly LlmMessage[] {
  return [
    ...(args.zoneB !== undefined ? [args.zoneB] : []),
    { role: "user", content: args.mrUserContent },
    ...(args.prefetch ?? []),
  ];
}
