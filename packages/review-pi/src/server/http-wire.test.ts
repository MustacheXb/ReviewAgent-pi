import { describe, expect, test } from "vitest";

import { SSE_HEARTBEAT_FRAME, SSE_RETRY_FRAME, parseJobsPath, sseDataFrame } from "./http-wire.js";

describe("parseJobsPath", () => {
  test("events 子路由：/v1/jobs/{jobId}/events", () => {
    expect(parseJobsPath("/v1/jobs/job-1-1/events")).toEqual({
      kind: "events",
      jobId: "job-1-1",
    });
  });

  test("artifact 子路由：audit / record 双形态", () => {
    expect(parseJobsPath("/v1/jobs/job-1-1/artifacts/audit")).toEqual({
      kind: "artifact",
      jobId: "job-1-1",
      artifact: "audit",
    });
    expect(parseJobsPath("/v1/jobs/job-1-1/artifacts/record")).toEqual({
      kind: "artifact",
      jobId: "job-1-1",
      artifact: "record",
    });
  });

  test("jobId 段 URL 解码（Location 头 encodeURIComponent 对偶）；query 串剥离", () => {
    expect(parseJobsPath("/v1/jobs/job%2Fx/events")).toEqual({ kind: "events", jobId: "job/x" });
    expect(parseJobsPath("/v1/jobs/job-1-1/events?foo=1&bar=2")).toEqual({
      kind: "events",
      jobId: "job-1-1",
    });
  });

  test("非契约面 → undefined：前缀/段数/artifact 类别/空 jobId/尾斜杠", () => {
    expect(parseJobsPath("/v2/jobs/job-1/events")).toBeUndefined();
    expect(parseJobsPath("/v1/jobs/job-1")).toBeUndefined();
    expect(parseJobsPath("/v1/jobs/job-1/events/extra")).toBeUndefined();
    expect(parseJobsPath("/v1/jobs/job-1/artifacts")).toBeUndefined();
    expect(parseJobsPath("/v1/jobs/job-1/artifacts/summary")).toBeUndefined();
    expect(parseJobsPath("/v1/jobs//events")).toBeUndefined();
    expect(parseJobsPath("/v1/jobs/job-1/events/")).toBeUndefined();
    expect(parseJobsPath("/healthz")).toBeUndefined();
  });
});

describe("SSE 帧序列化", () => {
  test("data 帧：event/id/data 三行 + 空行终结（W3C event-stream）", () => {
    expect(sseDataFrame("job", 3, { seq: 3, status: "running" })).toBe(
      'event: job\nid: 3\ndata: {"seq":3,"status":"running"}\n\n',
    );
  });

  test("retry 帧与心跳注释帧（首帧 5000ms 重连指示；心跳不进客户端事件面）", () => {
    expect(SSE_RETRY_FRAME).toBe("retry: 5000\n\n");
    expect(SSE_HEARTBEAT_FRAME).toBe(": heartbeat\n\n");
  });
});
