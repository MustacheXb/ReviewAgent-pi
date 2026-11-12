/**
 * C_ref eval-only 全仓参照（#43，评测基准方案 §7.1 / ADR-0016）：确定性全仓注入 +
 * C_ref kernel 适配 + 评测侧 fullRepo sidecar。
 *
 * 零网络 / 零 LLM；不进入生产协议 / CLI / ConfigId / RunAudit；生产入口
 * 不得 import 本目录。
 */
export {
  DEFAULT_FULL_REPO_BUDGET_CHARS,
  buildFullRepoInjection,
  loadRepoSnapshot,
  type BuildFullRepoInjectionInput,
  type CRefFullRepoRecord,
  type FullRepoInjection,
  type RepoSnapshot,
} from "./full-repo.js";
export {
  C_REF_SIDECAR_KIND,
  C_REF_SIDECAR_SCHEMA_VERSION,
  cRefSidecarPath,
  createCRefKernel,
  type CRefKernel,
  type CRefRunResult,
  type CRefSidecar,
  type CreateCRefKernelOptions,
} from "./c-ref-kernel.js";
