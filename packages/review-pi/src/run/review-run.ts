import path from "node:path";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { buildAuditFileContent, buildRunId, writeAuditFile } from "../audit/audit-writer.js";
import { CONFIGS, type ConfigId } from "../contracts/config.js";
import { DEFAULT_PREFETCH_BUDGETS } from "../contracts/prefetch.js";
import type { RunResult } from "../contracts/run.js";
import { buildRunRecord, writeRunRecord, type RunRecord } from "../experiment/run-record.js";
import { buildInitialContextMessages, buildInitialUserMessage } from "../loop/messages.js";
import { runReviewLoop, type ReviewTurnRunner } from "../loop/review-loop.js";
import { LOCKED_EFFORT_LABEL, REVIEW_MODEL_ID, runReviewTurn } from "../provider/pi-client.js";
import { piUsageToLlmUsage } from "../provider/usage-map.js";
import { SYSTEM_PROMPT } from "../zonea/system-prompt.js";
import { buildPrefetchContext, type PrefetchContext } from "../zoneb/prefetch.js";

// 单案全链入口（#3 P1a 离线全链；#4 起真跑同缝泛化；#5 起 config A/B 双驱）：
// 组装（Zone A/B/C + 预取）→ 六阶段循环（pi-ai 序列化缝）→ 审计投影落盘。
//
// fake 适配器与真适配器同缝：传输层经注入的 FetchFunction——离线开发/测试
// 注入 fakeFetch（canned SSE），真跑注入真 fetch + baseUrl（企业网关，
// REVIEWER_URL 解析产物），其余链路完全一致。
// 审计留痕口径（#4 密钥纪律）：审计与 RunRecord 只含 model（实际请求的
// 模型 id）与接入行为产物，绝不含 API key。
//
// config 面（#5 P2 字节门）:A = 零工具 + 零预取(req0 = Zone A + MR +
// Phase-1 三条);B = 零工具 + 确定性预取。C/D/E = P3 agentLoop,未实装。
// prefetch 注入缝:B 可注入预算取产物(门跨 rep 复用同案缓存);A 与预取
// 注入互斥(矛盾输入 fail fast)。

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
  readonly record: RunRecord;
  readonly recordPath: string;
  readonly auditPath: string;
}

export async function runReview(input: ReviewRunInput): Promise<ReviewRunResult> {
  const configId = input.configId ?? "B";
  const config = CONFIGS[configId];
  if (config.toolsEnabled) {
    throw new Error(
      `config ${configId} requires the P3 agent loop (tools/full-repo/ledger), which is not implemented; ` +
        `this entry drives A (zero-prefetch) and B (deterministic prefetch) only`,
    );
  }
  if (input.prefetch !== undefined && !config.prefetch) {
    throw new Error(
      `config A runs zero-prefetch; passing a prefetch injection alongside config A is contradictory`,
    );
  }
  const startedAt = input.startedAt ?? new Date();
  const modelId = input.modelId ?? REVIEW_MODEL_ID;

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
  const auditDir = path.join(
    input.runsRoot,
    input.experimentId,
    "audit",
    "vul4j",
    input.caseId,
    configId,
    `rep-${input.rep}`,
    "audit",
  );
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
  return { record, recordPath, auditPath };
}
