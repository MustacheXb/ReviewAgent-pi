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
import { buildNoiseFloorReport, renderNoiseFloorMarkdown } from "../l2/calibration.js";
import { buildL2Report, resolveCampaignIdentity } from "../l2/report.js";
import { expandUnits, parseCampaignCases, validateCampaignPlan } from "./plan.js";
import { toEvalRunRecord, unitKey } from "./records.js";
import { buildCampaignReport } from "./report.js";
import {
  readCampaignRecords,
  readFailures,
  readJudgeCounts,
  readOptionalJson,
} from "./rebuild.js";
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
  const identity = resolveCampaignIdentity(plan, environment);
  const resume = options.resume === true;

  const casesText = await readTextFile(plan.casesFile);
  const cases = parseCampaignCases(casesText, `campaign: cases file ${plan.casesFile}`);
  const units = expandUnits(plan, cases);
  const caseById = new Map(cases.map((mrCase) => [mrCase.caseId, mrCase]));
  const caseIds = new Set(caseById.keys());
  const resolvedRepoRoot = repoRoot ?? process.cwd();
  const ioTimeoutMs = deps.ioTimeoutMs ?? DEFAULT_IO_TIMEOUT_MS;

  // 续跑（#42）：读回既有记录 / judge / 失败留痕，保留单元产物与时间窗起点
  const resumeState = resume
    ? await loadResumeState(plan, caseIds, casesText)
    : null;
  if (!resume) {
    await resetCampaignOutput(plan.outputDir);
  }
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
  emit(
    progress,
    `run-start campaign=${plan.campaignId} units=${units.length}` +
      (resumeState === null
        ? ""
        : ` resume=true loaded=${resumeState.records.length} ` +
          `judged=${resumeState.judgeCounts.size} failures=${resumeState.failures.length}`),
  );

  const now = deps.now ?? (() => new Date().toISOString());
  const startedAt = resumeState?.startedAt ?? now();
  const execution = await executeUnits({
    plan,
    units,
    caseById,
    deps,
    now,
    repoRoot: resolvedRepoRoot,
    ioTimeoutMs,
    ...(resumeState !== null ? { resumeState } : {}),
    ...(progress !== undefined ? { progress } : {}),
  });
  const endedAt = now();

  const environmentManifest = buildEnvironmentManifest({
    campaignId: plan.campaignId,
    // calibrationRef 单源 = 身份解析（#42）：同 ref 双 arm 缺省自指 campaignId，
    // 保证 environment.json 与 l2-report.json 不出现一个 null 一个 id 的裂缝。
    provenance: {
      ...environment,
      evaluation: {
        ...environment.evaluation,
        calibrationRef: identity.calibrationRef,
      },
    },
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

interface ResumeState {
  readonly records: readonly EvalRunRecord[];
  readonly judgeCounts: ReadonlyMap<string, MatchCounts>;
  readonly failures: readonly CampaignFailure[];
  /** 原批次开始时间（environment window.start 或最早记录 completedAt） */
  readonly startedAt: string | null;
}

/**
 * 续跑状态（#42）：既有记录 / judge 留痕必须能对上新 plan（campaign 身份、
 * case、arm、rep）；对不上 fail fast，不拿旧批次冒充新结果。
 */
async function loadResumeState(
  plan: CampaignPlan,
  caseIds: ReadonlySet<string>,
  casesText: string,
): Promise<ResumeState> {
  const existingPlan = await readOptionalJson(campaignPlanPath(plan.outputDir));
  if (existingPlan !== null) {
    assertSamePlan(existingPlan, plan);
  }
  const existingCases = await readOptionalText(campaignCasesPath(plan.outputDir));
  if (existingCases !== null) {
    const expected = hashCasesText(casesText);
    const actual = hashCasesText(existingCases);
    if (actual !== expected) {
      throw new Error(
        `campaign resume: cases.json hash ${actual} does not match current cases ` +
          `${expected} — refusing to mix a different dataset into old records`,
      );
    }
  }
  const records = await readCampaignRecords(plan.outputDir, plan, caseIds, true);
  const judgeCounts = await readJudgeCounts(plan.outputDir, plan, caseIds, records);
  const failures = await readFailures(plan.outputDir, plan, caseIds);
  const environment = await readOptionalJson(campaignEnvironmentPath(plan.outputDir));
  let startedAt: string | null = null;
  if (isRecord(environment)) {
    if (environment.campaignId !== plan.campaignId) {
      throw new Error(
        `campaign resume: environment.json campaignId ${JSON.stringify(environment.campaignId)} ` +
          `does not match plan.json ${JSON.stringify(plan.campaignId)}`,
      );
    }
    const model = isRecord(environment.model) ? environment.model : null;
    if (model !== null && model.requestedId !== plan.model) {
      throw new Error(
        `campaign resume: environment.json model ${JSON.stringify(model.requestedId)} ` +
          `does not match plan.model ${JSON.stringify(plan.model)}`,
      );
    }
    const window = isRecord(environment.window) ? environment.window : null;
    if (window !== null && typeof window.start === "string") {
      startedAt = window.start;
    }
  }
  if (startedAt === null && records.length > 0) {
    startedAt = records
      .map((record) => record.completedAt)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))[0] ?? null;
  }
  return { records, judgeCounts, failures, startedAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSamePlan(value: unknown, plan: CampaignPlan): void {
  if (!isRecord(value)) {
    throw new Error("campaign resume: plan.json must be an object");
  }
  for (const field of [
    "campaignId",
    "baselineRef",
    "candidateRef",
    "casesFile",
    "reps",
    "model",
    "outputDir",
  ] as const) {
    if (value[field] !== plan[field]) {
      throw new Error(
        `campaign resume: plan.json ${field} ${JSON.stringify(value[field])} does not match ` +
          `current plan ${JSON.stringify(plan[field])}`,
      );
    }
  }
  if (JSON.stringify(value.arms) !== JSON.stringify(plan.arms)) {
    throw new Error("campaign resume: plan.json arms do not match current plan");
  }
}

async function readOptionalText(file: string): Promise<string | null> {
  try {
    return await readTextFile(file);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
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
  readonly resumeState?: ResumeState;
  readonly progress?: (event: string) => void;
}): Promise<ExecutionResult> {
  const recordsByKey = new Map<string, EvalRunRecord>(
    (args.resumeState?.records ?? []).map((record) => [unitKey(record), record]),
  );
  const judgeCounts = new Map<string, MatchCounts>(args.resumeState?.judgeCounts ?? []);
  const failures: CampaignFailure[] = [...(args.resumeState?.failures ?? [])];
  for (const unit of args.units) {
    const key = unitKey(unit);
    // 重试单元：先清掉该单元的陈旧失败留痕，避免成功后仍被记失败
    const withoutStale = failures.filter((failure) => unitKey(failure) !== key);
    failures.length = 0;
    failures.push(...withoutStale);

    const existingRecord = recordsByKey.get(key);
    if (existingRecord !== undefined && judgeCounts.has(key)) {
      emit(args.progress, `resume-skip ${unit.caseId}/${unit.arm}/rep-${unit.rep}`);
      continue;
    }
    const mrCase = args.caseById.get(unit.caseId);
    if (mrCase === undefined) {
      // expandUnits 由同一 cases 数组派生，理论上不可达；fail fast 防静默错配
      throw new Error(`campaign: no case loaded for unit ${unit.caseId}`);
    }
    if (existingRecord !== undefined) {
      // 记录已落盘、judge 缺失：只补判，不重跑内核
      emit(
        args.progress,
        `resume-judge ${unit.caseId}/${unit.arm}/rep-${unit.rep}`,
      );
      const judged = await judgeUnit({
        plan: args.plan,
        unit,
        mrCase,
        record: existingRecord,
        deps: args.deps,
        now: args.now,
        ioTimeoutMs: args.ioTimeoutMs,
        ...(args.progress !== undefined ? { progress: args.progress } : {}),
      });
      failures.push(...judged.failures);
      if (judged.counts !== null) {
        judgeCounts.set(key, judged.counts);
      }
      emit(
        args.progress,
        judged.failures.length === 0
          ? `unit-done ${unit.caseId}/${unit.arm}/rep-${unit.rep}`
          : `unit-failed ${unit.caseId}/${unit.arm}/rep-${unit.rep} ` +
              `stages=${judged.failures.map((failure) => failure.stage).join(",")}`,
      );
    } else {
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
      for (const record of outcome.records) {
        recordsByKey.set(unitKey(record), record);
      }
      failures.push(...outcome.failures);
      for (const [countsKey, counts] of outcome.judgeCounts) {
        judgeCounts.set(countsKey, counts);
      }
      emit(
        args.progress,
        outcome.failures.length === 0
          ? `unit-done ${unit.caseId}/${unit.arm}/rep-${unit.rep}`
          : `unit-failed ${unit.caseId}/${unit.arm}/rep-${unit.rep} ` +
              `stages=${outcome.failures.map((failure) => failure.stage).join(",")}`,
      );
    }
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
  // 记录按 plan 单元序返回（既有 + 本次），保证报告 / 配对统计确定性
  const records = args.units
    .map((unit) => recordsByKey.get(unitKey(unit)))
    .filter((record): record is EvalRunRecord => record !== undefined);
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
