/**
 * #29 P2b：产物下载端点 `GET /v1/jobs/{jobId}/artifacts/{audit|record}`
 * （ADR-0013 决策 8）。
 *
 * 语义：
 * - audit 与 record 分开授权（两端点各自独立过 artifact:read——执法在
 *   http-server 路由层传输面单点；拍板 2026-10-25：两者均需 artifact:read）；
 * - API 只认逻辑引用（`artifact:audit|record/<runId>`），本端点把引用解析回
 *   服务器路径落盘内容——路径本身不外泄（投影纪律见 http-view.ts）；
 * - 保留窗口：finishedAtMs + retentionDays（缺省 30 天，`--artifact-retention-days`
 *   可配）之外 → 404 + -32017 artifact_expired；文件缺失/不可读同面
 *   （不泄漏文件系统细节）；#30 SQLite store 落地后接清理任务；
 * - drain 期仍可下载（读面——与 SSE 新订阅不同，不持有长连接）；
 * - 响应：application/json 流 + Content-Length + attachment 文件名
 *   （audit/record 落盘即 JSON）。
 *
 * 错误面：未知/异租户 job、非终态/无产物 job → 200 + envelope -32001
 * （越权统一 not found，与 /rpc 同口径）；过期/缺失 → 404 + -32017。
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { CallContext, Principal } from "../rpc/context.js";
import { JSON_RPC_ERROR } from "../rpc/protocol.js";
import type { ReviewService } from "../rpc/service.js";
import { writeEnvelopeError } from "./http-wire.js";

/** 方案 §5.4：产物保留缺省 30 天（--artifact-retention-days 可配） */
export const DEFAULT_ARTIFACT_RETENTION_DAYS = 30;

export interface ArtifactEndpointOptions {
  readonly service: ReviewService;
  /** 保留窗口（天）；缺省 30 */
  readonly retentionDays?: number;
  /** 时钟注入（保留窗口判定单源；缺省真实时间） */
  readonly now?: () => Date;
}

export interface ArtifactEndpoint {
  /**
   * 处理一条已鉴权/已过 artifact:read 执法的产物下载请求。resolve 于响应
   * 完整写出（或错误面落定）后——in-flight 请求语义。
   */
  handleDownload(
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    requestId: string,
    jobId: string,
    kind: "audit" | "record",
  ): Promise<void>;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function createArtifactEndpoint(options: ArtifactEndpointOptions): ArtifactEndpoint {
  const { service } = options;
  const retentionDays = options.retentionDays ?? DEFAULT_ARTIFACT_RETENTION_DAYS;
  const now = options.now ?? (() => new Date());

  const handleDownload = async (
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    requestId: string,
    jobId: string,
    kind: "audit" | "record",
  ): Promise<void> => {
    const ctx: CallContext = { principal, requestId };
    const artifacts = await service.artifacts(jobId, ctx);
    if (artifacts === undefined) {
      writeEnvelopeError(res, 200, JSON_RPC_ERROR.JOB_NOT_FOUND, `Unknown job: ${jobId}`, { jobId });
      return;
    }
    if (artifacts.status !== "succeeded") {
      // 产物只在 succeeded 存在（executor 摘要携带路径）——未落定/失败的 job
      // 无产物面，与未知 job 同码不同文案（不另造码——错误码表闭合）
      writeEnvelopeError(
        res,
        200,
        JSON_RPC_ERROR.JOB_NOT_FOUND,
        `job has no artifacts (status: ${artifacts.status})`,
        { jobId },
      );
      return;
    }
    const artifactPath = kind === "audit" ? artifacts.auditPath : artifacts.recordPath;
    if (artifactPath === undefined) {
      // succeeded 摘要必填双路径——防御兜底（类型上不可达，运行时半开摘要兜底）
      writeEnvelopeError(res, 404, JSON_RPC_ERROR.ARTIFACT_EXPIRED, "artifact expired or missing", {
        jobId,
      });
      return;
    }
    // 保留窗口（决策 8）：finishedAtMs 起算 retentionDays 天
    if (
      artifacts.finishedAtMs !== undefined &&
      now().getTime() - artifacts.finishedAtMs > retentionDays * MS_PER_DAY
    ) {
      writeEnvelopeError(res, 404, JSON_RPC_ERROR.ARTIFACT_EXPIRED, "artifact expired", { jobId });
      return;
    }

    let size: number;
    try {
      const info = await stat(artifactPath);
      if (!info.isFile()) {
        throw new Error("not a file");
      }
      size = info.size;
    } catch {
      // 窗口内但文件已不在（清理任务先行/落盘失败遗留）：与过期同面收口
      writeEnvelopeError(res, 404, JSON_RPC_ERROR.ARTIFACT_EXPIRED, "artifact expired or missing", {
        jobId,
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="${basename(artifactPath)}"`,
    });
    try {
      await pipeline(createReadStream(artifactPath), res);
    } catch {
      // 头部已发（Content-Length 已承诺）：无法改面——断连收尾，客户端按传输失败重试
      res.destroy();
    }
    req.resume(); // GET 无 body；排空防御（连接复用纪律）
  };

  return { handleDownload };
}
