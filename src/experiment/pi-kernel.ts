import path from "node:path";
import { runReview, type ReviewRunInput, type ReviewRunResult } from "review-pi";
import type { RunResult } from "../contracts/run.js";
import type { ReviewKernel, UnitReviewRequest } from "./review-kernel.js";

/**
 * pi 内核适配器（#8 P4a 执行缝的 pi 侧）：把 root 的 UnitReviewRequest 装配为
 * review-pi 的 ReviewRunInput，再把 pi RunRecord 映射回 root RunResult。
 *
 * 装配纪律：
 * - persistRecord: false——runner 是记录唯一写者（防双写与孤儿文件）；
 * - model/config 经请求参数逐单元切 preset（内核无关性对照的变量面入口）；
 * - experimentRoot 拆 runsRoot + experimentId（pi 落盘布局同构）；
 * - source 守卫：pi 记录的 source 硬编码 "vul4j"（pi 内核线只评 vul4j），
 *   他源单元 fail fast——不写半截产物，失败由 runner 留痕隔离。
 *
 * 映射纪律（pi record.baseline → root RunResult）：
 * - requests 恒 []：重放字节以审计文件（auditPath）为真源，
 *   root run-store 的 recordToRunResult 同先例；
 * - cacheBreaks 缺省补 []（root RunAudit 必填、pi AuditLight 空时省键）；
 * - model 取 pi 记录的 model（内核实际请求的模型 id——口径诚实护栏的
 *   对账基准，与 plan.model 不符时由 runner 拒绝落盘）。
 *
 * 模块纪律：本模块是 root 程序闭包中唯一 import pi 内核执行入口（runReview）
 * 的位置，且只被 CLI 与测试消费（runner 只依赖 review-kernel.ts 接口模块；
 * cli.ts 另经包入口 import resolveReviewerEndpoint——纯网关配置解析，非内核
 * 执行）——analyze / alignment-gate 等冻结仪器脚本的闭包永不触及 pi 内核。
 */

export interface PiKernelDeps {
  /** 网关 API key（REVIEWER_API_KEY 解析产物；绝不落盘/回显） */
  readonly apiKey: string;
  /** 网关 base URL（REVIEWER_URL 解析产物；缺省官方端点由 pi 内核解析） */
  readonly baseUrl?: string;
  /** 传输层注入（离线测试 = SSE fake；线上 = 真 fetch） */
  readonly fetch: ReviewRunInput["fetch"];
  /** runReview 注入缝（测试桩；缺省真 pi 内核） */
  readonly runReviewFn?: typeof runReview;
}

export function piKernel(deps: PiKernelDeps): ReviewKernel {
  const runReviewFn = deps.runReviewFn ?? runReview;
  return {
    id: "pi",
    execute: async (request) => {
      if (request.unit.source !== "vul4j") {
        throw new Error(
          `pi kernel only runs vul4j units (got source "${request.unit.source}" on ` +
            `${request.unit.caseId}/${request.unit.configId}/rep-${request.unit.rep}): the pi run record ` +
            "hard-codes source \"vul4j\" — run this source on the legacy kernel or extend the record contract first",
        );
      }
      const runsRoot = path.dirname(request.experimentRoot);
      const experimentId = path.basename(request.experimentRoot);
      const result = await runReviewFn({
        caseId: request.unit.caseId,
        repoPath: request.mrCase.repoPath,
        diff: request.mrCase.diff,
        issueDescription: request.mrCase.issueDescription,
        apiKey: deps.apiKey,
        ...(deps.baseUrl !== undefined ? { baseUrl: deps.baseUrl } : {}),
        modelId: request.model,
        configId: request.unit.configId,
        fetch: deps.fetch,
        runsRoot,
        experimentId,
        rep: request.unit.rep,
        persistRecord: false,
      });
      return toRootRunResult(request, result);
    },
  };
}

/** pi RunRecord.baseline → root RunResult（映射纪律见模块注释） */
function toRootRunResult(request: UnitReviewRequest, result: ReviewRunResult): RunResult {
  const snapshot = result.record.baseline;
  return {
    caseId: request.unit.caseId,
    configId: request.unit.configId,
    model: result.record.model,
    findings: snapshot.findings,
    usage: snapshot.usage,
    rounds: snapshot.rounds,
    toolCalls: snapshot.toolCalls,
    audit: {
      requests: [],
      toolCallLog: snapshot.audit.toolCallLog,
      phaseLog: snapshot.audit.phaseLog,
      rejections: snapshot.audit.rejections,
      cacheBreaks: snapshot.audit.cacheBreaks ?? [],
      truncated: snapshot.audit.truncated,
      truncationReasons: snapshot.audit.truncationReasons,
      ...(snapshot.audit.prefetch !== undefined ? { prefetch: snapshot.audit.prefetch } : {}),
      ...(snapshot.audit.fullRepo !== undefined ? { fullRepo: snapshot.audit.fullRepo } : {}),
      ...(snapshot.audit.ledger !== undefined ? { ledger: snapshot.audit.ledger } : {}),
    },
    auditPath: result.auditPath,
  };
}
