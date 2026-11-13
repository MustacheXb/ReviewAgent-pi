import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewRunResult } from "review-pi";
import type { RunResult } from "../../instrument/contracts/run.js";
import type { ReviewKernel, UnitReviewRequest } from "../../gate/review-kernel.js";
import { toRootRunResult } from "../../gate/pi-kernel.js";

/**
 * Baseline 臂子进程内核（eval-only / #49 L2 跨 commit 对照）。
 *
 * 背景：真实 campaign 默认两臂共用当前 checkout 的 pi 内核（同代码校准）。
 * 跨 commit L2 需要 baseline 臂运行冻结基线（如 `eval-e-baseline-2026-11-11`
 * / e724958）的独立构建。本适配器在主进程内实现 `ReviewKernel`，每个单元：
 * - 把 `UnitReviewRequest`（含 apiKey / baseUrl，仅 stdin，不落盘不打印）交给
 *   基线 worktree 内的 Node 子进程；
 * - 子进程 import 基线自己的 `review-pi`，调用 `runReview(persistRecord:false)`；
 * - 结果 JSON 写临时文件，主进程读回并复用 `toRootRunResult` 映射。
 *
 * 纪律：
 * - 不把 key 放进 argv / 日志；错误只带基线仓库相对信息与有界 stderr；
 * - 子进程超时由本层与 campaign 双层兜底；结果文件 finally 清理；
 * - baseline worktree 必须已 `pnpm --filter review-pi build`（dist 存在）。
 */

/** 子进程缺省超时（与 campaign kernel timeout 一致：20 分钟） */
const DEFAULT_BASELINE_TIMEOUT_MS = 20 * 60_000;

export interface BaselineSubprocessKernelOptions {
  /** 基线 worktree 根（e724958 等冻结 ref 的检出） */
  readonly repoPath: string;
  readonly apiKey: string;
  readonly baseUrl?: string | null;
  /** 期望的基线 commit（传入时在首次执行前校验 HEAD） */
  readonly expectedRef?: string;
  readonly timeoutMs?: number;
  /** 测试注入：自定义 runner 脚本（缺省写入 <repo>/.tmp-gen/） */
  readonly runnerPath?: string;
}

export function baselineSubprocessKernel(
  options: BaselineSubprocessKernelOptions,
): ReviewKernel {
  let prepared: Promise<string> | undefined;
  let verified: Promise<void> | undefined;
  let resultCounter = 0;

  return {
    id: "pi",
    execute: async (request: UnitReviewRequest): Promise<RunResult> => {
      await (verified ??= verifyBaselineCommit(options.repoPath, options.expectedRef));
      const runnerPath = await (prepared ??= ensureRunner(options.repoPath, options.runnerPath));
      const resultPath = path.join(
        options.repoPath,
        ".tmp-gen",
        "baseline-kernel-results",
        `${process.pid}-${++resultCounter}.json`,
      );
      await mkdir(path.dirname(resultPath), { recursive: true });
      const payload = JSON.stringify({
        request,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl ?? null,
      });
      try {
        await runChild(runnerPath, options.repoPath, payload, resultPath, options.timeoutMs);
        const text = await readFile(resultPath, "utf8");
        const result = JSON.parse(text) as ReviewRunResult;
        return toRootRunResult(request, result);
      } finally {
        await rm(resultPath, { force: true }).catch(() => undefined);
      }
    },
  };
}

/** 首次执行前校验基线 worktree HEAD 与 expectedRef 一致（防错臂） */
async function verifyBaselineCommit(repoPath: string, expectedRef?: string): Promise<void> {
  if (expectedRef === undefined || expectedRef.length === 0) {
    return;
  }
  const head = revParse(repoPath, "HEAD");
  const expected = revParse(repoPath, `${expectedRef}^{commit}`);
  if (head !== expected) {
    throw new Error(
      `baseline kernel repo HEAD ${head.slice(0, 12)} does not match baseline ref ` +
        `"${expectedRef}" (${expected.slice(0, 12)}) — point --baseline-repo at the frozen baseline checkout`,
    );
  }
}

function revParse(repoPath: string, ref: string): string {
  try {
    return execFileSync("git", ["-C", repoPath, "rev-parse", ref], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`baseline kernel: git rev-parse ${ref} failed in "${repoPath}": ${message}`, {
      cause: error,
    });
  }
}

/** 写入 baseline 子进程 runner（import 基线自己的 review-pi） */
async function ensureRunner(repoPath: string, explicitPath?: string): Promise<string> {
  if (explicitPath !== undefined) {
    return explicitPath;
  }
  const runnerPath = path.join(repoPath, ".tmp-gen", "baseline-kernel-runner.mjs");
  await mkdir(path.dirname(runnerPath), { recursive: true });
  await writeFile(runnerPath, BASELINE_RUNNER_SOURCE, "utf8");
  return runnerPath;
}

const BASELINE_RUNNER_SOURCE = `import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runReview } from "review-pi";

// 基线臂 runner（由 eval/bench baselineSubprocessKernel 写入；不进产品面）。
// 输入：stdin JSON { request, apiKey, baseUrl }；输出：argv[2] 路径的 RunReviewResult。
const input = JSON.parse(readFileSync(0, "utf8"));
const resultPath = process.argv[2];
const request = input.request;
const result = await runReview({
  caseId: request.unit.caseId,
  repoPath: request.mrCase.repoPath,
  diff: request.mrCase.diff,
  issueDescription: request.mrCase.issueDescription,
  apiKey: input.apiKey,
  ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
  modelId: request.model,
  fetch: globalThis.fetch,
  runsRoot: path.dirname(request.experimentRoot),
  experimentId: path.basename(request.experimentRoot),
  rep: request.unit.rep,
  persistRecord: false,
});
writeFileSync(resultPath, JSON.stringify(result));
`;

/** 子进程执行：stdin 传 request，结果写文件；stderr 有界回传 */
function runChild(
  runnerPath: string,
  repoPath: string,
  payload: string,
  resultPath: string,
  timeoutMs = DEFAULT_BASELINE_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath, resultPath], {
      cwd: repoPath,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`baseline kernel timed out after ${timeoutMs}ms (${runnerPath})`));
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_000) {
        stderr += chunk.toString("utf8");
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `baseline kernel exited with code ${String(code)}: ${stderr.trim() || "(no stderr)"}`,
          ),
        );
      }
    });
    child.stdin.end(payload);
  });
}
