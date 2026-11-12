import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, FetchFunction, Model } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { Finding } from "../contracts/finding.js";
import type { LlmMessage, LlmUsage } from "../contracts/llm.js";
import {
  ReviewAbortedError,
  type CandidateRejection,
  type PhaseRecord,
  type ReviewRunProgress,
  type RunAudit,
  type StopReason,
  type ToolCallRecord,
  type WireRequest,
} from "../contracts/run.js";
import { applyCandidateGate } from "../gate/candidate-gate.js";
import {
  assistantText,
  captureWire,
  LOCKED_REASONING_EFFORT,
  reviewModelOf,
} from "../provider/pi-client.js";
import { addUsage, piUsageToLlmUsage, ZERO_USAGE } from "../provider/usage-map.js";
import { classifyCacheBreaks } from "./cache-break.js";
import {
  FINDINGS_PHASE_REQUEST_FLOOR,
  resolveReviewBudget,
  type ReviewBudgetOverride,
} from "./budget.js";
import {
  FORCED_FINALIZATION_INSTRUCTION,
  MAX_FORCED_FINALIZATIONS_PER_PHASE,
  PHASE_SKIPPED_REQUEST_BUDGET_EXHAUSTED_NOTE,
  PHASE_SKIPPED_REQUEST_BUDGET_NOTE,
  TOOL_ATTEMPTS_EXHAUSTED_SUMMARY,
  TOOL_BUDGET_EXHAUSTED_SUMMARY,
  TRUNCATION_MAX_REQUESTS,
  TRUNCATION_MAX_ROUNDS,
  TRUNCATION_OUTPUT_BUDGET,
  TRUNCATION_REQUEST_BUDGET_SKIPPED,
  TRUNCATION_TOOL_ATTEMPTS,
  TRUNCATION_TOOL_BUDGET,
} from "./constants.js";
import { parseCandidatesReply, parseVerificationReply, type VerificationVerdict } from "./parse.js";
import { PHASE_COUNT, PHASE_INSTRUCTIONS, PHASE_ORDER } from "./phases.js";
import { fromWireToolName, toWireToolName } from "../tools/registry.js";
import type { ReviewToolkit } from "../tools/toolkit.js";

// agentLoop 钩子驱动循环（#6 P3a；#32 / ADR-0014 起唯一内核形态）：六阶段 +
// 工具子循环跑在 pi-agent-core Agent 上，三个预定缝承载 review 语义——
//
// - shouldStopAfterTurn = review 状态机：工具轮恒继续（t-series 真源：执行
//   预算耗尽也 recall，相位只在文本回复时完结；尝试预算耗尽例外——#54
//   Forced Phase Finalization：本批 terminate + 注入收尾指令，每阶段至多
//   2 次）；文本轮完结当前阶段（解析 + PhaseRecord 留痕），经 agent.followUp
//   注入下一阶段指令或下一轮 phase-1 指令；complete / 轮次上界即停；
// - transformContext 不设（恒等透传）：消息前缀 append-only，Zone A/B/C
//   稳定前缀由内核时序直接保证；
// - state.tools = 七工具 AgentTool（name = wire 下划线名直达 wire function.name；
//   prepareArguments 剥未知键对齐 DSH 容忍语义——pi-ai 严格校验缝的方言对冲）。
//
// 工具预算与审计在 beforeToolCall / execute 包装层（#54 起预算闸前移到
// beforeToolCall，被拦调用不执行）：attempts 累计跨轮不重置（含被拒调用），
// 达上限后本批结果全部 terminate；executed 成功/失败均计入；超执行预算返回
// "Error: tool call budget exhausted"（= 审计 resultSummary = wire tool 消息
// content，t-series 真源字节）；超尝试预算返回 "Error: tool attempt budget
// exhausted"。truncationReasons 单列 TOOL_BUDGET_EXHAUSTED /
// TOOL_ATTEMPTS_EXHAUSTED 但不翻转 truncated（截断语义只归 MAX_ROUNDS 与
// 阶段/轮次跳过）。
//
// 请求 / 输出预算（#55 / ADR-0018 §2.2–§2.3）：请求预算只在阶段边界判定——
// 剩余不足以按常规序推进到裁决时，跳过尚未完成的前四阶段直入候选（被跳过
// 阶段逐条写 phaseLog，requestCount = 0）；候选/裁决保底 2 请求，候选一旦
// 开始裁决允许完成；连保底都不足则 MAX_REQUESTS_REACHED 收尾。输出预算只在
// 阶段完成后事后判定并停止后续请求（wire 不新增 max_tokens），超出即
// OUTPUT_BUDGET_EXHAUSTED 收尾。

export interface AgentReviewLoopInputs {
  readonly systemPrompt: string;
  /** 初始上下文消息（MR user 起始的 run 级组装，由调用方决定） */
  readonly initialContextMessages: readonly LlmMessage[];
  /** 七工具执行面（含功能态 Context Ledger） */
  readonly toolkit: ReviewToolkit;
  readonly apiKey: string;
  /** 网关 base URL 覆盖（REVIEWER_URL；缺省官方接入点） */
  readonly baseUrl?: string;
  /** 模型 id 覆盖（缺省钉住的评审模型） */
  readonly modelId?: string;
  /** 传输层注入；离线测试恒注入 fake 适配器 */
  readonly fetch?: FetchFunction;
  /**
   * 预算覆盖（#53 / ADR-0018 §1）：内核内部输入，不进入协议 / CLI / 环境
   * 变量；缺席字段取 `DEFAULT_REVIEW_BUDGET` 安全上界。
   */
  readonly budget?: ReviewBudgetOverride;
  /**
   * 取消信号（#23 S2 缝）：abort → agent.abort()（pi 内核取消面，spec #21
   * §6 / ADR-0012 决策 4）；prompt 返回后 signal 已中止 → 上抛
   * ReviewAbortedError。fake 适配器不感知 signal——shouldStopAfterTurn
   * 边界短路是离线确定性止步点（真路径 provider signal 先行中断）。
   */
  readonly signal?: AbortSignal;
  /** 进度观测（#23 S2 缝）：phase/round 边界（phase 入口）调用；纯观测，未配置零介入 */
  readonly onProgress?: (progress: ReviewRunProgress) => void;
}

export interface AgentReviewLoopOutcome {
  readonly findings: readonly Finding[];
  readonly usage: LlmUsage;
  readonly rounds: number;
  readonly toolCalls: number;
  /** 验证 complete 信号（= !truncated） */
  readonly complete: boolean;
  readonly audit: RunAudit;
}

/** 深解析阶段（0-based 指令下标）：候选与裁决的解析点 */
const CANDIDATES_PHASE_INDEX = 4;
const VERIFICATION_PHASE_INDEX = 5;

export async function runAgentReviewLoop(
  inputs: AgentReviewLoopInputs,
): Promise<AgentReviewLoopOutcome> {
  // 取消前置检查（#23 S2）：中止信号已到 → 任何工作不开始（与 runReview
  // 入口检查同谓词；覆盖 config C 全仓扫描 / toolkit 组装的长窗口）
  if (inputs.signal?.aborted) {
    throw new ReviewAbortedError();
  }
  // 预算解析单点（#53）：缺省 + 覆盖 → 生效预算；非法覆盖在此显式抛错。
  // maxRounds / maxExecutedToolCalls 在既有收口点；maxToolAttempts 由 #54
  // 的尝试闸消费；maxRequests / maxOutputTokens 由 #55 的阶段边界判定消费。
  const budget = resolveReviewBudget(inputs.budget);
  // 审计累积面（run 内顺序单写；产出时整体冻结为 readonly 投影）
  const requests: WireRequest[] = [];
  const toolCallLog: ToolCallRecord[] = [];
  const phaseLog: PhaseRecord[] = [];
  const rejections: CandidateRejection[] = [];
  const findings: Finding[] = [];
  const truncationReasons: string[] = [];
  let usage: LlmUsage = ZERO_USAGE;
  let executedToolCalls = 0;
  // 尝试计数（#54 / ADR-0018 §2.1）：模型每发出一个 toolCall 内容块计 1，
  // 跨轮不重置；与 executed 是两个独立闸（attempt 含被拒调用）。
  let attemptedToolCalls = 0;
  // 尝试预算是否已耗尽（黏性：耗尽后不再执行任何工具，直到 run 结束）
  let attemptsExhausted = false;
  // 当前工具批的模型回复（批边界识别 + 尝试预算「整批 terminate」判定）
  let currentBatchMessage: AssistantMessage | undefined;
  let currentBatchReachesAttemptCap = false;
  // 本批已走进 beforeToolCall 的调用数（对账内核即时拒绝的调用：
  // 未知工具名 / 参数校验失败不经过该钩子，但仍计一次 attempt）
  let currentBatchSeenCalls = 0;
  let round = 1;
  let phaseIndex = 0;
  let phaseRequestCount = 0;
  let phaseSkippedToolCalls = 0;
  // 当前阶段强制收尾注入次数（#54：每阶段至多 2 次，阶段切换重置）
  let phaseForcedFinalizations = 0;
  let roundCandidates: readonly unknown[] = [];
  let roundVerdicts: ReadonlyMap<string, VerificationVerdict> = new Map();
  let roundComplete = false;
  let emittedIds: ReadonlySet<string> = new Set();
  let truncated = false;
  let complete = false;
  // 停止原因（#53 / ADR-0018 §2.4）：新 run 恒写；模型完成与轮次上界在此
  // 骨架先落地，其余枚举值由后续批次（#54/#55）在各自收口点写入。
  let stopReason: StopReason | undefined;

  const agentTools: AgentTool[] = inputs.toolkit.schemas.map((schema) => {
    const parameters = JSON.parse(schema.parametersJson) as Record<string, unknown>;
    const knownKeys = knownArgumentKeys(parameters);
    const tool: AgentTool = {
      name: toWireToolName(schema.name),
      label: schema.name,
      description: schema.description,
      parameters,
      prepareArguments: (args) => stripUnknownArguments(args, knownKeys),
      execute: async (_toolCallId, params) => {
        const args = params as Record<string, unknown>;
        const argumentsJson = JSON.stringify(args);
        try {
          const result = await inputs.toolkit.executeTool(schema.name, args);
          toolCallLog.push({ name: schema.name, argumentsJson, resultSummary: result });
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (error) {
          // t-series 真源字节：失败前缀 "Error: "（VUL4J-16/E/rep-3 实证：
          // "Error: review.get_file: file …"——工具错误消息自带工具名前缀）
          const summary = `Error: ${errorMessage(error)}`;
          toolCallLog.push({ name: schema.name, argumentsJson, resultSummary: summary });
          return { content: [{ type: "text", text: summary }], details: {} };
        }
      },
    };
    return tool;
  });

  const streamFn: StreamFn = (model, context, options) =>
    deepseekProvider().stream(model as Model<"openai-completions">, context, {
      ...options,
      apiKey: inputs.apiKey,
      ...(inputs.fetch !== undefined ? { fetch: inputs.fetch } : {}),
      reasoningEffort: LOCKED_REASONING_EFFORT,
    });

  // followUp 注入缝：shouldStopAfterTurn 闭包引用 agent，先落占位再绑定
  // （只在 agent.prompt 运行期被调用，绑定必然先于首调）
  let enqueueFollowUp: (message: AgentMessage) => void = () => {
    throw new Error("internal error: follow-up enqueue invoked before agent construction");
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: inputs.systemPrompt,
      model: reviewModelOf(inputs.modelId, inputs.baseUrl),
      messages: inputs.initialContextMessages.map(toUserMessage),
      tools: agentTools,
    },
    streamFn,
    // DSH 工具批为严格批序执行（审计记录顺序 = 批内顺序）；parallel 模式按完成序落账
    toolExecution: "sequential",
    // 工具预算闸（#54 / ADR-0018 §2.1）：attempt 在模型发出时计数（含被拒
    // 调用），执行预约在放行时同步发生（失败不退还）；超预算调用由
    // beforeToolCall 拦截——工具本体不执行，审计与 wire 应答保持同字节。
    beforeToolCall: async ({ assistantMessage, toolCall, args }) => {
      if (assistantMessage !== currentBatchMessage) {
        currentBatchMessage = assistantMessage;
        currentBatchSeenCalls = 0;
        // 整批 terminate 判定：本批放行后累计尝试达到/超过上限 → 批内全部
        // 结果携带 terminate（pi 语义：批内 every 才生效）。
        currentBatchReachesAttemptCap =
          attemptedToolCalls + countToolCalls(assistantMessage) >= budget.maxToolAttempts;
      }
      currentBatchSeenCalls += 1;
      attemptedToolCalls += 1;
      if (currentBatchReachesAttemptCap && !attemptsExhausted) {
        attemptsExhausted = true;
        appendReason(truncationReasons, TRUNCATION_TOOL_ATTEMPTS);
      }
      const overAttempts = attemptedToolCalls > budget.maxToolAttempts;
      const overExecuted = executedToolCalls >= budget.maxExecutedToolCalls;
      if (overAttempts || overExecuted) {
        phaseSkippedToolCalls += 1;
        const reason = overAttempts
          ? TOOL_ATTEMPTS_EXHAUSTED_SUMMARY
          : TOOL_BUDGET_EXHAUSTED_SUMMARY;
        if (!overAttempts) {
          appendReason(truncationReasons, TRUNCATION_TOOL_BUDGET);
        }
        toolCallLog.push({
          name: fromWireToolName(toolCall.name),
          argumentsJson: JSON.stringify(args),
          resultSummary: reason,
        });
        return {
          block: true,
          reason,
          terminate: overAttempts || currentBatchReachesAttemptCap,
        };
      }
      // 执行预约：放行即计数（失败不退还，防失败死循环）
      executedToolCalls += 1;
      return undefined;
    },
    // 已执行结果补齐批级 terminate（拦截路径在 beforeToolCall 直接带回）；
    // 只认当前批的回复，避免跨批串写
    afterToolCall: async ({ assistantMessage }) =>
      assistantMessage === currentBatchMessage && currentBatchReachesAttemptCap
        ? { terminate: true }
        : undefined,
    onPayload: (payload) => {
      requests.push(auditWireCapture(payload));
      phaseRequestCount += 1;
    },
    shouldStopAfterTurn: (context): boolean => {
      // 取消边界短路（#23 S2）：signal 已中止 → 不再推进阶段（fake 路径的
      // 确定性止步点；真路径 provider signal 已先行中断，此处兜底收口）
      if (inputs.signal?.aborted) {
        return true;
      }
      const message = context.message;
      usage = addUsage(usage, piUsageToLlmUsage(message.usage));
      if (message.content.some((block) => block.type === "toolCall")) {
        // 尝试对账（ADR-0018 §1）：内核即时拒绝的调用（未知工具 / 参数校验
        // 失败）不经过 beforeToolCall，但同样是模型发出的 attempt。
        const seenForMessage = currentBatchMessage === message ? currentBatchSeenCalls : 0;
        attemptedToolCalls += countToolCalls(message) - seenForMessage;
        if (attemptedToolCalls >= budget.maxToolAttempts && !attemptsExhausted) {
          attemptsExhausted = true;
          appendReason(truncationReasons, TRUNCATION_TOOL_ATTEMPTS);
        }
        // 整批都没有经过预算闸（全部被内核即时拒绝）时 terminate 不成立，
        // 收尾指令会滞留 follow-up 队列并污染下一阶段——只在本批全部经闸时
        // 注入。
        const batchFullyGated =
          currentBatchMessage === message && currentBatchSeenCalls === countToolCalls(message);
        if (!attemptsExhausted || !batchFullyGated) {
          return false;
        }
        // 尝试预算耗尽后的工具轮（#54 / ADR-0018 §2.1）：本批已被 terminate，
        // 注入强制收尾指令让模型直接产出阶段 JSON；每阶段至多 2 次。
        if (phaseForcedFinalizations < MAX_FORCED_FINALIZATIONS_PER_PHASE) {
          phaseForcedFinalizations += 1;
          enqueueFollowUp(forcedFinalizationMessage());
          return false;
        }
        // 收尾注入用尽仍只发工具调用 → 以尝试预算耗尽终止
        return stopTruncated(TRUNCATION_TOOL_ATTEMPTS);
      }
      const replyText = assistantText(message);
      // 收尾指令仍不产出文本：以 PHASE_FORCED_INCOMPLETE 终止（#54）
      if (phaseForcedFinalizations > 0 && replyText.trim().length === 0) {
        // #54 审计形态保持：该路径只在 truncated/stopReason 留痕
        return stopTruncated("PHASE_FORCED_INCOMPLETE", false);
      }
      return advancePhase(replyText, enqueueFollowUp);
    },
  });
  enqueueFollowUp = (message) => {
    agent.followUp(message);
  };

  // 进度观测（#23 S2 缝）：phase/round 边界（phase 入口）发射——累计
  // toolCalls/usage 快照；可选链保证未配置时零对象构造、零介入
  const emitProgress = (): void => {
    inputs.onProgress?.({
      phase: phaseNameOf(phaseIndex),
      round,
      toolCalls: executedToolCalls,
      usage,
    });
  };
  emitProgress();

  // 取消接线（#23 S2）：input signal → agent.abort()——pi 内核取消面
  // （Agent.abort 只中止当前 run 的内部 controller；run 间隙触发为安全空操作）
  const onAbort = (): void => {
    agent.abort();
  };
  inputs.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await agent.prompt(phaseInstruction(0));
  } finally {
    inputs.signal?.removeEventListener("abort", onAbort);
  }
  // 取消收口（#23 S2）：prompt 正常返回但 signal 已中止（fake 路径经
  // shouldStopAfterTurn 边界短路止步）→ ReviewAbortedError——半途中止无
  // 对照价值，审计与 RunRecord 均不落盘；先于 error 检查（abort 优先归因）
  if (inputs.signal?.aborted) {
    throw new ReviewAbortedError();
  }

  // pi-ai 对 provider 错误不 reject（resolve 出 stopReason "error" 的消息后
  // agent 即止）：缝必须显式拦截，错误永不静默成一次"成功" run。
  const failed = agent.state.messages.find(
    (message: AgentMessage): message is AssistantMessage =>
      message.role === "assistant" && message.stopReason === "error",
  );
  if (failed !== undefined) {
    throw new Error(
      `review turn failed: ${failed.errorMessage ?? "provider returned an error stop reason"}`,
    );
  }

  // Context Ledger 快照恒投影（E 唯一形态——零工具调用为空数组）；
  // 命中统计只在确有账本查询时落键（零工具 run 审计字节不变，#56）。
  const ledger = inputs.toolkit.ledger.snapshot();
  const ledgerStats = inputs.toolkit.ledger.stats();
  const audit: RunAudit = {
    requests,
    toolCallLog,
    phaseLog,
    rejections,
    cacheBreaks: classifyCacheBreaks(requests),
    truncated,
    truncationReasons,
    ledger,
    ...(ledgerStats.ledgerHits + ledgerStats.ledgerMisses > 0 ? { ledgerStats } : {}),
    // 兜底：模型未声明 complete、也未触达轮次上界即停止（ADR-0018 §2.4
    // 的 MODEL_STOPPED）；正常路径均在 advancePhase 里显式赋值。
    stopReason: stopReason ?? "MODEL_STOPPED",
  };
  return { findings, usage, rounds: round, toolCalls: executedToolCalls, complete, audit };

  /** 文本轮收尾当前阶段并推进；返回值即 shouldStopAfterTurn 的停止判定 */
  function advancePhase(replyText: string, followUp: (message: AgentMessage) => void): boolean {
    const parsed = parsePhaseReply(replyText);
    const notes: string[] = [];
    if (phaseSkippedToolCalls > 0) {
      notes.push(`${phaseSkippedToolCalls} tool call(s) skipped: budget exhausted`);
    }
    if (parsed.note !== undefined) {
      notes.push(parsed.note);
    }
    phaseLog.push({
      round,
      phase: phaseNameOf(phaseIndex),
      requestCount: phaseRequestCount,
      ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
    });

    // 输出预算（#55 / ADR-0018 §2.3）：收到 assistant usage 后累计，只在阶段
    // 边界事后判定——本阶段文本已正常收尾，wire 不新增 max_tokens；超出即
    // 停止后续请求（请求预算的 5/6 阶段保底不豁免输出预算）。
    const outputBudgetExhausted = usage.outputTokens > budget.maxOutputTokens;

    if (phaseIndex < PHASE_COUNT - 1) {
      if (outputBudgetExhausted) {
        return stopTruncated(TRUNCATION_OUTPUT_BUDGET);
      }
      // 请求预算（#55 / ADR-0018 §2.2）：只在阶段边界判定。剩余请求不足以
      // 按常规序推进到裁决时，跳过尚未完成的前四阶段直入候选；候选一旦
      // 开始，裁决允许完成（保底 2 请求），候选→裁决之间不再设请求闸。
      const nextPhaseIndex = phaseIndex + 1;
      const decision = requestBudgetDecision(nextPhaseIndex);
      if (decision === "stop") {
        // 前四阶段内的硬停仍是「跳过」：逐条留痕后再终止
        if (nextPhaseIndex < CANDIDATES_PHASE_INDEX) {
          recordSkippedPhases(
            nextPhaseIndex,
            CANDIDATES_PHASE_INDEX,
            PHASE_SKIPPED_REQUEST_BUDGET_EXHAUSTED_NOTE,
          );
          appendReason(truncationReasons, TRUNCATION_REQUEST_BUDGET_SKIPPED);
        }
        return stopTruncated(TRUNCATION_MAX_REQUESTS);
      }
      if (decision === "skip") {
        recordSkippedPhases(
          nextPhaseIndex,
          CANDIDATES_PHASE_INDEX,
          PHASE_SKIPPED_REQUEST_BUDGET_NOTE,
        );
        appendReason(truncationReasons, TRUNCATION_REQUEST_BUDGET_SKIPPED);
        phaseIndex = CANDIDATES_PHASE_INDEX;
        resetPhaseCounters();
        emitProgress();
        followUp(phaseInstruction(phaseIndex));
        return false;
      }
      phaseIndex = nextPhaseIndex;
      resetPhaseCounters();
      emitProgress();
      followUp(phaseInstruction(phaseIndex));
      return false;
    }

    // Evidence Verification 收尾：候选拦截链 + 轮次决策
    const gate = applyCandidateGate({
      candidates: roundCandidates,
      verdicts: roundVerdicts,
      emittedIds,
      round,
    });
    findings.push(...gate.findings);
    rejections.push(...gate.rejections);
    emittedIds = gate.emittedIds;
    complete = roundComplete;
    if (complete) {
      stopReason = "MODEL_COMPLETE";
      return true;
    }
    if (outputBudgetExhausted) {
      return stopTruncated(TRUNCATION_OUTPUT_BUDGET);
    }
    if (round >= budget.maxRounds) {
      return stopTruncated(TRUNCATION_MAX_ROUNDS);
    }
    // 新一轮的 phase-1 边界同样受请求预算约束：不足常规一轮时直入候选。
    const decision = requestBudgetDecision(0);
    if (decision === "stop") {
      return stopTruncated(TRUNCATION_MAX_REQUESTS);
    }
    // 先推进轮次再留痕：被跳过阶段属于新一轮
    round += 1;
    if (decision === "skip") {
      recordSkippedPhases(0, CANDIDATES_PHASE_INDEX, PHASE_SKIPPED_REQUEST_BUDGET_NOTE);
      appendReason(truncationReasons, TRUNCATION_REQUEST_BUDGET_SKIPPED);
    }
    phaseIndex = decision === "skip" ? CANDIDATES_PHASE_INDEX : 0;
    resetPhaseCounters();
    roundCandidates = [];
    roundVerdicts = new Map();
    roundComplete = false;
    emitProgress();
    followUp(phaseInstruction(phaseIndex));
    return false;
  }

  /**
   * 请求预算阶段边界决策（#55 / ADR-0018 §2.2）：
   * - proceed：按常规序进入下一阶段；
   * - skip：跳过下一阶段…第 4 阶段，直入候选；
   * - stop：连候选/裁决的 2 请求保底都不足，终止 run。
   */
  function requestBudgetDecision(nextPhaseIndex: number): "proceed" | "skip" | "stop" {
    const remainingRequests = budget.maxRequests - requests.length;
    if (nextPhaseIndex < CANDIDATES_PHASE_INDEX) {
      // 常规序从下一阶段到裁决每阶段至少 1 请求
      if (remainingRequests >= PHASE_COUNT - nextPhaseIndex) {
        return "proceed";
      }
      return remainingRequests < FINDINGS_PHASE_REQUEST_FLOOR ? "stop" : "skip";
    }
    if (nextPhaseIndex === CANDIDATES_PHASE_INDEX) {
      return remainingRequests < FINDINGS_PHASE_REQUEST_FLOOR ? "stop" : "proceed";
    }
    // 候选 → 裁决之间：一旦开始允许完成
    return "proceed";
  }

  /**
   * 截断终止单点：truncated 翻转 + stopReason 赋值；默认把同名原因写入
   * truncationReasons（appendReason 去重，事件已留痕时无重复）。
   */
  function stopTruncated(reason: StopReason, recordReason = true): true {
    truncated = true;
    if (recordReason) {
      appendReason(truncationReasons, reason);
    }
    stopReason = reason;
    return true;
  }

  /** 被请求预算跳过的阶段逐条留痕（requestCount = 0；显式标注原因） */
  function recordSkippedPhases(
    fromPhaseIndex: number,
    toExclusive: number,
    note: string,
  ): void {
    for (let index = fromPhaseIndex; index < toExclusive; index += 1) {
      phaseLog.push({
        round,
        phase: phaseNameOf(index),
        requestCount: 0,
        note,
      });
    }
  }

  function parsePhaseReply(replyText: string): { readonly note?: string } {
    if (phaseIndex === CANDIDATES_PHASE_INDEX) {
      const parsed = parseCandidatesReply(replyText);
      roundCandidates = parsed.candidates;
      return parsed.note !== undefined ? { note: parsed.note } : {};
    }
    if (phaseIndex === VERIFICATION_PHASE_INDEX) {
      const parsed = parseVerificationReply(replyText);
      roundVerdicts = parsed.verdicts;
      roundComplete = parsed.complete;
      return parsed.note !== undefined ? { note: parsed.note } : {};
    }
    return {};
  }

  function resetPhaseCounters(): void {
    phaseRequestCount = 0;
    phaseSkippedToolCalls = 0;
    phaseForcedFinalizations = 0;
  }
}

/** LlmMessage → pi-ai UserMessage（timestamp 为内核内部字段，不参与序列化） */
function toUserMessage(message: LlmMessage): AgentMessage {
  if (message.role !== "user") {
    throw new Error(`initial context message must have role "user", got "${message.role}"`);
  }
  return { role: "user", content: message.content, timestamp: 0 };
}

function phaseInstruction(phaseIndex: number): AgentMessage {
  const instruction = PHASE_INSTRUCTIONS[phaseIndex];
  if (instruction === undefined) {
    throw new Error(`missing phase instruction at index ${phaseIndex}`);
  }
  return { role: "user", content: instruction, timestamp: 0 };
}

/** 强制阶段收尾指令（append-only user 消息；#54 / ADR-0018 §2.1） */
function forcedFinalizationMessage(): AgentMessage {
  return { role: "user", content: FORCED_FINALIZATION_INSTRUCTION, timestamp: 0 };
}

function phaseNameOf(phaseIndex: number): PhaseRecord["phase"] {
  const name = PHASE_ORDER[phaseIndex];
  if (name === undefined) {
    throw new Error(`missing phase name at index ${phaseIndex}`);
  }
  return name as PhaseRecord["phase"];
}

/**
 * 审计投影：wire 捕获（tools = wire 下划线名）→ DSH 审计口径（tools = 点分名，
 * 与 requests[].tools 真源同形态；wireBody 原文保持下划线形态不变）。
 */
function auditWireCapture(payload: unknown): WireRequest {
  const wire = captureWire(payload);
  return {
    ...wire,
    tools: wire.tools.map((tool) => ({ ...tool, name: fromWireToolName(tool.name) })),
  };
}

/** 一条 assistant 回复携带的 toolCall 内容块数（= 本批 attempt 数） */
function countToolCalls(message: AssistantMessage): number {
  return message.content.filter((block) => block.type === "toolCall").length;
}

/** schema 已知入参键（prepareArguments 剥未知键的保留集） */function knownArgumentKeys(parameters: Record<string, unknown>): ReadonlySet<string> {
  const properties = parameters.properties;
  if (typeof properties !== "object" || properties === null) {
    return new Set();
  }
  return new Set(Object.keys(properties));
}

function stripUnknownArguments(args: unknown, knownKeys: ReadonlySet<string>): Record<string, unknown> {
  if (typeof args !== "object" || args === null) {
    return {};
  }
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (knownKeys.has(key)) {
      stripped[key] = value;
    }
  }
  return stripped;
}

function appendReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
