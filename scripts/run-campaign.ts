/**
 * Campaign CLI 进程入口（#39，eval-only 骨架）：参数装配 + 退出码。
 *
 * 骨架阶段只提供 fake 依赖路径（`--fake`，零网络、确定性）：证明
 * 「plan → 单元执行 → 记录 → 报告」整条路径成立，记录带 `evalOnly: true`，
 * environment 的 judge 字段标 `fake`，**不得作为真实测量结果引用**。
 * 真实 E 内核 + judge 链装配在 #40；`--report-only` 已是完全可用的只读路径。
 *
 * 运行（仓库根；默认测试零网络，本入口不进 CI）：
 *   pnpm campaign -- --campaign-id smoke --baseline-ref <tag> \
 *     --candidate-ref <sha> --cases data/vul4j/cases.json \
 *     --model deepseek-v4-flash --fake
 *   pnpm campaign -- --report-only --out runs/eval/smoke
 *
 * 编译：tsc -p tsconfig.campaign.json（同 migration-gate 先例：必须走 -p，
 * 否则 baseUrl/paths 失效、review-pi 类型链解析回 vendored pi 源码）。
 *
 * 退出码：0 全绿 / report-only 成功；1 run 有单元失败（failures.json 留痕）；
 * 2 用法 / 装配 / 完整性错误。
 */
import path from "node:path";
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
import { errorMessage } from "../src/instrument/cli-args.js";

async function main(argv: readonly string[]): Promise<number> {
  const withFake = argv.includes("--fake");
  const parsed = parseCampaignArgs(argv.filter((token) => token !== "--fake"));
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

  if (!withFake) {
    console.error(
      "[campaign] run mode needs the real kernel/judge assembly, which lands in #40.\n" +
        "Use --fake for the #39 harness tracer bullet, or --report-only to rebuild from recorded units.",
    );
    return 2;
  }

  console.warn(
    "[campaign] --fake: synthetic records for the #39 harness tracer bullet — not a real measurement.",
  );
  const runOptions: CampaignRunCliOptions = {
    ...options,
    casesFile: path.resolve(options.casesFile),
    outDir: path.resolve(options.outDir),
  };
  try {
    const result = await runCampaignCommand(
      runOptions,
      { kernel: createFakeReviewKernel(), judge: createFakeJudgeClient() },
      fakeCampaignEnvironment(options.model),
    );
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
  } catch (error) {
    console.error(`[campaign] ${errorMessage(error)}`);
    return 2;
  }
}

process.exit(await main(process.argv.slice(2)));
