import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPersistedPlan, runExperiment } from "../../src/experiment/runner.js";
import { CASES_FILE, FAILURES_FILE, PLAN_FILE } from "../../src/experiment/runner.js";
import type { ExperimentOutcome } from "../../src/experiment/runner.js";
import { RunStore } from "../../src/experiment/run-store.js";
import {
  HAPPY_KERNEL_RESULT,
  experimentCleanCase,
  experimentMainCase,
  experimentPlan,
  gateRunRecord,
  happyKernel,
  scriptedKernel,
} from "./helpers.js";

/**
 * 实验矩阵运行器（Ticket 12 / issue #13 验收）：
 * 数据集 → 内核执行缝 → 记录落盘；断点续跑（已完成即跳过，不再花钱）；
 * 失败隔离（单单元失败留痕继续）；过期 model/verifier 配置启动即报错。
 * #9 P4b 起检视执行经 fake 内核（脚本化 RunResult，零网络零真实 LLM；
 * 内核缝契约/守卫细节见 runner-kernel.test.ts，真 pi 内核见 runner-pi-offline）。
 */

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "review-agent-runner-"));
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

describe("runExperiment（矩阵执行）", () => {
  it("单 case × config A × 1 rep：记录落盘 + plan/cases 留痕 + 审计路径透传", async () => {
    const case_ = experimentMainCase("runner-main-1");
    const outcome = await runExperiment(
      experimentPlan({ experimentId: "runner-happy" }),
      [case_],
      { kernel: happyKernel(1).kernel },
      rootOf("runner-happy"),
    );
    expect(outcome.executed).toBe(1);
    expect(outcome.resumed).toBe(0);
    expect(outcome.failures).toEqual([]);
    expect(outcome.records).toHaveLength(1);
    const record = outcome.records[0];
    expect(record).toMatchObject({
      source: "defects4j",
      caseId: "runner-main-1",
      configId: "A",
      rep: 1,
      model: "deepseek-v4-flash",
      verifier: "off",
    });
    expect(record?.baseline.findings).toHaveLength(1);
    expect(record?.baseline.usage).toEqual(HAPPY_KERNEL_RESULT.usage);
    // AuditLight 投影不含 requests（重放字节以 auditPath 为真源）
    expect(record?.baseline.audit).not.toHaveProperty("requests");
    // verifier 执行面已随 legacy 运行时退役（#9）：恒单遍，消融字段恒空
    expect(record?.effective).toBeNull();
    expect(record?.verifierPass).toBeNull();
    // plan.json / cases.json 留痕（外部可复现实验配置与数据集选择）
    const plan = (await readJson(path.join(rootOf("runner-happy").experimentRoot, PLAN_FILE))) as {
      readonly experimentId: string;
      readonly caseIds: readonly string[];
      readonly kernel: string;
    };
    expect(plan.experimentId).toBe("runner-happy");
    expect(plan.caseIds).toEqual(["runner-main-1"]);
    expect(plan.kernel).toBe("pi");
    const cases = (await readJson(
      path.join(rootOf("runner-happy").experimentRoot, CASES_FILE),
    )) as readonly { readonly caseId: string }[];
    expect(cases.map((entry) => entry.caseId)).toEqual(["runner-main-1"]);
    // 审计路径原样透传（审计落盘是内核职责，runner 不重排——runner-kernel 详测）
    expect(record?.baseline.auditPath).toBe(HAPPY_KERNEL_RESULT.auditPath);
  });

  it("reps=2：记录按 rep 升序（rep1 冷 / rep2 热分层的输入顺序）", async () => {
    const outcome = await runExperiment(
      experimentPlan({ experimentId: "runner-reps", reps: 2 }),
      [experimentMainCase("runner-main-2")],
      { kernel: happyKernel(2).kernel },
      rootOf("runner-reps"),
    );
    expect(outcome.records.map((record) => record.rep)).toEqual([1, 2]);
    expect(outcome.executed).toBe(2);
  });

  it("多 case 混源：clean MR 与主集 case 同批执行", async () => {
    const main = experimentMainCase("runner-main-3");
    const clean = experimentCleanCase("runner-clean-3");
    const outcome = await runExperiment(
      experimentPlan({ experimentId: "runner-mixed" }),
      [main, clean],
      { kernel: happyKernel(2).kernel },
      rootOf("runner-mixed"),
    );
    expect(outcome.executed).toBe(2);
    expect(outcome.records.map((record) => `${record.source}/${record.caseId}`)).toEqual([
      "defects4j/runner-main-3",
      "clean-mr/runner-clean-3",
    ]);
    expect(outcome.cases.map((mrCase) => mrCase.caseId)).toEqual([
      "runner-main-3",
      "runner-clean-3",
    ]);
  });
});

describe("runExperiment（断点续跑）", () => {
  it("同计划重跑：已完成单元跳过（内核零调用），记录仍齐全", async () => {
    const case_ = experimentMainCase("runner-resume-1");
    const root = rootOf("runner-resume");
    const first = await runExperiment(
      experimentPlan({ experimentId: "runner-resume", reps: 2 }),
      [case_],
      { kernel: happyKernel(2).kernel },
      root,
    );
    expect(first.executed).toBe(2);
    const idleKernel = happyKernel(0);
    const second = await runExperiment(
      experimentPlan({ experimentId: "runner-resume", reps: 2 }),
      [case_],
      { kernel: idleKernel.kernel },
      root,
    );
    expect(second.executed).toBe(0);
    expect(second.resumed).toBe(2);
    expect(idleKernel.callCount).toBe(0); // 不再花钱
    expect(second.records).toHaveLength(2);
    expect(second.records.map((record) => record.rep)).toEqual([1, 2]);
  });

  it("model / verifier 与既有记录冲突：启动即报错（防静默重跑烧钱）", async () => {
    const case_ = experimentMainCase("runner-stale-1", { labels: { riskClass: "High" } });
    const root = rootOf("runner-stale");
    await runExperiment(
      experimentPlan({ experimentId: "runner-stale" }),
      [case_],
      { kernel: happyKernel(1).kernel },
      root,
    );
    await expect(
      runExperiment(
        experimentPlan({
          experimentId: "runner-stale",
          model: "deepseek-v4-pro",
          highRiskOnly: true,
        }),
        [case_],
        { kernel: happyKernel(1).kernel },
        root,
      ),
    ).rejects.toThrow(/different\s+model\/verifier configuration/);
  });

  it("历史 verifier=on 记录与 pi 计划（恒 off）冲突：启动即报错（#9 后 legacy 记录的续跑边界）", async () => {
    const case_ = experimentMainCase("runner-stale-vf-1");
    const root = rootOf("runner-stale-vf");
    // verifier=on 只存在于 legacy 时代的记录（执行面已随 #9 退役）——手工落一条
    // 历史形态记录，验证 pi 计划续跑被拒（记录契约冻结，读侧守卫仍在）
    const store = new RunStore(path.join(root.experimentRoot, "runs"));
    await store.save(
      gateRunRecord({
        source: "defects4j",
        caseId: "runner-stale-vf-1",
        configId: "A",
        rep: 1,
        verifier: "on",
      }),
    );
    await expect(
      runExperiment(
        experimentPlan({ experimentId: "runner-stale-vf" }),
        [case_],
        { kernel: happyKernel(0).kernel },
        root,
      ),
    ).rejects.toThrow(/different\s+model\/verifier configuration/);
  });

  it("同 id 不同数据集选择：报错（防同目录混入异数据集记录）", async () => {
    const caseA = experimentMainCase("runner-case-a");
    const caseB = experimentMainCase("runner-case-b");
    const root = rootOf("runner-caseset");
    await runExperiment(
      experimentPlan({ experimentId: "runner-caseset" }),
      [caseA],
      { kernel: happyKernel(1).kernel },
      root,
    );
    await expect(
      runExperiment(
        experimentPlan({ experimentId: "runner-caseset" }),
        [caseA, caseB],
        { kernel: happyKernel(2).kernel },
        root,
      ),
    ).rejects.toThrow(/different case set/);
  });
});

describe("runExperiment（失败隔离）", () => {
  it("单单元内核失败：留痕 failures + failures.json，其余单元继续", async () => {
    const plan = experimentPlan({ experimentId: "runner-isolation" });
    const cases = [experimentMainCase("runner-iso-1"), experimentMainCase("runner-iso-2")];
    // 单元 1 正常完成；单元 2 注入确定性失败 → 留痕后整批继续
    const { kernel } = scriptedKernel([
      { kind: "result", result: HAPPY_KERNEL_RESULT },
      { kind: "fail", error: new Error("injected unit failure") },
    ]);
    const outcome = await runExperiment(plan, cases, { kernel }, rootOf("runner-isolation"));
    expect(outcome.executed).toBe(1);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatchObject({
      source: "defects4j",
      caseId: "runner-iso-2",
      configId: "A",
      rep: 1,
    });
    expect(outcome.failures[0]?.message).toContain("injected unit failure");
    expect(outcome.records.map((record) => record.caseId)).toEqual(["runner-iso-1"]);
    // 失败留痕落盘（--report-only 重建报告的数据源）
    const persisted = (await readJson(
      path.join(rootOf("runner-isolation").experimentRoot, FAILURES_FILE),
    )) as readonly { readonly caseId: string }[];
    expect(persisted).toEqual(outcome.failures);
  });

  it("全部单元失败：failures 全留痕，records 为空", async () => {
    const { kernel } = scriptedKernel([{ kind: "fail", error: new Error("api down") }]);
    const outcome = await runExperiment(
      experimentPlan({ experimentId: "runner-all-fail" }),
      [experimentMainCase("runner-af-1")],
      { kernel },
      rootOf("runner-all-fail"),
    );
    expect(outcome.executed).toBe(0);
    expect(outcome.records).toEqual([]);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.message).toContain("api down");
  });
});

describe("runExperiment（进度回调）", () => {
  it("onUnit 依次派发 completed/resumed/failed（回调异常不拖垮实验）", async () => {
    const case_ = experimentMainCase("runner-events-1");
    const root = rootOf("runner-events");
    const events: string[] = [];
    await runExperiment(
      experimentPlan({ experimentId: "runner-events" }),
      [case_],
      { kernel: happyKernel(1).kernel, onUnit: (event) => events.push(event.kind) },
      root,
    );
    const idleKernel = happyKernel(0);
    await runExperiment(
      experimentPlan({ experimentId: "runner-events" }),
      [case_],
      {
        kernel: idleKernel.kernel,
        onUnit: (event) => {
          events.push(event.kind);
          throw new Error("observer crash must not stop the experiment");
        },
      },
      root,
    );
    expect(events).toEqual(["completed", "resumed"]);
  });
});

describe("runExperiment（ExperimentOutcome 形状）", () => {
  it("expanded 携带展开结果（units/skipped 可审计）", async () => {
    const outcome: ExperimentOutcome = await runExperiment(
      experimentPlan({ experimentId: "runner-shape" }),
      [experimentMainCase("runner-shape-1"), experimentCleanCase("runner-shape-c")],
      { kernel: happyKernel(2).kernel },
      rootOf("runner-shape"),
    );
    expect(outcome.experimentId).toBe("runner-shape");
    expect(outcome.expanded.units).toHaveLength(2);
    expect(outcome.expanded.skipped).toEqual([]);
  });
});

describe("loadPersistedPlan（旧版 plan 兼容，#33/#8）", () => {
  it("#33 前的 plan.json 无 judgeModel 字段 → 归一为 null（当时即缺省 gpt-5.2-pro 口径）", async () => {
    const root = path.join(workDir, "legacy-plan");
    await mkdir(root, { recursive: true });
    const legacy: Record<string, unknown> = {
      ...experimentPlan({ experimentId: "legacy-plan" }),
    };
    delete legacy.judgeModel;
    await writeFile(path.join(root, PLAN_FILE), JSON.stringify(legacy), "utf8");
    const plan = await loadPersistedPlan(root);
    expect(plan.judgeModel).toBeNull();
    expect(plan.experimentId).toBe("legacy-plan");
  });

  it("#8 前的 plan.json 无 kernel 字段 → 归一为 legacy（历史计划只读：--report-only 仍可消费）", async () => {
    const root = path.join(workDir, "legacy-kernel-plan");
    await mkdir(root, { recursive: true });
    const legacy: Record<string, unknown> = {
      ...experimentPlan({ experimentId: "legacy-kernel-plan" }),
    };
    delete legacy.kernel;
    await writeFile(path.join(root, PLAN_FILE), JSON.stringify(legacy), "utf8");
    const plan = await loadPersistedPlan(root);
    expect(plan.kernel).toBe("legacy");
  });
});
