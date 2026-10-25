import { describe, expect, test } from "vitest";

import { fakeReviewRunSummary } from "../rpc/executor.js";
import type { ReviewJobView } from "../rpc/service.js";
import { artifactRef, toHttpJobView } from "./http-view.js";

const succeededView: ReviewJobView = {
  jobId: "job-1-1",
  status: "succeeded",
  caseId: "VUL4J-1",
  configId: "E",
  submittedAt: "2026-10-21T00:00:00.000Z",
  result: fakeReviewRunSummary({
    runId: "run-1",
    auditPath: "C:\\secret\\audit\\run-1.json",
    recordPath: "/srv/secret/record/run-1.json",
  }),
};

describe("artifactRef", () => {
  test("引用形态：artifact:audit|record/<runId>（方案 §4.2 逻辑引用）", () => {
    expect(artifactRef("audit", "run-1")).toBe("artifact:audit/run-1");
    expect(artifactRef("record", "run-42")).toBe("artifact:record/run-42");
  });
});

describe("toHttpJobView", () => {
  test("succeeded：路径双键换引用双键，其余键原样（findings/usage/rounds...）", () => {
    const httpView = toHttpJobView(succeededView);
    expect(httpView).toEqual({
      jobId: "job-1-1",
      status: "succeeded",
      caseId: "VUL4J-1",
      configId: "E",
      submittedAt: "2026-10-21T00:00:00.000Z",
      result: {
        runId: "run-1",
        findings: [],
        usage: fakeReviewRunSummary().usage,
        rounds: 3,
        toolCalls: 2,
        truncated: false,
        auditRef: "artifact:audit/run-1",
        recordRef: "artifact:record/run-1",
      },
    });
  });

  test("非 succeeded 视图（progress/error 面）原样投影——无 result 键", () => {
    const runningView: ReviewJobView = {
      jobId: "job-1-2",
      status: "running",
      caseId: "VUL4J-1",
      configId: "E",
      submittedAt: "2026-10-21T00:00:00.000Z",
      progress: { phase: "verify", round: 1, toolCalls: 4, usage: { inputTokens: 100, outputTokens: 50 } },
    };
    expect(toHttpJobView(runningView)).toEqual(runningView);

    const failedView: ReviewJobView = {
      jobId: "job-1-3",
      status: "failed",
      caseId: "VUL4J-1",
      configId: "E",
      submittedAt: "2026-10-21T00:00:00.000Z",
      error: { message: "review execution failed" },
    };
    expect(toHttpJobView(failedView)).toEqual(failedView);
  });

  test("纯投影：不改变输入视图（服务器路径不外泄的不可变保证）", () => {
    const source = succeededView;
    toHttpJobView(source);
    expect(source.result?.auditPath).toBe("C:\\secret\\audit\\run-1.json");
    expect(source.result?.recordPath).toBe("/srv/secret/record/run-1.json");
    expect("auditRef" in (source.result ?? {})).toBe(false);
  });
});
