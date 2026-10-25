/**
 * #30 P3a：ReviewJobStore 端口契约测试套——同套测试双实现（spec #25 Testing
 * Decisions：「memory / sqlite 同契约，SQLite 特有行为——重启恢复、跨重启
 * 重放——只在此缝测」）。
 *
 - `describeStoreContract`：形态无关的行为契约（allocateJobId / saveJob+getJob
 *   roundtrip / listJobs 过滤排序 / appendEvent+readJobEvents 重放语义 /
 *   loadActiveJobs 恢复面）——memory 与 sqlite 各注册一次；
 * - SQLite 特有 describe：跨实例持久性（close → 重开 = 重启模拟）、
 *   allocateJobId 跨实例防碰撞、blobs sha256 内容去重（直接查库断言 schema 面）；
 * - memory 特有 describe：maxJobEvents 保留窗（readEvents gap 材料推进）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import type { ReviewRunProgress, ReviewRunRequest, ReviewRunSummary } from "./executor.js";
import { fakeReviewRunSummary } from "./executor.js";
import type { ReviewJobEvent, ReviewJobView } from "./service.js";
import { createMemoryJobStore, type ReviewJobStore, type StoredReviewJob } from "./store.js";
import { createSqliteReviewJobStore } from "./sqlite-store.js";

// ---- 测试语料 ----

/** 执行请求基准值（submit 时刻已解析形态：diff 已是文本、repoPath 已 realpath） */
function storedRequest(overrides: Partial<ReviewRunRequest> = {}): ReviewRunRequest {
  return {
    caseId: "VUL4J-1",
    repoPath: "/tmp/repo-snapshot",
    diff: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n",
    issueDescription: "",
    configId: "E",
    ...overrides,
  };
}

/** StoredReviewJob 工厂：基准值 + 按需覆写（缺席省键字段不默认填充） */
function storedJob(overrides: Partial<StoredReviewJob> = {}): StoredReviewJob {
  return {
    jobId: "job-1000-1",
    tenantId: "tenant-a",
    status: "queued",
    request: storedRequest(),
    submittedAt: "2026-10-25T00:00:00.000Z",
    submittedSeq: 1,
    ...overrides,
  };
}

/** job 事件（{seq, job}——与 service emitEvent 同构） */
function jobEvent(seq: number, view: Partial<ReviewJobView> = {}): ReviewJobEvent {
  return {
    seq,
    job: {
      jobId: "job-1000-1",
      status: "queued",
      caseId: "VUL4J-1",
      configId: "E",
      submittedAt: "2026-10-25T00:00:00.000Z",
      ...view,
    },
  };
}

const OTHER_PROGRESS: ReviewRunProgress = { phase: "judge", round: 2, toolCalls: 5 };
const OTHER_SUMMARY: ReviewRunSummary = fakeReviewRunSummary({ runId: "run-stored-1" });

// ---- 同契约套（双实现注册）----

function describeStoreContract(name: string, makeStore: () => ReviewJobStore): void {
  describe(name, () => {
    test("allocateJobId：形态 job-<startMs>-<seq>；seq 单调递增且不重复", () => {
      const store = makeStore();
      const first = store.allocateJobId(1_700_000_000_000);
      const second = store.allocateJobId(1_700_000_000_000);
      expect(first.jobId).toBe("job-1700000000000-1");
      expect(first.seq).toBe(1);
      expect(second.jobId).toBe("job-1700000000000-2");
      expect(second.seq).toBe(2);
      // startMs 参与 jobId（跨启动毫秒面），seq 恒全局单调
      const third = store.allocateJobId(1_700_000_000_099);
      expect(third.jobId).toBe("job-1700000000099-3");
      expect(third.seq).toBe(3);
    });

    test("saveJob + getJob：全字段 roundtrip 保真（progress/result/error 缺席省键）", () => {
      const store = makeStore();
      const job = storedJob();
      store.saveJob(job);
      expect(store.getJob("job-1000-1")).toEqual(job);
    });

    test("saveJob + getJob：progress/result/error 在场时逐字段保真", () => {
      const store = makeStore();
      const job = storedJob({
        status: "running",
        progress: OTHER_PROGRESS,
      });
      store.saveJob(job);
      expect(store.getJob("job-1000-1")).toEqual(job);

      const finished = storedJob({
        status: "succeeded",
        result: OTHER_SUMMARY,
        finishedAtMs: 1_700_000_000_123,
      });
      store.saveJob(finished);
      expect(store.getJob("job-1000-1")).toEqual(finished);
    });

    test("saveJob：同 jobId 全量覆写（转移点 upsert——旧字段不残留）", () => {
      const store = makeStore();
      store.saveJob(storedJob({ status: "running", progress: OTHER_PROGRESS }));
      store.saveJob(
        storedJob({ status: "succeeded", result: OTHER_SUMMARY, finishedAtMs: 123 }),
      );
      const stored = store.getJob("job-1000-1");
      // running 期的 progress 不残留（缺席省键——终态快照不带执行中间态）
      expect(stored?.progress).toBeUndefined();
      expect(stored?.status).toBe("succeeded");
      expect(stored?.result).toEqual(OTHER_SUMMARY);
    });

    test("getJob：未知 jobId → undefined", () => {
      const store = makeStore();
      expect(store.getJob("job-unknown")).toBeUndefined();
    });

    test("saveJob 的 request 全字段 roundtrip（恢复面重新执行的全部材料）", () => {
      const store = makeStore();
      const request = storedRequest({
        caseId: "MR-42",
        repoPath: "D:\\snapshots\\repo-42",
        diff: "diff --git a/x b/x\n+payload\n",
        issueDescription: "议题描述（含 unicode 与 \"引号\"）",
        configId: "C",
        modelId: "custom-model-id",
      });
      store.saveJob(storedJob({ request }));
      expect(store.getJob("job-1000-1")?.request).toEqual(request);
    });

    test("listJobs：租户过滤 + submittedSeq 降序", () => {
      const store = makeStore();
      store.saveJob(storedJob({ jobId: "j-1", submittedSeq: 1 }));
      store.saveJob(
        storedJob({ jobId: "j-2", tenantId: "tenant-b", submittedSeq: 2 }),
      );
      store.saveJob(storedJob({ jobId: "j-3", submittedSeq: 3 }));

      const listed = store.listJobs("tenant-a");
      expect(listed.map((job) => job.jobId)).toEqual(["j-3", "j-1"]);
    });

    test("listJobs：status 过滤（可选）", () => {
      const store = makeStore();
      store.saveJob(storedJob({ jobId: "j-1", submittedSeq: 1, status: "succeeded" }));
      store.saveJob(storedJob({ jobId: "j-2", submittedSeq: 2, status: "queued" }));
      store.saveJob(storedJob({ jobId: "j-3", submittedSeq: 3, status: "queued" }));

      expect(store.listJobs("tenant-a").map((job) => job.jobId)).toEqual(["j-3", "j-2", "j-1"]);
      expect(store.listJobs("tenant-a", "queued").map((job) => job.jobId)).toEqual(["j-3", "j-2"]);
      expect(store.listJobs("tenant-a", "succeeded").map((job) => job.jobId)).toEqual(["j-1"]);
      expect(store.listJobs("tenant-a", "failed")).toEqual([]);
    });

    test("appendEvent + readJobEvents：afterSeq 过滤、升序、lastSeq/firstRetainedSeq", () => {
      const store = makeStore();
      store.saveJob(storedJob());

      // 从未发射：events 空、lastSeq = 0、firstRetainedSeq = 1（= lastSeq+1）
      const empty = store.readJobEvents("job-1000-1", 0);
      expect(empty).toEqual({ events: [], firstRetainedSeq: 1, lastSeq: 0 });

      store.appendEvent("job-1000-1", jobEvent(1, { status: "running" }));
      store.appendEvent("job-1000-1", jobEvent(2, { status: "succeeded" }));

      const fromZero = store.readJobEvents("job-1000-1", 0);
      expect(fromZero?.events.map((event) => [event.seq, event.job.status])).toEqual([
        [1, "running"],
        [2, "succeeded"],
      ]);
      expect(fromZero?.firstRetainedSeq).toBe(1);
      expect(fromZero?.lastSeq).toBe(2);

      const afterOne = store.readJobEvents("job-1000-1", 1);
      expect(afterOne?.events.map((event) => event.seq)).toEqual([2]);
      expect(afterOne?.lastSeq).toBe(2);

      // afterSeq = 当前位：空重放（已到最新）
      const atHead = store.readJobEvents("job-1000-1", 2);
      expect(atHead?.events).toEqual([]);
    });

    test("readJobEvents：事件保真（view 全字段——SSE 帧载荷即此）", () => {
      const store = makeStore();
      store.saveJob(storedJob());
      const event = jobEvent(1, {
        status: "succeeded",
        result: OTHER_SUMMARY,
      });
      store.appendEvent("job-1000-1", event);
      expect(store.readJobEvents("job-1000-1", 0)?.events[0]).toEqual(event);
    });

    test("readJobEvents：未知 jobId → undefined", () => {
      const store = makeStore();
      expect(store.readJobEvents("job-unknown", 0)).toBeUndefined();
    });

    test("loadActiveJobs：只含非终态，提交序升序（恢复入队序）", () => {
      const store = makeStore();
      store.saveJob(storedJob({ jobId: "j-1", submittedSeq: 1, status: "queued" }));
      store.saveJob(storedJob({ jobId: "j-2", submittedSeq: 2, status: "running" }));
      store.saveJob(
        storedJob({ jobId: "j-3", submittedSeq: 3, status: "cancelling" }),
      );
      store.saveJob(
        storedJob({ jobId: "j-4", submittedSeq: 4, status: "succeeded", finishedAtMs: 1 }),
      );
      store.saveJob(
        storedJob({ jobId: "j-5", submittedSeq: 5, status: "failed", finishedAtMs: 2 }),
      );
      store.saveJob(
        storedJob({ jobId: "j-6", submittedSeq: 6, status: "cancelled", finishedAtMs: 3 }),
      );

      const active = store.loadActiveJobs();
      expect(active.map((job) => [job.jobId, job.status])).toEqual([
        ["j-1", "queued"],
        ["j-2", "running"],
        ["j-3", "cancelling"],
      ]);
    });

    test("loadActiveJobs：空库 / 全终态 → 空数组", () => {
      const store = makeStore();
      expect(store.loadActiveJobs()).toEqual([]);
      store.saveJob(
        storedJob({ status: "succeeded", finishedAtMs: 1 }),
      );
      expect(store.loadActiveJobs()).toEqual([]);
    });

    test("appendEvent 后 saveJob 覆写不破坏事件日志（两数据面独立）", () => {
      const store = makeStore();
      store.saveJob(storedJob());
      store.appendEvent("job-1000-1", jobEvent(1, { status: "running" }));
      store.saveJob(storedJob({ status: "running" }));
      const slice = store.readJobEvents("job-1000-1", 0);
      expect(slice?.events.map((event) => event.seq)).toEqual([1]);
      expect(slice?.lastSeq).toBe(1);
      // 续发不冲突（seq 延续既有日志——重启恢复面同口径）
      store.appendEvent("job-1000-1", jobEvent(2, { status: "succeeded" }));
      expect(store.readJobEvents("job-1000-1", 0)?.events).toHaveLength(2);
    });
  });
}

// ---- 双实现注册 ----

describeStoreContract("ReviewJobStore 契约：memory", () => createMemoryJobStore());

const sqliteTempDirs: string[] = [];

afterAll(() => {
  for (const dir of sqliteTempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 句柄释放延迟：tmp 泄漏无害，不 FAIL suite
    }
  }
});

function makeSqliteDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-store-"));
  sqliteTempDirs.push(dir);
  return dir;
}

describeStoreContract("ReviewJobStore 契约：sqlite", () =>
  createSqliteReviewJobStore({ dataDir: makeSqliteDir() }),
);

// ---- memory 特有：保留窗 ----

describe("ReviewJobStore memory 特有：maxJobEvents 保留窗", () => {
  test("超出上限丢最旧——firstRetainedSeq 推进（readEvents gap 材料单源）", () => {
    const store = createMemoryJobStore({ maxJobEvents: 2 });
    store.saveJob(storedJob());
    store.appendEvent("job-1000-1", jobEvent(1, { status: "running" }));
    store.appendEvent("job-1000-1", jobEvent(2, { status: "running" }));
    store.appendEvent("job-1000-1", jobEvent(3, { status: "succeeded" }));

    const slice = store.readJobEvents("job-1000-1", 0);
    // 最旧的 seq=1 被清理：保留窗起点 = 2
    expect(slice?.events.map((event) => event.seq)).toEqual([2, 3]);
    expect(slice?.firstRetainedSeq).toBe(2);
    expect(slice?.lastSeq).toBe(3);
  });

  test("不设上限：全量保留（缺省——进程生命周期内不清理）", () => {
    const store = createMemoryJobStore();
    store.saveJob(storedJob());
    for (let seq = 1; seq <= 5; seq += 1) {
      store.appendEvent("job-1000-1", jobEvent(seq, { status: "running" }));
    }
    expect(store.readJobEvents("job-1000-1", 0)?.events).toHaveLength(5);
  });
});

// ---- sqlite 特有：持久性与防碰撞 ----

describe("ReviewJobStore sqlite 特有：跨实例持久性（重启恢复依赖面）", () => {
  test("close → 重开同 dataDir：job / 事件 / 活跃面全部恢复", () => {
    const dataDir = makeSqliteDir();
    const first = createSqliteReviewJobStore({ dataDir });
    first.saveJob(storedJob({ jobId: "j-q", submittedSeq: 1, status: "queued" }));
    first.saveJob(
      storedJob({ jobId: "j-r", submittedSeq: 2, status: "running", progress: OTHER_PROGRESS }),
    );
    first.saveJob(
      storedJob({ jobId: "j-s", submittedSeq: 3, status: "succeeded", result: OTHER_SUMMARY, finishedAtMs: 9 }),
    );
    first.appendEvent("j-q", jobEvent(1, { status: "running", jobId: "j-q" }));
    first.appendEvent("j-r", jobEvent(1, { status: "running", jobId: "j-r" }));
    first.close();

    // 重启：同 dataDir 新实例（service 启动恢复的 store 侧前提）
    const second = createSqliteReviewJobStore({ dataDir });
    expect(second.getJob("j-q")).toEqual(
      storedJob({ jobId: "j-q", submittedSeq: 1, status: "queued" }),
    );
    expect(second.getJob("j-r")).toEqual(
      storedJob({ jobId: "j-r", submittedSeq: 2, status: "running", progress: OTHER_PROGRESS }),
    );
    expect(second.getJob("j-s")).toEqual(
      storedJob({
        jobId: "j-s",
        submittedSeq: 3,
        status: "succeeded",
        result: OTHER_SUMMARY,
        finishedAtMs: 9,
      }),
    );

    // 事件日志跨实例重放（SSE Last-Event-ID 跨重启的 store 侧单源）
    const replay = second.readJobEvents("j-r", 0);
    expect(replay?.events.map((event) => event.seq)).toEqual([1]);
    expect(replay?.lastSeq).toBe(1);

    // 重启后续发不冲突（seq 延续既有日志——service 恢复 eventSeq 同口径）
    second.appendEvent("j-r", jobEvent(2, { status: "failed", jobId: "j-r" }));
    expect(second.readJobEvents("j-r", 0)?.events).toHaveLength(2);

    // 活跃面：非终态恢复（queued + running），终态不进
    expect(second.loadActiveJobs().map((job) => job.jobId)).toEqual(["j-q", "j-r"]);
    second.close();
  });

  test("allocateJobId 跨实例防碰撞：计数器持久——重开后延续不重号", () => {
    const dataDir = makeSqliteDir();
    const first = createSqliteReviewJobStore({ dataDir });
    // 分配即 save（service submit 同一同步块的原子序）：号被 job 行占住
    for (let seq = 1; seq <= 3; seq += 1) {
      const allocated = first.allocateJobId(1);
      expect(allocated.seq).toBe(seq);
      first.saveJob(storedJob({ jobId: allocated.jobId, submittedSeq: allocated.seq }));
    }
    first.close();

    const second = createSqliteReviewJobStore({ dataDir });
    // 与首实例已占号不撞（时钟回拨面：startMs 相同也不重号）
    const allocated = second.allocateJobId(1);
    expect(allocated.seq).toBe(4);
    expect(allocated.jobId).toBe("job-1-4");
    second.close();
  });

  test("blobs sha256：同内容 diff/issue 跨 job 去重存储（直接查库断言）", () => {
    const dataDir = makeSqliteDir();
    const store = createSqliteReviewJobStore({ dataDir });
    const sameDiff = "diff --git a/x b/x\n+same\n";
    const otherDiff = "diff --git a/y b/y\n+other\n";
    store.saveJob(storedJob({ jobId: "j-1", submittedSeq: 1, request: storedRequest({ diff: sameDiff, issueDescription: "same issue" }) }));
    store.saveJob(storedJob({ jobId: "j-2", submittedSeq: 2, request: storedRequest({ diff: sameDiff, issueDescription: "same issue" }) }));
    store.saveJob(storedJob({ jobId: "j-3", submittedSeq: 3, request: storedRequest({ diff: otherDiff, issueDescription: "same issue" }) }));

    // schema 面断言（验收口径：diff / issue 内容按 sha256 落 blobs）：
    // sameDiff + "same issue" 各一行 + otherDiff 一行 = 3 行（不是 6 份全文拷贝）
    expect(countBlobs(dataDir)).toBe(3);
    store.close();
  });

  test("close 幂等；close 后 dataDir 可被新实例重开", () => {
    const dataDir = makeSqliteDir();
    const store = createSqliteReviewJobStore({ dataDir });
    store.saveJob(storedJob());
    store.close();
    store.close(); // 幂等
    const reopened = createSqliteReviewJobStore({ dataDir });
    expect(reopened.getJob("job-1000-1")).toBeDefined();
    reopened.close();
  });
});

/** 直连 db 数 blobs 行数（sha256 内容寻址表的 schema 面断言用） */
function countBlobs(dataDir: string): number {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(path.join(dataDir, "jobs.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM blobs").get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}
