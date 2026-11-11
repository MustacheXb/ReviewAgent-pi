import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ReviewKernel, UnitReviewRequest } from "../../src/gate/review-kernel.js";
import type { MRCase } from "../../src/instrument/contracts/mr-case.js";
import type { RunResult } from "../../src/instrument/contracts/run.js";
import type {
  CampaignEnvironmentInput,
  CampaignPlan,
  JudgeClient,
  JudgeRequest,
} from "../../src/eval/campaign/index.js";

/** Campaign 测试共享夹具（#39）：fake 内核 / judge、plan、临时目录。零网络。 */

export const NOW = "2026-11-11T00:00:00.000Z";
export const MODEL = "deepseek-v4-flash";

export function mrCase(caseId: string, overrides: Partial<MRCase> = {}): MRCase {
  return {
    caseId,
    repoPath: `.cache/datasets/vul4j-repos/${caseId}`,
    diff: "diff --git a/A.java b/A.java",
    issueDescription: "issue",
    truth: {
      locations: [
        { file: "src/main/java/A.java", lineStart: 10, lineEnd: 12, defectNature: "SECURITY" },
      ],
      fixPatch: "patch",
    },
    labels: { source: "vul4j", riskClass: "Low", allowedConfigs: ["E"] },
    ...overrides,
  };
}

export function plan(overrides: Partial<CampaignPlan> = {}): CampaignPlan {
  return {
    campaignId: "smoke-2026-11-11",
    baselineRef: "eval-e-baseline-2026-11-11",
    candidateRef: "0123456789abcdef",
    casesFile: "unset",
    reps: 1,
    model: MODEL,
    arms: ["baseline"],
    outputDir: "unset",
    ...overrides,
  };
}

export function provenance(model: string): CampaignEnvironmentInput {
  return {
    evaluation: { branch: "eval/bench", calibrationRef: null },
    git: { branch: "eval/bench", commit: "deadbeef", tag: null },
    runtime: { node: "v22.0.0", os: "linux", machine: null },
    model: {
      requestedId: model,
      actualDeployment: null,
      providerClass: "gateway",
      baseUrlClass: null,
    },
    gateway: { cacheProbeBefore: null, cacheProbeAfter: null },
    judge: { model: "judge-model", promptVersion: "v1", temperature: 0.2, topP: null },
    prompts: { zoneA: "v1", toolsSchema: "v1" },
    claudeCode: {
      cliVersion: null,
      requestedModel: null,
      actualModels: null,
      maxTurns: null,
    },
    window: { start: NOW, end: NOW, timezone: "UTC" },
  };
}

export async function writeCases(dir: string, cases: readonly MRCase[]): Promise<string> {
  const file = path.join(dir, "cases.json");
  await writeFile(file, JSON.stringify(cases, null, 2), "utf8");
  return file;
}

export function runResult(request: UnitReviewRequest): RunResult {
  const location = request.mrCase.truth?.locations[0];
  const findings =
    location === undefined
      ? []
      : [
          {
            id: "F001",
            severity: "P2" as const,
            category: "SECURITY",
            file: location.file,
            line: location.lineStart,
            title: "title",
            description: "description",
            evidence: ["evidence"],
            rule: "SECURITY-001",
            confidence: 0.8,
          },
        ];
  return {
    caseId: request.unit.caseId,
    configId: "E",
    model: request.model,
    findings,
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 600,
      cacheWriteTokens: 0,
    },
    rounds: 2,
    toolCalls: 1,
    audit: {
      requests: [],
      toolCallLog: [{ name: "review.get_file", argumentsJson: "{}", resultSummary: "ok" }],
      phaseLog: [{ round: 1, phase: "Change Understanding", requestCount: 2 }],
      rejections: [],
      cacheBreaks: [],
      truncated: false,
      truncationReasons: [],
    },
    auditPath: "audit/fake.json",
  };
}

export type FakeKernel = ReviewKernel & { readonly calls: readonly UnitReviewRequest[] };

export function fakeKernel(
  options: { failWhen?: (request: UnitReviewRequest, callIndex: number) => boolean } = {},
): FakeKernel {
  const calls: UnitReviewRequest[] = [];
  return {
    id: "pi",
    calls,
    execute: async (request) => {
      const callIndex = calls.length;
      calls.push(request);
      if (options.failWhen?.(request, callIndex) === true) {
        throw new Error(`kernel failed for ${request.unit.caseId}/rep-${request.unit.rep}`);
      }
      return runResult(request);
    },
  };
}

export type FakeJudge = JudgeClient & { readonly calls: readonly JudgeRequest[] };

export function fakeJudge(
  options: { failWhen?: (request: JudgeRequest) => boolean } = {},
): FakeJudge {
  const calls: JudgeRequest[] = [];
  return {
    calls,
    judge: async (request) => {
      calls.push(request);
      if (options.failWhen?.(request) === true) {
        throw new Error(`judge failed for ${request.arm}`);
      }
      return { tp: 1, fp: 0, fn: 0 };
    },
  };
}

export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 临时目录注册表：测试 afterEach 统一清理（Windows 下递归删除）。 */
export function tempDirRegistry(): {
  readonly create: () => Promise<string>;
  readonly cleanup: () => Promise<void>;
} {
  const dirs: string[] = [];
  return {
    create: async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "review-campaign-"));
      dirs.push(dir);
      return dir;
    },
    cleanup: async () => {
      await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    },
  };
}
