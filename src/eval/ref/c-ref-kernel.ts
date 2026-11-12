import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ReviewKernel,
  RunUnit,
  UnitReviewRequest,
} from "../../gate/review-kernel.js";
import type { RunResult } from "../../instrument/contracts/run.js";
import {
  DEFAULT_FULL_REPO_BUDGET_CHARS,
  buildFullRepoInjection,
  loadRepoSnapshot,
  type CRefFullRepoRecord,
  type FullRepoInjection,
  type RepoSnapshot,
} from "./full-repo.js";

/**
 * C_ref kernel（#43，eval-only）：在现有 `ReviewKernel` 执行缝上包装 base E
 * kernel——把全仓注入追加到 issue 上下文，再交给 base kernel 执行。不新建
 * 第二套执行缝，不改生产 prompt / 协议 / ConfigId / RunAudit。
 *
 * 口径说明：pi E 内核只有一条初始 user 消息（MR 文本 + issue），没有独立的
 * 「额外上下文」入参，因此 C_ref 以 eval-only 方式把全仓内容追加在 issue 文本
 * 之后。这是「信息给满」参照，不是历史 config C 的逐字节复刻；注入记录写入
 * 评测侧 sidecar，生产 `RunAudit.fullRepo` 不复活。
 *
 * 确定性：同一仓库快照 + 同预算 → 注入字节稳定；sidecar 记账
 * `budgetChars / contentChars / truncated / totalFiles / shownFiles`。
 */

export const C_REF_SIDECAR_KIND = "c-ref-full-repo-sidecar";
export const C_REF_SIDECAR_SCHEMA_VERSION = 1;

export interface CRefSidecar {
  readonly kind: typeof C_REF_SIDECAR_KIND;
  readonly schemaVersion: typeof C_REF_SIDECAR_SCHEMA_VERSION;
  readonly ref: "C_ref";
  readonly evalOnly: true;
  readonly caseId: string;
  /** 历史配置标签 "C"（ADR-0016 决策 3；不是生产 ConfigId） */
  readonly configId: "C";
  /** 实际执行内核的生产标签（C_ref 复用 E 内核） */
  readonly kernelConfigId: RunUnit["configId"];
  readonly rep: number;
  readonly fullRepo: CRefFullRepoRecord;
}

/** C_ref 执行结果（评测侧扩展；base RunResult 形状不变） */
export interface CRefRunResult extends RunResult {
  readonly ref: "C_ref";
  readonly evalOnly: true;
  readonly fullRepo: CRefFullRepoRecord;
  readonly cRefSidecarPath: string;
}

/** C_ref kernel 执行缝（复用生产 ReviewKernel 接口；`ref` 标记 eval-only 参照） */
export interface CRefKernel extends ReviewKernel {
  readonly ref: "C_ref";
  execute(request: UnitReviewRequest): Promise<CRefRunResult>;
}

export interface CreateCRefKernelOptions {
  /** base E kernel（真实装配 = piKernel；测试 = fake） */
  readonly baseKernel: ReviewKernel;
  /** 全仓预算（缺省 80k chars） */
  readonly budgetChars?: number;
}

export function createCRefKernel(options: CreateCRefKernelOptions): CRefKernel {
  const budgetChars = options.budgetChars ?? DEFAULT_FULL_REPO_BUDGET_CHARS;
  const snapshots = new Map<string, Promise<RepoSnapshot>>();
  const injections = new Map<string, Promise<FullRepoInjection>>();

  const snapshotFor = (repoPath: string): Promise<RepoSnapshot> => {
    const key = path.resolve(repoPath);
    const cached = snapshots.get(key);
    if (cached !== undefined) {
      return cached;
    }
    // 失败的 promise 不留在缓存里（否则同一 repo 后续调用永远失败）
    const loaded = loadRepoSnapshot(key).catch((error: unknown) => {
      snapshots.delete(key);
      throw error;
    });
    snapshots.set(key, loaded);
    return loaded;
  };

  const injectionFor = (repoPath: string): Promise<FullRepoInjection> => {
    const key = `${path.resolve(repoPath)}|${budgetChars}`;
    const cached = injections.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const built = snapshotFor(repoPath)
      .then((repo) => buildFullRepoInjection({ repo, budgetChars }))
      .catch((error: unknown) => {
        injections.delete(key);
        throw error;
      });
    injections.set(key, built);
    return built;
  };

  return {
    id: options.baseKernel.id,
    ref: "C_ref",
    execute: async (request) => {
      const injection = await injectionFor(request.mrCase.repoPath);
      const augmented: UnitReviewRequest = {
        ...request,
        mrCase: {
          ...request.mrCase,
          issueDescription: appendFullRepo(request.mrCase.issueDescription, injection),
        },
      };
      const result = await options.baseKernel.execute(augmented);
      const sidecarPath = cRefSidecarPath(request.experimentRoot, request.unit);
      await writeSidecar(sidecarPath, {
        kind: C_REF_SIDECAR_KIND,
        schemaVersion: C_REF_SIDECAR_SCHEMA_VERSION,
        ref: "C_ref",
        evalOnly: true,
        caseId: request.unit.caseId,
        configId: "C",
        kernelConfigId: request.unit.configId,
        rep: request.unit.rep,
        fullRepo: injection.record,
      });
      return {
        ...result,
        ref: "C_ref",
        evalOnly: true,
        fullRepo: injection.record,
        cRefSidecarPath: sidecarPath,
      };
    },
  };
}

/** 评测侧 sidecar 路径：`<experimentRoot>/eval-sidecar/full-repo/<case>/<config>/rep-<n>.json` */
export function cRefSidecarPath(
  experimentRoot: string,
  unit: Pick<RunUnit, "caseId" | "configId" | "rep">,
): string {
  return path.join(
    experimentRoot,
    "eval-sidecar",
    "full-repo",
    safeSegment(unit.caseId),
    "C",
    `rep-${unit.rep}.json`,
  );
}

function appendFullRepo(issueDescription: string, injection: FullRepoInjection): string {
  return issueDescription.trim() === ""
    ? injection.message.content
    : `${issueDescription}\n\n${injection.message.content}`;
}

async function writeSidecar(file: string, sidecar: CRefSidecar): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
}

function safeSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.-]/g, "_");
  // 纯点段（"." / ".."）会逃出 sidecar 目录，按非法段处理
  return sanitized.length === 0 || sanitized === "." || sanitized === ".." ? "_" : sanitized;
}
