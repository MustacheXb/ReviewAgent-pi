import type {
  ClaudeCodeClient,
  ClaudeCodeOutcome,
  ClaudeCodeRequest,
} from "./contracts.js";

/**
 * 可编程 fake Claude Code client（#44 测试替身）：脚本化 outcome + 请求捕获 +
 * 失败注入。默认零网络、零 CLI 调用。
 */
export interface FakeClaudeCodeClientOptions {
  /** 按调用顺序返回的 outcome；耗尽后抛错（不静默） */
  readonly outcomes?: readonly ClaudeCodeOutcome[];
  /** 固定返回的 outcome（与 outcomes 二选一） */
  readonly outcome?: ClaudeCodeOutcome;
  /** 失败注入（按请求） */
  readonly failWhen?: (request: ClaudeCodeRequest, callIndex: number) => boolean;
}

export interface FakeClaudeCodeClient extends ClaudeCodeClient {
  readonly calls: readonly ClaudeCodeRequest[];
}

export function createFakeClaudeCodeClient(
  options: FakeClaudeCodeClientOptions = {},
): FakeClaudeCodeClient {
  const calls: ClaudeCodeRequest[] = [];
  return {
    calls,
    run: async (request) => {
      const callIndex = calls.length;
      calls.push(request);
      if (options.failWhen?.(request, callIndex) === true) {
        throw new Error(`fake Claude Code client failed for ${request.caseId}/rep-${request.rep}`);
      }
      const scripted = options.outcomes?.[callIndex];
      if (scripted !== undefined) {
        return scripted;
      }
      if (options.outcome !== undefined) {
        return options.outcome;
      }
      if (options.outcomes !== undefined) {
        throw new Error(
          `fake Claude Code client script exhausted after ${callIndex} call(s)`,
        );
      }
      return emptyOutcome();
    },
  };
}

export function emptyOutcome(): ClaudeCodeOutcome {
  return {
    findings: [],
    anomalies: [],
    cliVersion: "fake-claude-code",
    requestedModel: "fake-model",
    actualModels: null,
    numTurns: null,
    totalCostUsd: null,
    usage: null,
    modelUsage: null,
    permissionDenials: null,
    durationMs: null,
    error: null,
    truncated: false,
    resultText: "[]",
  };
}
