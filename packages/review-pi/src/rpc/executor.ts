/**
 * #22 S1 executor：ReviewRunExecutor 端口 + fake executor（spec #21 §7.3/§8.2、
 * ADR-0012 决策 3）。
 *
 * 端口纪律：executor 是唯一 import 内核执行入口（runReview）的模块——S1 全程
 * 用 fake，真适配器（ReviewRunResult → ReviewRunSummary 本地投影）随 S2 内核
 * signal/onProgress 缝交付。服务层拥有 job 状态，executor 只负责执行。
 */

import type { ConfigId } from "../contracts/config.js";
import type { Finding } from "../contracts/finding.js";
import type { LlmUsage } from "../contracts/llm.js";

/** 执行请求：SubmitReviewParams 的执行视图（repoPath 已由 service 层 resolve + allowlist 校验） */
export interface ReviewRunRequest {
  readonly caseId: string;
  readonly repoPath: string;
  readonly diff: string;
  /** 内核面必填 string；service 层对省略补齐空串（spec §5） */
  readonly issueDescription: string;
  readonly configId: ConfigId;
  readonly modelId?: string;
}

/**
 * 执行进度观测：内核 onProgress 缝（S2 接线）的观测事件。
 * service 以 phase/round 边界判定事件粒度（拍板 2026-10-21：不逐 toolCall 发射），
 * usage 为累计快照（可选——A/B 直驱路径未必有工具轮次口径）。
 */
export interface ReviewRunProgress {
  readonly phase: string;
  readonly round: number;
  readonly toolCalls: number;
  readonly usage?: LlmUsage;
}

/** 执行结果摘要：S2 适配器从内核 ReviewRunResult 本地投影（不改内核返回类型） */
export interface ReviewRunSummary {
  readonly runId: string;
  /** 原始英文源 findings（拍板：ADR-0010 呈现投影不进机对机协议） */
  readonly findings: readonly Finding[];
  readonly usage: LlmUsage;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly truncated: boolean;
  readonly auditPath: string;
  readonly recordPath: string;
}

export interface ReviewRunContext {
  readonly jobId: string;
  /** running cancel 的内核缝（S2：A/B 透传 provider signal；C/D/E 调 agent.abort()） */
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: ReviewRunProgress) => void;
}

export interface ReviewRunExecutor {
  execute(request: ReviewRunRequest, ctx: ReviewRunContext): Promise<ReviewRunSummary>;
}

/**
 * 执行侧错误合同（spec §9 安全缝）：publicMessage 是唯一进协议面
 * （view.error.message）的文案；诊断细节（路径/网关 URL/内部堆栈）留在
 * diagnosticMessage，S2 适配器写 stderr 日志，绝不进 view。
 * service 对非合同异常一律用固定 generic 文案兜底（不透传异常文本）。
 */
export class ReviewExecutionError extends Error {
  /** 协议面安全文案（自有措辞，非异常原文） */
  readonly publicMessage: string;

  constructor(publicMessage: string, diagnosticMessage?: string) {
    super(diagnosticMessage ?? publicMessage);
    this.name = "ReviewExecutionError";
    this.publicMessage = publicMessage;
  }
}

/** fake 摘要工厂：测试断言用基准值 + 按需覆写 */
export function fakeReviewRunSummary(overrides: Partial<ReviewRunSummary> = {}): ReviewRunSummary {
  return {
    runId: "run-fake-1",
    findings: [],
    usage: { inputTokens: 100, outputTokens: 50 },
    rounds: 3,
    toolCalls: 2,
    truncated: false,
    auditPath: "audit-fake.json",
    recordPath: "record-fake.json",
    ...overrides,
  };
}

/** 一次 fake 执行的受控句柄：测试按需 resolve / reject / 读 ctx */
export interface FakeExecution {
  readonly request: ReviewRunRequest;
  readonly ctx: ReviewRunContext;
  resolve(summary: ReviewRunSummary): void;
  reject(error: unknown): void;
}

/**
 * Fake executor：execute 永远挂起等待测试裁决——不做任何语义决策（abort 响应、
 * 进度节奏全部由测试驱动），避免 fake 反推实现。
 */
export class FakeReviewRunExecutor implements ReviewRunExecutor {
  readonly executions: FakeExecution[] = [];

  execute(request: ReviewRunRequest, ctx: ReviewRunContext): Promise<ReviewRunSummary> {
    return new Promise<ReviewRunSummary>((resolve, reject) => {
      this.executions.push({ request, ctx, resolve, reject });
    });
  }
}
