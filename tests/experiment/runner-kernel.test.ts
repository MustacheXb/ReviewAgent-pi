import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunResult } from "../../src/instrument/contracts/run.js";
import type { ExperimentPlan } from "../../src/experiment/plan.js";
import { validateExperimentPlan } from "../../src/experiment/plan.js";
import type { ReviewKernel, UnitReviewRequest } from "../../src/experiment/review-kernel.js";
import { PLAN_FILE, runExperiment } from "../../src/experiment/runner.js";
import { experimentMainCase, experimentPlan } from "./helpers.js";
import { makeFinding } from "../metrics/helpers.js";

/**
 * #8 P4a 内核执行缝 / #9 P4b 单一内核（runner 侧，fake 内核——零 pi 依赖）：
 * executeUnit 的可替换执行点。P4b 起 deps.kernel 必填、唯一可执行值 = pi
 * （legacy 运行时已退役，"legacy" 仅作历史计划的读侧值）。守卫面：
 * 启动一致性（kernel.id ≡ plan.kernel，含 legacy 计划的退役提示）、
 * plan.json 内核冲突检测（记录不携带内核标识，续跑一致性以 plan.json 为准）、
 * 口径诚实护栏、失败隔离、断点续跑在缝上同样工作。
 * 真 pi 内核过缝（离线 A–E 全链）见 runner-pi-offline.test.ts；真跑见 e2e。
 */

/** 缝请求 → 同构 RunResult（单 finding；auditPath 由「内核」自定——验证透传） */
function kernelResultOf(request: UnitReviewRequest): RunResult {
  return {
    caseId: request.unit.caseId,
    configId: request.unit.configId,
    model: request.model,
    findings: [makeFinding()],
    usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 0 },
    rounds: 1,
    toolCalls: 0,
    audit: {
      requests: [],
      toolCallLog: [],
      phaseLog: [],
      rejections: [],
      cacheBreaks: [],
      truncated: false,
      truncationReasons: [],
    },
    auditPath: path.join(request.experimentRoot, "pi-audit", `${request.unit.caseId}.json`),
  };
}

function recordingKernel(
  resultOf: (request: UnitReviewRequest) => RunResult = kernelResultOf,
): { readonly kernel: ReviewKernel; readonly requests: UnitReviewRequest[] } {
  const requests: UnitReviewRequest[] = [];
  return {
    requests,
    kernel: {
      id: "pi",
      execute: async (request) => {
        requests.push(request);
        return resultOf(request);
      },
    },
  };
}

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "review-agent-kernel-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function rootOf(id: string): { readonly experimentRoot: string } {
  return { experimentRoot: path.join(workDir, id) };
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

/** 落一份 #8 前的历史 plan.json（无 kernel 键——当时的真实形态） */
async function persistLegacyPlanJson(experimentRoot: string, plan: ExperimentPlan): Promise<void> {
  const legacy: Record<string, unknown> = { ...plan };
  delete legacy.kernel;
  await mkdir(experimentRoot, { recursive: true });
  await writeFile(path.join(experimentRoot, PLAN_FILE), JSON.stringify(legacy), "utf8");
}

describe("计划校验（kernel 字段，#8/#9）", () => {
  it("kernel 只接受 legacy | pi", () => {
    const bad = { ...experimentPlan(), kernel: "dsh" } as unknown as ExperimentPlan;
    expect(() => validateExperimentPlan(bad)).toThrow(/plan\.kernel/);
  });

  it("pi 内核与 verifier=on 互斥（pi 线恒 baseline-only，二遍复核是 legacy 消融面）", () => {
    expect(() => validateExperimentPlan(experimentPlan({ kernel: "pi", verifier: "on" }))).toThrow(
      /pi/,
    );
  });

  it("legacy 仍是合法值（#9 后仅作历史计划的读侧值：verifier=on 的 legacy 形状可校验）", () => {
    expect(() =>
      validateExperimentPlan(experimentPlan({ kernel: "legacy", verifier: "on" })),
    ).not.toThrow();
  });
});

describe("runExperiment（#8 内核执行缝 / #9 单一内核）", () => {
  it("plan.kernel=pi + 注入内核：executeUnit 经缝执行，runner 是记录唯一写者", async () => {
    const case_ = experimentMainCase("kernel-seam-1");
    const { kernel, requests } = recordingKernel();
    const root = rootOf("kernel-seam");
    const outcome = await runExperiment(
      experimentPlan({ experimentId: "kernel-seam", kernel: "pi" }),
      [case_],
      { kernel },
      root,
    );

    expect(outcome.executed).toBe(1);
    expect(outcome.resumed).toBe(0);
    expect(outcome.failures).toEqual([]);

    // 缝契约：内核收到 unit + mrCase + model + experimentRoot
    expect(requests).toHaveLength(1);
    expect(requests[0]?.unit).toEqual({
      source: "defects4j",
      caseId: "kernel-seam-1",
      configId: "A",
      rep: 1,
    });
    expect(requests[0]?.mrCase).toBe(case_);
    expect(requests[0]?.model).toBe("deepseek-v4-flash");
    expect(requests[0]?.experimentRoot).toBe(root.experimentRoot);

    // 记录由 runner 落盘（RunStore 布局不变）；baseline 快照来自内核 RunResult
    const record = outcome.records[0];
    expect(record).toMatchObject({
      source: "defects4j",
      caseId: "kernel-seam-1",
      configId: "A",
      rep: 1,
      model: "deepseek-v4-flash",
      verifier: "off",
    });
    expect(record?.baseline.findings).toHaveLength(1);
    expect(record?.baseline.usage).toEqual({ inputTokens: 11, outputTokens: 2, cacheReadTokens: 0 });
    // 内核自定的 auditPath 原样透传（审计落盘是内核职责，runner 不重排）
    expect(record?.baseline.auditPath).toBe(
      path.join(root.experimentRoot, "pi-audit", "kernel-seam-1.json"),
    );
    expect(
      existsSync(path.join(root.experimentRoot, "runs", "defects4j", "kernel-seam-1", "A", "rep-1.json")),
    ).toBe(true);

    // plan.json 留痕 kernel=pi（续跑一致性检测的数据源）
    const persistedPlan = (await readJson(path.join(root.experimentRoot, PLAN_FILE))) as {
      readonly kernel?: string;
    };
    expect(persistedPlan.kernel).toBe("pi");
  });

  it("启动一致性守卫：plan.kernel=legacy（历史计划）而注入 pi 内核 → 启动即报错（含退役提示），零落盘", async () => {
    const { kernel } = recordingKernel();
    await expect(
      runExperiment(
        experimentPlan({ experimentId: "kernel-guard", kernel: "legacy" }),
        [experimentMainCase("kernel-guard-1")],
        { kernel },
        rootOf("kernel-guard"),
      ),
    ).rejects.toThrow(/retired in P4b/);
    expect(existsSync(path.join(rootOf("kernel-guard").experimentRoot, PLAN_FILE))).toBe(false);
  });

  it("口径诚实护栏在缝上同样生效：内核返回 model ≠ plan.model → 单元失败留痕，不落记录", async () => {
    const { kernel } = recordingKernel((request) => ({
      ...kernelResultOf(request),
      model: "other-model",
    }));
    const outcome = await runExperiment(
      experimentPlan({ experimentId: "kernel-model", kernel: "pi" }),
      [experimentMainCase("kernel-model-1")],
      { kernel },
      rootOf("kernel-model"),
    );
    expect(outcome.executed).toBe(0);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.message).toMatch(/model/);
    expect(outcome.records).toEqual([]);
  });

  it("失败隔离经缝工作：内核抛错 → 该单元失败留痕，整批继续", async () => {
    let calls = 0;
    const requests: UnitReviewRequest[] = [];
    const kernel: ReviewKernel = {
      id: "pi",
      execute: async (request) => {
        calls += 1;
        requests.push(request);
        if (calls === 1) {
          throw new Error("kernel exploded");
        }
        return kernelResultOf(request);
      },
    };
    const outcome = await runExperiment(
      experimentPlan({ experimentId: "kernel-isolate", kernel: "pi", configs: ["A", "B"] }),
      [experimentMainCase("kernel-isolate-1")],
      { kernel },
      rootOf("kernel-isolate"),
    );
    expect(outcome.executed).toBe(1);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.message).toBe("kernel exploded");
    expect(outcome.failures[0]).toMatchObject({ configId: "A", rep: 1 });
    expect(outcome.records.map((record) => record.configId)).toEqual(["B"]);
  });

  it("断点续跑在 pi 内核路径下工作：已完成单元跳过（内核零调用）", async () => {
    const case_ = experimentMainCase("kernel-resume-1");
    const root = rootOf("kernel-resume");
    const plan = experimentPlan({ experimentId: "kernel-resume", kernel: "pi" });
    const first = recordingKernel();
    await runExperiment(plan, [case_], { kernel: first.kernel }, root);
    expect(first.requests).toHaveLength(1);

    const second = recordingKernel();
    const outcome = await runExperiment(plan, [case_], { kernel: second.kernel }, root);
    expect(outcome.resumed).toBe(1);
    expect(outcome.executed).toBe(0);
    expect(second.requests).toHaveLength(0);
  });

  it("续跑内核冲突检测：plan.json 是历史 legacy 形态（无 kernel 键）而新计划 pi → 启动即报错", async () => {
    const case_ = experimentMainCase("kernel-conflict-1");
    const root = rootOf("kernel-conflict");
    // #8 前的历史形态：plan.json 无 kernel 键（legacy 执行已退役，无法真跑——手工落档）
    await persistLegacyPlanJson(root.experimentRoot, experimentPlan({ experimentId: "kernel-conflict" }));
    const { kernel } = recordingKernel();
    await expect(
      runExperiment(
        experimentPlan({ experimentId: "kernel-conflict", kernel: "pi" }),
        [case_],
        { kernel },
        root,
      ),
    ).rejects.toThrow(/kernel/);
  });

  it("续跑内核冲突检测（反向）：plan.json 已是 pi 而新计划 legacy → 启动即报错（legacy 只读）", async () => {
    const case_ = experimentMainCase("kernel-conflict-rev-1");
    const root = rootOf("kernel-conflict-rev");
    const { kernel } = recordingKernel();
    await runExperiment(
      experimentPlan({ experimentId: "kernel-conflict-rev", kernel: "pi" }),
      [case_],
      { kernel },
      root,
    );
    await expect(
      runExperiment(
        experimentPlan({ experimentId: "kernel-conflict-rev", kernel: "legacy" }),
        [case_],
        { kernel },
        root,
      ),
    ).rejects.toThrow(/legacy runtime was retired in P4b/);
  });
});
