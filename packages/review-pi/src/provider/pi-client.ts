import type { AssistantMessage, Context, FetchFunction, Model, TextContent } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { ToolSchema, WireMessage } from "../contracts/llm.js";

/**
 * pi-ai 序列化缝（内核变量面）：真 provider + 真 openai SDK 序列化路径，
 * 传输层经注入的 FetchFunction（fake 适配器与真适配器同缝，零网络）。
 *
 * wireBody = onPayload 序列化点捕获的请求原文（JSON.stringify(payload)），
 * 与 DSH 线 wire-log 同语义（序列化点原文，一次逻辑调用一条）。
 * 请求面对齐 DSH deepseek 画像：不传 max_tokens（t 系列审计 wireBody 无此键）。
 * 口径记账（#3 票面「max_output=1K」）：该值为立项预算表口径，DSH 线 wire
 * 无对应键（根仓 src 亦无此常量），字节复刻面无可复刻物——按审计真源口径
 * 不落 wire，P2 字节门再议。
 * 锁档纪律（DSH 线 ADR-0002，逐项有测试）：
 * - effort 单档锁定：harness/审计标签恒 "default"，线上恒
 *   thinking {type:"enabled"} + reasoning_effort "high"；
 * - 请求不携带采样参数；config B 无工具（tools 不出场）。
 */

/** 钉住的评审模型（评测口径：单模型 deepseek-v4-flash） */
export const REVIEW_MODEL_ID = "deepseek-v4-flash";
/** 锁档 effort 标签（harness/审计面；与 DSH 线 wire.ts 同名单源） */
export const LOCKED_EFFORT_LABEL = "default";
/** 锁档线上档位：pi-ai reasoningEffort → wire reasoning_effort "high"（deepseek thinkingLevelMap） */
export const LOCKED_REASONING_EFFORT = "high";

/** onPayload 序列化点捕获（审计 requests[] 条目形状：model/effort/messages/tools + wireBody 原文） */
export interface WireCapture {
  readonly model: string;
  readonly effort: string;
  readonly messages: readonly WireMessage[];
  readonly tools: readonly ToolSchema[];
  /** JSON.stringify(payload) 原文（= 发往 provider 的请求体，可原样重放） */
  readonly wireBody: string;
}

export interface ReviewTurnInput {
  readonly context: Context;
  readonly apiKey: string;
  /** 传输层注入；缺省线上 global fetch（离线测试恒注入 fake 适配器） */
  readonly fetch?: FetchFunction;
}

export interface ReviewTurnOutcome {
  readonly message: AssistantMessage;
  readonly wire: WireCapture;
}

const WIRE_ROLES: readonly string[] = ["system", "user", "assistant", "tool"];

export async function runReviewTurn(input: ReviewTurnInput): Promise<ReviewTurnOutcome> {
  const model = requireReviewModel();
  let wire: WireCapture | undefined;
  const stream = deepseekProvider().stream(model, input.context, {
    apiKey: input.apiKey,
    fetch: input.fetch,
    reasoningEffort: LOCKED_REASONING_EFFORT,
    onPayload: (payload) => {
      wire = captureWire(payload);
    },
  });
  const message = await stream.result();
  // pi-ai 对 provider 错误不 reject：resolve 出 stopReason "error" 的 AssistantMessage，
  // 缝必须显式拦截（错误永不静默成一次"成功"回合）。
  if (message.stopReason === "error") {
    throw new Error(
      `review turn failed: ${message.errorMessage ?? "provider returned an error stop reason"}`,
    );
  }
  if (wire === undefined) {
    throw new Error("pi-ai did not reach the onPayload serialization point (wire capture missing)");
  }
  return { message, wire };
}

/** assistant 回复纯文本（content text 块按 "\n" 连接；与 DSH joinTextBlocks 同口径） */
export function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function requireReviewModel(): Model<"openai-completions"> {
  const model = deepseekProvider()
    .getModels()
    .find((candidate) => candidate.id === REVIEW_MODEL_ID);
  if (model === undefined) {
    throw new Error(`review model "${REVIEW_MODEL_ID}" not found in the deepseek provider catalog`);
  }
  return model;
}

/** 校验并投影 onPayload payload（边界校验 fail fast；扩展字段透传不裁剪） */
function captureWire(payload: unknown): WireCapture {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("onPayload payload is not an object");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.model !== "string") {
    throw new Error("onPayload payload has no string model field");
  }
  if (!Array.isArray(record.messages)) {
    throw new Error("onPayload payload has no messages array");
  }
  const messages = record.messages.map(wireMessageOf);
  const tools = Array.isArray(record.tools) ? record.tools.map(toolSchemaOf) : [];
  return {
    model: record.model,
    effort: LOCKED_EFFORT_LABEL,
    messages,
    tools,
    wireBody: JSON.stringify(payload),
  };
}

function wireMessageOf(entry: unknown): WireMessage {
  if (typeof entry !== "object" || entry === null) {
    throw new Error("onPayload messages entry is not an object");
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.role !== "string" || !WIRE_ROLES.includes(record.role)) {
    throw new Error(`onPayload messages entry has an unknown wire role: ${JSON.stringify(record.role)}`);
  }
  if (typeof record.content !== "string") {
    throw new Error("onPayload messages entry has no string content field");
  }
  return entry as WireMessage;
}

/** wire function tool → DSH 审计口径 ToolSchema（config B 恒空数组，投影为将来工具配置就位） */
function toolSchemaOf(entry: unknown): ToolSchema {
  if (typeof entry !== "object" || entry === null) {
    throw new Error("onPayload tools entry is not an object");
  }
  const tool = entry as Record<string, unknown>;
  const fn = tool.function;
  if (typeof fn !== "object" || fn === null) {
    throw new Error("onPayload tools entry is not an openai function tool");
  }
  const fnRecord = fn as Record<string, unknown>;
  if (typeof fnRecord.name !== "string" || typeof fnRecord.description !== "string") {
    throw new Error("onPayload tools entry is not an openai function tool");
  }
  return {
    name: fnRecord.name,
    description: fnRecord.description,
    parametersJson: JSON.stringify(fnRecord.parameters ?? {}),
  };
}
