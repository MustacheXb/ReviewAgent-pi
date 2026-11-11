import { execFileSync } from "node:child_process";
import os from "node:os";
import type { CampaignEnvironmentInput } from "../campaign/contracts.js";
import { JUDGE_TEMPERATURE, JUDGE_TOP_P } from "../judge/gpt-request-mapper.js";
import { JUDGE_PROMPT_VERSION } from "../judge/prompt.js";

/**
 * `environment.json` provenance 采集（#40，附录 B.3）：把运行时可观测事实
 * 收敛为 campaign environment 输入——git 身份、运行时、被测模型、网关类别、
 * judge 版本、时间窗时区。
 *
 * 纪律（ADR-0017 N/A）：
 * - 未知值一律 null，不写 0；
 * - 只记端点「类别」，不记 URL 原文与任何 key 值（URL 可能携带 token）；
 * - git 命令失败不阻断运行，对应字段记 null（provenance 尽力而为）。
 *
 * 运行窗口 start / end 由 runner 在开跑 / 收尾时补齐；dataset hash 由 runner
 * 从 cases 原始字节计算。本模块只提供调用侧已知事实。
 */

/** git 命令注入缝：返回 stdout（trim）或 null（命令失败） */
export type GitRunner = (args: readonly string[]) => string | null;

export interface CollectCampaignEnvironmentOptions {
  /** 被测模型 id（必须与 plan.model 一致） */
  readonly model: string;
  /** judge 模型 id（异构约束在客户端构造期校验） */
  readonly judgeModel: string;
  /** reviewer 接入点（REVIEWER_URL / DEEPSEEK_URL 解析产物；未设置 = null） */
  readonly reviewerBaseUrl: string | null;
  /** baseline ref（L2 校准参照；缺省 null） */
  readonly calibrationRef?: string | null;
  /** git 命令注入（测试）；缺省在 repoRoot 执行真实 git */
  readonly git?: GitRunner;
  /** 运行时信息注入（测试） */
  readonly nodeVersion?: string;
  readonly platform?: string;
  readonly hostname?: string;
  readonly timezone?: string;
  /** 默认 git runner 的工作目录（仓库根） */
  readonly repoRoot?: string;
}

export function collectCampaignEnvironment(
  options: CollectCampaignEnvironmentOptions,
): CampaignEnvironmentInput {
  const git = options.git ?? defaultGitRunner(options.repoRoot ?? process.cwd());
  const branch = normalizeBranch(git(["rev-parse", "--abbrev-ref", "HEAD"]));
  const commit = git(["rev-parse", "HEAD"]);
  const tag = git(["describe", "--exact-match", "--tags", "HEAD"]);
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    evaluation: {
      branch,
      calibrationRef: options.calibrationRef ?? null,
    },
    git: { branch, commit, tag },
    runtime: {
      node: options.nodeVersion ?? process.version,
      os: options.platform ?? `${process.platform}-${process.arch}`,
      machine: options.hostname ?? os.hostname(),
    },
    model: {
      requestedId: options.model,
      // 网关不回显部署版本（pi 记录只携带请求 model id）→ N/A
      actualDeployment: null,
      providerClass: classifyProvider(options.reviewerBaseUrl),
      baseUrlClass: classifyBaseUrl(options.reviewerBaseUrl),
    },
    gateway: {
      // 缓存探针脚本随研究装置删除（#32）；跨窗口缓存对比前需人工补探针
      cacheProbeBefore: null,
      cacheProbeAfter: null,
    },
    judge: {
      model: options.judgeModel,
      promptVersion: JUDGE_PROMPT_VERSION,
      temperature: JUDGE_TEMPERATURE,
      topP: JUDGE_TOP_P,
    },
    prompts: {
      // Zone A / 工具 schema 版本字面量未在 review-pi 公开面单源化 → N/A
      zoneA: null,
      toolsSchema: null,
    },
    claudeCode: {
      // Claude Code 外部参照不在 #40 范围（P2）
      cliVersion: null,
      requestedModel: null,
      actualModels: null,
      maxTurns: null,
    },
    window: {
      // runner 用真实运行起止时间补齐
      start: null,
      end: null,
      timezone,
    },
  };
}

/** 网关 provider 类别（只按 hostname 分类，不保留 URL 原文） */
export type ProviderClass = "volcengine" | "deepseek" | "openai" | "local" | "custom";

/** base URL 类别（官方端点 / 网关 / 本地） */
export type BaseUrlClass = "official-endpoint" | "gateway-endpoint" | "local-endpoint";

export function classifyProvider(baseUrl: string | null): ProviderClass | null {
  const host = hostnameOf(baseUrl);
  if (host === null) {
    return null;
  }
  if (host === "api.deepseek.com" || host.endsWith(".deepseek.com")) {
    return "deepseek";
  }
  if (host === "api.openai.com" || host.endsWith(".openai.com")) {
    return "openai";
  }
  if (
    host.includes("volces") ||
    host.includes("volcengine") ||
    host.includes("volceapi") ||
    host.includes("byteark")
  ) {
    return "volcengine";
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return "local";
  }
  return "custom";
}

export function classifyBaseUrl(baseUrl: string | null): BaseUrlClass | null {
  const provider = classifyProvider(baseUrl);
  if (provider === null) {
    return null;
  }
  if (provider === "local") {
    return "local-endpoint";
  }
  if (provider === "deepseek" || provider === "openai") {
    return "official-endpoint";
  }
  return "gateway-endpoint";
}

function hostnameOf(baseUrl: string | null): string | null {
  if (baseUrl === null || baseUrl.trim() === "") {
    return null;
  }
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // 非法 URL 不猜测类别（N/A），也不回显 URL 原文
    return null;
  }
}

/** detached HEAD 的 branch 占位 "HEAD" 归一为 null（无分支可归因） */
function normalizeBranch(branch: string | null): string | null {
  return branch === null || branch === "HEAD" ? null : branch;
}

function defaultGitRunner(cwd: string): GitRunner {
  return (args) => {
    try {
      const output = execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return output.length > 0 ? output : null;
    } catch {
      return null;
    }
  };
}
