import { spawn } from "node:child_process";
import type { MRCase } from "../../../instrument/contracts/mr-case.js";
import {
  CLAUDE_CODE_ALLOWED_TOOLS,
  CLAUDE_CODE_MAX_TURNS,
  CLAUDE_CODE_REFERENCE_KIND,
  CLAUDE_CODE_REFERENCE_SCHEMA_VERSION,
  ClaudeCodeOutputError,
  type ClaudeCodeClient,
  type ClaudeCodeOutcome,
  type ClaudeCodeReferenceRecord,
  type ClaudeCodeRequest,
} from "./contracts.js";
import { parseClaudeCodeStdout } from "./normalize.js";

/**
 * Claude Code 真实 CLI 适配（#44，eval-only）。
 *
 * - `claude -p --output-format json --max-turns 5 --allowedTools Read,Grep,Glob`；
 *   提示词只经 stdin 注入；cwd = case 仓库快照；
 * - stdout JSON → outcome（findings 归一 / usage / cost / turns / denials）；
 * - CLI 版本与实际模型由调用方 / 输出留痕；key 不落盘（沿用 CLI 自身认证）；
 * - 有界等待：超时 kill 并抛错，调用方按失败留痕。
 *
 * 默认 runner 在 Windows 走 shell（`claude` 是 npm 全局 shim）；测试注入
 * `runner`，不触达真实 CLI。
 */

export interface ClaudeCodeCommandInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly timeoutMs: number;
}

export interface ClaudeCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export type ClaudeCodeCommandRunner = (
  input: ClaudeCodeCommandInput,
) => Promise<ClaudeCodeCommandResult>;

export const DEFAULT_CLAUDE_CODE_TIMEOUT_MS = 10 * 60_000;

export interface CreateClaudeCodeClientOptions {
  /** CLI 可执行文件（缺省 "claude"） */
  readonly cliPath?: string;
  /** 请求模型（可选；实际模型以 modelUsage 为准） */
  readonly model?: string;
  /** 轮次上界（缺省 / 上限 5；不允许调高） */
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
  /** CLI 版本（真实装配可先跑 `claude --version`；缺省 null = N/A） */
  readonly cliVersion?: string | null;
  /** 命令执行注入（测试）；缺省 spawn */
  readonly runner?: ClaudeCodeCommandRunner;
}

export function createClaudeCodeClient(
  options: CreateClaudeCodeClientOptions = {},
): ClaudeCodeClient {
  const cliPath = options.cliPath ?? "claude";
  const maxTurns = Math.min(options.maxTurns ?? CLAUDE_CODE_MAX_TURNS, CLAUDE_CODE_MAX_TURNS);
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
    throw new Error(`claude-code: maxTurns must be a positive integer (got ${maxTurns})`);
  }
  const runner = options.runner ?? defaultClaudeCodeRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLAUDE_CODE_TIMEOUT_MS;

  return {
    run: async (request: ClaudeCodeRequest): Promise<ClaudeCodeOutcome> => {
      const args = buildArgs(maxTurns, options.model);
      const result = await runner({
        command: cliPath,
        args,
        cwd: request.mrCase.repoPath,
        stdin: buildClaudeCodePrompt(request.mrCase),
        timeoutMs,
      });
      let parsed;
      try {
        parsed = parseClaudeCodeStdout(result.stdout);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new ClaudeCodeOutputError(
          `Claude Code CLI output unusable (exit ${String(result.exitCode)}): ${reason}; ` +
            summarize(result.stderr),
        );
      }
      // CLI 在 max-turns / 权限拒绝等 is_error 情况下可能非零退出，但 stdout 仍
      // 带完整 usage / cost / turns / denials——保留为参照记录，不丢元数据。
      return {
        ...parsed,
        cliVersion: options.cliVersion ?? null,
        requestedModel: options.model ?? null,
      };
    },
  };
}

/** 单列记录（eval-only；不进入生产 RunRecord / RunAudit / ConfigId） */
export function toClaudeCodeReferenceRecord(
  request: ClaudeCodeRequest,
  outcome: ClaudeCodeOutcome,
): ClaudeCodeReferenceRecord {
  return {
    kind: CLAUDE_CODE_REFERENCE_KIND,
    schemaVersion: CLAUDE_CODE_REFERENCE_SCHEMA_VERSION,
    evalOnly: true,
    caseId: request.caseId,
    rep: request.rep,
    maxTurns: CLAUDE_CODE_MAX_TURNS,
    allowedTools: CLAUDE_CODE_ALLOWED_TOOLS,
    cliVersion: outcome.cliVersion,
    requestedModel: outcome.requestedModel,
    actualModels: outcome.actualModels,
    numTurns: outcome.numTurns,
    totalCostUsd: outcome.totalCostUsd,
    usage: outcome.usage,
    modelUsage: outcome.modelUsage,
    permissionDenials: outcome.permissionDenials,
    durationMs: outcome.durationMs,
    error: outcome.error,
    truncated: outcome.truncated,
    findings: outcome.findings,
    anomalies: outcome.anomalies,
    resultText: outcome.resultText,
  };
}

/** CLI 版本输出解析（`claude --version` → "2.1.241 (Claude Code)" → "2.1.241"） */
export function parseClaudeCodeVersion(output: string): string | null {
  const trimmed = output.trim();
  if (trimmed === "") {
    return null;
  }
  const match = /\b(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/.exec(trimmed);
  return match?.[1] ?? (trimmed.split(/\r?\n/)[0] ?? null);
}

/** 运行 `claude --version` 并解析版本；失败 / 空输出 → null（N/A，不写假值） */
export async function detectClaudeCodeVersion(options: {
  readonly cliPath?: string;
  readonly runner?: ClaudeCodeCommandRunner;
  readonly timeoutMs?: number;
} = {}): Promise<string | null> {
  const runner = options.runner ?? defaultClaudeCodeRunner;
  try {
    const result = await runner({
      command: options.cliPath ?? "claude",
      args: ["--version"],
      cwd: process.cwd(),
      stdin: "",
      timeoutMs: options.timeoutMs ?? 30_000,
    });
    return result.exitCode === 0 ? parseClaudeCodeVersion(result.stdout) : null;
  } catch {
    return null;
  }
}

export function buildArgs(maxTurns: number, model: string | undefined): readonly string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--max-turns",
    String(maxTurns),
    // 硬限制可用工具集（--allowedTools 只是免提示放行，不限制工具面）
    "--tools",
    CLAUDE_CODE_ALLOWED_TOOLS.join(","),
    "--allowedTools",
    CLAUDE_CODE_ALLOWED_TOOLS.join(","),
    ...(model !== undefined ? ["--model", model] : []),
  ];
}

export function buildClaudeCodePrompt(mrCase: MRCase): string {
  return [
    "You are an external general-purpose coding agent taking part in a security review benchmark.",
    "Review the change in the current repository and report only defects that are actually present.",
    "You may use Read, Grep and Glob to inspect the repository; do not modify files.",
    "",
    "Issue description:",
    mrCase.issueDescription.trim() === "" ? "(none)" : mrCase.issueDescription,
    "",
    "Change (unified diff):",
    mrCase.diff,
    "",
    "Return ONLY a JSON array (no prose, no markdown fence) of findings. Each element:",
    '{"id":"string","severity":"P0|P1|P2|P3","category":"string","file":"repo/relative/path",',
    '"line":123,"title":"string","description":"string","evidence":["string"],',
    '"rule":"string","confidence":0.0}',
    "If you find no defect, return [].",
  ].join("\n");
}

const defaultClaudeCodeRunner: ClaudeCodeCommandRunner = (input) =>
  new Promise((resolve, reject) => {
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Windows 的 claude 是 npm shim（.cmd），需要 shell 解析
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(
          new ClaudeCodeOutputError(
            `Claude Code CLI timed out after ${input.timeoutMs}ms`,
          ),
        );
      }
    }, input.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new ClaudeCodeOutputError(`Claude Code CLI failed to start: ${error.message}`));
      }
    });
    child.stdin.on("error", (error: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new ClaudeCodeOutputError(`Claude Code CLI stdin failed: ${error.message}`));
      }
    });
    child.on("close", (code: number | null) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code });
      }
    });
    child.stdin.end(input.stdin);
  });

function summarize(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") {
    return "(no output)";
  }
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
}
