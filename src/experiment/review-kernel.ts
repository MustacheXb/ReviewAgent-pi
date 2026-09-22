import type { MRCase } from "../instrument/contracts/mr-case.js";
import type { RunResult } from "../instrument/contracts/run.js";
import type { ReviewKernelId, RunUnit } from "./plan.js";

/**
 * 内核执行缝（#8 P4a 立 / #9 P4b 收口到单一内核）：runner executeUnit 的
 * 可替换执行点——实验面与产品面共享同一内核协议。config 经请求参数逐单元
 * 切 preset（A–E）。
 *
 * P4b（#9）起仓库收敛到单一内核：legacy 实现（根仓检视运行时，六阶段骨架
 * + Zone 注入 + 工具箱 + DeepSeek 客户端）已整批退役，唯一在位内核 = pi
 * （pi-kernel.ts 适配 packages/review-pi）。缝保留——内核身份仍是 plan.kernel
 * 的对账维度（断点续跑一致性守卫），未来内核仍经此接入，不再复活旧实现。
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
