/**
 * #22 S1/S3 main：rpc 子命令的会话核心与进程装配。
 *
 * S1 交付纯会话核心 createRpcSession：parse（protocol）→ dispatch → 全部输出
 * （响应 + review.event 通知）经单一 onOutput 缝——进程内可测，无 stdin/stdout
 * 依赖。S3 在其外包进程面：stdin 行循环（jsonl reader）、stdio-guard 接管、
 * EOF/信号 drain、Windows 退出纪律。
 *
 * shutdown 语义（spec §2.3）：先回响应 → 停止收单（draining，submit → -32010）
 * → 取消 queued → 等 running → 由进程面退出。事件通知与响应同缝，天然保序。
 */

import { serializeJsonLine } from "./jsonl.js";
import {
  JSON_RPC_ERROR,
  RPC_METHOD,
  RpcError,
  errorResponse,
  eventNotification,
  parseIncomingLine,
  successResponse,
  validateCancelParams,
  validateGetParams,
  validateListParams,
  validateSubmitParams,
  type JsonRpcId,
} from "./protocol.js";
import type { ReviewService } from "./service.js";

/** server.capabilities payload（spec §4/§5：协议版本、serverId、方法表、limits；S3 装配时 limits 从 service 派生） */
export interface RpcServerInfo {
  /** spec §4：协议版本为数字（v1 = 1） */
  readonly protocolVersion: number;
  readonly serverId: string;
  readonly methods: readonly string[];
  readonly limits: {
    readonly maxDiffBytes: number;
    readonly maxQueueDepth: number;
    readonly concurrency: number;
    /** repoPath allowlist 是否生效（--repo-root 装配面） */
    readonly repoRootEnforced: boolean;
  };
}

export interface RpcSessionOptions {
  readonly service: ReviewService;
  readonly serverInfo: RpcServerInfo;
  /** 单一输出缝：协议行（含换行）由此离开会话——S3 接 stdio-guard raw 写 */
  readonly onOutput: (line: string) => void;
}

export interface RpcSession {
  /** 处理一行入站命令（空行已在 jsonl framing 层忽略）；响应/事件经 onOutput */
  handleLine(line: string): Promise<void>;
}

export function createRpcSession(options: RpcSessionOptions): RpcSession {
  const { service, serverInfo, onOutput } = options;

  const write = (document: unknown): void => {
    onOutput(serializeJsonLine(document));
  };

  // job 事件 → review.event 通知（与响应同一输出缝，写队列保序）
  service.subscribe((event) => write(eventNotification(event)));

  const dispatch = async (id: JsonRpcId, method: string, params: unknown): Promise<void> => {
    switch (method) {
      case RPC_METHOD.CAPABILITIES: {
        write(successResponse(id, serverInfo));
        return;
      }
      case RPC_METHOD.SUBMIT: {
        const validation = validateSubmitParams(params);
        if (!validation.ok) {
          writeRpcError(id, validation.error);
          return;
        }
        write(successResponse(id, await service.submit(validation.value)));
        return;
      }
      case RPC_METHOD.GET: {
        const validation = validateGetParams(params);
        if (!validation.ok) {
          writeRpcError(id, validation.error);
          return;
        }
        const view = service.get(validation.value.jobId);
        if (view === undefined) {
          write(
            errorResponse(
              id,
              JSON_RPC_ERROR.JOB_NOT_FOUND,
              `Unknown job: ${validation.value.jobId}`,
              { jobId: validation.value.jobId },
            ),
          );
          return;
        }
        write(successResponse(id, view));
        return;
      }
      case RPC_METHOD.LIST: {
        const validation = validateListParams(params);
        if (!validation.ok) {
          writeRpcError(id, validation.error);
          return;
        }
        write(successResponse(id, service.list(validation.value)));
        return;
      }
      case RPC_METHOD.CANCEL: {
        const validation = validateCancelParams(params);
        if (!validation.ok) {
          writeRpcError(id, validation.error);
          return;
        }
        write(successResponse(id, await service.cancel(validation.value.jobId)));
        return;
      }
      case RPC_METHOD.SHUTDOWN: {
        // 先回响应，再 drain（spec §2.3）；drain 期间事件继续经输出缝流出
        write(successResponse(id, { status: "shutdown" }));
        await service.close();
        return;
      }
      default: {
        write(errorResponse(id, JSON_RPC_ERROR.METHOD_NOT_FOUND, `Method not found: ${method}`));
        return;
      }
    }
  };

  const writeRpcError = (id: JsonRpcId, error: RpcError): void => {
    write(errorResponse(id, error.code, error.message, error.data));
  };

  return {
    async handleLine(line: string): Promise<void> {
      const parsed = parseIncomingLine(line);
      if (parsed.kind === "error") {
        write(errorResponse(parsed.id, parsed.error.code, parsed.error.message));
        return;
      }
      try {
        await dispatch(parsed.id, parsed.method, parsed.params);
      } catch (error) {
        if (error instanceof RpcError) {
          writeRpcError(parsed.id, error);
          return;
        }
        // 内部异常：固定文案（message 可能携带路径/内部细节，不进协议面——spec §9）
        write(errorResponse(parsed.id, JSON_RPC_ERROR.INTERNAL_ERROR, "Internal error"));
      }
    },
  };
}
