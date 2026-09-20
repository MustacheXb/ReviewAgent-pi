// P3a C/D/E 重放真源加载（#6）——t-series 审计 → agentLoop 重放素材。
//
// 重放协议（真源 = DSH 审计 requests[].wireBody 序列化点原文）：
// - 初始上下文：req0 消息序 = system + 初始上下文（MR / fullRepo，按配置）
//   + phase-1 指令——前两者作为 runAgentReviewLoop 输入注入，phase-1 指令
//   由 pi 侧 followUp 自产（对照面拦截指令字节漂移）；
// - 回复脚本：每请求 i≥1 的增量首条 assistant 即请求 i-1 的回复——带
//   tool_calls 为工具轮（按批回放），纯文本为文本轮（content:null 重放
//   空串，pi 序列化器整条省略 = EMPTY_ASSISTANT_REPLY 登记方言）；
// - 工具执行：脚本注入（toolCallLog 执行条目 resultSummary 按调用序），
//   执行器字节面由 tool-outputs 门单独把守，本门只证循环驱动语义；
// - 终局回复（不进任何请求）按真源终态反推合成：最后一轮候选 ×
//   findings/rejections 状态映射 + complete = !truncated。
//
// 可移植性同 A/B 门：runs/ gitignored（CI 无真源）→ 调用方注册显式跳过。

import { readFileSync } from "node:fs";
import type { FakeReply } from "../provider/fake-fetch.js";
import type { LlmMessage } from "../contracts/llm.js";
import type { LedgerEntry } from "../contracts/ledger.js";
import type { CandidateRejection, PhaseRecord, ToolCallRecord } from "../contracts/run.js";
import type { Finding } from "../contracts/finding.js";
import { parseCandidatesReply } from "../loop/parse.js";
import { TOOL_BUDGET_EXHAUSTED_SUMMARY } from "../loop/constants.js";
import { deepEqualJson } from "./json-equal.js";

/** C/D/E 门驱动的配置面（A/B 走字节门，不在此列） */
export type AgentConfigId = "C" | "D" | "E";

/** 真源审计的可对照投影（run 级语义面；usage 不进对照——重放 usage 恒零） */
export interface AgentTruthExpectation {
  readonly rounds: number;
  readonly toolCalls: number;
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
  readonly phaseLog: readonly PhaseRecord[];
  readonly toolCallLog: readonly ToolCallRecord[];
  readonly findings: readonly Finding[];
  readonly rejections: readonly CandidateRejection[];
  /** config E：Context Ledger 条目（按登记序）；C/D 恒空数组（审计无该键） */
  readonly ledger: readonly LedgerEntry[];
  /** 真源审计 requests[].tools 投影（点分名；恒定面，对照一次即可） */
  readonly tools: readonly unknown[];
}

/** 一条 C/D/E 真源记录的重放素材 */
export interface AgentGateTruth {
  readonly configId: AgentConfigId;
  readonly systemPrompt: string;
  readonly initialContextMessages: readonly LlmMessage[];
  readonly replies: readonly FakeReply[];
  readonly wireBodies: readonly string[];
  /** 执行条目 resultSummary 队列（按调用序；预算拦截的第 7+ 次不到达） */
  readonly toolResults: readonly string[];
  /** ledger 副作用回放队列（config E；失败执行不消耗） */
  readonly ledgerEntries: readonly LedgerEntry[];
  readonly expectation: AgentTruthExpectation;
}

export function loadAgentTruth(auditPath: string, configId: AgentConfigId): AgentGateTruth {
  const audit = JSON.parse(readFileSync(auditPath, "utf8")) as Record<string, unknown>;
  const requests = requireRequests(audit, auditPath);
  const wireBodies = requests.map((request, index) => {
    const wireBody = request["wireBody"];
    if (typeof wireBody !== "string" || wireBody === "") {
      throw new Error(`audit request ${index} has no wireBody string: ${auditPath}`);
    }
    return wireBody;
  });
  const messages = wireBodies.map((wire, index) => parseMessages(wire, index, auditPath));

  // req0 消息序：system → 初始上下文（user×N）→ phase-1 指令（pi 自产，不注入）
  const first = messages[0] ?? [];
  if (first.length < 3 || first[0]?.["role"] !== "system") {
    throw new Error(`audit request 0 is not [system, …context…, phase-1 instruction]: ${auditPath}`);
  }
  const systemPrompt = requireString(first[0]?.["content"], "request 0 system content", auditPath);
  const initialContextMessages: LlmMessage[] = [];
  for (let index = 1; index < first.length - 1; index++) {
    const message = first[index];
    if (message?.["role"] !== "user") {
      throw new Error(
        `audit request 0 message ${index} (initial context) is not a user message: ${auditPath}`,
      );
    }
    initialContextMessages.push({
      role: "user",
      content: requireString(message["content"], `request 0 message ${index} content`, auditPath),
    });
  }

  // 回复脚本：请求 i-1 的回复 = 请求 i 增量的首条 assistant
  const replies: FakeReply[] = [];
  for (let index = 1; index < messages.length; index++) {
    const previous = messages[index - 1] ?? [];
    const current = messages[index] ?? [];
    const delta = current.slice(previous.length);
    const assistant = delta[0];
    if (assistant === undefined || assistant["role"] !== "assistant") {
      throw new Error(
        `audit request ${index} delta does not start with an assistant reply: ${auditPath}`,
      );
    }
    const toolCalls = assistant["tool_calls"];
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      // 工具轮常带伴随文本（DSH wire: content:"Now let me…" + tool_calls）——
      // 混合回放；content:null 时 text 空串（pi 序列化同为 null，两线同形）
      replies.push({
        text: textOf(assistant, auditPath),
        toolCalls: toolCalls.map((call) => toFakeToolCall(call, auditPath)),
        usage: ZERO_USAGE,
      });
    } else {
      replies.push({ text: textOf(assistant, auditPath), usage: ZERO_USAGE });
    }
  }
  // 终局：反推合成（最后一轮 phase-5 回复候选 × 真源终态）
  replies.push(synthesizeTerminalReply(messages, audit, auditPath));

  // 工具执行脚本与 ledger 副作用队列
  const toolCallLog = requireArray(audit["toolCallLog"], "toolCallLog", auditPath);
  const toolResults: string[] = [];
  for (const entry of toolCallLog) {
    const resultSummary = requireString(
      (entry as Record<string, unknown>)["resultSummary"],
      "toolCallLog resultSummary",
      auditPath,
    );
    if (resultSummary !== TOOL_BUDGET_EXHAUSTED_SUMMARY) {
      toolResults.push(resultSummary);
    }
  }
  const ledger = configId === "E" ? requireArray(audit["ledger"], "ledger (config E)", auditPath) : [];

  return {
    configId,
    systemPrompt,
    initialContextMessages,
    replies,
    wireBodies,
    toolResults,
    ledgerEntries: ledger.map((entry) => toLedgerEntry(entry, auditPath)),
    expectation: {
      rounds: requireNumber(audit["rounds"], "rounds", auditPath),
      toolCalls: requireNumber(audit["toolCalls"], "toolCalls", auditPath),
      truncated: audit["truncated"] === true,
      truncationReasons: requireStringArray(audit["truncationReasons"], "truncationReasons", auditPath),
      phaseLog: requireArray(audit["phaseLog"], "phaseLog", auditPath).map((entry) => toPhaseRecord(entry, auditPath)),
      toolCallLog: toolCallLog.map((entry) => toToolCallRecord(entry, auditPath)),
      findings: requireArray(audit["findings"], "findings", auditPath) as readonly Finding[],
      rejections: requireArray(audit["rejections"], "rejections", auditPath) as readonly CandidateRejection[],
      ledger: ledger.map((entry) => toLedgerEntry(entry, auditPath)),
      tools: (requests[0] as Record<string, unknown>)["tools"] as unknown[],
    },
  };
}

/** 请求 i 增量首条 assistant 的文本（content:null 空回复重放为空串） */
function textOf(assistant: Record<string, unknown>, auditPath: string): string {
  const content = assistant["content"];
  if (typeof content === "string") {
    return content;
  }
  if (content === null) {
    return "";
  }
  throw new Error(`audit assistant reply content is neither string nor null: ${auditPath}`);
}

function toFakeToolCall(call: unknown, auditPath: string): { id: string; name: string; arguments: Record<string, unknown> } {
  const record = call as Record<string, unknown>;
  const fn = record["function"] as Record<string, unknown> | undefined;
  if (
    typeof record["id"] !== "string" ||
    typeof fn?.["name"] !== "string" ||
    typeof fn["arguments"] !== "string"
  ) {
    throw new Error(`audit assistant tool_call is malformed (id/function.name/arguments): ${auditPath}`);
  }
  // 模型原文（带空格的非紧凑 JSON）→ 解析值；fake 适配器重序列化为紧凑形态
  // 发帧——pi-ai 解析后语义同值（TOOL_CALL_ARGUMENTS_RESERIALIZATION 登记方言）
  return {
    id: record["id"],
    name: fn["name"],
    arguments: JSON.parse(fn["arguments"]) as Record<string, unknown>,
  };
}

/** 终局回复合成：最后一轮 phase-5 候选 × 真源终态（findings/rejections）映射。
 * 解析失败形态（真源 phaseLog 终局 note 含 "verification reply is not valid
 * JSON"——终局回复原文不进任何请求，审计仅有行为产物）回放哨兵非 JSON
 * 文本，让 pi 走同款解析失败路径（note / verdicts 空 / complete false）。 */
function synthesizeTerminalReply(
  messages: readonly Record<string, unknown>[][],
  audit: Record<string, unknown>,
  auditPath: string,
): FakeReply {
  const phaseLog = requireArray(audit["phaseLog"], "phaseLog", auditPath);
  const lastNote = (phaseLog[phaseLog.length - 1] as Record<string, unknown> | undefined)?.["note"];
  if (typeof lastNote === "string" && lastNote.includes("verification reply is not valid JSON")) {
    return { text: NOT_JSON_SENTINEL, usage: ZERO_USAGE };
  }

  const last = messages[messages.length - 1] ?? [];
  const lastUserIndex = findLastIndex(last, (message) => message["role"] === "user");
  if (lastUserIndex <= 0) {
    throw new Error(`audit last request has no user instruction to anchor phase-5 reply: ${auditPath}`);
  }
  const phase5 = last[lastUserIndex - 1];
  if (phase5?.["role"] !== "assistant") {
    throw new Error(
      `audit last request phase-5 reply (assistant before last user instruction) is missing: ${auditPath}`,
    );
  }
  const candidates = parseCandidatesReply(textOf(phase5, auditPath)).candidates;

  const findings = requireArray(audit["findings"], "findings", auditPath) as Array<{ id?: unknown }>;
  const emitted = new Set(findings.map((finding) => finding["id"]).filter((id): id is string => typeof id === "string"));
  const rejections = requireArray(audit["rejections"], "rejections", auditPath) as Array<{
    candidateId?: unknown;
    stage?: unknown;
    reason?: unknown;
  }>;
  const rejectionById = new Map(
    rejections
      .map((rejection) => [rejection["candidateId"], rejection] as const)
      .filter((entry): entry is [string, typeof rejections[number]] => typeof entry[0] === "string"),
  );

  const REJECTED_PREFIX = "evidence verification rejected the candidate";
  const verdicts = candidates.flatMap((candidate) => {
    const id = typeof (candidate as { id?: unknown })["id"] === "string"
      ? ((candidate as { id: string })["id"])
      : undefined;
    if (id === undefined) {
      return [];
    }
    if (emitted.has(id)) {
      // 新 finding（pass）或跨轮重复（放行到 DUPLICATE_ID 拦截）——均 pass
      return [{ id, pass: true, reason: "replay synthesized verdict" }];
    }
    const rejection = rejectionById.get(id);
    if (rejection?.["stage"] === "VERIFICATION_FAILED" && typeof rejection["reason"] === "string") {
      const reason = rejection["reason"];
      if (reason === "no verification verdict for candidate") {
        return []; // 裁决缺席：不给 verdict，gate 产同形 rejection
      }
      if (reason.startsWith(REJECTED_PREFIX)) {
        const detail = reason.slice(REJECTED_PREFIX.length).replace(/^:\s*/, "");
        return [{ id, pass: false, reason: detail }];
      }
    }
    // 更早阶段拦截（SCHEMA/NON_ENGLISH/NO_EVIDENCE）或真源缺席：不给 verdict
    return [];
  });
  const complete = audit["truncated"] !== true;
  return {
    text: JSON.stringify({ verdicts, complete }),
    usage: ZERO_USAGE,
  };
}

/** 脚本回放的 fake usage（usage 只进记账，不进对照面） */
const ZERO_USAGE = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;

/** 解析失败形态的终局哨兵：非 JSON、无代码围栏——parseVerificationReply
 * 必走失败路径（与真源行为产物 note 逐字节对齐） */
const NOT_JSON_SENTINEL = "replay sentinel: truth verification reply was not valid JSON";

function toLedgerEntry(entry: unknown, auditPath: string): LedgerEntry {
  const record = entry as Record<string, unknown>;
  return {
    id: requireString(record["id"], "ledger id", auditPath),
    kind: requireString(record["kind"], "ledger kind", auditPath) as LedgerEntry["kind"],
    description: requireString(record["description"], "ledger description", auditPath),
  };
}

function toPhaseRecord(entry: unknown, auditPath: string): PhaseRecord {
  const record = entry as Record<string, unknown>;
  const note = record["note"];
  return {
    round: requireNumber(record["round"], "phaseLog round", auditPath),
    phase: requireString(record["phase"], "phaseLog phase", auditPath) as PhaseRecord["phase"],
    requestCount: requireNumber(record["requestCount"], "phaseLog requestCount", auditPath),
    ...(typeof note === "string" ? { note } : {}),
  };
}

function toToolCallRecord(entry: unknown, auditPath: string): ToolCallRecord {
  const record = entry as Record<string, unknown>;
  return {
    name: requireString(record["name"], "toolCallLog name", auditPath),
    argumentsJson: requireString(record["argumentsJson"], "toolCallLog argumentsJson", auditPath),
    resultSummary: requireString(record["resultSummary"], "toolCallLog resultSummary", auditPath),
  };
}

function requireRequests(audit: Record<string, unknown>, auditPath: string): Record<string, unknown>[] {
  const requests = audit["requests"];
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error(`audit has no requests array: ${auditPath}`);
  }
  return requests as Record<string, unknown>[];
}

function parseMessages(wire: string, index: number, auditPath: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wire);
  } catch (error) {
    // 与同文件其他 require* 一致：错误必带请求序与真源路径（可定位）
    throw new Error(`audit wireBody ${index} is not valid JSON: ${auditPath}`, { cause: error });
  }
  const messages =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { messages?: unknown }).messages
      : undefined;
  if (!Array.isArray(messages) || messages.some((entry) => typeof entry !== "object" || entry === null)) {
    throw new Error(`audit wireBody ${index} is not an object with a messages array: ${auditPath}`);
  }
  return messages as Record<string, unknown>[];
}

function requireArray(value: unknown, field: string, auditPath: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`audit has no ${field} array: ${auditPath}`);
  }
  return value;
}

function requireString(value: unknown, field: string, auditPath: string): string {
  if (typeof value !== "string") {
    throw new Error(`audit ${field} is not a string: ${auditPath}`);
  }
  return value;
}

function requireNumber(value: unknown, field: string, auditPath: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`audit ${field} is not an integer: ${auditPath}`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string, auditPath: string): string[] {
  return requireArray(value, field, auditPath).map((entry) => requireString(entry, field, auditPath));
}

function findLastIndex<T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index] as T)) {
      return index;
    }
  }
  return -1;
}

/** 语义门对照用的值相等（JSON 值域；argumentsJson 解析口径） */
export function parsedJsonEqual(left: string, right: string): boolean {
  return deepEqualJson(JSON.parse(left), JSON.parse(right));
}
