import path from "node:path";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { buildAuditFileContent, buildRunId, writeAuditFile } from "../audit/audit-writer.js";
import type { ConfigId } from "../contracts/config.js";
import { DEFAULT_PREFETCH_BUDGETS } from "../contracts/prefetch.js";
import type { RunResult } from "../contracts/run.js";
import { buildRunRecord, writeRunRecord, type RunRecord } from "../experiment/run-record.js";
import { buildInitialContextMessages, buildInitialUserMessage } from "../loop/messages.js";
import { runReviewLoop, type ReviewTurnRunner } from "../loop/review-loop.js";
import { LOCKED_EFFORT_LABEL, REVIEW_MODEL_ID, runReviewTurn } from "../provider/pi-client.js";
import { piUsageToLlmUsage } from "../provider/usage-map.js";
import { SYSTEM_PROMPT } from "../zonea/system-prompt.js";
import { buildPrefetchContext } from "../zoneb/prefetch.js";

// P1a 离线全链入口（#3）：单案 × config B（零工具 + 确定性预取）。
// 组装（Zone A/B/C + 预取）→ 六阶段循环（pi-ai 序列化缝）→ 审计投影落盘。
//
// fake 适配器与真适配器同缝：传输层经注入的 FetchFunction——离线开发/测试
// 注入 fakeFetch（canned SSE），线上注入真 fetch，其余链路完全一致。

/** P1a 驱动的唯一配置：config B（零工具 + 预取管线） */
const CONFIG_B: ConfigId = "B";

export interface OfflineReviewInput {
  readonly caseId: string;
  /** 本地 git 仓库快照路径（base = MR 前版本） */
  readonly repoPath: string;
  readonly diff: string;
  readonly issueDescription: string;
  readonly apiKey: string;
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

export interface OfflineReviewResult {
  readonly record: RunRecord;
  readonly recordPath: string;
  readonly auditPath: string;
}

export async function runOfflineReview(input: OfflineReviewInput): Promise<OfflineReviewResult> {
  const startedAt = input.startedAt ?? new Date();

  // config B 组装：确定性预取管线（Zone B + Symbol/Reference/Call Chain 三层）
  const prefetch = await buildPrefetchContext({
    repoPath: input.repoPath,
    diff: input.diff,
    budgets: DEFAULT_PREFETCH_BUDGETS,
  });
  const initialContextMessages = buildInitialContextMessages({
    zoneB: prefetch.zoneBMessage,
    mrUserContent: buildInitialUserMessage(input.caseId, input.issueDescription, input.diff),
    prefetch: prefetch.layerMessages,
  });

  // 六阶段循环：每回合经 pi-ai 序列化缝（真 provider + 真 SDK 序列化路径）
  const runTurn: ReviewTurnRunner = async (context) => {
    const { message, wire } = await runReviewTurn({
      context,
      apiKey: input.apiKey,
      fetch: input.fetch,
    });
    return { message, wire, usage: piUsageToLlmUsage(message.usage) };
  };
  const outcome = await runReviewLoop({
    systemPrompt: SYSTEM_PROMPT,
    initialContextMessages,
    prefetchRecords: prefetch.records,
    runTurn,
  });

  // 审计投影：AuditFileContent（requests[].wireBody 可重放字节）→ RunRecord
  const finishedAt = new Date();
  const runId = buildRunId(startedAt, CONFIG_B, input.caseId);
  const auditDir = path.join(
    input.runsRoot,
    input.experimentId,
    "audit",
    "vul4j",
    input.caseId,
    CONFIG_B,
    `rep-${input.rep}`,
    "audit",
  );
  const auditContent = buildAuditFileContent({
    runId,
    caseId: input.caseId,
    configId: CONFIG_B,
    model: REVIEW_MODEL_ID,
    effort: LOCKED_EFFORT_LABEL,
    startedAt,
    finishedAt,
    rounds: outcome.rounds,
    toolCalls: outcome.toolCalls,
    usage: outcome.usage,
    findings: outcome.findings,
    audit: outcome.audit,
    prefetch: prefetch.records,
  });
  const auditPath = await writeAuditFile(auditDir, auditContent);

  const result: RunResult = {
    caseId: input.caseId,
    configId: CONFIG_B,
    model: REVIEW_MODEL_ID,
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
    configId: CONFIG_B,
    rep: input.rep,
    model: REVIEW_MODEL_ID,
    completedAt: finishedAt,
    result,
  });
  const recordPath = await writeRunRecord(input.runsRoot, input.experimentId, record);
  return { record, recordPath, auditPath };
}
