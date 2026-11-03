import type { ConfigId } from "../instrument/contracts/config.js";
import type { MRCase } from "../instrument/contracts/mr-case.js";
import type { RunResult } from "../instrument/contracts/run.js";

/**
 * 内核执行缝（#8 P4a 立 / #9 P4b 收口到单一内核；#32 随评测装置删除落位
 * src/gate）：runMigrationGate 的可替换执行点——迁移门与历史实验 runner 共用
 * 同一内核协议。P4b（#9）起唯一在位内核 = pi（pi-kernel.ts 适配
 * packages/review-pi）；legacy 只作历史计划（#8 前 plan.json）的读侧值，
 * 执行被守卫拒绝，不再复活旧实现。
 *
 * 接口纪律（RunResult 同构）：
 * - execute 返回根仓 RunResult——记录组装、口径诚实护栏（model ≡ 目标模型）、
 *   审计路径透传全部留在调用侧（migration-gate），内核不感知 RunStore；
 * - 审计落盘是内核职责（auditDir/布局由内核自定）；调用侧是记录唯一写者
 *   （pi 内核以 persistRecord=false 对应）；
 * - 本模块零 pi 依赖：门逻辑只经本接口触达内核，永不 import review-pi
 *   （pi 适配器在 pi-kernel.ts，仅 scripts/run-migration-gate.ts 装配与测试
 *   消费）。
 *
 * 值类型迁移注（#32）：EXPERIMENT_SOURCES / ExperimentSource / RunUnit /
 * ReviewKernelId 原落 experiment/plan.ts（防 plan ↔ review-kernel 循环引用）；
 * 评测计划面删除后随缝迁入本模块（plan 已不存在，循环不复存在）——命名保留
 * 历史缝词汇（与 RunRecord 审计目录骨架 runs/<source>/<caseId>/<configId>/
 * rep-<rep> 同构；历史 A-D 值域经 ConfigId 只读兼容保留）。
 */

/** 数据源规范名（与 MRCase.labels.source 的词表一致；迁移门单案恒 "vul4j"） */
export const EXPERIMENT_SOURCES = ["defects4j", "vul4j", "msb-java", "clean-mr"] as const;
export type ExperimentSource = (typeof EXPERIMENT_SOURCES)[number];

/**
 * 检视内核 id：pi = vendored pi 内核（packages/review-pi，ADR-0009 从 0 重写）
 * ——P4b 起唯一可执行值；legacy = 根仓检视运行时的历史值（六阶段骨架 + Zone
 * 注入 + 工具箱 + DeepSeek 客户端，已整批退役）——只作历史计划的读侧值。
 */
export type ReviewKernelId = "legacy" | "pi";

/** 一次检视运行单元（source/caseId/configId/rep——审计键与目录骨架） */
export interface RunUnit {
  readonly source: ExperimentSource;
  readonly caseId: string;
  readonly configId: ConfigId;
  /** 重复运行序（1 起；迁移门恒 1） */
  readonly rep: number;
}

/** 单元执行请求（缝契约：调用侧 → 内核的全部输入） */
export interface UnitReviewRequest {
  /** 待执行单元（source/caseId/configId/rep——审计键；生产恒 configId "E"） */
  readonly unit: RunUnit;
  /** 评测 case（repoPath / diff / issueDescription / labels） */
  readonly mrCase: MRCase;
  /** 检视模型 id（#43 自由 id；口径诚实护栏的对账基准） */
  readonly model: string;
  /** 审计根目录（runs/<experimentId>；审计布局的锚） */
  readonly experimentRoot: string;
}

/** 可替换执行点（id 一致性由装配侧守卫检查） */
export interface ReviewKernel {
  readonly id: ReviewKernelId;
  execute(request: UnitReviewRequest): Promise<RunResult>;
}
