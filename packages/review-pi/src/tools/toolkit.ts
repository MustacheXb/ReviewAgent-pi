import type { ContextLedger } from "../contracts/ledger.js";
import type { KnowledgeCorpus } from "../contracts/knowledge.js";
import type { ToolSchema } from "../contracts/llm.js";
import type { ToolProfile, ToolProfileSource } from "../contracts/tool-profile.js";
import { loadRepoContext, type RepoContext } from "../zoneb/repo-context.js";
import { createContextLedger } from "./ledger.js";
import { DEFAULT_TOOL_RESULT_BUDGET_CHARS } from "./result-budget.js";
import { getDiffTool } from "./get-diff.js";
import { getFileTool } from "./get-file.js";
import { getSymbolTool } from "./get-symbol.js";
import {
  findReferencesTool,
  getCallChainTool,
  searchHistoryTool,
  searchRuleTool,
} from "./search-tools.js";
import {
  REVIEW_TOOL_ORDER,
  deriveToolProfile,
  reviewToolSchemasForProfile,
  toolNamesForProfile,
} from "./registry.js";
import type { ReviewToolHandler, ToolRunContext } from "./toolkit-types.js";

/**
 * review.* 工具箱装配（#6 P3a：工具驱动内核的工具面；#32 / ADR-0014 起唯一形态）。
 *
 * - schema 面（Zone A）：按 Tool Profile 从注册表投影（#52；生产缺省 core-5，
 *   语料存在时增补检索工具），字节稳定；
 * - 执行面（Zone C）：懒加载 RepoContext memoize——模型不调用工具的 run 不产生
 *   仓库读取成本；首次调用失败成为有界的工具错误（进审计 toolCallLog），不静默；
 * - Profile：由可用知识语料派生、run 内固定；非 profile 工具按 unknown tool
 *   有界拒绝；内部 toolProfileOverride 供评测消融；
 * - Context Ledger：功能态注入（重复读取返回 "Already loaded: ctx#NNN" 引用）；
 * - C3 Knowledge 语料（search_rule / search_history 数据源）静态注入，缺省空语料；
 *   Tool Profile 据此派生（缺省 core-5，#52）。
 *
 * 本层是纯逻辑层（与 pi-agent-core 解耦）：Agent 桥接（AgentTool 包装、
 * 工具预算、审计记录）在 loop 层落位。
 */

/** 七工具执行器（顺序与 REVIEW_TOOL_ORDER 对齐；装配处查重防漂移） */
export function reviewToolHandlers(): ReadonlyMap<string, ReviewToolHandler> {
  const handlers: ReadonlyArray<[string, ReviewToolHandler]> = [
    ["review.get_diff", getDiffTool],
    ["review.get_symbol", getSymbolTool],
    ["review.get_file", getFileTool],
    ["review.find_references", findReferencesTool],
    ["review.get_call_chain", getCallChainTool],
    ["review.search_rule", searchRuleTool],
    ["review.search_history", searchHistoryTool],
  ];
  const byName = new Map(handlers);
  if (byName.size !== handlers.length) {
    throw new Error("internal error: duplicate review tool handler registration");
  }
  for (const name of REVIEW_TOOL_ORDER) {
    if (!byName.has(name)) {
      throw new Error(`internal error: missing executor for registered tool "${name}"`);
    }
  }
  return byName;
}

export interface ReviewToolkitOptions {
  readonly repoPath: string;
  readonly diff: string;
  /** 单次工具结果字符预算，默认 DEFAULT_TOOL_RESULT_BUDGET_CHARS */
  readonly resultBudgetChars?: number;
  /** C3 Knowledge 检索语料（search_rule / search_history 数据源；缺省空语料）。
   *  同时决定 Tool Profile 的派生（rules/history 是否存在 → 四档之一）。 */
  readonly knowledge?: KnowledgeCorpus;
  /**
   * Tool Profile 覆盖（#52 / ADR-0018 §3）：内核内部输入，评测消融专用；
   * 不进入协议、CLI 或环境变量。缺省按 knowledge 派生（生产缺省 core-5）。
   */
  readonly toolProfileOverride?: ToolProfile;
}

export interface ReviewToolkit {
  /** 挂载到审计投影与 Agent 桥接的 schema（点分名，字节稳定，Zone A 的一部分） */
  readonly schemas: readonly ToolSchema[];
  /** 实际生效的 Tool Profile（run 内固定；#52） */
  readonly toolProfile: ToolProfile;
  /** profile 来源：语料派生 / 内部覆盖 */
  readonly toolProfileSource: ToolProfileSource;
  /** 本 toolkit 的 Ledger（审计留痕用；功能态去重） */
  readonly ledger: ContextLedger;
  /**
   * 执行单次工具调用（点分名 + 已解析参数）→ 结果文本（resultSummary）。
   * 未知名 / 执行抛错由调用方（Agent 桥接层）捕获包装为 "Error: <message>"。
   */
  executeTool(name: string, args: Record<string, unknown>): Promise<string>;
}

export function buildReviewToolkit(options: ReviewToolkitOptions): ReviewToolkit {
  // Tool Profile 由可用语料派生、run 内固定（#52）；override 只作受控消融。
  const profile = options.toolProfileOverride ?? deriveToolProfile(options.knowledge);
  const toolProfileSource: ToolProfileSource =
    options.toolProfileOverride !== undefined ? "override" : "derived";
  const schemas = reviewToolSchemasForProfile(profile);
  const allowed = new Set<string>(toolNamesForProfile(profile));
  const handlers = new Map(
    [...reviewToolHandlers()].filter(([name]) => allowed.has(name)),
  );
  const repoPromise = memoizedRepo(options);
  const ledger = createContextLedger();
  const context: ToolRunContext = {
    diff: options.diff,
    repo: () => repoPromise(),
    resultBudgetChars: options.resultBudgetChars ?? DEFAULT_TOOL_RESULT_BUDGET_CHARS,
    rules: options.knowledge?.rules ?? [],
    history: options.knowledge?.history ?? [],
    ledger,
  };
  return {
    schemas,
    toolProfile: profile,
    toolProfileSource,
    ledger,
    executeTool: async (name, args): Promise<string> => {
      const handler = handlers.get(name);
      if (handler === undefined) {
        throw new Error(
          `unknown tool "${boundedToolName(name)}" (available: ${schemas.map((entry) => entry.name).join(", ")})`,
        );
      }
      return handler(args, context);
    },
  };
}

/** 工具名回显上限（未知名可能来自模型幻觉，回显必须有界） */
function boundedToolName(name: string): string {
  return name.length <= 60 ? name : `${name.slice(0, 60)}...`;
}

/** RepoContext 懒加载（memoize：同一 toolkit 内只加载一次，失败可重读同一错误） */
function memoizedRepo(options: ReviewToolkitOptions): () => Promise<RepoContext> {
  let cached: Promise<RepoContext> | undefined;
  return (): Promise<RepoContext> => {
    cached ??= loadRepoContext(options.repoPath);
    return cached;
  };
}
