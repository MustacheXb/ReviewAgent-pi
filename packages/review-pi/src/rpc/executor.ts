/**
 * #22 S1 executor：ReviewRunExecutor 端口 + fake executor（spec #21 §7.3/§8.2、
 * ADR-0012 决策 3）；#23 S2 交付真适配器 KernelReviewRunExecutor。
 *
 * 端口纪律：executor 是唯一 import 内核执行入口（runReview）的模块。服务层
 * 拥有 job 状态，executor 只负责执行。真适配器职责（spec #21 §7.3）：
 * - 内核参数派生面收敛在此：experimentId 缺省恒 "reviewagent-rpc"（#30 起
 *   经 experimentIdOf 缝可注入按 job 派生）、rep 恒 1、启动期单次解析的
 *   endpoint 凭据、--out resolve 产物 runsRoot；
 * - ReviewRunResult → ReviewRunSummary 本地投影（内核返回类型不改）；
 * - 内核异常合同化：publicMessage 固定 generic 进协议面，诊断细节走
 *   onDiagnostic（缺省 stderr）——绝不进 view（spec §9 安全缝）；
 * - 取消不是失败：ReviewAbortedError 原样透传（service：cancelling → cancelled）。
 */

import type { FetchFunction } from "@earendil-works/pi-ai";
import type { ConfigId } from "../contracts/config.js";
import type { Finding } from "../contracts/finding.js";
import type { LlmUsage } from "../contracts/llm.js";
import type { ReviewerEndpoint } from "../provider/reviewer-endpoint.js";
import { ReviewAbortedError, runReview, type ReviewRunResult } from "../run/review-run.js";

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
 *
 * 与内核 contracts/run.ts 的 ReviewRunProgress 同名不同宽是刻意的：协议观测面
 * phase 放宽为 string，不绑内核相位枚举（S1 service 测试即以自由字符串驱动，
 * 收窄即破零存量测试修改纪律）；内核事件按结构兼容流入（ReviewPhase ⊂ string，
 * 函数参数逆变成立），适配器透传无需转换。
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

// ---- 真适配器（#23 S2）----

/** rpc run 留痕的恒定实验标识（spec §1：审计/记录落 {out}/reviewagent-rpc/...） */
const RPC_EXPERIMENT_ID = "reviewagent-rpc";

export interface KernelReviewRunExecutorOptions {
  /** 启动期单次解析的网关凭据（rpc 进程装配时 fail fast；全程复用，不逐 job 重解析） */
  readonly endpoint: ReviewerEndpoint;
  /** 运行留盘根目录（--out resolve 产物；rep 恒 1） */
  readonly runsRoot: string;
  /**
   * experimentId 派生缝（#30 P3a）：缺省恒 "reviewagent-rpc"（stdio 现状
   * 不变）；sqlite 装配传 identity（jobId）——产物目录 {runsRoot}/{jobId}/…
   * 按 job 隔离，跨 job 互不覆盖（重启重入队重跑覆盖自身，rep 恒 1 语义
   * 不变）。
   */
  readonly experimentIdOf?: (jobId: string) => string;
  /** 传输层注入；缺省 globalThis.fetch（离线测试注入 fake 适配器） */
  readonly fetch?: FetchFunction;
  /** 诊断输出缝（内核异常细节）；缺省写 stderr——绝不进协议面（spec §9） */
  readonly onDiagnostic?: (message: string) => void;
}

/**
 * 真适配器：runReview 的唯一调用方。job 请求面 → 内核输入（参数派生单点），
 * ReviewRunResult → ReviewRunSummary 本地投影，异常合同化（ReviewAbortedError
 * 透传、其余包 ReviewExecutionError 且诊断走 sink）。
 */
export class KernelReviewRunExecutor implements ReviewRunExecutor {
  private readonly endpoint: ReviewerEndpoint;
  private readonly runsRoot: string;
  private readonly experimentIdOf: (jobId: string) => string;
  private readonly fetch: FetchFunction;
  private readonly onDiagnostic: (message: string) => void;

  constructor(options: KernelReviewRunExecutorOptions) {
    this.endpoint = options.endpoint;
    this.runsRoot = options.runsRoot;
    this.experimentIdOf = options.experimentIdOf ?? (() => RPC_EXPERIMENT_ID);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.onDiagnostic =
      options.onDiagnostic ??
      ((message: string) => {
        process.stderr.write(`${message}\n`);
      });
  }

  async execute(request: ReviewRunRequest, ctx: ReviewRunContext): Promise<ReviewRunSummary> {
    try {
      const result = await runReview({
        caseId: request.caseId,
        repoPath: request.repoPath,
        diff: request.diff,
        issueDescription: request.issueDescription,
        configId: request.configId,
        ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
        apiKey: this.endpoint.apiKey,
        baseUrl: this.endpoint.baseUrl,
        fetch: this.fetch,
        runsRoot: this.runsRoot,
        experimentId: this.experimentIdOf(ctx.jobId),
        rep: 1,
        signal: ctx.signal,
        ...(ctx.onProgress !== undefined ? { onProgress: ctx.onProgress } : {}),
      });
      return projectReviewRunSummary(result);
    } catch (error) {
      // 取消不是失败：原样透传（service 的 cancelling 分支收口为 cancelled）
      if (error instanceof ReviewAbortedError) {
        throw error;
      }
      const diagnostic = `review execution failed (job ${ctx.jobId}): ${errorMessage(error)}`;
      this.onDiagnostic(diagnostic);
      // 协议面只见固定 generic 文案；诊断原文留在 Error.message 与 sink 双通道
      throw new ReviewExecutionError("review execution failed", diagnostic);
    }
  }
}

/** ReviewRunResult → ReviewRunSummary 本地投影（内核返回类型不改；磁盘真源为对照） */
function projectReviewRunSummary(result: ReviewRunResult): ReviewRunSummary {
  const baseline = result.record.baseline;
  return {
    runId: result.runId,
    findings: baseline.findings,
    usage: baseline.usage,
    rounds: baseline.rounds,
    toolCalls: baseline.toolCalls,
    truncated: baseline.audit.truncated,
    auditPath: result.auditPath,
    recordPath: result.recordPath,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
