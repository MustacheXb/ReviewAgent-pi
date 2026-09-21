import path from "node:path";
import { CONFIGS } from "../contracts/config.js";
import type { LlmClient } from "../contracts/llm-client.js";
import type { MRCase } from "../contracts/mr-case.js";
import type { RunResult } from "../contracts/run.js";
import { DEFAULT_EFFORT, runReview } from "../run/run-review.js";
import type { ReviewKernelId, RunUnit } from "./plan.js";
import { sanitizeCaseId } from "./run-store.js";

/**
 * 内核执行缝（#8 P4a）：runner executeUnit 的可替换执行点——实验面与产品面
 * 共享同一内核协议。config 经请求参数逐单元切 preset（A–E），同一 runner 可
 * 按计划在旧运行时（legacy）与 pi 内核（pi，见 pi-kernel.ts）间切换。
 *
 * 接口纪律（RunResult 同构）：
 * - execute 返回根仓 RunResult——记录组装、口径诚实护栏（model ≡ plan.model）、
 *   审计路径透传全部留在 runner，内核不感知 RunStore；
 * - 审计落盘是内核职责（auditDir/布局由内核自定）；runner 是记录唯一写者
 *   （pi 内核以 persistRecord=false 对应）；
 * - 本模块零 pi 依赖：analyze / alignment-gate 等脚本闭包只经 runner 触达
 *   本接口，永不 import review-pi（pi 适配器在 pi-kernel.ts，仅 CLI 与测试消费）。
 */

/** 单元执行请求（缝契约：runner → 内核的全部输入） */
export interface UnitReviewRequest {
  /** 待执行单元（source/caseId/configId/rep——断点续跑与审计键） */
  readonly unit: RunUnit;
  /** 评测 case（repoPath / diff / issueDescription / labels） */
  readonly mrCase: MRCase;
  /** 检视模型 id（#43 自由 id；口径诚实护栏的对账基准） */
  readonly model: string;
  /** 实验根目录（runs/<experimentId>；审计布局的锚） */
  readonly experimentRoot: string;
}

/** 可替换执行点（id 与 plan.kernel 一致性由 runner 启动守卫检查） */
export interface ReviewKernel {
  readonly id: ReviewKernelId;
  execute(request: UnitReviewRequest): Promise<RunResult>;
}

/**
 * legacy 内核（缺省）：根仓检视运行时（六阶段骨架 + Zone 注入 + 工具箱）。
 * 审计布局与 #8 前的 runner 完全一致：
 * <experimentRoot>/audit/<source>/<safeCaseId>/<configId>/rep-<rep>/。
 */
export function legacyKernel(llmClient: LlmClient): ReviewKernel {
  return {
    id: "legacy",
    execute: (request) =>
      runReview(CONFIGS[request.unit.configId], request.mrCase, llmClient, {
        auditDir: path.join(
          request.experimentRoot,
          "audit",
          request.unit.source,
          sanitizeCaseId(request.unit.caseId),
          request.unit.configId,
          `rep-${request.unit.rep}`,
        ),
        model: request.model,
        effort: DEFAULT_EFFORT,
      }),
  };
}
