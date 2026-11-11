/**
 * OpenAI Chat Completions 响应 → judge 客户端中间形状（纯函数，逐字段校验）。
 *
 * 只提取 judge 判定所需的两项：助手回复正文（裁定 JSON 文本）与
 * finish_reason（用于识别 max_tokens 截断）。judge token 用量不进入评测
 * 成本口径（CARC 只记被测内核），因此不做 usage 映射。
 */

import { GptJudgeResponseFormatError } from "./errors.js";

export interface MappedGptResponse {
  /** 助手回复正文（judge 裁定 JSON 文本） */
  readonly content: string;
  readonly finishReason: string | undefined;
}

export function mapGptChatCompletionsResponse(wire: unknown): MappedGptResponse {
  const root = asRecord(wire, "response");
  const choices = root.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new GptJudgeResponseFormatError("response.choices must be a non-empty array");
  }
  const choice = asRecord(choices[0], "response.choices[0]");
  const message = asRecord(choice.message, "response.choices[0].message");
  return {
    content: mapContent(message.content),
    finishReason: optionalString(choice.finish_reason, "response.choices[0].finish_reason"),
  };
}

function mapContent(content: unknown): string {
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content !== "string") {
    throw new GptJudgeResponseFormatError(
      `response.choices[0].message.content must be a string or null (got ${typeof content})`,
    );
  }
  return content;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GptJudgeResponseFormatError(`${path} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new GptJudgeResponseFormatError(`${path} must be a string`);
  }
  return value;
}
