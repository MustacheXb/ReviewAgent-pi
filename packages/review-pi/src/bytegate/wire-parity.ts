// P2 字节纪律门(#5)——wire 逐字节对照比较器(测量常量面零漂移的形式化证明)。
//
// 纪律形态(沿用 zone-a parity 先例):真源 = DSH 审计 requests[].wireBody
// (序列化点原文);pi 侧请求体经登记差异类别归一化后必须与真源逐字节相等。
// 差异类别白名单收口:计算差异 = 登记差异强制相等——白名单外零容忍,
// 登记项停摆(不再触发)同样红门,防止白名单静默腐烂。触发面分两档:
// 结构性类别每请求必触发(记录级死登记检查口径);数据条件类别仅在数据
// 形状出现时触发(空回复——DSH 以 content:null 入 wire、pi 整条省略该
// 消息),其「必须触发」由比较器单测与全量语料(该形状记录依赖归一化
// 才能 parity)双向把守。
//
// 两侧 JSON 均为各自序列化点 JSON.stringify 原文,故「值相等 + 键序对齐」
// ⟹ 逐字节相等;终局断言直接比对 DSH 原文字节,不给转义残留留活口。

import { deepEqualJson } from "./json-equal.js";

/** 登记差异类别(白名单;增删都是显式决策,须同步登记依据) */
export const REGISTERED_WIRE_DIFFERENCE_CATEGORIES = [
  "STREAM_FLAG",
  "STREAM_OPTIONS",
  "ASSISTANT_REASONING_CONTENT",
  "EMPTY_ASSISTANT_REPLY",
  "KEY_ORDER",
] as const;

export type WireDifferenceCategory = (typeof REGISTERED_WIRE_DIFFERENCE_CATEGORIES)[number];

/**
 * 触发面:structural = 方言结构性差异,每请求必触发(记录级死登记检查
 * 口径);data-conditional = 仅当数据形状出现时触发(如空回复),记录级
 * 不强求——其「必须触发」由比较器单测(断言触发)与全量语料(该形状
 * 记录依赖归一化才能 parity)双向把守。
 */
export type WireDifferenceFiringScope = "structural" | "data-conditional";

/** 登记依据(显式决策记录:为什么这是内核身份差异而非测量常量漂移) */
export interface WireDifferenceRegistration {
  readonly category: WireDifferenceCategory;
  readonly firingScope: WireDifferenceFiringScope;
  readonly rationale: string;
}

export const REGISTERED_WIRE_DIFFERENCES: readonly WireDifferenceRegistration[] = [
  {
    category: "STREAM_FLAG",
    firingScope: "structural",
    rationale:
      "DSH 线 deepseek 客户端非流式(stream:false);pi 内核 openai-completions 恒流式" +
      "(stream:true)。传输方言,不影响请求语义面。",
  },
  {
    category: "STREAM_OPTIONS",
    firingScope: "structural",
    rationale:
      "pi 流式配套的 usage 上报开关(stream_options.include_usage);DSH 非流式无此键。",
  },
  {
    category: "ASSISTANT_REASONING_CONTENT",
    firingScope: "structural",
    rationale:
      "pi-ai deepseek 兼容层给 assistant 消息补 reasoning_content:\"\"" +
      "(requiresReasoningContentOnAssistantMessages,维持多轮 thinking 会话);DSH 线 SDK 不发该键。",
  },
  {
    category: "EMPTY_ASSISTANT_REPLY",
    firingScope: "data-conditional",
    rationale:
      "空回复入 wire 的两核形状:DSH 线序列化为 {role:\"assistant\",content:null};" +
      "pi 内核 openai-completions 序列化器对无内容 assistant 消息整条省略(vendored 既有行为:" +
      "provider 不接受空 assistant 消息)。t2/VUL4J-79/B/rep-2 实证(180 条中 1 条)。",
  },
  {
    category: "KEY_ORDER",
    firingScope: "structural",
    rationale:
      "序列化点键序方言:pi = model,messages,stream,stream_options,thinking,reasoning_effort;" +
      "DSH = model,messages,thinking,reasoning_effort,stream。JSON 语义无差,字节序不同。",
  },
];

/** 结构性登记类别(每请求必触发;记录级死登记检查口径) */
export const STRUCTURAL_WIRE_DIFFERENCE_CATEGORIES: readonly WireDifferenceCategory[] =
  REGISTERED_WIRE_DIFFERENCES.filter(
    (registration) => registration.firingScope === "structural",
  ).map((registration) => registration.category);

export interface WireParityOk {
  readonly parity: true;
  /** 本请求实际触发的登记类别(字节相等时为空) */
  readonly firedCategories: readonly WireDifferenceCategory[];
}

export interface WireParityDrift {
  readonly parity: false;
  /** 未登记差异定位(人话 + 机器可检索) */
  readonly reason: string;
}

export type WireParityResult = WireParityOk | WireParityDrift;

/** JSON 值域(解析后的形状) */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** 单请求对照:pi 侧经登记归一化后与 DSH 真源逐字节相等 */
export function compareWireParity(dshWireBody: string, piWireBody: string): WireParityResult {
  if (dshWireBody === piWireBody) {
    return { parity: true, firedCategories: [] };
  }
  const dsh = parseTopLevel(dshWireBody);
  if (dsh === undefined) {
    return drift(`DSH wire body is not a JSON object: ${preview(dshWireBody)}`);
  }
  const pi = parseTopLevel(piWireBody);
  if (pi === undefined) {
    return drift(`pi wire body is not a JSON object: ${preview(piWireBody)}`);
  }

  const fired: WireDifferenceCategory[] = [];
  const values = new Map<string, Json>(Object.entries(pi));

  // STREAM_FLAG:仅归一化 DSH 非流式 ↔ pi 恒流式这一登记形态
  if (values.get("stream") === true && dsh["stream"] === false) {
    values.set("stream", false);
    fired.push("STREAM_FLAG");
  } else if (values.get("stream") !== dsh["stream"]) {
    return drift(
      `top-level "stream" differs outside the registered STREAM_FLAG shape ` +
        `(DSH=${preview(jsonText(dsh["stream"]))}, pi=${preview(jsonText(values.get("stream")))})`,
    );
  }

  // STREAM_OPTIONS:仅归一化 DSH 无键 ↔ pi 恒 {include_usage:true}
  const piStreamOptions = values.get("stream_options");
  if (!("stream_options" in dsh) && deepEqualJson(piStreamOptions, { include_usage: true })) {
    values.delete("stream_options");
    fired.push("STREAM_OPTIONS");
  } else if (!deepEqualJson(piStreamOptions, dsh["stream_options"])) {
    return drift(
      `top-level "stream_options" differs outside the registered STREAM_OPTIONS shape ` +
        `(DSH=${preview(jsonText(dsh["stream_options"]))}, pi=${preview(jsonText(piStreamOptions))})`,
    );
  }

  // messages 归一化(两级登记差异;见 normalizeMessages)
  const normalizedMessages = normalizeMessages(dsh, values, fired);
  if (typeof normalizedMessages === "string") {
    return drift(normalizedMessages);
  }
  if (normalizedMessages !== undefined) {
    values.set("messages", normalizedMessages);
  }

  // 键集必须一致(归一化后);多键/缺键都是未登记差异
  const dshKeys = Object.keys(dsh);
  const piKeys = [...values.keys()];
  if (piKeys.length !== dshKeys.length || dshKeys.some((key) => !values.has(key))) {
    return drift(
      `top-level key set differs: DSH=[${dshKeys.join(",")}] pi=[${piKeys.join(",")}] ` +
        `(pi-only=[${piKeys.filter((key) => !(key in dsh)).join(",")}], ` +
        `DSH-only=[${dshKeys.filter((key) => !values.has(key)).join(",")}])`,
    );
  }

  // KEY_ORDER:pi 键序重排为 DSH 键序(键集已一致,仅序方言)
  if (piKeys.some((key, index) => key !== dshKeys[index])) {
    fired.push("KEY_ORDER");
  }

  // 终局逐字节对账:按 DSH 键序重组 pi 值域,序列化必须等于 DSH 原文
  const reordered: Record<string, Json> = {};
  for (const key of dshKeys) {
    reordered[key] = values.get(key) as Json;
  }
  const finalWire = JSON.stringify(reordered);
  if (finalWire !== dshWireBody) {
    return drift(diagnoseByteResidue(reordered, dsh, dshWireBody, finalWire));
  }
  return { parity: true, firedCategories: fired };
}

/** 整记录对照:逐请求 parity + 结构性触发集与登记集强制相等(双向收口) */
export interface RecordParityOk {
  readonly parity: true;
  /** 全记录实际触发的登记类别(按登记序) */
  readonly firedCategories: readonly WireDifferenceCategory[];
}

export type RecordParityResult =
  | RecordParityOk
  | { readonly parity: false; readonly reason: string };

export function compareRecordParity(
  dshWireBodies: readonly string[],
  piWireBodies: readonly string[],
): RecordParityResult {
  if (dshWireBodies.length !== piWireBodies.length) {
    return {
      parity: false,
      reason: `request count differs: DSH ${dshWireBodies.length} vs pi ${piWireBodies.length}`,
    };
  }
  const fired = new Set<WireDifferenceCategory>();
  for (let index = 0; index < dshWireBodies.length; index++) {
    const result = compareWireParity(
      dshWireBodies[index] ?? "",
      piWireBodies[index] ?? "",
    );
    if (!result.parity) {
      return { parity: false, reason: `request ${index}: ${result.reason}` };
    }
    for (const category of result.firedCategories) {
      fired.add(category);
    }
  }
  // 死登记检查口径 = 结构性类别(每请求必触发);数据条件类别不强求
  // 每记录触发——见 WireDifferenceFiringScope。
  const dead = STRUCTURAL_WIRE_DIFFERENCE_CATEGORIES.filter((category) => !fired.has(category));
  if (dead.length > 0) {
    return {
      parity: false,
      reason:
        `structural registered difference categories did not fire (dead registration): [${dead.join(", ")}]; ` +
        `fired: [${STRUCTURAL_WIRE_DIFFERENCE_CATEGORIES.filter((category) => fired.has(category)).join(", ")}]`,
    };
  }
  return {
    parity: true,
    firedCategories: REGISTERED_WIRE_DIFFERENCE_CATEGORIES.filter((category) =>
      fired.has(category),
    ),
  };
}

/**
 * messages 归一化(pi 侧向 DSH 方言对齐)。两级登记差异:
 * - EMPTY_ASSISTANT_REPLY:DSH 空回复以 {role:"assistant",content:null} 入
 *   wire;pi 侧无对应消息(序列化器整条省略)——在 pi 侧对应位置补回该形状;
 * - ASSISTANT_REASONING_CONTENT:pi assistant 带空串、DSH 无该键时剥除。
 * 返回 undefined = 无可归一化;string = 未登记差异;
 * Json[] = 归一化后的 messages。
 */
function normalizeMessages(
  dsh: Record<string, Json>,
  values: Map<string, Json>,
  fired: WireDifferenceCategory[],
): Json[] | string | undefined {
  const dshMessages = dsh["messages"];
  const piMessages = values.get("messages");
  if (!Array.isArray(dshMessages) || !Array.isArray(piMessages)) {
    return `top-level "messages" is not an array (DSH=${Array.isArray(dshMessages)}, pi=${Array.isArray(piMessages)})`;
  }
  const emptyReplyCount = dshMessages.filter(isEmptyReplyAssistant).length;
  if (piMessages.length !== dshMessages.length - emptyReplyCount) {
    const note = emptyReplyCount > 0 ? ` (of which ${emptyReplyCount} null-content assistant)` : "";
    return `message count differs: DSH ${dshMessages.length}${note} vs pi ${piMessages.length}`;
  }
  let normalized = piMessages;
  if (emptyReplyCount > 0) {
    fired.push("EMPTY_ASSISTANT_REPLY");
    normalized = insertEmptyReplyAssistants(dshMessages, piMessages);
  }
  let mutated = false;
  const stripped = normalized.map((message, index) => {
    const truth = dshMessages[index];
    if (
      isJsonRecord(message) &&
      isJsonRecord(truth) &&
      message["role"] === "assistant" &&
      message["reasoning_content"] === "" &&
      !("reasoning_content" in truth)
    ) {
      mutated = true;
      const rest: Record<string, Json> = {};
      for (const [key, value] of Object.entries(message)) {
        if (key !== "reasoning_content") {
          rest[key] = value;
        }
      }
      return rest;
    }
    return message;
  });
  if (mutated) {
    fired.push("ASSISTANT_REASONING_CONTENT");
    return stripped;
  }
  return emptyReplyCount > 0 ? normalized : undefined;
}

/** DSH 空回复形状:content:null 的 assistant 消息 */
function isEmptyReplyAssistant(message: Json): boolean {
  return isJsonRecord(message) && message["role"] === "assistant" && message["content"] === null;
}

/**
 * 在 pi 消息流的对应位置补回 DSH 空回复形状。全新构造(不挪用 DSH 对象):
 * 若 DSH 侧该消息携带登记形态外的键,终局字节对账必红,逼出显式重登记。
 */
function insertEmptyReplyAssistants(dshMessages: Json[], piMessages: Json[]): Json[] {
  const aligned: Json[] = [];
  let cursor = 0;
  for (const dshMessage of dshMessages) {
    if (isEmptyReplyAssistant(dshMessage)) {
      aligned.push({ role: "assistant", content: null });
      continue;
    }
    aligned.push(piMessages[cursor] as Json);
    cursor += 1;
  }
  return aligned;
}

/** 终局字节残留定位:逐键值比对找首个分歧,给出请求内坐标 */
function diagnoseByteResidue(
  pi: Record<string, Json>,
  dsh: Record<string, Json>,
  dshWireBody: string,
  piWireBody: string,
): string {
  for (const key of Object.keys(dsh)) {
    const piText = jsonText(pi[key]);
    const dshText = jsonText(dsh[key]);
    if (piText !== dshText) {
      if (key === "messages" && Array.isArray(dsh[key]) && Array.isArray(pi[key])) {
        const index = firstDifferingIndex(
          (pi[key] as Json[]).map((m) => jsonText(m)),
          (dsh[key] as Json[]).map((m) => jsonText(m)),
        );
        return (
          `messages[${index}] differs: DSH=${preview(jsonText(dsh[key][index]))} ` +
          `pi=${preview(jsonText(pi[key][index]))}`
        );
      }
      return `top-level "${key}" differs: DSH=${preview(dshText)} pi=${preview(piText)}`;
    }
  }
  return (
    `byte-level residue after normalization (escaping/formatting): ` +
    `DSH=${preview(dshWireBody)} pi=${preview(piWireBody)}`
  );
}

function firstDifferingIndex(piTexts: string[], dshTexts: string[]): number {
  for (let index = 0; index < Math.max(piTexts.length, dshTexts.length); index++) {
    if (piTexts[index] !== dshTexts[index]) {
      return index;
    }
  }
  return -1;
}

function parseTopLevel(wire: string): Record<string, Json> | undefined {
  try {
    const parsed: unknown = JSON.parse(wire);
    if (isJsonRecord(parsed)) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isJsonRecord(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function drift(reason: string): WireParityDrift {
  return { parity: false, reason };
}

/** JSON 文本化(undefined → 字面 "undefined",不抛不崩) */
function jsonText(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

/** 失败定位片段:截首 200 字符,防巨量字节刷屏 */
function preview(text: string): string {
  const head = text.slice(0, 200);
  return text.length > 200 ? `${head}…(${text.length} chars)` : head;
}
