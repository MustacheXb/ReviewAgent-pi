import type { RunRecord } from "review-pi";
import type { ReviewKernel } from "../../gate/review-kernel.js";
import type { MRCase } from "../../instrument/contracts/mr-case.js";
import type { AnalysisReport, MatchCounts } from "../analysis/contracts.js";
import type { L2Report } from "../l2/contracts.js";
import type { NoiseFloorReport } from "../l2/calibration.js";

/**
 * Campaign runner 契约（#39 P1 骨架，eval-only）：campaign plan、执行单元、
 * 评测记录 sidecar、judge 链注入缝与环境 manifest。
 *
 * 落位纪律（ADR-0016）：本目录只存在于长期 `eval/bench` 分支；生产入口
 * （`src/cli` / `src/rpc` / `src/server` / `src/run`）不得 import。本目录保持
 * 零网络、零真实执行入口：真实 pi 内核 + judge 链装配在 `src/eval/assembly`
 * （#40，进程入口在 `CAMPAIGN_REAL=1` 门控后调用），由本目录的注入缝消费。
 * 双 arm 配对统计与 L2 门见 `src/eval/l2`（#41），runner 落 `l2-report.json`。
 *
 * N/A 纪律（ADR-0017）：environment 未知字段一律 `null`，不写 0；缺失
 * judge 结果的单元在报告中为 `null`，不记 0。
 */

/** campaign 对照臂规范名（读取 / 报告侧统一词表） */
export const CAMPAIGN_ARMS = ["baseline", "candidate"] as const;

/** 一条对照臂 */
export type CampaignArm = (typeof CAMPAIGN_ARMS)[number];

/** 评测记录对 environment 的引用名（campaign 目录内相对路径） */
export const ENVIRONMENT_REF = "environment.json";

/** campaign 报告 kind（按 arm 分节；每节的 schema 复用只读分析器） */
export const CAMPAIGN_REPORT_KIND = "campaign-report";

/** campaign 报告 schema 版本（golden 测试锁定） */
export const CAMPAIGN_REPORT_SCHEMA_VERSION = 1;

/** campaign plan（`plan.json` 的机读形状；CLI 旗标与文件输入共用） */
export interface CampaignPlan {
  /** campaign id（安全路径段；输出目录名） */
  readonly campaignId: string;
  /** baseline 臂 ref（冻结 tag / commit） */
  readonly baselineRef: string;
  /** candidate 臂 ref（本次优化 commit） */
  readonly candidateRef: string;
  /** cases file（JSON 数组，MRCase 形状） */
  readonly casesFile: string;
  /** 每个 case × arm 的重复次数（1 起） */
  readonly reps: number;
  /** 被测模型 id（E 运行时单源） */
  readonly model: string;
  /** 参跑对照臂（顺序即同 case 同 rep 内的执行顺序） */
  readonly arms: readonly CampaignArm[];
  /** campaign 输出目录（`runs/eval/<campaign-id>`；本 campaign 自有） */
  readonly outputDir: string;
}

/** 展开后的执行单元（E-only：configId 恒 "E"，source 恒 "vul4j"） */
export interface CampaignUnit {
  readonly source: "vul4j";
  readonly caseId: string;
  readonly arm: CampaignArm;
  readonly rep: number;
}

/** cases file 的机读形状（骨架直接消费 MRCase；真值校验在 plan seam） */
export type CampaignCase = MRCase;

/**
 * 评测单元记录（RunRecord + 评测侧 sidecar；评测方案 §8.4）。
 * `configId` 是 E 的历史标签；`evalOnly` 防止与生产 A–D 记录混淆。
 */
export interface EvalRunRecord extends RunRecord {
  readonly campaignId: string;
  readonly arm: CampaignArm;
  readonly evalOnly: true;
  readonly environmentRef: typeof ENVIRONMENT_REF;
}

/** judge 链输入（一个已落盘的评测单元记录 + 对应 case 真值） */
export interface JudgeRequest {
  readonly campaignId: string;
  readonly arm: CampaignArm;
  readonly rep: number;
  readonly mrCase: CampaignCase;
  readonly record: EvalRunRecord;
}

/**
 * judge 链返回：行级计数 + 有界失败留痕（#40）。`anomalies` 是 judge 输出
 * 中越界索引 / 重复占用 / 畸形条目被丢弃的说明，空数组 = 无异常；调用方
 * 必须落盘，不静默吞掉。
 */
export interface JudgeOutcome {
  readonly counts: MatchCounts;
  readonly anomalies: readonly string[];
}

/**
 * judge 链注入缝：返回行级 TP / FP / FN 计数与有界失败留痕。
 * 失败由抛错表达——runner 留痕，不自动重试（VUL4J 评测方案 §失败隔离）。
 */
export interface JudgeClient {
  judge(request: JudgeRequest): Promise<JudgeOutcome>;
}

/** judge 结果落盘形状（`judge/` 目录；`failed` 单元在报告中为 N/A） */
export type JudgeRecord = JudgeRecordBase &
  (
    | {
        readonly status: "judged";
        readonly counts: MatchCounts;
        /** judge 输出有界失败留痕（空数组 = 无异常；旧记录此键可缺省） */
        readonly anomalies?: readonly string[];
      }
    | {
        readonly status: "failed";
        readonly error: string;
      }
  );

/** judge 结果自带的单元身份（`--report-only` 不依赖目录结构推断） */
export interface JudgeRecordBase {
  readonly campaignId: string;
  readonly source: "vul4j";
  readonly caseId: string;
  readonly arm: CampaignArm;
  readonly rep: number;
  readonly completedAt: string;
}

/** 单元失败留痕阶段：内核执行 / judge 链 / 记录落盘（单源词表） */
export const CAMPAIGN_FAILURE_STAGES = ["kernel", "judge", "record"] as const;

export type CampaignFailureStage = (typeof CAMPAIGN_FAILURE_STAGES)[number];

/** 单元级失败留痕（`failures.json`；不拖垮整批，不静默剔除） */
export interface CampaignFailure {
  readonly campaignId: string;
  readonly source: "vul4j";
  readonly caseId: string;
  readonly arm: CampaignArm;
  readonly rep: number;
  readonly stage: CampaignFailureStage;
  readonly error: string;
  readonly at: string;
}

/** 网关缓存探针结果（附录 B.3；未知 → null，不写 0） */
export interface CacheProbe {
  readonly hitRate: number | null;
  readonly blockAligned: boolean | null;
}

/**
 * 环境 provenance 输入面（附录 B.3）。调用侧（CLI / 真实装配）提供已知值，
 * 未知值一律 `null`；`campaignId` / `dataset` / `evaluation.campaign` 由
 * runner 单源补齐。
 */
export interface CampaignEnvironmentInput {
  readonly evaluation: {
    readonly branch: string | null;
    readonly calibrationRef: string | null;
  };
  readonly git: {
    readonly branch: string | null;
    readonly commit: string | null;
    readonly tag: string | null;
  };
  readonly runtime: {
    readonly node: string | null;
    readonly os: string | null;
    readonly machine: string | null;
  };
  readonly model: {
    readonly requestedId: string;
    readonly actualDeployment: string | null;
    readonly providerClass: string | null;
    readonly baseUrlClass: string | null;
  };
  readonly gateway: {
    readonly cacheProbeBefore: CacheProbe | null;
    readonly cacheProbeAfter: CacheProbe | null;
  };
  readonly judge: {
    readonly model: string | null;
    readonly promptVersion: string | null;
    readonly temperature: number | null;
    readonly topP: number | null;
  };
  readonly prompts: {
    readonly zoneA: string | null;
    readonly toolsSchema: string | null;
  };
  readonly claudeCode: {
    readonly cliVersion: string | null;
    readonly requestedModel: string | null;
    readonly actualModels: readonly string[] | null;
    readonly maxTurns: number | null;
  };
  readonly window: {
    readonly start: string | null;
    readonly end: string | null;
    readonly timezone: string | null;
  };
}

/** `environment.json` 机读形状（B.3；key 不落盘） */
export interface EnvironmentManifest extends CampaignEnvironmentInput {
  readonly campaignId: string;
  readonly evaluation: {
    readonly branch: string | null;
    readonly campaign: string;
    readonly calibrationRef: string | null;
  };
  readonly dataset: {
    readonly casesFile: string;
    readonly caseCount: number;
    readonly hash: string;
  };
}

/** 记录 / judge 留痕落盘超时缺省（#40 冒烟事故：无界写盘曾挂起 90 分钟） */
export const DEFAULT_IO_TIMEOUT_MS = 60_000;

/** runner 注入面：fake / 真实内核 + judge 链 + 时钟（测试用固定值） */
export interface CampaignDeps {
  readonly kernel: ReviewKernel;
  /**
   * 按 arm 路由的内核（#41 双 arm 代码对照注入缝）：baseline / candidate
   * 处于不同 commit 时各提供一个运行器；未提供时两臂共用 `kernel`（同代码
   * 校准 / fake 测试）。真实装配默认只有当前 checkout 的 kernel。
   */
  readonly armKernels?: Partial<Readonly<Record<CampaignArm, ReviewKernel>>>;
  readonly judge: JudgeClient;
  /** 记录 / 失败 / 环境时间戳来源；缺省真实时钟 */
  readonly now?: () => string;
  /**
   * 单单元内核超时（毫秒；#40）。缺省不限（fake / 离线路径零等待）。
   * 超时按 kernel 阶段留痕，继续下一单元——真实网络挂起不拖垮整批。
   */
  readonly kernelTimeoutMs?: number;
  /** 单单元 judge 超时（毫秒；#40）。缺省不限；超时按 judge 阶段留痕。 */
  readonly judgeTimeoutMs?: number;
  /**
   * 记录 / judge 留痕 / failures 落盘超时（毫秒；#40）。缺省 60s。
   * 覆盖 kernel 返回之后、judge 之前的写盘窗口——该窗口无界曾导致整批静默挂起。
   */
  readonly ioTimeoutMs?: number;
}

/** 一次 campaign 运行的输入 */
export interface RunCampaignOptions {
  readonly plan: CampaignPlan;
  readonly environment: CampaignEnvironmentInput;
  /**
   * 相对 `repoPath` 的解析基准（#40；缺省 process.cwd）。只影响送入内核的
   * 请求，不改 cases 原始字节 / 记录 / 数据集 hash——证据面保持可复算。
   */
  readonly repoRoot?: string;
  /**
   * 进度回调（#40 事故诊断）：单元开始 / kernel 完成 / 记录落盘 / judge
   * 完成 / 单元失败。回调异常不影响运行（诊断面 best-effort）；进程入口用
   * 它写 `progress.log` 并驱动无进度看门狗。
   */
  readonly progress?: (event: string) => void;
}

/**
 * campaign 报告：按 arm 分节，每节是 main 只读分析器的 `AnalysisReport`
 * （kind `run-record-analysis`）。分析器按 `source|caseId|configId|rep`
 * 去重且不含 arm，合并两臂会撞唯一键——因此 campaign 层分节，配对统计与
 * L2 门由 `src/eval/l2`（#41）消费两侧分节报告（输出 `l2-report.json`）。
 */
export interface CampaignReport {
  readonly kind: typeof CAMPAIGN_REPORT_KIND;
  readonly schemaVersion: typeof CAMPAIGN_REPORT_SCHEMA_VERSION;
  readonly campaignId: string;
  /** 仅包含实际有记录的 arm（key 按 CAMPAIGN_ARMS 规范序） */
  readonly arms: Readonly<Partial<Record<CampaignArm, AnalysisReport>>>;
}

/** 一次 campaign 运行的结果（全部已落盘；内存副本供 CLI / 测试消费） */
export interface CampaignRunResult {
  readonly outDir: string;
  readonly units: readonly CampaignUnit[];
  readonly records: readonly EvalRunRecord[];
  readonly failures: readonly CampaignFailure[];
  readonly environment: EnvironmentManifest;
  readonly report: CampaignReport;
  /** L2 配对回归报告（#41；同时落盘 `l2-report.json`） */
  readonly l2: L2Report;
  /** 空对照校准噪声底报告（#42；仅 calibration campaign 落盘，否则 null） */
  readonly noiseFloor: NoiseFloorReport | null;
}
