import path from "node:path";
import type { UnitReviewRequest } from "../../gate/review-kernel.js";
import type { RunResult } from "../../instrument/contracts/run.js";
import type { MatchCounts } from "../analysis/contracts.js";
import {
  DEFAULT_IO_TIMEOUT_MS,
  type CampaignCase,
  type CampaignDeps,
  type CampaignEnvironmentInput,
  type CampaignFailure,
  type CampaignFailureStage,
  type CampaignPlan,
  type CampaignReport,
  type CampaignUnit,
  type EvalRunRecord,
  type JudgeOutcome,
  type JudgeRecord,
  type RunCampaignOptions,
  type CampaignRunResult,
} from "./contracts.js";
import { buildEnvironmentManifest, hashCasesText } from "./environment.js";
import { buildNoiseFloorReport } from "../l2/calibration.js";
import { renderNoiseFloorMarkdown } from "../l2/calibration.js";
import { buildL2Report, resolveCampaignIdentity } from "../l2/report.js";
import { expandUnits, parseCampaignCases, validateCampaignPlan } from "./plan.js";
import { toEvalRunRecord, unitKey } from "./records.js";
import { buildCampaignReport } from "./report.js";
import {
  campaignCasesPath,
  campaignEnvironmentPath,
  campaignFailuresPath,
  campaignJudgePath,
  campaignL2ReportPath,
  campaignNoiseFloorMarkdownPath,
  campaignNoiseFloorReportPath,
  campaignPlanPath,
  campaignRecordPath,
  campaignReportPath,
  readTextFile,
  resetCampaignOutput,
  writeJsonFile,
  writeTextFile,
} from "./store.js";
import { withTimeout } from "./timeout.js";

/**
 * Campaign runner（#39 骨架 / #40 真实装配接线）：读取 plan + cases file，
 * 按 case → rep → arm 顺序执行单元，注入 `ReviewKernel` 与 `JudgeClient`，
 * 落盘单元记录 / judge 结果 / `environment.json` / `failures.json` / 报告。
 *
 * 失败隔离（VUL4J 评测方案）：单单元内核 / judge / 落盘失败只留痕并继续，
 * 不静默剔除；报告按已完成记录生成，coverage 反映实际完成面。judge 失败
 * 不自动重试；重跑同一输出目录会清空单元产物并全量重跑（不做单元级续跑）。
 *
 * 有界等待（#40 冒烟事故）：kernel / judge / **记录落盘** 全部经 `withTimeout`
 * 兜底，超时按阶段留痕并继续下一单元；`failures.json` 逐单元落盘。真实网络
 * 或文件系统挂起不得让整批静默停摆。
 *
 * 重跑语义：同一输出目录视为新一次运行，先清空上次单元产物（runs / judge /
 * audit / report / failures / environment），防陈旧记录混入新报告或被
 * `--report-only` 当成有效证据。
 *
 * E-only：configId 恒 "E"、source 恒 "vul4j"；双 arm 配对统计 / L2 门由
 * `src/eval/l2`（#41）在运行结束时生成并落盘 `l2-report.json`。
 * 默认测试零网络。
 */
export async function runCampaign(
  options: RunCampaignOptions,
  deps: CampaignDeps,
): Promise<CampaignRunResult> {
  const { plan, environment, repoRoot, progress } = options;
  validateCampaignPlan(plan);
  assertEnvironmentMatchesPlan(environment, plan);
  // 空对照校准身份校验前置（#42）：错配的 calibrationRef 在烧真实网关前 fail fast
  resolveCampaignIdentity(plan, environment);

  const casesText = await readTextFile(plan.casesFile);
  const cases = parseCampaignCases(casesText, `campaign: cases file ${plan.casesFile}`);
  const units = expandUnits(plan, cases);
  const caseById = new Map(cases.map((mrCase) => [mrCase.caseId, mrCase]));
  const resolvedRepoRoot = repoRoot ?? process.cwd();
  const ioTimeoutMs = deps.ioTimeoutMs ?? DEFAULT_IO_TIMEOUT_MS;

  await resetCampaignOutput(plan.outputDir);
  await withTimeout(
    writeJsonFile(campaignPlanPath(plan.outputDir), plan),
    ioTimeoutMs,
    "plan write",
  );
  await withTimeout(
    writeTextFile(campaignCasesPath(plan.outputDir), casesText),
    ioTimeoutMs,
    "cases write",
  );
  emit(progress, `run-start campaign=${plan.campaignId} units=${units.length}`);

  const now = deps.now ?? (() => new Date().toISOString());
  const startedAt = now();
  const execution = await executeUnits({
    plan,
    units,
    caseById,
    deps,
    now,
    repoRoot: resolvedRepoRoot,
    ioTimeoutMs,
    ...(progress !== undefined ? { progress } : {}),
  });
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
  // L2 配对回归报告（#41）：warm(rep2+) 主口径 + 冷/热分离 + 四门判定
  const l2 = buildL2Report({
    plan,
    arms: report.arms,
    environment: environmentManifest,
    records: execution.records,
    plannedUnits: units.length,
    failedUnits: execution.failures.length,
  });
  // 空对照校准噪声底（#42）：只有 calibration campaign 落 JSON + Markdown
  const noiseFloor =
    l2.campaignType === "calibration"
      ? buildNoiseFloorReport({ l2, environment: environmentManifest })
      : null;

  await withTimeout(
    writeJsonFile(campaignEnvironmentPath(plan.outputDir), environmentManifest),
    ioTimeoutMs,
    "environment write",
  );
  await withTimeout(
    writeJsonFile(campaignFailuresPath(plan.outputDir), execution.failures),
    ioTimeoutMs,
    "failures write",
  );
  await withTimeout(
    writeJsonFile(campaignReportPath(plan.outputDir), report),
    ioTimeoutMs,
    "report write",
  );
  await withTimeout(
    writeJsonFile(campaignL2ReportPath(plan.outputDir), l2),
    ioTimeoutMs,
    "l2 report write",
  );
  if (noiseFloor !== null) {
    await withTimeout(
      writeJsonFile(campaignNoiseFloorReportPath(plan.outputDir), noiseFloor),
      ioTimeoutMs,
      "noise floor report write",
    );
    await withTimeout(
      writeTextFile(
        campaignNoiseFloorMarkdownPath(plan.outputDir),
        renderNoiseFloorMarkdown(noiseFloor),
      ),
      ioTimeoutMs,
      "noise floor markdown write",
    );
  }
  emit(
    progress,
    `run-done records=${execution.records.length} failures=${execution.failures.length} ` +
      `claimsAllowed=${l2.claimsAllowed}` +
      (noiseFloor === null ? "" : ` calibrationRef=${noiseFloor.calibrationRef}`),
  );

  return {
    outDir: plan.outputDir,
    units,
    records: execution.records,
    failures: execution.failures,
    environment: environmentManifest,
    report,
    l2,
    noiseFloor,
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
  readonly repoRoot: string;
  readonly ioTimeoutMs: number;
  readonly progress?: (event: string) => void;
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
      repoRoot: args.repoRoot,
      ioTimeoutMs: args.ioTimeoutMs,
      ...(args.progress !== undefined ? { progress: args.progress } : {}),
    });
    records.push(...outcome.records);
    failures.push(...outcome.failures);
    for (const [key, counts] of outcome.judgeCounts) {
      judgeCounts.set(key, counts);
    }
    emit(
      args.progress,
      outcome.failures.length === 0
        ? `unit-done ${unit.caseId}/${unit.arm}/rep-${unit.rep}`
        : `unit-failed ${unit.caseId}/${unit.arm}/rep-${unit.rep} ` +
            `stages=${outcome.failures.map((failure) => failure.stage).join(",")}`,
    );
    // 失败留痕逐单元落盘（#40 冒烟事故）：进程被终止时不丢已发生单元的失败；
    // 最终仍由 runCampaign 覆写一次完整快照。写盘自身也设界——留痕写盘挂起
    // 不得让整批静默停摆。
    try {
      await withTimeout(
        writeJsonFile(campaignFailuresPath(args.plan.outputDir), failures),
        args.ioTimeoutMs,
        "failures write",
      );
    } catch (error) {
      const failure = makeFailure(args.plan.campaignId, unit, "record", error, args.now());
      failures.push(failure);
      emit(args.progress, `failures-write-failed ${failure.error}`);
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
  readonly repoRoot: string;
  readonly ioTimeoutMs: number;
  readonly progress?: (event: string) => void;
}): Promise<UnitOutcome> {
  const { plan, unit, mrCase, deps, now, repoRoot, ioTimeoutMs, progress } = args;
  emit(progress, `unit-start ${unit.caseId}/${unit.arm}/rep-${unit.rep}`);
  // 跨 commit 双 arm：按 arm 路由内核（未提供时两臂共用，同代码校准）
  const kernel = deps.armKernels?.[unit.arm] ?? deps.kernel;
  let result: RunResult;
  try {
    result = await withTimeout(
      kernel.execute(buildKernelRequest(plan, unit, mrCase, repoRoot)),
      deps.kernelTimeoutMs,
      "kernel execution",
    );
  } catch (error) {
    return failedUnit(plan.campaignId, unit, "kernel", error, now());
  }
  emit(progress, "kernel-done");

  const record = toEvalRunRecord({ plan, unit, result, completedAt: now() });
  try {
    await withTimeout(
      writeJsonFile(campaignRecordPath(plan.outputDir, record), record),
      ioTimeoutMs,
      "record write",
    );
  } catch (error) {
    return failedUnit(plan.campaignId, unit, "record", error, now());
  }
  emit(progress, "record-written");

  const judged = await judgeUnit({
    plan,
    unit,
    mrCase,
    record,
    deps,
    now,
    ioTimeoutMs,
    ...(progress !== undefined ? { progress } : {}),
  });
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
  repoRoot: string,
): UnitReviewRequest {
  return {
    unit: {
      source: unit.source,
      caseId: unit.caseId,
      configId: "E",
      rep: unit.rep,
    },
    // 相对 repoPath 锚定 repoRoot（同 migration-gate 纪律）：CWD 漂移不改变
    // 内核读取的仓库快照；cases 原始字节与 hash 不变。
    mrCase: {
      ...mrCase,
      repoPath: path.isAbsolute(mrCase.repoPath)
        ? mrCase.repoPath
        : path.resolve(repoRoot, mrCase.repoPath),
    },
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
  readonly ioTimeoutMs: number;
  readonly progress?: (event: string) => void;
}): Promise<{ readonly counts: MatchCounts | null; readonly failures: readonly CampaignFailure[] }> {
  const { plan, unit, mrCase, record, deps, now, ioTimeoutMs, progress } = args;
  let outcome: JudgeOutcome;
  emit(progress, "judge-start");
  try {
    outcome = await withTimeout(
      deps.judge.judge({
        campaignId: plan.campaignId,
        arm: unit.arm,
        rep: unit.rep,
        mrCase,
        record,
      }),
      deps.judgeTimeoutMs,
      "judge execution",
    );
  } catch (error) {
    // judge 调用失败：留痕并写 failed 记录；不自动重试（重跑整批重判）
    const failures: CampaignFailure[] = [
      makeFailure(plan.campaignId, unit, "judge", error, now()),
    ];
    const writeFailure = await tryWriteJudgeFailure(
      plan.outputDir,
      unit,
      error,
      now,
      plan.campaignId,
      ioTimeoutMs,
    );
    if (writeFailure !== null) {
      failures.push(writeFailure);
    }
    return { counts: null, failures };
  }
  emit(progress, `judge-done tp=${outcome.counts.tp} fp=${outcome.counts.fp} fn=${outcome.counts.fn}`);

  const judgeRecord: JudgeRecord = {
    status: "judged",
    campaignId: plan.campaignId,
    source: unit.source,
    caseId: unit.caseId,
    arm: unit.arm,
    rep: unit.rep,
    counts: outcome.counts,
    anomalies: [...outcome.anomalies],
    completedAt: now(),
  };
  try {
    await withTimeout(
      writeJsonFile(campaignJudgePath(plan.outputDir, unit), judgeRecord),
      ioTimeoutMs,
      "judge record write",
    );
  } catch (error) {
    // judge 已成功但留痕落盘失败：报告不消费未落盘计数（保持 report-only
    // 可重建），失败阶段记 record 而不是 judge。
    return {
      counts: null,
      failures: [makeFailure(plan.campaignId, unit, "record", error, now())],
    };
  }
  return { counts: outcome.counts, failures: [] };
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
  timeoutMs: number,
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
    await withTimeout(
      writeJsonFile(campaignJudgePath(outDir, unit), judgeRecord),
      timeoutMs,
      "judge failure write",
    );
    return null;
  } catch (writeError) {
    return makeFailure(campaignId, unit, "record", writeError, now());
  }
}

/** 进度事件（best-effort 诊断面：回调异常不拖垮评测） */
function emit(progress: ((event: string) => void) | undefined, event: string): void {
  if (progress === undefined) {
    return;
  }
  try {
    progress(event);
  } catch {
    // 诊断面失败不影响评测结果；调用方（CLI）自行保证落盘 best-effort
  }
}
