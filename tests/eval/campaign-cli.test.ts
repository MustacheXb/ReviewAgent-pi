import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewKernel } from "../../src/gate/review-kernel.js";
import type { JudgeClient } from "../../src/eval/campaign/index.js";
import {
  campaignExitCode,
  parseCampaignArgs,
  runCampaignCommand,
  type CampaignCliOptions,
} from "../../src/eval/campaign/index.js";
import {
  MODEL,
  NOW,
  fakeJudge,
  fakeKernel,
  mrCase,
  provenance,
  tempDirRegistry,
  writeCases,
} from "./campaign-fixtures.js";

/**
 * Campaign CLI seam（#39）：campaign id / baseline-candidate ref / cases file /
 * reps / arms / --report-only 的参数面与命令分派。跑路径只用 fake 依赖。
 */

const tempDirs = tempDirRegistry();

afterEach(async () => {
  await tempDirs.cleanup();
});

function parsed(argv: readonly string[]): CampaignCliOptions {
  const result = parseCampaignArgs(argv);
  if (!result.ok) {
    throw new Error(`unexpected parse failure: ${result.message}`);
  }
  return result.options;
}

function parseError(argv: readonly string[]): string {
  const result = parseCampaignArgs(argv);
  if (result.ok) {
    throw new Error("expected parse failure");
  }
  return result.message;
}

const RUN_FLAGS = [
  "--campaign-id",
  "smoke-2026-11-11",
  "--baseline-ref",
  "eval-e-baseline-2026-11-11",
  "--candidate-ref",
  "0123456789abcdef",
  "--cases",
  "data/vul4j/cases.json",
  "--model",
  MODEL,
];

/** run 旗标，替换 cases / out（RUN_FLAGS 含默认 cases，直接追加会重复给值） */
function runFlags(
  casesFile: string,
  outputDir: string,
  extra: readonly string[] = [],
): string[] {
  return [
    "--campaign-id",
    "smoke-2026-11-11",
    "--baseline-ref",
    "eval-e-baseline-2026-11-11",
    "--candidate-ref",
    "0123456789abcdef",
    "--cases",
    casesFile,
    "--model",
    MODEL,
    "--out",
    outputDir,
    ...extra,
  ];
}

describe("parseCampaignArgs: run 模式", () => {
  it("必填项齐全时给出默认 reps=1 / 双臂 / out=runs/eval/<campaign-id>", () => {
    const options = parsed(RUN_FLAGS);

    expect(options.reportOnly).toBe(false);
    if (options.reportOnly) {
      throw new Error("expected run options");
    }
    expect(options).toEqual({
      reportOnly: false,
      campaignId: "smoke-2026-11-11",
      baselineRef: "eval-e-baseline-2026-11-11",
      candidateRef: "0123456789abcdef",
      casesFile: "data/vul4j/cases.json",
      reps: 1,
      model: MODEL,
      arms: ["baseline", "candidate"],
      outDir: path.join("runs", "eval", "smoke-2026-11-11"),
      calibrationRef: null,
      resume: false,
    });
  });

  it("显式 reps / arms / out 与 --flag=value 形式", () => {
    const options = parsed([
      ...RUN_FLAGS.filter((token) => token !== "--campaign-id" && token !== "smoke-2026-11-11"),
      "--campaign-id=explicit",
      "--reps=3",
      "--arms=candidate",
      "--out=/tmp/campaign",
    ]);
    if (options.reportOnly) {
      throw new Error("expected run options");
    }
    expect(options).toMatchObject({
      campaignId: "explicit",
      reps: 3,
      arms: ["candidate"],
      outDir: "/tmp/campaign",
    });
  });

  it("非法 / 重复 arm 列表拒绝", () => {
    expect(parseError([...RUN_FLAGS, "--arms", "nope"])).toMatch(/arm/);
    expect(parseError([...RUN_FLAGS, "--arms", "baseline,baseline"])).toMatch(/duplicates/);
  });

  it("reps 必须是正整数", () => {
    for (const reps of ["0", "-1", "1.5", "abc"]) {
      expect(parseError([...RUN_FLAGS, "--reps", reps])).toMatch(/reps/);
    }
  });

  it("缺必填项时逐个报出 flag 名", () => {
    const required = ["--campaign-id", "--baseline-ref", "--candidate-ref", "--cases", "--model"];
    for (const flag of required) {
      const argv: string[] = [];
      for (let index = 0; index < RUN_FLAGS.length; index += 2) {
        const name = RUN_FLAGS[index];
        if (name !== flag) {
          argv.push(name as string, RUN_FLAGS[index + 1] as string);
        }
      }
      expect(parseError(argv)).toContain(flag);
    }
  });

  it("--resume 只对 run 模式有效；report-only 拒绝", () => {
    const options = parsed([...RUN_FLAGS, "--resume"]);
    if (options.reportOnly) {
      throw new Error("expected run options");
    }
    expect(options.resume).toBe(true);
    expect(parseError(["--report-only", "--out", "x", "--resume"])).toMatch(/--report-only/);
  });

  it("--randomize-arms 缺省种子可复现；--arm-seed 覆盖；单独给种子拒绝", () => {
    const defaultSeed = parsed([...RUN_FLAGS, "--randomize-arms"]);
    if (defaultSeed.reportOnly) {
      throw new Error("expected run options");
    }
    expect(defaultSeed.armOrder).toBe("randomized");
    expect(defaultSeed.armOrderSeed).toBe(20261112);

    const customSeed = parsed([
      ...RUN_FLAGS,
      "--randomize-arms",
      "--arm-seed",
      "42",
    ]);
    if (customSeed.reportOnly) {
      throw new Error("expected run options");
    }
    expect(customSeed.armOrderSeed).toBe(42);

    expect(parseError([...RUN_FLAGS, "--arm-seed", "42"])).toMatch(/arm-seed|randomize/);
    expect(parseError(["--report-only", "--out", "x", "--randomize-arms"])).toMatch(
      /--report-only/,
    );
  });

  it("--help 与未知 flag 返回用法错误", () => {
    expect(parseError(["--help"])).toMatch(/help/);
    expect(parseError(["--nope"])).toMatch(/unknown flag/);
  });
});

describe("parseCampaignArgs: --report-only 模式", () => {
  it("--out 指向 campaign 目录", () => {
    const options = parsed(["--report-only", "--out", "runs/eval/smoke"]);
    expect(options).toEqual({
      reportOnly: true,
      campaignId: null,
      outDir: "runs/eval/smoke",
    });
  });

  it("--campaign-id 可推导默认 out", () => {
    const options = parsed(["--report-only", "--campaign-id", "smoke"]);
    expect(options).toEqual({
      reportOnly: true,
      campaignId: "smoke",
      outDir: path.join("runs", "eval", "smoke"),
    });
  });

  it("缺 out / campaign-id，或混入 run-only flag 时拒绝", () => {
    expect(parseError(["--report-only"])).toMatch(/--out|campaign-id/);
    expect(parseError(["--report-only", "--out", "x", "--model", MODEL])).toMatch(
      /--report-only/,
    );
  });
});

describe("parseCampaignArgs: 空对照校准（#42）", () => {
  const CALIBRATION_FLAGS = [
    "--campaign-id",
    "p1-calibration-2026-11-11",
    "--baseline-ref",
    "eval-e-baseline-2026-11-11",
    "--candidate-ref",
    "eval-e-baseline-2026-11-11",
    "--cases",
    "data/vul4j/target-cases.json",
    "--model",
    MODEL,
  ];

  it("--calibration 要求同 ref、双 arm，并自动写 calibrationRef = campaign-id", () => {
    const options = parsed([...CALIBRATION_FLAGS, "--reps", "3", "--calibration"]);
    if (options.reportOnly) {
      throw new Error("expected run options");
    }
    expect(options.calibrationRef).toBe("p1-calibration-2026-11-11");
    expect(options.arms).toEqual(["baseline", "candidate"]);
  });

  it("--calibration 但 ref 不同 / 单 arm / reps<2 → 拒绝", () => {
    const differentRef = [...CALIBRATION_FLAGS];
    differentRef[differentRef.indexOf("--candidate-ref") + 1] = "0123456789abcdef";
    expect(parseError([...differentRef, "--calibration"])).toMatch(/baseline-ref.*candidate-ref/);
    expect(parseError([...CALIBRATION_FLAGS, "--arms", "baseline", "--calibration"])).toMatch(
      /arms/,
    );
    expect(parseError([...CALIBRATION_FLAGS, "--reps", "1", "--calibration"])).toMatch(/reps/);
  });

  it("正式 campaign 可引用 --calibration-ref；与 --calibration 互斥", () => {
    const options = parsed([...RUN_FLAGS, "--calibration-ref", "cal-1"]);
    if (options.reportOnly) {
      throw new Error("expected run options");
    }
    expect(options.calibrationRef).toBe("cal-1");
    expect(parseError([...CALIBRATION_FLAGS, "--calibration", "--calibration-ref", "cal-1"])).toMatch(
      /mutually exclusive|互相|同时/,
    );
  });

  it("--report-only 不接受校准旗标（run-only）", () => {
    expect(
      parseError(["--report-only", "--out", "x", "--calibration"]),
    ).toMatch(/--report-only/);
    expect(
      parseError(["--report-only", "--out", "x", "--calibration-ref", "cal-1"]),
    ).toMatch(/--report-only/);
  });
});

describe("runCampaignCommand: 命令分派", () => {
  it("run 模式用 fake 依赖完成 E-only 单案；report-only 只读重建且不触内核 / judge", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");

    const runOptions = parsed(runFlags(casesFile, outputDir, ["--arms", "baseline"]));
    const runResult = await runCampaignCommand(
      runOptions,
      { kernel: fakeKernel(), judge: fakeJudge(), now: () => NOW },
      provenance(MODEL),
    );
    expect(runResult.mode).toBe("run");
    if (runResult.mode !== "run") {
      throw new Error("expected run result");
    }
    expect(runResult.run.records).toHaveLength(1);
    expect(campaignExitCode(runResult)).toBe(0);

    const reportFile = path.join(outputDir, "report.json");
    const originalBytes = readFileSync(reportFile, "utf8");
    await rm(reportFile);

    const forbiddenKernel: ReviewKernel = {
      id: "pi",
      execute: async () => {
        throw new Error("kernel must not run in report-only mode");
      },
    };
    const forbiddenJudge: JudgeClient = {
      judge: async () => {
        throw new Error("judge must not run in report-only mode");
      },
    };
    const reportOnlyOptions = parsed(["--report-only", "--out", outputDir]);
    const reportOnly = await runCampaignCommand(reportOnlyOptions, {
      kernel: forbiddenKernel,
      judge: forbiddenJudge,
    });

    expect(reportOnly.mode).toBe("report-only");
    if (reportOnly.mode !== "report-only") {
      throw new Error("expected report-only result");
    }
    expect(reportOnly.report).toEqual(runResult.run.report);
    expect(readFileSync(reportFile, "utf8")).toBe(originalBytes);
    expect(campaignExitCode(reportOnly)).toBe(0);
  });

  it("report-only 的 --campaign-id 与 plan.json 不一致时 fail fast", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    await runCampaignCommand(
      parsed(runFlags(casesFile, outputDir)),
      { kernel: fakeKernel(), judge: fakeJudge(), now: () => NOW },
      provenance(MODEL),
    );

    await expect(
      runCampaignCommand(parsed(["--report-only", "--out", outputDir, "--campaign-id", "other"]), {
        kernel: fakeKernel(),
        judge: fakeJudge(),
      }),
    ).rejects.toThrow(/campaignId/);
  });

  it("run 模式有单元失败时退出码为 1", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    const result = await runCampaignCommand(
      parsed(runFlags(casesFile, outputDir, ["--arms", "baseline,candidate"])),
      {
        kernel: fakeKernel({ failWhen: (_request, index) => index === 1 }),
        judge: fakeJudge(),
        now: () => NOW,
      },
      provenance(MODEL),
    );

    expect(result.mode).toBe("run");
    expect(campaignExitCode(result)).toBe(1);
    expect(result.mode === "run" && result.run.failures).toHaveLength(1);
  });

  it("双 arm 非空对照且 L2 门未通过 → 退出码 1（硬合并门）", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    const result = await runCampaignCommand(
      parsed(
        runFlags(casesFile, outputDir, ["--arms", "baseline,candidate", "--reps", "2"]),
      ),
      { kernel: fakeKernel(), judge: fakeJudge(), now: () => NOW },
      provenance(MODEL),
    );

    expect(result.mode).toBe("run");
    if (result.mode !== "run") {
      throw new Error("expected run result");
    }
    // 相同 fake 数据 → CARC 比率 1，成本门 fail
    expect(result.run.l2.claimsAllowed).toBe(false);
    expect(campaignExitCode(result)).toBe(1);
  });

  it("空对照校准（baseline == candidate ref）门未过但退出码 0", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    const outputDir = path.join(dir, "campaign");
    const argv = runFlags(casesFile, outputDir, ["--arms", "baseline,candidate", "--reps", "2"]);
    const candidateIndex = argv.indexOf("--candidate-ref") + 1;
    argv[candidateIndex] = "eval-e-baseline-2026-11-11";

    const result = await runCampaignCommand(
      parsed(argv),
      { kernel: fakeKernel(), judge: fakeJudge(), now: () => NOW },
      provenance(MODEL),
    );

    expect(result.mode).toBe("run");
    if (result.mode !== "run") {
      throw new Error("expected run result");
    }
    expect(result.run.l2.claimsAllowed).toBe(false);
    expect(campaignExitCode(result)).toBe(0);
  });

  it("run 模式缺 environment provenance 时 fail fast", async () => {
    const dir = await tempDirs.create();
    const casesFile = await writeCases(dir, [mrCase("VUL4J-1")]);
    await expect(
      runCampaignCommand(
        parsed(runFlags(casesFile, path.join(dir, "campaign"))),
        { kernel: fakeKernel(), judge: fakeJudge(), now: () => NOW },
      ),
    ).rejects.toThrow(/environment/);
  });
});
