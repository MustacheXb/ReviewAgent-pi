/**
 * Campaign CLI 进程入口（#39 骨架 / #40 真实装配）：参数装配 + 退出码。
 *
 * 模式：
 * - `--fake`：确定性 fake 依赖（零网络），只作 harness tracer bullet，
 *   记录带 `evalOnly: true`、environment 的 judge 字段标 fake，**不得作为
 *   真实测量结果引用**。
 * - 真实路径（缺省）：须 `CAMPAIGN_REAL=1` 显式门控（真实网关 + judge
 *   烧真钱、需网络），门控后装配 pi 内核（E）+ 真实 judge 链并采集完整
 *   `environment.json` provenance。
 * - `--report-only`：只读已有 campaign 目录重建报告，零网络。
 *
 * 运行（仓库根）：
 *   CAMPAIGN_REAL=1 pnpm campaign -- --campaign-id p1-smoke-2026-11-11 \
 *     --baseline-ref eval-e-baseline-2026-11-11 --candidate-ref <sha> \
 *     --cases data/vul4j/p1-smoke-cases.json --model deepseek-v4-flash \
 *     --reps 2 --arms baseline [--judge-model glm-5.2]
 *   pnpm campaign -- --report-only --out runs/eval/p1-smoke-2026-11-11
 *
 * `.env.local` 由本入口装载（显式环境变量优先，文件只补缺；值绝不回显）。
 *
 * 编译：tsc -p tsconfig.campaign.json（同 migration-gate 先例：必须走 -p，
 * 否则 baseUrl/paths 失效、review-pi 类型链解析回 vendored pi 源码）。
 *
 * 退出码：0 全绿 / report-only 成功；1 run 有单元失败（failures.json 留痕）；
 * 2 用法 / 装配 / 门控 / 完整性错误。
 */
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  campaignExitCode,
  parseCampaignArgs,
  runCampaignCommand,
  type CampaignRunCliOptions,
} from "../src/eval/campaign/index.js";
import {
  createFakeJudgeClient,
  createFakeReviewKernel,
  fakeCampaignEnvironment,
} from "../src/eval/campaign/fakes.js";
import {
  extractValueFlag,
  prepareRealCampaign,
} from "../src/eval/assembly/index.js";
import { errorMessage } from "../src/instrument/cli-args.js";
import { formatEnvLocalSummary, loadEnvLocalFile } from "../src/instrument/env-local.js";

// 编译产物位于 .tmp-gen/scripts/（tsconfig 保留 scripts/ 子目录），仓库根在两级之上
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** judge 模型缺省（异构：被测为 deepseek 系；可用 --judge-model / CAMPAIGN_JUDGE_MODEL 覆盖） */
const DEFAULT_CAMPAIGN_JUDGE_MODEL = "glm-5.2";
/**
 * 无进度看门狗（#40 冒烟事故兜底）：真实运行 40 分钟无任何单元进度即中止。
 * 单阶段超时（kernel 20m / judge 30m / 写盘 60s）覆盖已知路径；看门狗覆盖
 * 未知的无界等待，避免再次出现静默 90 分钟停摆。
 */
const NO_PROGRESS_WATCHDOG_MS = 40 * 60_000;

async function main(argv: readonly string[]): Promise<number> {
  // 进程入口显式装载 .env.local（显式环境变量优先，文件只补缺）
  const envSummary = loadEnvLocalFile(path.join(REPO_ROOT, ".env.local"));
  if (envSummary.exists) {
    console.info(`[campaign] .env.local: ${formatEnvLocalSummary(envSummary)}`);
  }

  let judgeModel: string | null;
  let withoutJudgeModel: readonly string[];
  try {
    const extracted = extractValueFlag(argv, "--judge-model");
    judgeModel = extracted.value;
    withoutJudgeModel = extracted.argv;
  } catch (error) {
    console.error(`[campaign] ${errorMessage(error)}`);
    return 2;
  }
  const withFake = withoutJudgeModel.includes("--fake");
  const parsed = parseCampaignArgs(withoutJudgeModel.filter((token) => token !== "--fake"));
  if (!parsed.ok) {
    console.error(`${parsed.message}\n${parsed.usage}`);
    return 2;
  }
  const options = parsed.options;

  if (options.reportOnly) {
    if (withFake) {
      console.error("[campaign] --fake is only meaningful for run mode (report-only reads records)");
      return 2;
    }
    if (judgeModel !== null) {
      console.error("[campaign] --judge-model is only meaningful for run mode");
      return 2;
    }
    const outDir = path.resolve(options.outDir);
    try {
      const result = await runCampaignCommand(
        { ...options, outDir },
        { kernel: createFakeReviewKernel(), judge: createFakeJudgeClient() },
      );
      if (result.mode !== "report-only") {
        throw new Error("unexpected command mode");
      }
      console.log(`[campaign] report rebuilt: ${path.join(outDir, "report.json")}`);
      for (const [arm, report] of Object.entries(result.report.arms)) {
        console.log(
          `[campaign] ${arm}: runs=${report.summary.runCount} cases=${report.summary.caseCount}`,
        );
      }
      return 0;
    } catch (error) {
      console.error(`[campaign] ${errorMessage(error)}`);
      return 2;
    }
  }

  const runOptions: CampaignRunCliOptions = {
    ...options,
    casesFile: path.resolve(options.casesFile),
    outDir: path.resolve(options.outDir),
  };
  const envJudgeModel = process.env.CAMPAIGN_JUDGE_MODEL?.trim();
  const resolvedJudgeModel =
    judgeModel ??
    (envJudgeModel !== undefined && envJudgeModel.length > 0 ? envJudgeModel : DEFAULT_CAMPAIGN_JUDGE_MODEL);

  try {
    if (withFake) {
      if (judgeModel !== null) {
        console.error("[campaign] --judge-model is only meaningful for real run mode");
        return 2;
      }
      console.warn(
        "[campaign] --fake: synthetic records for the harness tracer bullet — not a real measurement.",
      );
      const result = await runCampaignCommand(
        runOptions,
        { kernel: createFakeReviewKernel(), judge: createFakeJudgeClient() },
        fakeCampaignEnvironment(options.model),
      );
      return reportRun(result);
    }

    const setup = prepareRealCampaign({
      model: options.model,
      judgeModel: resolvedJudgeModel,
      repoRoot: REPO_ROOT,
    });
    console.log(
      `[campaign] real run: model=${options.model} judge=${resolvedJudgeModel} ` +
        `gateway=${setup.environment.model.providerClass ?? "N/A"}`,
    );
    const progressPath = path.join(runOptions.outDir, "progress.log");
    let lastProgressAt = Date.now();
    const progress = (event: string): void => {
      lastProgressAt = Date.now();
      try {
        appendFileSync(progressPath, `${new Date().toISOString()} ${event}\n`, "utf8");
      } catch {
        // 诊断面 best-effort：进度日志写失败不拖垮评测
      }
    };
    const watchdog = setInterval(() => {
      const idleMs = Date.now() - lastProgressAt;
      if (idleMs > NO_PROGRESS_WATCHDOG_MS) {
        console.error(
          `[campaign] watchdog: no progress for ${Math.round(idleMs / 60_000)} minutes ` +
            `(last event in ${progressPath}); aborting real run — completed units are persisted`,
        );
        process.exit(2);
      }
    }, 60_000);
    try {
      const result = await runCampaignCommand(
        runOptions,
        setup.deps,
        setup.environment,
        { repoRoot: REPO_ROOT, progress },
      );
      return reportRun(result);
    } finally {
      clearInterval(watchdog);
    }
  } catch (error) {
    console.error(`[campaign] ${errorMessage(error)}`);
    return 2;
  }
}

function reportRun(result: Awaited<ReturnType<typeof runCampaignCommand>>): number {
  if (result.mode !== "run") {
    throw new Error("unexpected command mode");
  }
  console.log(
    `[campaign] units recorded: ${result.run.records.length}/${result.run.units.length}; ` +
      `failures: ${result.run.failures.length}`,
  );
  for (const [arm, report] of Object.entries(result.run.report.arms)) {
    console.log(
      `[campaign] ${arm}: runs=${report.summary.runCount} ` +
        `CARC mean=${report.summary.cost.carc?.mean ?? "N/A"} ` +
        `judgeRecall=${report.l1.judge.recall?.mean ?? "N/A"}`,
    );
  }
  console.log(`[campaign] output: ${result.run.outDir}`);
  for (const failure of result.run.failures) {
    console.error(
      `[campaign] FAILED ${failure.caseId}/${failure.arm}/rep-${failure.rep} ` +
        `[${failure.stage}] ${failure.error}`,
    );
  }
  return campaignExitCode(result);
}

process.exit(await main(process.argv.slice(2)));
