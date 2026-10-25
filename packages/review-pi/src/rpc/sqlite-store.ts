/**
 * #30 P3a：ReviewJobStore 的 `node:sqlite` 生产适配器（ADR-0013 决策 6/8）。
 *
 * schema（验收口径：jobs / job_events 表 + 租户-状态-时间索引 + blobs
 * sha256 内容寻址）：
 * - `jobs`：job 行全量快照；`diff` / `issueDescription` 不存全文——按
 *   sha256 落 `blobs`（同内容跨 job 去重），读面 JOIN 回原文；
 * - `job_events`：事件日志（per-job seq 主键）——SSE `Last-Event-ID` 跨重启
 *   重放的持久单源（恒全量保留，无 memory 面的保留窗）；
 * - `idx_jobs_tenant_status_time`：(tenant_id, status, submitted_seq)——
 *   listJobs 查询下推索引（service 租户过滤 + 状态过滤 + 降序）；
 * - 计数器不另立 meta 表：`submitted_seq` 即分配号（UNIQUE 单调），实例
 *   启动时 `MAX(submitted_seq)` 恢复进程内计数器（跨重启防碰撞）。
 *
 * `node:sqlite` 可用性（ADR-0013 决策 8）：`DatabaseSync` 经 createRequire
 * 运行时加载（TS 类型走 type-only import——编译期零运行时绑定；bundle 面
 * 字符串加载不被 esbuild 内联），不可用时 fail fast 人话错误——不静默
 * 降级 memory。ExperimentalWarning（Node 22）属预期（issue #30）。
 *
 * 同步面（端口纪律，见 store.ts 模块注）：DatabaseSync 全同步 API——
 * 单实例部署下无并发写竞态；WAL + synchronous=NORMAL 崩溃安全（进程被杀
 * 后已提交事务落盘，未提交事务回滚——重启恢复以 jobs 行状态为准）。
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { DatabaseSync } from "node:sqlite";

import type { ConfigId } from "../contracts/config.js";
import type { ReviewJobStatus } from "./protocol.js";
import type { ReviewJobEvent } from "./service.js";
import { formatJobId, type AllocatedJobId, type ReviewJobStore, type StoredReviewJob } from "./store.js";

export interface SqliteJobStoreOptions {
  /** 数据根目录（建库 `<dataDir>/jobs.sqlite`；runs / audit / record 同根——spec） */
  readonly dataDir: string;
}

/** db 文件名（dataDir 下单库：jobs / job_events / blobs 共库） */
const DB_FILENAME = "jobs.sqlite";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS blobs (
    sha256 TEXT PRIMARY KEY,
    content TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    status TEXT NOT NULL,
    case_id TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    config_id TEXT NOT NULL,
    model_id TEXT,
    diff_sha256 TEXT NOT NULL,
    issue_sha256 TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    submitted_seq INTEGER NOT NULL UNIQUE,
    finished_at_ms INTEGER,
    progress_json TEXT,
    result_json TEXT,
    error_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_tenant_status_time
    ON jobs (tenant_id, status, submitted_seq);
  CREATE TABLE IF NOT EXISTS job_events (
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_json TEXT NOT NULL,
    PRIMARY KEY (job_id, seq)
  );
`;

/** job 行读取面（blobs JOIN 回原文——diff / issue 全文不重复存 job 行） */
const JOB_SELECT_SQL = `
  SELECT j.job_id, j.tenant_id, j.status, j.case_id, j.repo_path, j.config_id,
         j.model_id, j.submitted_at, j.submitted_seq, j.finished_at_ms,
         j.progress_json, j.result_json, j.error_json,
         d.content AS diff_text, i.content AS issue_text
  FROM jobs j
  JOIN blobs d ON d.sha256 = j.diff_sha256
  JOIN blobs i ON i.sha256 = j.issue_sha256
`;

/**
 * `node:sqlite` 运行时加载（fail fast 面）：不可用 → 人话错误（含逃生口
 * 指引），不静默降级。createRequire（而非顶层 import）使加载失败落在
 * 工厂构造期（可被启动装配捕获报错），不在模块加载期崩进程。
 */
function loadDatabaseSync(): typeof DatabaseSync {
  try {
    const sqlite = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: typeof DatabaseSync;
    };
    return sqlite.DatabaseSync;
  } catch {
    throw new Error(
      "node:sqlite is not available in this Node.js build (requires Node >= 22.5; " +
        "engines >= 22.19.0). Start with --store memory as an escape hatch, or upgrade Node.js.",
    );
  }
}

/** db 行形态（JOB_SELECT_SQL 投影；null = 缺席省键字段的 SQL 载体） */
interface JobRow {
  readonly job_id: string;
  readonly tenant_id: string;
  readonly status: string;
  readonly case_id: string;
  readonly repo_path: string;
  readonly config_id: string;
  readonly model_id: string | null;
  readonly submitted_at: string;
  readonly submitted_seq: number;
  readonly finished_at_ms: number | null;
  readonly progress_json: string | null;
  readonly result_json: string | null;
  readonly error_json: string | null;
  readonly diff_text: string;
  readonly issue_text: string;
}

/** 行 → StoredReviewJob（缺席省键纪律：SQL null 不进对象） */
function toStoredJob(row: JobRow): StoredReviewJob {
  return {
    jobId: row.job_id,
    tenantId: row.tenant_id,
    status: row.status as StoredReviewJob["status"],
    request: {
      caseId: row.case_id,
      repoPath: row.repo_path,
      diff: row.diff_text,
      issueDescription: row.issue_text,
      configId: row.config_id as ConfigId,
      ...(row.model_id !== null ? { modelId: row.model_id } : {}),
    },
    submittedAt: row.submitted_at,
    submittedSeq: row.submitted_seq,
    ...(row.finished_at_ms !== null ? { finishedAtMs: row.finished_at_ms } : {}),
    ...(row.progress_json !== null ? { progress: JSON.parse(row.progress_json) } : {}),
    ...(row.result_json !== null ? { result: JSON.parse(row.result_json) } : {}),
    ...(row.error_json !== null ? { error: JSON.parse(row.error_json) } : {}),
  };
}

/**
 * 打开共享库连接（`<dataDir>/jobs.sqlite`）：建目录 + WAL / synchronous /
 * busy_timeout PRAGMA + jobs 侧 schema（DDL 幂等）。除本适配器外，同库其他
 * 面（如 server 侧幂等表）经此复用同一开库纪律——`node:sqlite` 可用性
 * fail fast（loadDatabaseSync 人话错误）与 PRAGMA 面不双源。同文件多连接
 * （各面各持一连接）在 WAL + busy_timeout 下是 sqlite 一等公民用法。
 */
export function openJobsDatabase(dataDir: string): DatabaseSync {
  const DatabaseSync = loadDatabaseSync();
  mkdirSync(dataDir, { recursive: true });
  const db: DatabaseSync = new DatabaseSync(path.join(dataDir, DB_FILENAME));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  return db;
}

export function createSqliteReviewJobStore(options: SqliteJobStoreOptions): ReviewJobStore {
  const db = openJobsDatabase(options.dataDir);

  const putBlob = db.prepare(
    "INSERT INTO blobs (sha256, content) VALUES (?, ?) ON CONFLICT(sha256) DO NOTHING",
  );
  const upsertJob = db.prepare(`
    INSERT INTO jobs (
      job_id, tenant_id, status, case_id, repo_path, config_id, model_id,
      diff_sha256, issue_sha256, submitted_at, submitted_seq,
      finished_at_ms, progress_json, result_json, error_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      tenant_id = excluded.tenant_id,
      status = excluded.status,
      case_id = excluded.case_id,
      repo_path = excluded.repo_path,
      config_id = excluded.config_id,
      model_id = excluded.model_id,
      diff_sha256 = excluded.diff_sha256,
      issue_sha256 = excluded.issue_sha256,
      submitted_at = excluded.submitted_at,
      submitted_seq = excluded.submitted_seq,
      finished_at_ms = excluded.finished_at_ms,
      progress_json = excluded.progress_json,
      result_json = excluded.result_json,
      error_json = excluded.error_json
  `);
  const getJobStmt = db.prepare(`${JOB_SELECT_SQL} WHERE j.job_id = ?`);
  const listJobsStmt = db.prepare(`${JOB_SELECT_SQL} WHERE j.tenant_id = ? ORDER BY j.submitted_seq DESC`);
  const listJobsByStatusStmt = db.prepare(
    `${JOB_SELECT_SQL} WHERE j.tenant_id = ? AND j.status = ? ORDER BY j.submitted_seq DESC`,
  );
  const activeJobsStmt = db.prepare(
    `${JOB_SELECT_SQL} WHERE j.status IN ('queued', 'running', 'cancelling') ORDER BY j.submitted_seq ASC`,
  );
  const insertEvent = db.prepare(
    "INSERT INTO job_events (job_id, seq, event_json) VALUES (?, ?, ?)",
  );
  const hasJob = db.prepare("SELECT 1 AS present FROM jobs WHERE job_id = ?");
  const eventBounds = db.prepare(
    "SELECT MIN(seq) AS first, MAX(seq) AS last FROM job_events WHERE job_id = ?",
  );
  const eventsAfter = db.prepare(
    "SELECT seq, event_json FROM job_events WHERE job_id = ? AND seq > ? ORDER BY seq",
  );
  const maxSubmittedSeq = db.prepare("SELECT MAX(submitted_seq) AS max FROM jobs");

  /** 文本 → sha256 内容寻址落 blobs（同内容跨 job 去重——幂等 upsert） */
  const storeBlob = (content: string): string => {
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    putBlob.run(sha256, content);
    return sha256;
  };

  const saveJob = (job: StoredReviewJob): void => {
    upsertJob.run(
      job.jobId,
      job.tenantId,
      job.status,
      job.request.caseId,
      job.request.repoPath,
      job.request.configId,
      job.request.modelId ?? null,
      storeBlob(job.request.diff),
      storeBlob(job.request.issueDescription),
      job.submittedAt,
      job.submittedSeq,
      job.finishedAtMs ?? null,
      job.progress !== undefined ? JSON.stringify(job.progress) : null,
      job.result !== undefined ? JSON.stringify(job.result) : null,
      job.error !== undefined ? JSON.stringify(job.error) : null,
    );
  };

  // 计数器恢复（跨重启防碰撞）：进程内单调 + 启动时 MAX(submitted_seq) 续号
  // ——号被 job 行占住；allocate 与 saveJob 在 service submit 的同一同步块，
  // 悬空分配不跨实例。关闭态幂等标记（close 后再 close no-op）。
  const initialMax = (maxSubmittedSeq.get() as unknown as { max: number | null }).max;
  let counter = initialMax ?? 0;
  let closed = false;

  return {
    allocateJobId(startMs: number): AllocatedJobId {
      counter += 1;
      return { jobId: formatJobId(startMs, counter), seq: counter };
    },

    saveJob,

    getJob(jobId: string): StoredReviewJob | undefined {
      const row = getJobStmt.get(jobId) as unknown as JobRow | undefined;
      return row === undefined ? undefined : toStoredJob(row);
    },

    listJobs(tenantId: string, status?: ReviewJobStatus): readonly StoredReviewJob[] {
      const rows =
        status === undefined
          ? (listJobsStmt.all(tenantId) as unknown as JobRow[])
          : (listJobsByStatusStmt.all(tenantId, status) as unknown as JobRow[]);
      return rows.map(toStoredJob);
    },

    appendEvent(jobId: string, event: ReviewJobEvent): void {
      // 主键 (job_id, seq) 冲突即 throw：seq 分配 bug 的 fail fast 面
      insertEvent.run(jobId, event.seq, JSON.stringify(event));
    },

    readJobEvents(jobId: string, afterSeq: number) {
      if (hasJob.get(jobId) === undefined) {
        return undefined;
      }
      const bounds = eventBounds.get(jobId) as unknown as { first: number | null; last: number | null };
      const lastSeq = bounds.last ?? 0;
      const firstRetainedSeq = bounds.first ?? lastSeq + 1;
      const rows = eventsAfter.all(jobId, afterSeq) as unknown as Array<{ seq: number; event_json: string }>;
      return {
        events: rows.map((row) => JSON.parse(row.event_json) as ReviewJobEvent),
        firstRetainedSeq,
        lastSeq,
      };
    },

    loadActiveJobs(): readonly StoredReviewJob[] {
      return (activeJobsStmt.all() as unknown as JobRow[]).map(toStoredJob);
    },

    close(): void {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
