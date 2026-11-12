import { createHash } from "node:crypto";
import type { CampaignEnvironmentInput, EnvironmentManifest } from "./contracts.js";
import { portableRepoPath } from "./paths.js";

/**
 * `environment.json` 构造（#39，附录 B.3 骨架）：固定 key 序，未知字段一律
 * `null`（N/A，不写 0）；key 不落盘。`campaignId` / `evaluation.campaign` /
 * `dataset` 由 runner 单源补齐，调用侧只提供已知 provenance。
 */

export interface EnvironmentManifestArgs {
  readonly campaignId: string;
  readonly provenance: CampaignEnvironmentInput;
  readonly dataset: {
    readonly casesFile: string;
    readonly caseCount: number;
    readonly hash: string;
  };
  /** provenance.window.start 缺省（null）时使用的运行起点 */
  readonly startedAt: string;
  /** provenance.window.end 缺省（null）时使用的运行终点 */
  readonly endedAt: string;
}

export function buildEnvironmentManifest(args: EnvironmentManifestArgs): EnvironmentManifest {
  const { provenance } = args;
  if (provenance.model.requestedId.trim() === "") {
    throw new Error("campaign environment: model.requestedId must be a non-empty model id");
  }
  return {
    campaignId: args.campaignId,
    evaluation: {
      branch: provenance.evaluation.branch,
      campaign: args.campaignId,
      calibrationRef: provenance.evaluation.calibrationRef,
    },
    git: {
      branch: provenance.git.branch,
      commit: provenance.git.commit,
      tag: provenance.git.tag,
    },
    runtime: {
      node: provenance.runtime.node,
      os: provenance.runtime.os,
      machine: provenance.runtime.machine,
    },
    model: {
      requestedId: provenance.model.requestedId,
      actualDeployment: provenance.model.actualDeployment,
      providerClass: provenance.model.providerClass,
      baseUrlClass: provenance.model.baseUrlClass,
    },
    gateway: {
      cacheProbeBefore: provenance.gateway.cacheProbeBefore,
      cacheProbeAfter: provenance.gateway.cacheProbeAfter,
    },
    judge: {
      model: provenance.judge.model,
      promptVersion: provenance.judge.promptVersion,
      temperature: provenance.judge.temperature,
      topP: provenance.judge.topP,
    },
    prompts: {
      zoneA: provenance.prompts.zoneA,
      toolsSchema: provenance.prompts.toolsSchema,
    },
    claudeCode: {
      cliVersion: provenance.claudeCode.cliVersion,
      requestedModel: provenance.claudeCode.requestedModel,
      actualModels:
        provenance.claudeCode.actualModels === null
          ? null
          : [...provenance.claudeCode.actualModels],
      maxTurns: provenance.claudeCode.maxTurns,
    },
    window: {
      start: provenance.window.start ?? args.startedAt,
      end: provenance.window.end ?? args.endedAt,
      timezone: provenance.window.timezone,
    },
    dataset: {
      casesFile: portableRepoPath(args.dataset.casesFile),
      caseCount: args.dataset.caseCount,
      hash: args.dataset.hash,
    },
  };
}

/** cases file 原始字节的 sha256（数据集 hash 单源） */
export function hashCasesText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
