/**
 * #29 P2b：HTTP 面的 job 视图投影（ADR-0013 决策 8——API 只回逻辑引用，
 * 不回服务器绝对路径）。
 *
 * `result.auditPath` / `recordPath` 是 executor 落盘的服务器路径（stdio 面 /
 * 运维面语义）；HTTP 面（/rpc 响应 + SSE data 帧）一律替换为
 * `artifact:audit|record/<runId>` 逻辑引用，客户端持引用调
 * `GET /v1/jobs/{jobId}/artifacts/{kind}` 取内容。stdio 面不经此投影——
 * 本地进程文件路径对宿主直接可用（两传输面差异，ADR-0013 拓扑 B 的
 * server 子树职责）。
 *
 * 纯函数模块：无 IO、无状态——单测即全测。
 */

import type { ReviewRunSummary } from "../rpc/executor.js";
import type { ReviewJobView } from "../rpc/service.js";

/** artifact 逻辑引用形态：`artifact:audit/<runId>` / `artifact:record/<runId>`（方案 §4.2） */
export function artifactRef(kind: "audit" | "record", runId: string): string {
  return `artifact:${kind}/${runId}`;
}

/**
 * HTTP 面结果形态：与 `ReviewRunSummary` 同构，但路径双键换引用双键
 * （findings 恒英文原始源——ADR-0010 呈现投影不进机对机协议）。
 */
export type HttpReviewResult = Omit<ReviewRunSummary, "auditPath" | "recordPath"> & {
  readonly auditRef: string;
  readonly recordRef: string;
};

/** HTTP 面 job 视图：result 换 `HttpReviewResult`，其余键与 `ReviewJobView` 同构 */
export type HttpReviewJobView = Omit<ReviewJobView, "result"> & {
  readonly result?: HttpReviewResult;
};

function toHttpResult(result: ReviewRunSummary): HttpReviewResult {
  const { auditPath: _auditPath, recordPath: _recordPath, ...rest } = result;
  return {
    ...rest,
    auditRef: artifactRef("audit", result.runId),
    recordRef: artifactRef("record", result.runId),
  };
}

/** service job 视图 → HTTP wire 视图（纯投影：不改输入，路径键换引用键） */
export function toHttpJobView(view: ReviewJobView): HttpReviewJobView {
  const { result, ...rest } = view;
  return {
    ...rest,
    ...(result !== undefined ? { result: toHttpResult(result) } : {}),
  };
}
