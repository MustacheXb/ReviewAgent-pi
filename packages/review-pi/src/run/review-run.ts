import path from "node:path";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { buildAuditFileContent, buildRunId, writeAuditFile } from "../audit/audit-writer.js";
import { CONFIG_E, type ConfigId } from "../contracts/config.js";
import type { LlmMessage } from "../contracts/llm.js";
import { ReviewAbortedError, type RunResult, type ReviewRunProgress } from "../contracts/run.js";
import { buildRunRecord, writeRunRecord, type RunRecord } from "../experiment/run-record.js";
import { runAgentReviewLoop } from "../loop/agent-review-loop.js";
import { buildInitialUserMessage } from "../loop/messages.js";
import { LOCKED_EFFORT_LABEL, REVIEW_MODEL_ID } from "../provider/pi-client.js";
import { buildReviewToolkit } from "../tools/toolkit.js";
import { SYSTEM_PROMPT } from "../zonea/system-prompt.js";
import { guardMrBoundary } from "./mr-boundary-guard.js";

// S2 内核缝契约再出口（#23）：消费方（rpc executor / 根侧）经内核入口单点
// 取 ReviewAbortedError 与进度事件类型，不直探 contracts 层。
export { ReviewAbortedError } from "../contracts/run.js";
export type { ReviewRunProgress } from "../contracts/run.js";

// 单案全链入口（#3 P1a 离线全链；#6 P3a 起工具驱动 agentLoop）：
// 组装（Zone A + MR）→ agentLoop（七工具 + Context Ledger + 轮次上界）→
// 审计投影落盘。
//
// fake 适配器与真适配器同缝：传输层经注入的 FetchFunction——离线开发/测试
// 注入 fakeFetch（canned SSE），真跑注入真 fetch + baseUrl（企业网关，
// REVIEWER_URL 解析产物），其余链路完全一致。
// 审计留痕口径（#4 密钥纪律）：审计与 RunRecord 只含 model（实际请求的
// 模型 id）与接入行为产物，绝不含 API key。
//
// config 面（#32 / ADR-0014 E-only 生产化）：驱动配置不再是调用方输入——
// 内核恒派生 CONFIG_E（工具驱动 agentLoop + Context Ledger）。历史配置
// 矩阵 A–D（直驱六阶段循环 / 确定性预取 / 全仓注入）已随研究装置根除；
// RunRecord / 处置库的读取面仍接受 A–E 历史记录（回溯锚字段名不变）。

export interface ReviewRunInput {
  readonly caseId: string;
  /** 本地 git 仓库快照路径（base = MR 前版本；工具按需懒加载读取） */
  readonly repoPath: string;
  readonly diff: string;
  readonly issueDescription: string;
  readonly apiKey: string;
  /** 网关 base URL（#4 真跑：REVIEWER_URL 解析产物；缺省官方 api.deepseek.com） */
  readonly baseUrl?: string;
  /** 模型 id（#45 自由 id；缺省钉住的评审模型） */
  readonly modelId?: string;
  /** 传输层注入（离线 = fakeFetch；线上 = 真 fetch） */
  readonly fetch: FetchFunction;
  /** 运行留痕根目录（fixture 或真实 runs/） */
  readonly runsRoot: string;
  /** 实验标识（目录名，如 "phase2-smoke"） */
  readonly experimentId: string;
  readonly rep: number;
  /**
   * 记录落盘开关（#8 runner 执行缝）：缺省 true（内核自写 RunRecord——
   * CLI / e2e 直跑形态）；false = 执行缝模式——runner 是记录唯一写者，
   * 内核不落盘（recordPath 返回空串），审计照常落盘。
   */
  readonly persistRecord?: boolean;
  /** 起始时间戳（测试确定性钩子；缺省当前时间） */
  readonly startedAt?: Date;
  /**
   * 取消信号（#23 S2 rpc 缝）：中止时上抛 ReviewAbortedError——审计与
   * RunRecord 均不落盘（半途中止无对照价值）。内核调 agent.abort() +
   * 回合边界止步。
   */
  readonly signal?: AbortSignal;
  /**
   * 进度观测（#23 S2 rpc 缝）：phase/round 边界（phase 入口）调用。
   * 纯观测——不进 wire、不改消息序；未配置时字节行为不变（缺席省键）。
   */
  readonly onProgress?: (progress: ReviewRunProgress) => void;
}

export interface ReviewRunResult {
  /** run 标识（毫秒时间戳 + 配置 + 用例；审计文件名同源；#7 CLI stdout 契约） */
  readonly runId: string;
  readonly record: RunRecord;
  readonly recordPath: string;
  readonly auditPath: string;
}

export async function runReview(input: ReviewRunInput): Promise<ReviewRunResult> {
  // 取消前置检查（#23 S2）：signal 已中止 → 任何工作（含 toolkit 组装）都不开始
  if (input.signal?.aborted) {
    throw new ReviewAbortedError();
  }
  // 驱动配置单源派生（v3 起）：内核恒 E——CLI / rpc / migration-gate 调用面
  // 不再传配置（协议面已无 configId 字段，ADR-0014 §10）
  const configId = CONFIG_E;
  const startedAt = input.startedAt ?? new Date();
  const modelId = input.modelId ?? REVIEW_MODEL_ID;
  // MR 边界护栏（#12）：纯度量，不触碰请求字节面：界内 degraded=false 全程
  // 零介入（缺席省键），超界/不可度量只追加结果尾键（domainWarning + 审计
  // mrBoundary），照常执行。
  const boundary = guardMrBoundary(input.diff);

  // 初始上下文：MR user 单条（system 走 systemPrompt 通道；Zone B / 预取 /
  // 全仓注入面已随 A–D 根除）
  const initialContextMessages: LlmMessage[] = [
    { role: "user", content: buildInitialUserMessage(input.caseId, input.issueDescription, input.diff) },
  ];

  // 七工具执行面：RepoContext 懒加载（模型不调用工具的 run 不产生仓库读取
  // 成本）；Context Ledger 功能态（E 去重面）
  const toolkit = buildReviewToolkit({
    repoPath: input.repoPath,
    diff: input.diff,
  });
  const outcome = await runAgentReviewLoop({
    systemPrompt: SYSTEM_PROMPT,
    initialContextMessages,
    toolkit,
    apiKey: input.apiKey,
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    fetch: input.fetch,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {}),
  });

  // 审计投影：AuditFileContent（requests[].wireBody 可重放字节）→ RunRecord
  const finishedAt = new Date();
  const runId = buildRunId(startedAt, configId, input.caseId);
  const auditDir = buildAuditDir(input, configId);
  const auditContent = buildAuditFileContent({
    runId,
    caseId: input.caseId,
    configId,
    model: modelId,
    effort: LOCKED_EFFORT_LABEL,
    startedAt,
    finishedAt,
    rounds: outcome.rounds,
    toolCalls: outcome.toolCalls,
    usage: outcome.usage,
    findings: outcome.findings,
    audit: outcome.audit,
    // E 的 ledger 快照经 outcome.audit 透传（恒投影——含空数组形态）
    ...(outcome.audit.ledger !== undefined ? { ledger: outcome.audit.ledger } : {}),
    // 护栏降级留痕（#12）：界内省键（缺席省键纪律——审计键序只在尾部扩展）
    ...(boundary.degraded ? { mrBoundary: boundary.mrBoundary } : {}),
  });
  const auditPath = await writeAuditFile(auditDir, auditContent);

  const result: RunResult = {
    caseId: input.caseId,
    configId,
    model: modelId,
    findings: outcome.findings,
    usage: outcome.usage,
    rounds: outcome.rounds,
    toolCalls: outcome.toolCalls,
    audit: outcome.audit,
    auditPath,
    // 域外显式降级标注（#12）：界内省键（边界内与无护栏时逐字节一致）
    ...(boundary.degraded ? { domainWarning: boundary.domainWarning } : {}),
  };
  const record = buildRunRecord({
    source: "vul4j",
    caseId: input.caseId,
    configId,
    rep: input.rep,
    model: modelId,
    completedAt: finishedAt,
    result,
  });
  const recordPath = await persistRunRecord(input, record);
  return { runId, record, recordPath, auditPath };
}

/**
 * 记录落盘单点：persistRecord=false（执行缝模式）时内核不落盘、返回空串——
 * runner 是记录唯一写者，防双写与孤儿文件。
 */
function persistRunRecord(input: ReviewRunInput, record: RunRecord): Promise<string> {
  if (input.persistRecord === false) {
    return Promise.resolve("");
  }
  return writeRunRecord(input.runsRoot, input.experimentId, record);
}

/** 审计文件目录（落盘位形单点定义） */
function buildAuditDir(input: ReviewRunInput, configId: ConfigId): string {
  return path.join(
    input.runsRoot,
    input.experimentId,
    "audit",
    "vul4j",
    input.caseId,
    configId,
    `rep-${input.rep}`,
    "audit",
  );
}
