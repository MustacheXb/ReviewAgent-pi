/**
 * Claude Code 外部参照（#44，eval-only）：CLI client / fake / 输出归一化 /
 * 同一 judge 链 / 单列报告。
 *
 * 定位（ADR-0017 §4）：跨模型参照只单列，不进 S/A/B；不进入生产协议 /
 * CLI / ConfigId / RunAudit；生产入口不得 import 本目录。
 */
export {
  CLAUDE_CODE_ALLOWED_TOOLS,
  CLAUDE_CODE_MAX_TURNS,
  CLAUDE_CODE_REFERENCE_KIND,
  CLAUDE_CODE_REFERENCE_SCHEMA_VERSION,
  ClaudeCodeOutputError,
  type ClaudeCodeClient,
  type ClaudeCodeOutcome,
  type ClaudeCodeReferenceRecord,
  type ClaudeCodeRequest,
  type ClaudeCodeUsage,
} from "./contracts.js";
export {
  buildArgs,
  buildClaudeCodePrompt,
  createClaudeCodeClient,
  DEFAULT_CLAUDE_CODE_TIMEOUT_MS,
  detectClaudeCodeVersion,
  parseClaudeCodeVersion,
  toClaudeCodeReferenceRecord,
  type ClaudeCodeCommandInput,
  type ClaudeCodeCommandResult,
  type ClaudeCodeCommandRunner,
  type CreateClaudeCodeClientOptions,
} from "./client.js";
export {
  createFakeClaudeCodeClient,
  emptyOutcome,
  type FakeClaudeCodeClient,
  type FakeClaudeCodeClientOptions,
} from "./fake-client.js";
export {
  normalizeClaudeCodeFindings,
  parseClaudeCodeStdout,
  type NormalizedClaudeCodeFindings,
} from "./normalize.js";
export {
  buildClaudeCodeColumn,
  judgeClaudeCodeFindings,
  renderClaudeCodeColumnMarkdown,
  type BuildClaudeCodeColumnOptions,
  type ClaudeCodeColumn,
  type ClaudeCodeColumnJudge,
  type JudgeClaudeCodeInput,
} from "./reference.js";
