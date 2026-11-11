import type { UnitReviewRequest } from "../../gate/review-kernel.js";
import type { RunResult } from "../../instrument/contracts/run.js";
import type { MatchCounts } from "../analysis/contracts.js";
import {
  type CampaignCase,
  type CampaignDeps,
  type CampaignEnvironmentInput,
  type CampaignFailure,
  type CampaignFailureStage,
  type CampaignPlan,
  type CampaignReport,
  type CampaignUnit,
  type EvalRunRecord,
  type JudgeRecord,
  type RunCampaignOptions,
  type CampaignRunResult,
} from "./contracts.js";
import { buildEnvironmentManifest, hashCasesText } from "./environment.js";
import { expandUnits, parseCampaignCases, validateCampaignPlan } from "./plan.js";
import { toEvalRunRecord, unitKey } from "./records.js";
import { buildCampaignReport } from "./report.js";
import {
  campaignCasesPath,
  campaignEnvironmentPath,
  campaignFailuresPath,
  campaignJudgePath,
  campaignPlanPath,
  campaignRecordPath,
  campaignReportPath,
  readTextFile,
  resetCampaignOutput,
  writeJsonFile,
  writeTextFile,
} from "./store.js";

/**
 * Campaign runner（#39 P1 骨架）：读取 plan + cases file，按 case → rep →
 * arm 顺序执行单元，注入 `ReviewKernel` 与 `JudgeClient`，落盘单元记录 /
 * judge 结果 / `environment.json` / `failures.json` / 报告。
 *
 * 失败隔离（VUL4J 评测方案）：单单元内核 / judge / 落盘失败只留痕并继续，
 * 不静默剔除；报告按已完成记录生成，coverage 反映实际完成面。judge 失败
 * 不自动重试——删除 `judge/` 留痕后重跑即重判。
 *
 * 重跑语义：同一输出目录视为新一次运行，先清空上次单元产物（runs / judge /
 * report / failures / environment），防陈旧记录混入新报告或被 `--report-only`
 * 当成有效证据。
 *
 * E-only 骨架：configId 恒 "E"、source 恒 "vul4j"；真实内核 / judge 装配在
 * #40，双 arm 配对统计 / L2 门在 #41。默认测试零网络。
 */
export async function runCampaign(
  options: RunCampaignOptions,
  deps: CampaignDeps,
): Promise<CampaignRunResult> {
  const { plan, environment } = options;
  validateCampaignPlan(plan);
  assertEnvironmentMatchesPlan(environment, plan);

  const casesText = await readTextFile(plan.casesFile);
  const cases = parseCampaignCases(casesText, `campaign: cases file ${plan.casesFile}`);
  const units = expandUnits(plan, cases);
  const caseById = new Map(cases.map((mrCase) => [mrCase.caseId, mrCase]));

  await resetCampaignOutput(plan.outputDir);
  await writeJsonFile(campaignPlanPath(plan.outputDir), plan);
  await writeTextFile(campaignCasesPath(plan.outputDir), casesText);

  const now = deps.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const execution = await executeUnits({ plan, units, caseById, deps, now });
  const endedAt = now();

  const environmentManifest = buildEnvironmentManifest({
    campaignId: plan.campaignId,
    provenance: environment,
    dataset: {
      casesFile: plan.casesFile,
      caseCount: cases.length,
      hash: hashCasesText(casesText),
    },
    startedAt,
    endedAt,
  });
  const report: CampaignReport = buildCampaignReport({
    campaignId: plan.campaignId,
    records: execution.records,
    judgeCounts: execution.judgeCounts,
    cases,
  });

  await writeJsonFile(campaignEnvironmentPath(plan.outputDir), environmentManifest);
  await writeJsonFile(campaignFailuresPath(plan.outputDir), execution.failures);
  await writeJsonFile(campaignReportPath(plan.outputDir), report);

  return {
    outDir: plan.outputDir,
    units,
    records: execution.records,
    failures: execution.failures,
    environment: environmentManifest,
    report,
  };
}

function assertEnvironmentMatchesPlan(
  environment: CampaignEnvironmentInput,
  plan: CampaignPlan,
): void {
  if (environment.model.requestedId !== plan.model) {
    throw new Error(
      `campaign: environment.model.requestedId (${JSON.stringify(environment.model.requestedId)}) ` +
        `must equal plan.model (${JSON.stringify(plan.model)})`,
    );
  }
}

interface ExecutionResult {
  readonly records: readonly EvalRunRecord[];
  readonly failures: readonly CampaignFailure[];
  readonly judgeCounts: ReadonlyMap<string, MatchCounts>;
}

async function executeUnits(args: {
  readonly plan: CampaignPlan;
  readonly units: readonly CampaignUnit[];
  readonly caseById: ReadonlyMap<string, CampaignCase>;
  readonly deps: CampaignDeps;
  readonly now: () => string;
}): Promise<ExecutionResult> {
  const records: EvalRunRecord[] = [];
  const failures: CampaignFailure[] = [];
  const judgeCounts = new Map<string, MatchCounts>();
  for (const unit of args.units) {
    const mrCase = args.caseById.get(unit.caseId);
    if (mrCase === undefined) {
      // expandUnits 由同一 cases 数组派生，理论上不可达；fail fast 防静默错配
      throw new Error(`campaign: no case loaded for unit ${unit.caseId}`);
    }
    const outcome = await executeUnit({
      plan: args.plan,
      unit,
      mrCase,
      deps: args.deps,
      now: args.now,
    });
    records.push(...outcome.records);
    failures.push(...outcome.failures);
    for (const [key, counts] of outcome.judgeCounts) {
      judgeCounts.set(key, counts);
    }
  }
  return { records, failures, judgeCounts };
}

interface UnitOutcome {
  readonly records: readonly EvalRunRecord[];
  readonly failures: readonly CampaignFailure[];
  readonly judgeCounts: ReadonlyMap<string, MatchCounts>;
}

async function executeUnit(args: {
  readonly plan: CampaignPlan;
  readonly unit: CampaignUnit;
  readonly mrCase: CampaignCase;
  readonly deps: CampaignDeps;
  readonly now: () => string;
}): Promise<UnitOutcome> {
  const { plan, unit, mrCase, deps, now } = args;
  let result: RunResult;
  try {
    result = await deps.kernel.execute(buildKernelRequest(plan, unit, mrCase));
  } catch (error) {
    return failedUnit(plan.campaignId, unit, "kernel", error, now());
  }

  const record = toEvalRunRecord({ plan, unit, result, completedAt: now() });
  try {
    await writeJsonFile(campaignRecordPath(plan.outputDir, record), record);
  } catch (error) {
    return failedUnit(plan.campaignId, unit, "record", error, now());
  }

  const judged = await judgeUnit({ plan, unit, mrCase, record, deps, now });
  return {
    records: [record],
    failures: judged.failures,
    judgeCounts:
      judged.counts === null ? new Map() : new Map([[unitKey(unit), judged.counts]]),
  };
}

function buildKernelRequest(
  plan: CampaignPlan,
  unit: CampaignUnit,
  mrCase: CampaignCase,
): UnitReviewRequest {
  return {
    unit: {
      source: unit.source,
      caseId: unit.caseId,
      configId: "E",
      rep: unit.rep,
    },
    mrCase,
    model: plan.model,
    experimentRoot: plan.outputDir,
  };
}

async function judgeUnit(args: {
  readonly plan: CampaignPlan;
  readonly unit: CampaignUnit;
  readonly mrCase: CampaignCase;
  readonly record: EvalRunRecord;
  readonly deps: CampaignDeps;
  readonly now: () => string;
}): Promise<{ readonly counts: MatchCounts | null; readonly failures: readonly CampaignFailure[] }> {
  const { plan, unit, mrCase, record, deps, now } = args;
  let counts: MatchCounts;
  try {
    counts = await deps.judge.judge({
      campaignId: plan.campaignId,
      arm: unit.arm,
      rep: unit.rep,
      mrCase,
      record,
    });
  } catch (error) {
    // judge 调用失败：留痕并写 failed 记录；不自动重试（删留痕后重跑即重判）
    const failures: CampaignFailure[] = [
      makeFailure(plan.campaignId, unit, "judge", error, now()),
    ];
    const writeFailure = await tryWriteJudgeFailure(
      plan.outputDir,
      unit,
      error,
      now,
      plan.campaignId,
    );
    if (writeFailure !== null) {
      failures.push(writeFailure);
    }
    return { counts: null, failures };
  }

  const judgeRecord: JudgeRecord = {
    status: "judged",
    campaignId: plan.campaignId,
    source: unit.source,
    caseId: unit.caseId,
    arm: unit.arm,
    rep: unit.rep,
    counts,
    completedAt: now(),
  };
  try {
    await writeJsonFile(campaignJudgePath(plan.outputDir, unit), judgeRecord);
  } catch (error) {
    // judge 已成功但留痕落盘失败：报告不消费未落盘计数（保持 report-only
    // 可重建），失败阶段记 record 而不是 judge。
    return {
      counts: null,
      failures: [makeFailure(plan.campaignId, unit, "record", error, now())],
    };
  }
  return { counts, failures: [] };
}

function failedUnit(
  campaignId: string,
  unit: CampaignUnit,
  stage: CampaignFailureStage,
  error: unknown,
  at: string,
): UnitOutcome {
  return {
    records: [],
    failures: [makeFailure(campaignId, unit, stage, error, at)],
    judgeCounts: new Map(),
  };
}

function makeFailure(
  campaignId: string,
  unit: CampaignUnit,
  stage: CampaignFailureStage,
  error: unknown,
  at: string,
): CampaignFailure {
  return {
    campaignId,
    source: unit.source,
    caseId: unit.caseId,
    arm: unit.arm,
    rep: unit.rep,
    stage,
    error: error instanceof Error ? error.message : String(error),
    at,
  };
}

/** judge 失败留痕（best effort：写失败补一条 record 阶段失败，不静默） */
async function tryWriteJudgeFailure(
  outDir: string,
  unit: CampaignUnit,
  error: unknown,
  now: () => string,
  campaignId: string,
): Promise<CampaignFailure | null> {
  const judgeRecord: JudgeRecord = {
    status: "failed",
    campaignId,
    source: unit.source,
    caseId: unit.caseId,
    arm: unit.arm,
    rep: unit.rep,
    error: error instanceof Error ? error.message : String(error),
    completedAt: now(),
  };
  try {
    await writeJsonFile(campaignJudgePath(outDir, unit), judgeRecord);
    return null;
  } catch (writeError) {
    return makeFailure(campaignId, unit, "record", writeError, now());
  }
}
