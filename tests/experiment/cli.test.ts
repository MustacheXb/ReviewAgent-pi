import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EnvLocalLoadResult } from "../../src/instrument/env-local.js";
import { FakeJudgeClient } from "../../src/judge/fake-judge-client.js";
import {
  cliOptionsToPlan,
  experimentCliUsage,
  parseExperimentArgs,
  runExperimentCli,
} from "../../src/experiment/cli.js";
import { experimentMainCase, judgeAdjudication, recordingKernel } from "./helpers.js";

/**
 * parseExperimentArgs 特征锁定测试（表驱动重构的行为零变化锚点）：
 * 覆盖 缺省值 / 内联 = 与空格取值 / 取值缺失 / 未知 flag / 枚举与数值校验 / 可重复参数。
 * #9 P4b 起 --kernel/--verifier 旗标退役（未知 flag 拒绝）：内核恒 pi、verifier 恒 off，
 * 由 cliOptionsToPlan 钉死进计划；小实验经 recordingKernel（fake pi 内核）驱动。
 */

function parseOk(argv: readonly string[]): ReturnType<typeof parseExperimentArgs> {
  const parsed = parseExperimentArgs(argv);
  expect(parsed.ok, `expected ok for ${JSON.stringify(argv)}`).toBe(true);
  return parsed;
}

function parseFail(argv: readonly string[]): { readonly message: string; readonly usage: string } {
  const parsed = parseExperimentArgs(argv);
  expect(parsed.ok, `expected failure for ${JSON.stringify(argv)}`).toBe(false);
  if (parsed.ok) {
    throw new Error("unreachable");
  }
  return { message: parsed.message, usage: parsed.usage };
}

describe("parseExperimentArgs — 缺省与必填", () => {
  it("仅 --id：其余全缺省", () => {
    const parsed = parseOk(["--id", "poc1"]);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.options).toMatchObject({
      experimentId: "poc1",
      sources: ["defects4j", "vul4j", "msb-java", "clean-mr"],
      configs: ["A", "B", "C", "D", "E"],
      reps: 3,
      model: "deepseek-v4-flash",
      highRiskOnly: false,
      perSourceLimit: null,
      caseFilter: [],
      judge: false,
      humanReviewRate: 0.1,
      humanReviewSeed: "poc1-human-review-2026",
      cleanMr: false,
      reportOnly: false,
      runsRoot: "runs",
    });
    expect(parsed.options.casesFile).toBeUndefined();
    expect(parsed.options.cleanMrRepoPath).toBeUndefined();
  });

  it("缺 --id 报错并附 usage", () => {
    const { message, usage } = parseFail(["--reps", "2"]);
    expect(message).toBe("--id is required");
    expect(usage).toBe(experimentCliUsage());
  });

  it("--help / -h 走失败通道（消息固定）", () => {
    expect(parseFail(["--help"]).message).toBe("--help requested");
    expect(parseFail(["-h"]).message).toBe("--help requested");
  });
});

describe("parseExperimentArgs — 取值形式", () => {
  it("空格取值与 --flag=value 等价", () => {
    expect(parseOk(["--id", "a", "--reps", "2"]).ok && parseOk(["--id", "a", "--reps=2"]).ok).toBe(true);
    const spaced = parseOk(["--id", "a", "--reps", "2"]);
    const inline = parseOk(["--id=a", "--reps=2"]);
    expect(spaced.ok && spaced.options.reps).toBe(inline.ok && inline.options.reps);
  });

  it("取值缺失（下一个 token 是 flag 或结尾）报 requires a value", () => {
    expect(parseFail(["--id", "a", "--reps", "--judge"]).message).toBe('flag --reps requires a value');
    expect(parseFail(["--id", "a", "--reps"]).message).toBe('flag --reps requires a value');
  });

  it("内联空串被接受为空值（--id= → 后续 --id is required）", () => {
    expect(parseFail(["--id="]).message).toBe("--id is required");
  });

  it("裸 -- 分隔符被跳过（pnpm run 透传场景：pnpm experiment -- --id …）", () => {
    const parsed = parseOk(["--", "--id", "poc1", "--judge"]);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.options.experimentId).toBe("poc1");
    expect(parsed.options.judge).toBe(true);
    // 尾部孤立 -- 同样无害（无位置参数 CLI 的约定语义）
    expect(parseOk(["--id", "poc1", "--"]).ok).toBe(true);
  });

  it("未知 flag 报错（消息内嵌 usage）", () => {
    const { message } = parseFail(["--id", "a", "--bogus"]);
    expect(message).toContain('unknown flag "--bogus"');
    expect(message).toContain("Usage: run-experiment [options]");
  });

  it("未知 flag 的内联值形态在错误中保留原 token", () => {
    const { message } = parseFail(["--id", "a", "--bogus=3"]);
    expect(message).toContain('unknown flag "--bogus=3"');
  });
});

describe("parseExperimentArgs — 列表 / 枚举 / 数值校验", () => {
  it("--sources 与 --configs 解析（configs 大小写不敏感）", () => {
    const parsed = parseOk(["--id", "a", "--sources", "defects4j,clean-mr", "--configs", "a,c"]);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.options.sources).toEqual(["defects4j", "clean-mr"]);
    expect(parsed.options.configs).toEqual(["A", "C"]);
  });

  it("列表：空项 / 未知项 / 重复项逐一报错", () => {
    expect(parseFail(["--id", "a", "--sources", " , "]).message).toContain("comma list of source names");
    expect(parseFail(["--id", "a", "--sources", "defects4j,github"]).message).toContain(
      "unknown source name(s): github",
    );
    expect(parseFail(["--id", "a", "--configs", "A,A"]).message).toContain(
      "config list must not contain duplicates",
    );
  });

  it("--verifier 已退役（#9）：未知 flag 拒绝（verifier 恒 off，由 cliOptionsToPlan 钉死）", () => {
    expect(parseFail(["--id", "a", "--verifier", "on"]).message).toContain('unknown flag "--verifier"');
  });

  it("--model 自由 id + 别名（#43）：任意非空 id 直通；flash/pro 别名保留", () => {
    const flash = parseOk(["--id", "a", "--model", "flash"]);
    expect(flash.ok && flash.options.model).toBe("deepseek-v4-flash");
    const pro = parseOk(["--id", "a", "--model", "pro"]);
    const proFull = parseOk(["--id", "a", "--model", "deepseek-v4-pro"]);
    expect(pro.ok && pro.options.model).toBe(proFull.ok && proFull.options.model);
    expect(pro.ok && pro.options.model).toBe("deepseek-v4-pro");
    const free = parseOk(["--id", "a", "--model", "qwen3-max"]);
    expect(free.ok && free.options.model).toBe("qwen3-max");
    // 首尾空白容忍（trim 后直通）
    const padded = parseOk(["--id", "a", "--model", "  glm-4.7  "]);
    expect(padded.ok && padded.options.model).toBe("glm-4.7");
    expect(parseFail(["--id", "a", "--model", "  "]).message).toBe(
      "--model must be a non-empty model id",
    );
  });

  it("--reps / --limit 拒绝非正整数", () => {
    expect(parseFail(["--id", "a", "--reps", "0"]).message).toBe('--reps must be an integer >= 1 (got "0")');
    expect(parseFail(["--id", "a", "--reps", "x"]).message).toBe('--reps must be an integer >= 1 (got "x")');
    expect(parseFail(["--id", "a", "--limit", "-1"]).message).toBe('--limit must be an integer >= 1 (got "-1")');
    const parsed = parseOk(["--id", "a", "--limit", "5"]);
    expect(parsed.ok && parsed.options.perSourceLimit).toBe(5);
  });

  it("--human-review-rate 限 (0,1]、--human-review-seed 非空", () => {
    expect(parseFail(["--id", "a", "--human-review-rate", "0"]).message).toBe(
      '--human-review-rate must be a number in (0, 1] (got "0")',
    );
    expect(parseFail(["--id", "a", "--human-review-rate", "1.1"]).message).toBe(
      '--human-review-rate must be a number in (0, 1] (got "1.1")',
    );
    expect(parseFail(["--id", "a", "--human-review-seed", "  "]).message).toBe(
      "--human-review-seed must be a non-empty string",
    );
    const parsed = parseOk(["--id", "a", "--human-review-rate", "0.25", "--human-review-seed", "seed-x"]);
    expect(parsed.ok && parsed.options.humanReviewRate).toBe(0.25);
  });
});

describe("parseExperimentArgs — 布尔 flag 与可重复参数", () => {
  it("布尔 flag：--clean-mr / --high-risk-only / --judge / --report-only", () => {
    const parsed = parseOk(["--id", "a", "--clean-mr", "--high-risk-only", "--judge", "--report-only"]);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.options.cleanMr).toBe(true);
    expect(parsed.options.highRiskOnly).toBe(true);
    expect(parsed.options.judge).toBe(true);
    expect(parsed.options.reportOnly).toBe(true);
  });

  it("--clean-mr 未提供 repo 时填充占位路径（A/B 零工具不读取）", () => {
    const parsed = parseOk(["--id", "a", "--clean-mr"]);
    expect(parsed.ok && parsed.options.cleanMrRepoPath).toBe("./clean-mr-placeholder-repo");
    const withRepo = parseOk(["--id", "a", "--clean-mr", "--clean-mr-repo", "D:/repos/clean"]);
    expect(withRepo.ok && withRepo.options.cleanMrRepoPath).toBe("D:/repos/clean");
  });

  it("--case 可重复累积，空值报错", () => {
    const parsed = parseOk(["--id", "a", "--case", "c-1", "--case=c-2"]);
    expect(parsed.ok && parsed.options.caseFilter).toEqual(["c-1", "c-2"]);
    expect(parseFail(["--id", "a", "--case", ""]).message).toBe("--case requires a non-empty caseId");
  });

  it("--cases-file / --runs-root 透传", () => {
    const parsed = parseOk(["--id", "a", "--cases-file", "ds.json", "--runs-root", "out/runs"]);
    expect(parsed.ok && parsed.options.casesFile).toBe("ds.json");
    expect(parsed.ok && parsed.options.runsRoot).toBe("out/runs");
  });

  it("--judge-model 下传（#33）：双取值形式、缺省 null、空白拒绝、用法含旗标", () => {
    const spaced = parseOk(["--id", "a", "--judge-model", "glm-5-3-260814"]);
    if (!spaced.ok) throw new Error("unreachable");
    expect(spaced.options.judgeModel).toBe("glm-5-3-260814");
    const inline = parseOk(["--id=a", "--judge-model=glm-5-3-260814"]);
    if (!inline.ok) throw new Error("unreachable");
    expect(inline.options.judgeModel).toBe("glm-5-3-260814");
    const bare = parseOk(["--id", "a"]);
    if (!bare.ok) throw new Error("unreachable");
    expect(bare.options.judgeModel).toBeNull();
    expect(parseFail(["--id", "a", "--judge-model", "  "]).message).toBe(
      "--judge-model must be a non-empty model id",
    );
    expect(experimentCliUsage()).toContain("--judge-model");
  });
});

describe("runExperimentCli — .env.local 装载接线", () => {
  /** 空装载结果（exists=false 形态；测试只关心调用时序） */
  function noFileResult(): EnvLocalLoadResult {
    return { filePath: ".env.local", exists: false, loadedKeys: [], skippedKeys: [], malformedLines: [] };
  }

  it("装载先于环境校验：注入的 key 让启动检查通过（失败落在 cases 文件，而非环境缺失）", async () => {
    const env: Record<string, string | undefined> = {};
    let loadCalls = 0;
    const logs: string[] = [];
    const exitCode = await runExperimentCli(
      ["--id", "env-local-wiring", "--cases-file", "does-not-exist-cases.json"],
      {
        env,
        loadEnvLocal: () => {
          loadCalls += 1;
          env.DEEPSEEK_API_KEY = "from-env-local";
          return { filePath: ".env.local", exists: true, loadedKeys: ["DEEPSEEK_API_KEY"], skippedKeys: [], malformedLines: [] };
        },
        log: (line) => logs.push(line),
      },
    );
    expect(loadCalls).toBe(1);
    expect(exitCode).toBe(2);
    const joined = logs.join("\n");
    // 环境校验看到了装载注入的 key（否则打出 "experiment startup blocked"）
    expect(joined).not.toContain("experiment startup blocked");
    // 已推进到数据装载（cases 文件不存在 → 配置错误通道）
    expect(joined).toContain("failed to read cases file");
  });

  it("argv 解析失败时不装载 .env.local", async () => {
    let loadCalls = 0;
    const exitCode = await runExperimentCli(["--id", "a", "--bogus"], {
      loadEnvLocal: () => {
        loadCalls += 1;
        return noFileResult();
      },
      log: () => {},
    });
    expect(exitCode).toBe(2);
    expect(loadCalls).toBe(0);
  });

  it("装载抛错（如权限）→ 退出 2 并给出错误信息", async () => {
    const logs: string[] = [];
    const exitCode = await runExperimentCli(["--id", "a"], {
      loadEnvLocal: () => {
        throw new Error("EACCES: permission denied, open '.env.local'");
      },
      log: (line) => logs.push(line),
    });
    expect(exitCode).toBe(2);
    expect(logs.join("\n")).toContain("EACCES");
  });
});

describe("cliOptionsToPlan — 校验透传", () => {
  it("合法选项产出合法计划（v4-pro + highRiskOnly）", () => {
    const parsed = parseOk(["--id", "a", "--model", "pro", "--high-risk-only", "--sources", "defects4j"]);
    if (!parsed.ok) throw new Error("unreachable");
    const plan = cliOptionsToPlan(parsed.options);
    expect(plan.model).toBe("deepseek-v4-pro");
    expect(plan.highRiskOnly).toBe(true);
  });

  it("v4-pro 未开 highRiskOnly 时由计划校验拦截", () => {
    const parsed = parseOk(["--id", "a", "--model", "pro"]);
    if (!parsed.ok) throw new Error("unreachable");
    expect(() => cliOptionsToPlan(parsed.options)).toThrow(/highRiskOnly/);
  });

  it("--judge-model 进计划：glm-5.3 通过；deepseek 系也入计划（#43 拒绝移至 CLI 预检）", () => {
    const parsed = parseOk(["--id", "a", "--judge", "--judge-model", "glm-5-3-260814"]);
    if (!parsed.ok) throw new Error("unreachable");
    expect(cliOptionsToPlan(parsed.options).judgeModel).toBe("glm-5-3-260814");
    // #43：异构降级需 env 知识（自定义接入点判定），计划层只做形状校验——
    // 降级放行的计划持久化后必须可重校验（resume）
    const downgraded = parseOk(["--id", "a", "--judge-model", "deepseek-chat"]);
    if (!downgraded.ok) throw new Error("unreachable");
    expect(cliOptionsToPlan(downgraded.options).judgeModel).toBe("deepseek-chat");
  });
});

describe("runExperimentCli — --judge-model 下传接线（#33）", () => {
  /** 空装载结果（exists=false 形态；本组测试不依赖 .env.local） */
  function noFileResult(): EnvLocalLoadResult {
    return { filePath: ".env.local", exists: false, loadedKeys: [], skippedKeys: [], malformedLines: [] };
  }

  /** Single case × config C × 1 rep of a small experiment (fake pi kernel + judge factory capturing the model) */
  async function runTinyExperiment(
    workDir: string,
    argv: readonly string[],
    captured: { model?: string | null },
  ): Promise<{ readonly exitCode: number; readonly logs: string[]; readonly judgeCalls: number }> {
    const casesFile = path.join(workDir, "cases.json");
    await writeFile(casesFile, JSON.stringify([experimentMainCase("judge-model-case")]), "utf8");
    const fakeJudge = FakeJudgeClient.fromAdjudications([judgeAdjudication()]);
    const logs: string[] = [];
    const exitCode = await runExperimentCli([...argv, "--cases-file", casesFile, "--runs-root", workDir], {
      env: { DEEPSEEK_API_KEY: "test-ds-key", OPENAI_API_KEY: "test-openai-key" },
      createPiKernel: () => recordingKernel().kernel,
      createJudgeClient: (model) => {
        captured.model = model;
        return fakeJudge;
      },
      loadEnvLocal: () => noFileResult(),
      log: (line) => logs.push(line),
    });
    return { exitCode, logs, judgeCalls: fakeJudge.callCount };
  }

  it("createJudgeClient 收到计划 judgeModel；judge 阶段真实消费；plan.json 留痕含模型 id", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "review-agent-judge-model-"));
    try {
      const captured: { model?: string | null } = {};
      const { exitCode, logs, judgeCalls } = await runTinyExperiment(workDir, [
        "--id", "judge-model-wiring",
        "--configs", "C",
        "--reps", "1",
        "--judge",
        "--judge-model", "glm-5-3-260814",
      ], captured);
      expect(exitCode).toBe(0);
      expect(captured.model).toBe("glm-5-3-260814");
      expect(judgeCalls).toBe(1); // 判定链真实执行（FakeJudge 消费 1 单元裁定）
      expect(logs.join("\n")).toContain("judge");
      const planJson = JSON.parse(
        await readFile(path.join(workDir, "judge-model-wiring", "plan.json"), "utf8"),
      ) as { readonly judgeModel?: string | null };
      expect(planJson.judgeModel).toBe("glm-5-3-260814");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("缺省不传 → createJudgeClient 收到 null（客户端层落到 DEFAULT_JUDGE_MODEL）", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "review-agent-judge-default-"));
    try {
      const captured: { model?: string | null } = {};
      const { exitCode } = await runTinyExperiment(workDir, [
        "--id", "judge-model-default",
        "--configs", "C",
        "--reps", "1",
        "--judge",
      ], captured);
      expect(exitCode).toBe(0);
      expect(captured.model).toBeNull();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

describe("runExperimentCli — 自定义模型 + manifest 接线（#43）", () => {
  function noFileResult(): EnvLocalLoadResult {
    return { filePath: ".env.local", exists: false, loadedKeys: [], skippedKeys: [], malformedLines: [] };
  }

  /** 单 case × config C × 1 rep 的一场小实验（fake pi 内核；env 注入驱动预检与 manifest） */
  async function runTinyModelExperiment(
    workDir: string,
    argv: readonly string[],
    env: Record<string, string | undefined>,
  ): Promise<{ readonly exitCode: number; readonly logs: string[] }> {
    const casesFile = path.join(workDir, "cases.json");
    await writeFile(casesFile, JSON.stringify([experimentMainCase("custom-model-case")]), "utf8");
    const logs: string[] = [];
    const exitCode = await runExperimentCli(
      [...argv, "--configs", "C", "--reps", "1", "--cases-file", casesFile, "--runs-root", workDir],
      {
        env,
        createPiKernel: () => recordingKernel().kernel,
        loadEnvLocal: () => noFileResult(),
        log: (line) => logs.push(line),
      },
    );
    return { exitCode, logs };
  }

  it("--model qwen3-max 跑通：plan.json 记录自由模型 id（记录与请求同源）", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "review-agent-custom-model-"));
    try {
      const { exitCode } = await runTinyModelExperiment(workDir, ["--id", "custom-model", "--model", "qwen3-max"], {
        REVIEWER_API_KEY: "test-reviewer-key-001",
      });
      expect(exitCode).toBe(0);
      const planText = await readFile(path.join(workDir, "custom-model", "plan.json"), "utf8");
      const planJson = JSON.parse(planText) as { readonly model?: string };
      expect(planJson.model).toBe("qwen3-max");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("manifest 记录检视链接入点：REVIEWER_URL > DEEPSEEK_URL > 缺省；绝不记录 key", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "review-agent-manifest-url-"));
    try {
      // 推荐名优先
      const custom = await runTinyModelExperiment(workDir, ["--id", "manifest-custom-url"], {
        REVIEWER_API_KEY: "test-reviewer-key-001",
        REVIEWER_URL: "https://gateway.example.com",
        DEEPSEEK_URL: "https://legacy.example.com",
      });
      expect(custom.exitCode).toBe(0);
      const customPlan = JSON.parse(
        await readFile(path.join(workDir, "manifest-custom-url", "plan.json"), "utf8"),
      ) as { readonly reviewerBaseUrl?: string };
      expect(customPlan.reviewerBaseUrl).toBe("https://gateway.example.com");

      // 旧名兼容别名
      const legacy = await runTinyModelExperiment(workDir, ["--id", "manifest-legacy-url"], {
        DEEPSEEK_API_KEY: "test-reviewer-key-001",
        DEEPSEEK_URL: "https://relay.example.com",
      });
      expect(legacy.exitCode).toBe(0);
      const legacyPlan = JSON.parse(
        await readFile(path.join(workDir, "manifest-legacy-url", "plan.json"), "utf8"),
      ) as { readonly reviewerBaseUrl?: string };
      expect(legacyPlan.reviewerBaseUrl).toBe("https://relay.example.com");

      // 未设 → 官方缺省；key 纪律：key 值绝不进 manifest
      const none = await runTinyModelExperiment(workDir, ["--id", "manifest-default-url"], {
        REVIEWER_API_KEY: "test-reviewer-key-001",
      });
      expect(none.exitCode).toBe(0);
      const nonePlanText = await readFile(path.join(workDir, "manifest-default-url", "plan.json"), "utf8");
      const nonePlan = JSON.parse(nonePlanText) as { readonly reviewerBaseUrl?: string };
      expect(nonePlan.reviewerBaseUrl).toBe("https://api.deepseek.com");
      expect(nonePlanText).not.toContain("test-reviewer-key-001");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("env 预检双名：REVIEWER_API_KEY 单独满足；两名均缺 → 启动阻断（清单用推荐名形态）", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "review-agent-env-precheck-"));
    try {
      const blocked = await runTinyModelExperiment(workDir, ["--id", "env-precheck-blocked"], {});
      expect(blocked.exitCode).toBe(2);
      const joined = blocked.logs.join("\n");
      expect(joined).toContain("REVIEWER_API_KEY (or DEEPSEEK_API_KEY)");
      expect(joined).not.toContain("test-");

      const passed = await runTinyModelExperiment(workDir, ["--id", "env-precheck-role-name"], {
        REVIEWER_API_KEY: "role-key-only",
      });
      expect(passed.exitCode).toBe(0);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

describe("runExperimentCli — 异构校验预检（#43：同源判定以被测模型为对照系，自定义接入点降 warning）", () => {
  function noFileResult(): EnvLocalLoadResult {
    return { filePath: ".env.local", exists: false, loadedKeys: [], skippedKeys: [], malformedLines: [] };
  }

  /**
   * 单 case × config C × 1 rep + judge 的小实验（fake pi 内核 + 捕获模型与异构
   * 上下文的 judge 工厂；env 注入驱动预检与降级判定）。
   */
  async function runTinyJudgeExperiment(
    workDir: string,
    argv: readonly string[],
    env: Record<string, string | undefined>,
    captured: {
      model?: string | null;
      downgrade?: boolean;
      customEndpoint?: boolean;
      reviewerModel?: string;
    },
  ): Promise<{ readonly exitCode: number; readonly logs: string[] }> {
    const casesFile = path.join(workDir, "cases.json");
    await writeFile(casesFile, JSON.stringify([experimentMainCase("judge-heterogeneity-case")]), "utf8");
    const fakeJudge = FakeJudgeClient.fromAdjudications([judgeAdjudication()]);
    const logs: string[] = [];
    const exitCode = await runExperimentCli(
      [...argv, "--configs", "C", "--reps", "1", "--cases-file", casesFile, "--runs-root", workDir],
      {
        env,
        createPiKernel: () => recordingKernel().kernel,
        createJudgeClient: (model, context) => {
          captured.model = model;
          captured.downgrade = context.heterogeneityDowngraded;
          captured.customEndpoint = context.customLlmEndpoint;
          captured.reviewerModel = context.reviewerModel;
          return fakeJudge;
        },
        loadEnvLocal: () => noFileResult(),
        log: (line) => logs.push(line),
      },
    );
    return { exitCode, logs };
  }

  it("deepseek 系 judge + deepseek 被测（缺省）+ 双侧官方端点 → 启动即拒（exit 2，不烧检视预算；judge 工厂未被调用）", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "review-agent-hetero-block-"));
    try {
      const captured: { model?: string | null; downgrade?: boolean; customEndpoint?: boolean; reviewerModel?: string } = {};
      const { exitCode, logs } = await runTinyJudgeExperiment(
        workDir,
        ["--id", "hetero-blocked", "--judge", "--judge-model", "deepseek-v4-flash"],
        { REVIEWER_API_KEY: "test-reviewer-key-001", JUDGE_API_KEY: "test-judge-key-001" },
        captured,
      );
      expect(exitCode).toBe(2);
      const joined = logs.join("\n");
      expect(joined).toContain("heterogeneous");
      // 错误消息写明降级出口：自证异构后经自定义接入点承担
      expect(joined).toContain("REVIEWER_URL");
      expect(captured.model).toBeUndefined();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  // 四个变量名（新旧 × 双侧）任一即触发降级——逐名独立用例（各自计时预算）
  const CUSTOM_ENDPOINT_VARS: readonly (readonly [string, string])[] = [
    ["REVIEWER_URL", "https://gw.example.com"],
    ["DEEPSEEK_URL", "https://relay.example.com"],
    ["JUDGE_URL", "https://judge-gw.example.com"],
    ["OPENAI_URL", "https://legacy-judge.example.com"],
  ];

  for (const [name, value] of CUSTOM_ENDPOINT_VARS) {
    it(`deepseek 系 judge + ${name} → warning 放行 + 降级上下文下传 judge 工厂`, async () => {
      const workDir = await mkdtemp(path.join(tmpdir(), "review-agent-hetero-warn-"));
      try {
        const captured: { model?: string | null; downgrade?: boolean; customEndpoint?: boolean; reviewerModel?: string } = {};
        const { exitCode, logs } = await runTinyJudgeExperiment(
          workDir,
          ["--id", "hetero-warned", "--judge", "--judge-model", "deepseek-v4-flash"],
          {
            REVIEWER_API_KEY: "test-reviewer-key-001",
            JUDGE_API_KEY: "test-judge-key-001",
            [name]: value,
          },
          captured,
        );
        expect(exitCode).toBe(0);
        const joined = logs.join("\n");
        expect(joined).toContain("warning");
        expect(joined).toContain("same-source");
        expect(captured.model).toBe("deepseek-v4-flash");
        expect(captured.downgrade).toBe(true);
        expect(captured.customEndpoint).toBe(true);
        // 对照系 = 被测模型（缺省 deepseek-v4-flash）
        expect(captured.reviewerModel).toBe("deepseek-v4-flash");
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  }

  it("deepseek 系 judge + glm 被测（--model 自由 id）→ 家族异构放行（修复按 DeepSeek 被测的盲目拒绝）", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "review-agent-hetero-cross-"));
    try {
      const captured: { model?: string | null; downgrade?: boolean; customEndpoint?: boolean; reviewerModel?: string } = {};
      const { exitCode, logs } = await runTinyJudgeExperiment(
        workDir,
        ["--id", "hetero-cross", "--model", "glm-4.7", "--judge", "--judge-model", "deepseek-v4-flash"],
        { REVIEWER_API_KEY: "test-reviewer-key-001", JUDGE_API_KEY: "test-judge-key-001" },
        captured,
      );
      expect(exitCode).toBe(0);
      expect(logs.join("\n")).not.toContain("same-source");
      expect(captured.model).toBe("deepseek-v4-flash");
      expect(captured.reviewerModel).toBe("glm-4.7");
      expect(captured.downgrade).toBe(false);
      expect(captured.customEndpoint).toBe(false);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("glm judge + glm 被测（同家族）+ 官方端点 → 启动即拒（自由 id 暴露的盲区，exit 2）", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "review-agent-hetero-glm-block-"));
    try {
      const captured: { model?: string | null; downgrade?: boolean; customEndpoint?: boolean; reviewerModel?: string } = {};
      const { exitCode, logs } = await runTinyJudgeExperiment(
        workDir,
        ["--id", "hetero-glm-blocked", "--model", "glm-4.7", "--judge", "--judge-model", "glm-5-3-260814"],
        { REVIEWER_API_KEY: "test-reviewer-key-001", JUDGE_API_KEY: "test-judge-key-001" },
        captured,
      );
      expect(exitCode).toBe(2);
      expect(logs.join("\n")).toContain("heterogeneous");
      expect(captured.model).toBeUndefined();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("glm judge + glm 被测（同家族）+ 自定义接入点 → warning 放行（降级通道不挑家族）", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "review-agent-hetero-glm-warn-"));
    try {
      const captured: { model?: string | null; downgrade?: boolean; customEndpoint?: boolean; reviewerModel?: string } = {};
      const { exitCode, logs } = await runTinyJudgeExperiment(
        workDir,
        ["--id", "hetero-glm-warned", "--model", "glm-4.7", "--judge", "--judge-model", "glm-5-3-260814"],
        {
          REVIEWER_API_KEY: "test-reviewer-key-001",
          JUDGE_API_KEY: "test-judge-key-001",
          REVIEWER_URL: "https://gw.example.com",
        },
        captured,
      );
      expect(exitCode).toBe(0);
      const joined = logs.join("\n");
      expect(joined).toContain("warning");
      expect(joined).toContain("same-source");
      expect(captured.downgrade).toBe(true);
      expect(captured.reviewerModel).toBe("glm-4.7");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("异构 id judge（glm）+ deepseek 被测 + 自定义接入点 → 无 warning、降级上下文 false", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "review-agent-hetero-glm-"));
    try {
      const captured: { model?: string | null; downgrade?: boolean; customEndpoint?: boolean; reviewerModel?: string } = {};
      const { exitCode, logs } = await runTinyJudgeExperiment(
        workDir,
        ["--id", "hetero-glm", "--judge", "--judge-model", "glm-5-3-260814"],
        {
          REVIEWER_API_KEY: "test-reviewer-key-001",
          JUDGE_API_KEY: "test-judge-key-001",
          REVIEWER_URL: "https://gw.example.com",
        },
        captured,
      );
      expect(exitCode).toBe(0);
      expect(logs.join("\n")).not.toContain("same-source");
      expect(captured.downgrade).toBe(false);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("缺省 judge 模型（gpt-5.2-pro）+ 自定义接入点 → 无 warning（论文协议锚恒异构）", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "review-agent-hetero-default-"));
    try {
      const captured: { model?: string | null; downgrade?: boolean; customEndpoint?: boolean; reviewerModel?: string } = {};
      const { exitCode, logs } = await runTinyJudgeExperiment(
        workDir,
        ["--id", "hetero-default", "--judge"],
        {
          REVIEWER_API_KEY: "test-reviewer-key-001",
          JUDGE_API_KEY: "test-judge-key-001",
          REVIEWER_URL: "https://gw.example.com",
        },
        captured,
      );
      expect(exitCode).toBe(0);
      expect(logs.join("\n")).not.toContain("same-source");
      expect(captured.model).toBeNull();
      expect(captured.downgrade).toBe(false);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

describe("runExperimentCli — --report-only 异构预检对照持久化计划（#16）", () => {
  function noFileResult(): EnvLocalLoadResult {
    return { filePath: ".env.local", exists: false, loadedKeys: [], skippedKeys: [], malformedLines: [] };
  }

  interface Captured {
    model?: string | null;
    downgrade?: boolean;
    customEndpoint?: boolean;
    reviewerModel?: string;
  }

  /** 两步共用的 CLI 驱动器：cases.json 幂等落盘 + fake 内核 + 捕获 judge 工厂入参 */
  async function runCaptured(
    workDir: string,
    argv: readonly string[],
    env: Record<string, string | undefined>,
    captured: Captured,
  ): Promise<{ readonly exitCode: number; readonly logs: string[] }> {
    const casesFile = path.join(workDir, "cases.json");
    await writeFile(casesFile, JSON.stringify([experimentMainCase("report-only-model-case")]), "utf8");
    const fakeJudge = FakeJudgeClient.fromAdjudications([judgeAdjudication()]);
    const logs: string[] = [];
    const exitCode = await runExperimentCli(
      [...argv, "--configs", "C", "--reps", "1", "--cases-file", casesFile, "--runs-root", workDir],
      {
        env,
        createPiKernel: () => recordingKernel().kernel,
        createJudgeClient: (model, context) => {
          captured.model = model;
          captured.downgrade = context.heterogeneityDowngraded;
          captured.customEndpoint = context.customLlmEndpoint;
          captured.reviewerModel = context.reviewerModel;
          return fakeJudge;
        },
        loadEnvLocal: () => noFileResult(),
        log: (line) => logs.push(line),
      },
    );
    return { exitCode, logs };
  }

  it("report-only 指向 glm 被测实验、不传 --model → 预检按持久化 model 判定（CLI 缺省模型不再误拦）", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "review-agent-report-only-pass-"));
    try {
      // 第一步：真跑出持久化实验目录（被测 glm-4.7 / judge deepseek-v4-flash，异源放行）
      const first = await runCaptured(
        workDir,
        ["--id", "report-only-pass", "--model", "glm-4.7", "--judge", "--judge-model", "deepseek-v4-flash"],
        { REVIEWER_API_KEY: "test-reviewer-key-001", JUDGE_API_KEY: "test-judge-key-001" },
        {},
      );
      expect(first.exitCode).toBe(0);

      // 第二步：--report-only 复算、不传 --model（CLI 计划落缺省 deepseek-v4-flash——
      // 与 judge 同源；修复前预检按 CLI 模型误拦 exit 2，修复后按持久化 glm-4.7 放行）
      const captured: Captured = {};
      const second = await runCaptured(
        workDir,
        ["--id", "report-only-pass", "--report-only", "--judge", "--judge-model", "deepseek-v4-flash"],
        { JUDGE_API_KEY: "test-judge-key-001" },
        captured,
      );
      expect(second.exitCode).toBe(0);
      expect(second.logs.join("\n")).not.toContain("same-source");
      // judge 工厂上下文 = 持久化计划的 model / judgeModel（与实际被报告的数据同源）
      expect(captured.reviewerModel).toBe("glm-4.7");
      expect(captured.model).toBe("deepseek-v4-flash");
      expect(captured.downgrade).toBe(false);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("report-only 传与持久化不同的 --model → 预检仍按持久化 model 判定（CLI 异值不再误放）", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "review-agent-report-only-block-"));
    try {
      // 第一步：自定义接入点降级放行，跑出 deepseek/deepseek 同源实验目录
      const first = await runCaptured(
        workDir,
        ["--id", "report-only-block", "--model", "deepseek-v4-flash", "--judge", "--judge-model", "deepseek-v4-flash"],
        {
          REVIEWER_API_KEY: "test-reviewer-key-001",
          JUDGE_API_KEY: "test-judge-key-001",
          REVIEWER_URL: "https://gw.example.com",
        },
        {},
      );
      expect(first.exitCode).toBe(0);

      // 第二步：无自定义端点 + CLI --model glm-4.7（异值）——修复前按 CLI 判异源误放，
      // 修复后按持久化 deepseek/deepseek 同源拦截（exit 2，judge 工厂未被调用）
      const captured: Captured = {};
      const second = await runCaptured(
        workDir,
        [
          "--id", "report-only-block", "--report-only", "--judge", "--judge-model", "deepseek-v4-flash",
          "--model", "glm-4.7",
        ],
        { JUDGE_API_KEY: "test-judge-key-001" },
        captured,
      );
      expect(second.exitCode).toBe(2);
      expect(second.logs.join("\n")).toContain("heterogeneous");
      expect(captured.model).toBeUndefined();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("report-only 指向不存在实验目录 → 持久化计划载入失败 exit 2（错误文案与重建路径一致）", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "review-agent-report-only-missing-"));
    try {
      const { exitCode, logs } = await runCaptured(
        workDir,
        ["--id", "no-such-experiment", "--report-only", "--judge", "--judge-model", "deepseek-v4-flash"],
        { JUDGE_API_KEY: "test-judge-key-001" },
        {},
      );
      expect(exitCode).toBe(2);
      const joined = logs.join("\n");
      expect(joined).toContain("no plan.json");
      expect(joined).toContain("run the experiment first");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

describe("内核选择收口（#8 P4a 执行缝 / #9 P4b 单一内核）", () => {
  function noFileResult(): EnvLocalLoadResult {
    return { filePath: ".env.local", exists: false, loadedKeys: [], skippedKeys: [], malformedLines: [] };
  }

  it("旗标退役：--kernel/--verifier 均为未知 flag；用法文本不含旗标但说明内核恒 pi", () => {
    expect(parseFail(["--id", "a", "--kernel", "pi"]).message).toContain('unknown flag "--kernel"');
    expect(parseFail(["--id", "a", "--verifier", "on"]).message).toContain('unknown flag "--verifier"');
    const usage = experimentCliUsage();
    expect(usage).not.toContain("--kernel");
    expect(usage).not.toContain("--verifier");
    // 用法附注写明内核口径（P4b 唯一可执行内核 + legacy 只读退役）
    expect(usage).toContain("Review kernel: pi");
  });

  it("进计划：kernel 恒 pi、verifier 恒 off（cliOptionsToPlan 钉死——无旗标可覆盖）", () => {
    const parsed = parseOk(["--id", "a"]);
    if (!parsed.ok) throw new Error("unreachable");
    const plan = cliOptionsToPlan(parsed.options);
    expect(plan.kernel).toBe("pi");
    expect(plan.verifier).toBe("off");
  });

  it("createPiKernel 装配内核经缝执行、plan.json 留痕 kernel=pi", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "review-agent-kernel-cli-"));
    try {
      const casesFile = path.join(workDir, "cases.json");
      await writeFile(
        casesFile,
        JSON.stringify([
          experimentMainCase("kernel-cli-1", {
            labels: { source: "vul4j", riskClass: "High", allowedConfigs: ["A", "B", "C", "D", "E"] },
          }),
        ]),
        "utf8",
      );
      const kernelRequests: unknown[] = [];
      let factoryEnv: Record<string, string | undefined> | undefined;
      const logs: string[] = [];
      const exitCode = await runExperimentCli(
        [
          "--id", "kernel-cli-pi",
          "--configs", "A",
          "--reps", "1",
          "--cases-file", casesFile,
          "--runs-root", workDir,
        ],
        {
          env: { REVIEWER_API_KEY: "test-reviewer-key-001" },
          createPiKernel: (env) => {
            factoryEnv = env;
            return {
              id: "pi",
              execute: async (request) => {
                kernelRequests.push(request);
                return {
                  caseId: request.unit.caseId,
                  configId: request.unit.configId,
                  model: request.model,
                  findings: [],
                  usage: { inputTokens: 1, outputTokens: 1 },
                  rounds: 1,
                  toolCalls: 0,
                  audit: {
                    requests: [], toolCallLog: [], phaseLog: [], rejections: [],
                    cacheBreaks: [], truncated: false, truncationReasons: [],
                  },
                  auditPath: path.join(request.experimentRoot, "pi-audit", `${request.unit.caseId}.json`),
                };
              },
            };
          },
          loadEnvLocal: () => noFileResult(),
          log: (line) => logs.push(line),
        },
      );
      expect(exitCode).toBe(0);
      // 工厂收到注入 env（key 解析在工厂内完成，此处只验传递）
      expect(factoryEnv?.REVIEWER_API_KEY).toBe("test-reviewer-key-001");
      // pi 内核经缝执行 1 单元（P4b：唯一执行路径——createPiKernel 恒被调用）
      expect(kernelRequests).toHaveLength(1);
      // plan.json 留痕 kernel=pi（续跑一致性检测的数据源）
      const planJson = JSON.parse(
        await readFile(path.join(workDir, "kernel-cli-pi", "plan.json"), "utf8"),
      ) as { readonly kernel?: string };
      expect(planJson.kernel).toBe("pi");
      // 记录由 runner 落盘（RunStore 布局）
      const recordPath = path.join(workDir, "kernel-cli-pi", "runs", "vul4j", "kernel-cli-1", "A", "rep-1.json");
      expect(JSON.parse(await readFile(recordPath, "utf8"))).toMatchObject({ caseId: "kernel-cli-1" });
      // 进度日志可见内核选择（成本/口径可见性）
      expect(logs.join("\n")).toContain("kernel=pi");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
