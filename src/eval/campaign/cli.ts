import path from "node:path";
import {
  applyListFlag,
  flagFail,
  flagOk,
  parseCliArgs,
  type CliArgSpec,
  type CliParseResult,
  type FlagApplyResult,
  type ValueFlagParser,
} from "../../instrument/cli-args.js";
import {
  CAMPAIGN_ARMS,
  type CampaignArm,
  type CampaignDeps,
  type CampaignEnvironmentInput,
  type CampaignPlan,
  type CampaignReport,
  type CampaignRunResult,
} from "./contracts.js";
import type { L2Report, NoiseFloorReport } from "../l2/contracts.js";
import { rebuildCampaignReport } from "./rebuild.js";
import { runCampaign } from "./runner.js";

/**
 * Campaign CLI 参数面（#39）：campaign id / baseline-candidate ref / cases
 * file / reps / arms / `--report-only`。
 *
 * 模式：
 * - run（缺省）：构造 plan 并调用 `runCampaign`；必须注入内核 / judge 与
 *   environment provenance。真实装配在 `src/eval/assembly`（#40，进程入口
 *   门控后注入）；本核心模块保持零网络。
 * - `--report-only`：只读已有 campaign 目录重建报告，只接受 `--out` /
 *   `--campaign-id`——混入 run-only flag 直接拒绝，防误以为会重跑。
 *
 * 退出码由 `campaignExitCode` 派生：run 有单元失败 → 1；双 arm 非空对照
 * （baseline/candidate ref 不同）且 L2 门未通过 → 1；report-only / 单臂 /
 * 空对照校准 / 全绿 → 0。用法错误由进程入口返回 2（不在本模块内）。
 */

/** run 模式 options（CampaignPlan 字段 + 输出目录 + 校准元数据；reportOnly 判别标签） */
export interface CampaignRunCliOptions extends Omit<CampaignPlan, "outputDir"> {
  readonly reportOnly: false;
  readonly outDir: string;
  /**
   * 空对照校准 campaign id（#42）：`--calibration` 自指 campaign-id；
   * `--calibration-ref <id>` 供正式 campaign 引用已完成的校准；缺省 null。
   */
  readonly calibrationRef: string | null;
}

/** report-only options（campaign id 可选，仅用于校验 plan.json） */
export interface CampaignReportOnlyCliOptions {
  readonly reportOnly: true;
  readonly campaignId: string | null;
  readonly outDir: string;
}

export type CampaignCliOptions = CampaignRunCliOptions | CampaignReportOnlyCliOptions;

export type CampaignCommandResult =
  | { readonly mode: "run"; readonly run: CampaignRunResult }
  | {
      readonly mode: "report-only";
      readonly report: CampaignReport;
      readonly l2: L2Report;
      readonly noiseFloor: NoiseFloorReport | null;
    };

interface CampaignParseValues {
  campaignId: string | null;
  baselineRef: string | null;
  candidateRef: string | null;
  casesFile: string | null;
  repsRaw: string | null;
  model: string | null;
  arms: CampaignArm[] | null;
  outDir: string | null;
  reportOnly: boolean;
  calibration: boolean;
  calibrationRef: string | null;
}

const USAGE = `用法：
  run-campaign --campaign-id <id> --baseline-ref <ref> --candidate-ref <ref>
               --cases <cases.json> --model <id> [--reps <n>] [--arms baseline,candidate]
               [--calibration | --calibration-ref <id>] [--out <campaign-dir>] [--fake]
  run-campaign --report-only (--out <campaign-dir> | --campaign-id <id>)
  --campaign-id         campaign id（run 必填；report-only 可选，用于校验 plan.json）
  --baseline-ref        baseline 臂 ref（冻结 tag / commit；run 必填）
  --candidate-ref       candidate 臂 ref（run 必填）
  --cases               cases file（JSON 数组，MRCase 形状；run 必填）
  --model               被测模型 id（run 必填）
  --reps                每个 case × arm 的重复次数（正整数，缺省 1）
  --arms                对照臂逗号列表（缺省 baseline,candidate）
  --calibration         空对照校准（#42）：要求 baseline-ref == candidate-ref、双臂；
                        自动记录 calibrationRef = campaign-id
  --calibration-ref     正式 campaign 引用的空对照校准 id（与 --calibration 互斥）
  --out                 campaign 输出目录（缺省 runs/eval/<campaign-id>）
  --report-only         只读已有记录重建报告（不执行内核 / judge）
  --fake                #39 骨架：注入 fake 内核 / judge（零网络；不是真实测量）`;

const VALUE_FLAG_FIELDS = {
  "--campaign-id": "campaignId",
  "--baseline-ref": "baselineRef",
  "--candidate-ref": "candidateRef",
  "--cases": "casesFile",
  "--model": "model",
  "--out": "outDir",
  "--calibration-ref": "calibrationRef",
} as const;

function singleValueFlag(flagName: keyof typeof VALUE_FLAG_FIELDS): ValueFlagParser<CampaignParseValues> {
  const field = VALUE_FLAG_FIELDS[flagName];
  return (value, current) =>
    once(flagName, current[field], { [field]: value } as Partial<CampaignParseValues>);
}

/** 单次值 flag 守卫：重复给值统一报错（单值字符串 / reps / arms 共用） */
function once<T>(flagName: string, current: unknown, patch: Partial<T>): FlagApplyResult<T> {
  return current !== null ? flagFail(`flag ${flagName} given more than once`) : flagOk(patch);
}

const CAMPAIGN_ARG_SPEC: CliArgSpec<CampaignParseValues, CampaignCliOptions> = {
  usage: USAGE,
  defaultValues: (): CampaignParseValues => ({
    campaignId: null,
    baselineRef: null,
    candidateRef: null,
    casesFile: null,
    repsRaw: null,
    model: null,
    arms: null,
    outDir: null,
    reportOnly: false,
    calibration: false,
    calibrationRef: null,
  }),
  booleanFlags: {
    "--report-only": { reportOnly: true },
    "--calibration": { calibration: true },
  },
  valueFlags: {
    "--campaign-id": singleValueFlag("--campaign-id"),
    "--baseline-ref": singleValueFlag("--baseline-ref"),
    "--candidate-ref": singleValueFlag("--candidate-ref"),
    "--cases": singleValueFlag("--cases"),
    "--model": singleValueFlag("--model"),
    "--out": singleValueFlag("--out"),
    "--calibration-ref": singleValueFlag("--calibration-ref"),
    "--reps": (value, current) => once("--reps", current.repsRaw, { repsRaw: value }),
    "--arms": (value, current) => {
      if (current.arms !== null) {
        return flagFail("flag --arms given more than once");
      }
      return applyListFlag<CampaignParseValues, CampaignArm>(value, CAMPAIGN_ARMS, "arm", (arms) => ({
        arms,
      }));
    },
  },
  finalize: (values, fail) =>
    values.reportOnly ? finalizeReportOnly(values, fail) : finalizeRun(values, fail),
};

type CampaignFail = (message: string) => CliParseResult<CampaignCliOptions>;

function finalizeReportOnly(
  values: CampaignParseValues,
  fail: CampaignFail,
): CliParseResult<CampaignCliOptions> {
  if (
    values.baselineRef !== null ||
    values.candidateRef !== null ||
    values.casesFile !== null ||
    values.repsRaw !== null ||
    values.model !== null ||
    values.arms !== null ||
    values.calibration ||
    values.calibrationRef !== null
  ) {
    return fail("--report-only only accepts --campaign-id and --out");
  }
  const outDir =
    values.outDir ??
    (values.campaignId !== null ? path.join("runs", "eval", values.campaignId) : null);
  if (outDir === null || outDir.trim() === "") {
    return fail("--report-only requires --out <campaign-dir> (or --campaign-id)");
  }
  return {
    ok: true,
    options: { reportOnly: true, campaignId: values.campaignId, outDir },
  };
}

function finalizeRun(
  values: CampaignParseValues,
  fail: CampaignFail,
): CliParseResult<CampaignCliOptions> {
  const campaignId = requireValue(values.campaignId);
  if (campaignId === null) {
    return fail("--campaign-id is required");
  }
  const baselineRef = requireValue(values.baselineRef);
  if (baselineRef === null) {
    return fail("--baseline-ref is required");
  }
  const candidateRef = requireValue(values.candidateRef);
  if (candidateRef === null) {
    return fail("--candidate-ref is required");
  }
  const casesFile = requireValue(values.casesFile);
  if (casesFile === null) {
    return fail("--cases is required");
  }
  const model = requireValue(values.model);
  if (model === null) {
    return fail("--model is required");
  }
  const reps = parseReps(values.repsRaw, fail);
  if (typeof reps !== "number") {
    return reps;
  }
  const arms = values.arms ?? [...CAMPAIGN_ARMS];
  const calibrationRef = resolveCalibrationRef(
    values,
    campaignId,
    baselineRef,
    candidateRef,
    arms,
    reps,
    fail,
  );
  if (typeof calibrationRef !== "string" && calibrationRef !== null) {
    return calibrationRef;
  }
  return {
    ok: true,
    options: {
      reportOnly: false,
      campaignId,
      baselineRef,
      candidateRef,
      casesFile,
      reps,
      model,
      arms,
      outDir: values.outDir ?? path.join("runs", "eval", campaignId),
      calibrationRef,
    },
  };
}

/**
 * 校准元数据（#42）：`--calibration` 表示本 campaign 就是空对照校准——必须
 * 同 ref + 双 arm，并自指 campaign-id；`--calibration-ref` 供正式 campaign
 * 引用已完成的校准。两者互斥。
 */
function resolveCalibrationRef(
  values: CampaignParseValues,
  campaignId: string,
  baselineRef: string,
  candidateRef: string,
  arms: readonly CampaignArm[],
  reps: number,
  fail: CampaignFail,
): string | null | CliParseResult<CampaignCliOptions> {
  if (values.calibration && values.calibrationRef !== null) {
    return fail("--calibration and --calibration-ref are mutually exclusive");
  }
  if (!values.calibration) {
    return values.calibrationRef;
  }
  if (baselineRef !== candidateRef) {
    return fail(
      "--calibration requires --baseline-ref == --candidate-ref " +
        "(empty control: same code in both arms)",
    );
  }
  if (!arms.includes("baseline") || !arms.includes("candidate")) {
    return fail("--calibration requires both baseline and candidate arms");
  }
  if (reps < 2) {
    return fail(
      "--calibration requires --reps >= 2 (warm = rep2+ is the L2 main line; P1 uses 3)",
    );
  }
  return campaignId;
}

function requireValue(value: string | null): string | null {
  return value === null || value.trim() === "" ? null : value;
}

function parseReps(
  raw: string | null,
  fail: CampaignFail,
): number | CliParseResult<CampaignCliOptions> {
  if (raw === null) {
    return 1;
  }
  if (!/^[0-9]+$/.test(raw) || Number(raw) <= 0) {
    return fail("--reps must be a positive integer");
  }
  return Number(raw);
}

/** 解析 CLI 参数（纯函数；进程入口负责打印 usage / 退出码 2） */
export function parseCampaignArgs(argv: readonly string[]): CliParseResult<CampaignCliOptions> {
  return parseCliArgs(argv, CAMPAIGN_ARG_SPEC);
}

/**
 * run 模式的运行期选项（#40）：cases 内相对 repoPath 的解析基准。
 * 不属于 plan（不进 plan.json / 数据集 hash）。
 */
export interface CampaignRunRuntimeOptions {
  readonly repoRoot?: string;
  /** 进度回调（#40 事故诊断 / 看门狗）；run-only */
  readonly progress?: (event: string) => void;
}

/**
 * 命令分派：run 走 `runCampaign`；report-only 走 `rebuildCampaignReport`。
 * report-only 不消费 `deps`（测试用抛错内核 / judge 证明未触达）。
 */
export async function runCampaignCommand(
  options: CampaignCliOptions,
  deps: CampaignDeps,
  environment?: CampaignEnvironmentInput,
  runtime: CampaignRunRuntimeOptions = {},
): Promise<CampaignCommandResult> {
  if (options.reportOnly) {
    const { report, l2, noiseFloor } = await rebuildCampaignReport({ outDir: options.outDir });
    if (options.campaignId !== null && report.campaignId !== options.campaignId) {
      throw new Error(
        `campaign: --campaign-id ${JSON.stringify(options.campaignId)} does not match ` +
          `plan.json campaignId ${JSON.stringify(report.campaignId)}`,
      );
    }
    return { mode: "report-only", report, l2, noiseFloor };
  }
  if (environment === undefined) {
    throw new Error(
      "campaign: run mode requires environment provenance (real assembly: src/eval/assembly)",
    );
  }
  const plan: CampaignPlan = {
    campaignId: options.campaignId,
    baselineRef: options.baselineRef,
    candidateRef: options.candidateRef,
    casesFile: options.casesFile,
    reps: options.reps,
    model: options.model,
    arms: options.arms,
    outputDir: options.outDir,
  };
  // 校准元数据单源 = CLI（#42）：覆盖 provenance 里的 calibrationRef，
  // 防装配层与 plan 语义漂移；runCampaign 会在烧网关前校验同 ref / 自指。
  const environmentWithCalibration: CampaignEnvironmentInput = {
    ...environment,
    evaluation: {
      ...environment.evaluation,
      calibrationRef: options.calibrationRef,
    },
  };
  const run = await runCampaign(
    {
      plan,
      environment: environmentWithCalibration,
      ...(runtime.repoRoot !== undefined ? { repoRoot: runtime.repoRoot } : {}),
      ...(runtime.progress !== undefined ? { progress: runtime.progress } : {}),
    },
    deps,
  );
  return { mode: "run", run };
}

/**
 * 进程退出码：run 有单元失败 → 1；双 arm 且 baseline/candidate ref 不同、
 * L2 门未通过 → 1（token 相关改动的硬合并门，ADR-0017 §3）；report-only、
 * 单臂冒烟、空对照校准（同 ref）与全绿 → 0（用法错误由入口给 2）。
 */
export function campaignExitCode(result: CampaignCommandResult): number {
  if (result.mode !== "run") {
    return 0;
  }
  const { run } = result;
  if (run.failures.length > 0) {
    return 1;
  }
  const arms = new Set(run.units.map((unit) => unit.arm));
  const paired = arms.has("baseline") && arms.has("candidate");
  const calibration = run.l2.baseline.ref === run.l2.candidate.ref;
  return paired && !calibration && !run.l2.claimsAllowed ? 1 : 0;
}
