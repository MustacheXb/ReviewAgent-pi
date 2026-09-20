import path from "node:path";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { buildAuditFileContent, buildRunId, writeAuditFile } from "../audit/audit-writer.js";
import { CONFIGS, type ConfigId, type ReviewConfig } from "../contracts/config.js";
import type { LlmMessage } from "../contracts/llm.js";
import { DEFAULT_PREFETCH_BUDGETS } from "../contracts/prefetch.js";
import type { RunResult } from "../contracts/run.js";
import { buildRunRecord, writeRunRecord, type RunRecord } from "../experiment/run-record.js";
import { runAgentReviewLoop } from "../loop/agent-review-loop.js";
import { buildInitialContextMessages, buildInitialUserMessage } from "../loop/messages.js";
import { runReviewLoop, type ReviewTurnRunner } from "../loop/review-loop.js";
import { LOCKED_EFFORT_LABEL, REVIEW_MODEL_ID, runReviewTurn } from "../provider/pi-client.js";
import { piUsageToLlmUsage } from "../provider/usage-map.js";
import { buildReviewToolkit } from "../tools/toolkit.js";
import { SYSTEM_PROMPT } from "../zonea/system-prompt.js";
import {
  DEFAULT_FULL_REPO_BUDGET_CHARS,
  buildFullRepoInjection,
  type FullRepoInjection,
} from "../zoneb/full-repo-injection.js";
import { loadRepoContext, type RepoContext } from "../zoneb/repo-context.js";
import { buildPrefetchContext, type PrefetchContext } from "../zoneb/prefetch.js";

// 单案全链入口（#3 P1a 离线全链；#4 起真跑同缝泛化；#5 起 config A/B 双驱；
// #6 P3a 起 C/D/E 工具驱动 agentLoop）：
// 组装（Zone A/B/C + 预取 / 全仓注入）→ 六阶段循环（pi-ai 序列化缝；C/D/E
// 跑 pi-agent-core Agent + 三钩子）→ 审计投影落盘。
//
// fake 适配器与真适配器同缝：传输层经注入的 FetchFunction——离线开发/测试
// 注入 fakeFetch（canned SSE），真跑注入真 fetch + baseUrl（企业网关，
// REVIEWER_URL 解析产物），其余链路完全一致。
// 审计留痕口径（#4 密钥纪律）：审计与 RunRecord 只含 model（实际请求的
// 模型 id）与接入行为产物，绝不含 API key。
//
// config 面：A = 零工具 + 零预取；B = 零工具 + 确定性预取；
// C/D/E = 工具驱动 agentLoop（七工具 + 轮次上界；C 加全仓注入、E 加
// Context Ledger）。prefetch 注入缝仅 B（A 与 C/D/E 均与预取注入互斥）。

export interface ReviewRunInput {
  readonly caseId: string;
  /** 本地 git 仓库快照路径（base = MR 前版本；config A 不读仓库） */
  readonly repoPath: string;
  readonly diff: string;
  readonly issueDescription: string;
  readonly apiKey: string;
  /** 驱动配置（缺省 B；A/B 之外未实装） */
  readonly configId?: ConfigId;
  /** 预取注入（仅 config B;缺省现场计算;门缓存缝） */
  readonly prefetch?: PrefetchContext;
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
  /** 起始时间戳（测试确定性钩子；缺省当前时间） */
  readonly startedAt?: Date;
}

export interface ReviewRunResult {
  /** run 标识（毫秒时间戳 + 配置 + 用例；审计文件名同源；#7 CLI stdout 契约） */
  readonly runId: string;
  readonly record: RunRecord;
  readonly recordPath: string;
  readonly auditPath: string;
}

export async function runReview(input: ReviewRunInput): Promise<ReviewRunResult> {
  const configId = input.configId ?? "B";
  const config = CONFIGS[configId];
  const startedAt = input.startedAt ?? new Date();
  const modelId = input.modelId ?? REVIEW_MODEL_ID;
  if (config.toolsEnabled) {
    return runToolDrivenReview(input, configId, config, startedAt, modelId);
  }
  if (input.prefetch !== undefined && !config.prefetch) {
    throw new Error(
      `config A runs zero-prefetch; passing a prefetch injection alongside config A is contradictory`,
    );
  }

  // config B 组装：确定性预取管线（Zone B + Symbol/Reference/Call Chain 三层）。
  // 预取可注入（门跨 rep 复用同案缓存;同一仓库 + 同一 diff → 字节级相同）。
  // config A 零预取——不计算也不注入（预取产物只服务 B 的组装面）。
  const prefetch =
    input.prefetch !== undefined
      ? input.prefetch
      : config.prefetch
        ? await buildPrefetchContext({
            repoPath: input.repoPath,
            diff: input.diff,
            budgets: DEFAULT_PREFETCH_BUDGETS,
          })
        : undefined;
  const initialContextMessages = buildInitialContextMessages({
    ...(prefetch !== undefined ? { zoneB: prefetch.zoneBMessage } : {}),
    mrUserContent: buildInitialUserMessage(input.caseId, input.issueDescription, input.diff),
    ...(prefetch !== undefined ? { prefetch: prefetch.layerMessages } : {}),
  });

  // 六阶段循环：每回合经 pi-ai 序列化缝（真 provider + 真 SDK 序列化路径）
  const runTurn: ReviewTurnRunner = async (context) => {
    const { message, wire } = await runReviewTurn({
      context,
      apiKey: input.apiKey,
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      fetch: input.fetch,
    });
    return { message, wire, usage: piUsageToLlmUsage(message.usage) };
  };
  const outcome = await runReviewLoop({
    systemPrompt: SYSTEM_PROMPT,
    initialContextMessages,
    ...(prefetch !== undefined ? { prefetchRecords: prefetch.records } : {}),
    runTurn,
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
    ...(prefetch !== undefined ? { prefetch: prefetch.records } : {}),
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
  const recordPath = await writeRunRecord(input.runsRoot, input.experimentId, record);
  return { runId, record, recordPath, auditPath };
}

/** 审计文件目录（A/B 与 C/D/E 共用落盘位形——单点定义防单侧改漏） */
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

/**
 * C/D/E 工具驱动路径（#6 P3a）：初始上下文（MR + config C 全仓注入）→
 * pi-agent-core Agent 三钩子循环（七工具 + 轮次上界 + Ledger）→ 审计投影。
 * 与 A/B 路径共用 runId / 落盘三件套；审计键按配置扩展（C: fullRepo、
 * E: ledger——DSH 真源同位键）。
 */
async function runToolDrivenReview(
  input: ReviewRunInput,
  configId: ConfigId,
  config: ReviewConfig,
  startedAt: Date,
  modelId: string,
): Promise<ReviewRunResult> {
  if (input.prefetch !== undefined) {
    throw new Error(
      `config ${configId} runs the tool-driven agent loop; passing a prefetch injection alongside config ${configId} is contradictory`,
    );
  }

  // config C：全仓注入（run 级上下文，追加在 MR 之后）；与工具读仓共享
  // 一次 RepoContext 加载（全仓注入必读仓，懒加载缝在此收拢）
  let repo: RepoContext | undefined;
  let fullRepo: FullRepoInjection | undefined;
  if (config.fullRepo) {
    repo = await loadRepoContext(input.repoPath);
    fullRepo = await buildFullRepoInjection({
      repo,
      budgetChars: DEFAULT_FULL_REPO_BUDGET_CHARS,
    });
  }
  const initialContextMessages: LlmMessage[] = [
    { role: "user", content: buildInitialUserMessage(input.caseId, input.issueDescription, input.diff) },
    ...(fullRepo !== undefined ? [fullRepo.message] : []),
  ];

  const toolkit = buildReviewToolkit({
    repoPath: input.repoPath,
    diff: input.diff,
    ...(repo !== undefined ? { repo } : {}),
    ledgerMode: config.ledger ? "enabled" : "inert",
  });
  const outcome = await runAgentReviewLoop({
    systemPrompt: SYSTEM_PROMPT,
    initialContextMessages,
    toolkit,
    apiKey: input.apiKey,
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    fetch: input.fetch,
    includeLedgerAudit: config.ledger,
  });

  // 审计投影：fullRepo 记账并入 RunAudit（AuditLight/审计文件同源投影）
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
    ...(fullRepo !== undefined ? { fullRepo: fullRepo.record } : {}),
    // E 的 ledger 快照经 outcome.audit 透传（恒投影——含空数组形态）
    ...(outcome.audit.ledger !== undefined ? { ledger: outcome.audit.ledger } : {}),
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
    audit: {
      ...outcome.audit,
      ...(fullRepo !== undefined ? { fullRepo: fullRepo.record } : {}),
    },
    auditPath,
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
  const recordPath = await writeRunRecord(input.runsRoot, input.experimentId, record);
  return { runId, record, recordPath, auditPath };
}
