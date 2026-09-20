// P3a 语义等价比较器（#6）——C/D/E 对照口径：「语义一致而非字节一致」。
//
// 与 A/B 字节门（wire-parity.ts）的分工：A/B 归一化到 DSH 键序后逐字节
// 相等；本比较器只断言 JSON 值域深相等（键序天然无关）。归一化面 =
// A/B 已登记方言的语义投影（STREAM_FLAG / STREAM_OPTIONS /
// ASSISTANT_REASONING_CONTENT / EMPTY_ASSISTANT_REPLY——继承面，此处独立
// 实现、不回写 A/B 清单）+ 工具面四类方言（tool-dialect.ts 单列真源）。
//
// 死登记检查口径（记录级）：结构性类别（继承 STREAM_FLAG/STREAM_OPTIONS/
// ASSISTANT_REASONING_CONTENT + 工具 TOOL_STRICT_FLAG/TOOL_CHOICE_ABSENT）
// 必触发——C/D/E 每请求带七工具、每 run ≥6 请求必有 assistant 消息；
// 数据条件类别（EMPTY_ASSISTANT_REPLY / TOOL_CALL_ARGUMENTS_
// RESERIALIZATION）仅在数据形状出现时触发，记录级不强求。

import { deepEqualJson } from "./json-equal.js";
import {
  REGISTERED_TOOL_DIFFERENCE_CATEGORIES,
  STRUCTURAL_TOOL_DIFFERENCE_CATEGORIES,
} from "./tool-dialect.js";

/** 语义门呈现的触发类别 = 继承面 + 工具面（注册序） */
export const SEMANTIC_PARITY_CATEGORIES: readonly string[] = [
  "STREAM_FLAG",
  "STREAM_OPTIONS",
  "ASSISTANT_REASONING_CONTENT",
  "EMPTY_ASSISTANT_REPLY",
  ...REGISTERED_TOOL_DIFFERENCE_CATEGORIES,
];

/** 记录级必触发的结构性类别（继承面工具无关传输方言 + 工具面结构性方言） */
const STRUCTURAL_SEMANTIC_CATEGORIES: readonly string[] = [
  "STREAM_FLAG",
  "STREAM_OPTIONS",
  "ASSISTANT_REASONING_CONTENT",
  ...STRUCTURAL_TOOL_DIFFERENCE_CATEGORIES,
];

export interface SemanticParityOk {
  readonly parity: true;
  /** 本记录实际触发的登记类别（语义门呈现序） */
  readonly firedCategories: readonly string[];
}

export type SemanticParityResult =
  | SemanticParityOk
  | { readonly parity: false; readonly reason: string };

/** 整记录对照：逐请求归一化深比较 + 结构性触发集与登记集强制相等 */
export function compareSemanticRecord(
  dshWireBodies: readonly string[],
  piWireBodies: readonly string[],
): SemanticParityResult {
  if (dshWireBodies.length !== piWireBodies.length) {
    return {
      parity: false,
      reason: `request count differs: DSH ${dshWireBodies.length} vs pi ${piWireBodies.length}`,
    };
  }
  const fired = new Set<string>();
  for (let index = 0; index < dshWireBodies.length; index++) {
    const result = compareSemanticWire(dshWireBodies[index] ?? "", piWireBodies[index] ?? "");
    if (!result.parity) {
      return { parity: false, reason: `request ${index}: ${result.reason}` };
    }
    for (const category of result.firedCategories) {
      fired.add(category);
    }
  }
  const dead = STRUCTURAL_SEMANTIC_CATEGORIES.filter((category) => !fired.has(category));
  if (dead.length > 0) {
    return {
      parity: false,
      reason:
        `structural registered difference categories did not fire (dead registration): [${dead.join(", ")}]`,
    };
  }
  return {
    parity: true,
    firedCategories: SEMANTIC_PARITY_CATEGORIES.filter((category) => fired.has(category)),
  };
}

/** 单请求对照：两侧各自归一化登记方言后 JSON 值域深相等 */
export function compareSemanticWire(
  dshWireBody: string,
  piWireBody: string,
): SemanticParityResult {
  const dsh = parseWire(dshWireBody, "DSH");
  const pi = parseWire(piWireBody, "pi");
  if (typeof dsh === "string" || typeof pi === "string") {
    return drift(typeof dsh === "string" ? dsh : (pi as string));
  }
  const piFired = new Set<string>();
  const dshFired = new Set<string>();

  // 继承面（A/B 已登记传输方言的语义投影）——登记形态校验后剥除：
  // 形态外的值差异立即红门（与 wire-parity.ts 同强度，不因剥除而静默放行），
  // 键缺席/同值（方言未出场）不剥不记
  if (pi["stream"] === true && dsh["stream"] === false) {
    // STREAM_FLAG: pi 恒 stream:true / DSH stream:false
    delete pi["stream"];
    delete dsh["stream"];
    piFired.add("STREAM_FLAG");
  } else if (pi["stream"] !== dsh["stream"]) {
    return drift(
      `top-level "stream" differs outside the registered STREAM_FLAG shape ` +
        `(DSH=${preview(jsonText(dsh["stream"]))}, pi=${preview(jsonText(pi["stream"]))})`,
    );
  }
  const piStreamOptions = pi["stream_options"];
  if (!("stream_options" in dsh) && deepEqualJson(piStreamOptions, { include_usage: true })) {
    // STREAM_OPTIONS: pi 流式 usage 上报键（DSH 本无）
    delete pi["stream_options"];
    piFired.add("STREAM_OPTIONS");
  } else if (!deepEqualJson(piStreamOptions, dsh["stream_options"])) {
    return drift(
      `top-level "stream_options" differs outside the registered STREAM_OPTIONS shape ` +
        `(DSH=${preview(jsonText(dsh["stream_options"]))}, pi=${preview(jsonText(piStreamOptions))})`,
    );
  }
  if (dsh["tool_choice"] === "auto" && !("tool_choice" in pi)) {
    // TOOL_CHOICE_ABSENT: DSH 恒 "auto" / pi 缺席
    delete dsh["tool_choice"];
    dshFired.add("TOOL_CHOICE_ABSENT");
  } else if (jsonText(dsh["tool_choice"]) !== jsonText(pi["tool_choice"])) {
    return drift(
      `top-level "tool_choice" differs outside the registered TOOL_CHOICE_ABSENT shape ` +
        `(DSH=${preview(jsonText(dsh["tool_choice"]))}, pi=${preview(jsonText(pi["tool_choice"]))})`,
    );
  }

  normalizePiTools(pi, piFired);
  normalizeDshMessages(dsh, dshFired);
  normalizePiMessages(pi, piFired);
  const argsError = normalizeArguments(dsh, "DSH", dshFired) ?? normalizeArguments(pi, "pi", piFired);
  if (argsError !== undefined) {
    return drift(argsError);
  }

  if (!deepEqualJson(dsh, pi)) {
    return drift(diagnose(dsh, pi));
  }
  const merged = new Set([...piFired, ...dshFired]);
  return {
    parity: true,
    firedCategories: SEMANTIC_PARITY_CATEGORIES.filter((category) => merged.has(category)),
  };
}

/** JSON 值域（解析后的形状） */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function parseWire(wire: string, side: string): Record<string, Json> | string {
  try {
    const parsed: unknown = JSON.parse(wire);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, Json>;
    }
  } catch {
    // fall through to drift
  }
  return `${side} wire body is not a JSON object: ${preview(wire)}`;
}

/** pi 侧工具面归一化：剥 function.strict（TOOL_STRICT_FLAG） */
function normalizePiTools(pi: Record<string, Json>, fired: Set<string>): void {
  const tools = pi["tools"];
  if (!Array.isArray(tools) || tools.length === 0) {
    return;
  }
  let stripped = false;
  pi["tools"] = tools.map((entry) => {
    if (!isRecord(entry) || !isRecord(entry["function"])) {
      return entry;
    }
    const fn = entry["function"];
    if (!("strict" in fn)) {
      return entry;
    }
    stripped = true;
    const rest: Record<string, Json> = {};
    for (const [key, value] of Object.entries(fn)) {
      if (key !== "strict") {
        rest[key] = value;
      }
    }
    return { ...entry, function: rest };
  });
  if (stripped) {
    fired.add("TOOL_STRICT_FLAG");
  }
}

/**
 * DSH 侧消息归一化：剥空回复 assistant（EMPTY_ASSISTANT_REPLY 的语义门
 * 投影——pi 序列化器对无内容 assistant 整条省略，对照取「两侧都无该消息」）。
 */
function normalizeDshMessages(dsh: Record<string, Json>, fired: Set<string>): void {
  const messages = dsh["messages"];
  if (!Array.isArray(messages)) {
    return;
  }
  const kept = messages.filter(
    (message) => !(isRecord(message) && message["role"] === "assistant" && !("tool_calls" in message) && message["content"] === null),
  );
  if (kept.length !== messages.length) {
    fired.add("EMPTY_ASSISTANT_REPLY");
    dsh["messages"] = kept;
  }
}

/** pi 侧消息归一化：剥 assistant 的空串 reasoning_content（继承方言；
 * 工具轮 assistant 同样被 pi-ai 补该键，一并剥除） */
function normalizePiMessages(pi: Record<string, Json>, fired: Set<string>): void {
  const messages = pi["messages"];
  if (!Array.isArray(messages)) {
    return;
  }
  let mutated = false;
  pi["messages"] = messages.map((message) => {
    if (!isRecord(message) || message["role"] !== "assistant" || message["reasoning_content"] !== "") {
      return message;
    }
    mutated = true;
    const rest: Record<string, Json> = {};
    for (const [key, value] of Object.entries(message)) {
      if (key !== "reasoning_content") {
        rest[key] = value;
      }
    }
    return rest;
  });
  if (mutated) {
    fired.add("ASSISTANT_REASONING_CONTENT");
  }
}

/**
 * 两侧消息内 assistant tool_calls 的 arguments 归一化（工具面方言）：
 * 字符串 → 解析值（TOOL_CALL_ARGUMENTS_RESERIALIZATION——两侧解析口径
 * 相同则字节形态差异消解）；解析失败返回 drift 原因（模型原文非法 JSON
 * 属未登记差异，不静默保留蒙混过关）。
 */
function normalizeArguments(
  side: Record<string, Json>,
  label: string,
  fired: Set<string>,
): string | undefined {
  const messages = side["messages"];
  if (!Array.isArray(messages)) {
    return undefined;
  }
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message["tool_calls"])) {
      continue;
    }
    for (const call of message["tool_calls"]) {
      if (!isRecord(call) || !isRecord(call["function"])) {
        continue;
      }
      const fn = call["function"];
      const args = fn["arguments"];
      if (typeof args !== "string") {
        continue;
      }
      try {
        const parsed = JSON.parse(args) as Json;
        // 触发口径 = 重序列化形态与原文不同（字节恰同则方言未实际出场）
        if (JSON.stringify(parsed) !== args) {
          fired.add("TOOL_CALL_ARGUMENTS_RESERIALIZATION");
        }
        fn["arguments"] = parsed;
      } catch {
        return `${label} assistant tool_calls arguments is not valid JSON: ${preview(args)}`;
      }
    }
  }
  return undefined;
}

/** 逐键定位首个分歧（drift 诊断坐标） */
function diagnose(dsh: Record<string, Json>, pi: Record<string, Json>): string {
  for (const key of new Set([...Object.keys(dsh), ...Object.keys(pi)])) {
    const dshText = JSON.stringify(dsh[key]) ?? "undefined";
    const piText = JSON.stringify(pi[key]) ?? "undefined";
    if (dshText !== piText) {
      if (key === "messages" && Array.isArray(dsh[key]) && Array.isArray(pi[key])) {
        const dshMessages = dsh[key] as Json[];
        const piMessages = pi[key] as Json[];
        for (let index = 0; index < Math.max(dshMessages.length, piMessages.length); index++) {
          const dshEntry = JSON.stringify(dshMessages[index]) ?? "undefined";
          const piEntry = JSON.stringify(piMessages[index]) ?? "undefined";
          if (dshEntry !== piEntry) {
            return `messages[${index}] differs: DSH=${preview(dshEntry)} pi=${preview(piEntry)}`;
          }
        }
      }
      return `top-level "${key}" differs: DSH=${preview(dshText)} pi=${preview(piText)}`;
    }
  }
  return `value-domain drift (escaping/formatting): DSH=${preview(JSON.stringify(dsh))} pi=${preview(JSON.stringify(pi))}`;
}

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function drift(reason: string): { readonly parity: false; readonly reason: string } {
  return { parity: false, reason };
}

/** JSON 值的序列化文本（诊断面；键缺席呈现为 "undefined"） */
function jsonText(value: Json | undefined): string {
  return JSON.stringify(value) ?? "undefined";
}

/** 失败定位片段：截首 200 字符，防巨量字节刷屏 */
function preview(text: string): string {
  const head = text.slice(0, 200);
  return text.length > 200 ? `${head}…(${text.length} chars)` : head;
}
