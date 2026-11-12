import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewKernel, UnitReviewRequest } from "../../src/gate/review-kernel.js";
import {
  cRefSidecarPath,
  createCRefKernel,
} from "../../src/eval/ref/c-ref-kernel.js";
import { runResult } from "./campaign-fixtures.js";

/**
 * C_ref kernel seam（#43）：eval-only 包装 base E kernel，把全仓注入追加到
 * issue 上下文，并把 FullRepoRecord 写评测侧 sidecar（不写生产 RunAudit）。
 */

const SAMPLE = path.join(__dirname, "testdata", "full-repo", "sample");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function request(experimentRoot: string): UnitReviewRequest {
  return {
    unit: { source: "vul4j", caseId: "VUL4J-1", configId: "E", rep: 1 },
    mrCase: {
      caseId: "VUL4J-1",
      repoPath: SAMPLE,
      diff: "diff --git a/A.java b/A.java",
      issueDescription: "original issue",
      truth: null,
      labels: { source: "vul4j", riskClass: "Low", allowedConfigs: ["E"] },
    },
    model: "deepseek-v4-flash",
    experimentRoot,
  };
}

describe("createCRefKernel", () => {
  it("单案：全仓内容进入 issue 上下文，返回 eval-only fullRepo 记录并写 sidecar", async () => {
    const experimentRoot = await mkdtemp(path.join(tmpdir(), "c-ref-kernel-"));
    tempDirs.push(experimentRoot);
    const captured: { request: UnitReviewRequest | null } = { request: null };
    const baseKernel: ReviewKernel = {
      id: "pi",
      execute: async (req) => {
        captured.request = req;
        return runResult(req);
      },
    };
    const kernel = createCRefKernel({ baseKernel, budgetChars: 10_000 });

    const result = await kernel.execute(request(experimentRoot));

    if (captured.request === null) {
      throw new Error("base kernel was not called");
    }
    const description = captured.request.mrCase.issueDescription;
    expect(description).toContain("original issue");
    expect(description).toContain("Full repository context (C_ref, eval-only).");
    expect(description).toContain("## File: src/main/java/com/example/Alpha.java");
    expect(description).not.toContain("Ignored.java");
    expect(description).not.toContain("Generated.java");

    expect(result.fullRepo).toMatchObject({
      budgetChars: 10_000,
      truncated: false,
      totalFiles: 3,
      shownFiles: 3,
    });
    // 生产 RunAudit 不复活 fullRepo
    expect("fullRepo" in result.audit).toBe(false);

    const sidecarFile = cRefSidecarPath(experimentRoot, request(experimentRoot).unit);
    expect(existsSync(sidecarFile)).toBe(true);
    const sidecar = JSON.parse(readFileSync(sidecarFile, "utf8")) as Record<string, unknown>;
    expect(sidecar).toMatchObject({
      kind: "c-ref-full-repo-sidecar",
      schemaVersion: 1,
      ref: "C_ref",
      evalOnly: true,
      caseId: "VUL4J-1",
      configId: "C",
      kernelConfigId: "E",
      rep: 1,
      fullRepo: result.fullRepo,
    });
  });

  it("确定性与截断留痕：同输入 sidecar 字节稳定；小预算 truncated=true", async () => {
    const rootA = await mkdtemp(path.join(tmpdir(), "c-ref-kernel-a-"));
    const rootB = await mkdtemp(path.join(tmpdir(), "c-ref-kernel-b-"));
    tempDirs.push(rootA, rootB);
    const baseKernel: ReviewKernel = {
      id: "pi",
      execute: async (req) => runResult(req),
    };

    const small = createCRefKernel({ baseKernel, budgetChars: 500 });
    const resultA = await small.execute(request(rootA));
    await small.execute(request(rootB));

    expect(resultA.fullRepo.truncated).toBe(true);
    expect(resultA.fullRepo.shownFiles).toBeLessThan(3);
    const sidecarA = cRefSidecarPath(rootA, request(rootA).unit);
    const sidecarB = cRefSidecarPath(rootB, request(rootB).unit);
    expect(readFileSync(sidecarA, "utf8")).toBe(readFileSync(sidecarB, "utf8"));
  });

  it("base kernel 失败：不写 sidecar，错误原样上抛", async () => {
    const experimentRoot = await mkdtemp(path.join(tmpdir(), "c-ref-kernel-fail-"));
    tempDirs.push(experimentRoot);
    const failing: ReviewKernel = {
      id: "pi",
      execute: async () => {
        throw new Error("base kernel failed");
      },
    };
    const kernel = createCRefKernel({ baseKernel: failing, budgetChars: 10_000 });

    await expect(kernel.execute(request(experimentRoot))).rejects.toThrow(/base kernel failed/);
    expect(existsSync(cRefSidecarPath(experimentRoot, request(experimentRoot).unit))).toBe(false);
  });
});
