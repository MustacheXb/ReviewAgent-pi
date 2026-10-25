// review-pi 公开导出面（#8 P4a runner 执行缝）：root 侧经 workspace 依赖
// `review-pi` 消费的最小面——内核入口（runReview）+ 记录类型（RunRecord）
// + 网关解析（resolveReviewerEndpoint）+ 网关双探针（root 侧 e2e 真跑
// 前置诊断，#4 P1b 既有模式的单源复用）。包内其余模块不进公开面：
// fake-fetch / testing 是测试专用（root 侧测试自带最小 SSE fake，防
// exports map 双胞胎 types 解析问题），cli 是进程入口，e2e 是本包测试。
//
// 纪律：本文件只做 re-export，零逻辑；新增导出需先过 package.json
// exports map 与 dist 构建验证（types 链到 vendored pi-ai dist d.ts）。

export {
  runReview,
  ReviewAbortedError,
  type ReviewRunInput,
  type ReviewRunResult,
  type ReviewRunProgress,
} from "./run/review-run.js";
export type {
  AuditLight,
  RunRecord,
  RunSnapshot,
  ExperimentSource,
  VerifierMode,
} from "./experiment/run-record.js";
export { resolveReviewerEndpoint, type ReviewerEndpoint } from "./provider/reviewer-endpoint.js";
export {
  formatSmokeDiagnostics,
  runSmokeProbes,
  type SmokeProbeInput,
  type SmokeProbesResult,
} from "./provider/gateway-probe.js";
// #29：钉住的评审模型 id 升公开面（demo/e2e 的回环 stub 网关以此应答
// /v1/models——与真网关口径同源）。
export { REVIEW_MODEL_ID } from "./provider/pi-client.js";
// #29：SSE stub 渲染器升公开面（demo 的进程内回环网关与包内 fake 适配器
// 共用同一 wire 格式单源——格式漂移即单点同步）。
export { sseBody, type FakeReply, type FakeToolCall, type FakeUsage } from "./provider/fake-fetch.js";
// #27 v2（ADR-0013 中性后果项）：ReviewRunSummary 升公开面——stdio/HTTP 宿主
// 与评测驱动只消费该 DTO，不触内核 RunRecord 内部字段（P0 半成品补完）。
export type { ReviewRunSummary } from "./rpc/executor.js";
// #28（ADR-0013 决策 1）：typed HTTP client 升公开面——宿主/评测驱动以编程
// 方式消费 HTTP 形态（demo 与 P2b 集成同款入口）；异常基类 RpcResponseError
// 一并导出（stdio / HTTP 两面共享的 error 契约）。
// #29 P2b：SSE 订阅（ReviewHttpClientEvent）与 artifact 下载面的客户端类型
// （HTTP 投影视图——result 携 auditRef/recordRef 逻辑引用）一并公开。
export {
  HttpRpcResponseError,
  ReviewHttpClient,
  type ReviewHttpClientOptions,
  type ReviewHttpClientEvent,
  type HttpReviewJobPage,
} from "./server/http-client.js";
export type { HttpReviewJobView } from "./server/http-view.js";
