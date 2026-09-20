import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { DEFAULT_PREFETCH_BUDGETS } from "../contracts/prefetch.js";
import { runReview } from "../run/review-run.js";
import { fakeFetch, type FakeReply } from "../provider/fake-fetch.js";
import { buildPrefetchContext, type PrefetchContext } from "../zoneb/prefetch.js";
import {
  discoverGateRecords,
  loadCaseInputs,
  loadWireTruth,
  type GateCaseInput,
} from "./ground-truth.js";
import { retryTransientSearch } from "./prefetch-retry.js";
import { compareRecordParity } from "./wire-parity.js";

// P2 字节纪律门(#5)——单实验门 runner(被 byte-gate.t{1..5}.gate.ts 逐实验调用)。
//
// 形态(沿用 zone-a parity 先例):真源 = DSH 审计 requests[].wireBody
// (序列化点原文);pi 侧经 fake 适配器重放(wireBody 自带完整回放脚本:
// 真回复 1..n-1 + 合成终局),逐记录 compareRecordParity——
// 计算差异 = 登记差异强制相等,白名单外零容忍。
//
// 可移植性(P0 采纳约定消费):门运行于本仓实验根——auditPath 经尾部
// 重锚本仓 runs/;案输入读 data/vul4j/target-cases.json;仓库快照按
// 相对路径解析。runs/ 与 .cache/ 均 gitignored:CI 上无真源 → 各实验
// 注册显式跳过占位后返回(vitest 对匹配 include 却零测试的文件判败,
// 静默空转会让 CI 必红),覆盖完整性由 coverage 文件把口。
//
// 拆分 5 文件 = vitest 文件级真并行:真仓快照预取(千至万文件级逐文件
// 扫描,冷缓存每案分钟至十数分钟)是墙钟大头——并行后墙钟 ≈ 最慢实验
// 的预取阶段(池内再 ÷ 并发度)。

/** 本仓根(byte-gate.t*.gate.ts 同层 → 包 → packages → 仓根) */
export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
/** 实验留痕根(P0 采纳的 t-series 真源树) */
export const RUNS_ROOT = path.join(REPO_ROOT, "runs");

/** 确定性起始时间(runId/审计文件名不进对照字节面,钉住消除噪声) */
export const FIXED_STARTED_AT = new Date("2026-01-01T00:00:00.000Z");

/**
 * fake 回复 usage:零值(usage 只进记账,不进请求字节面)。
 * 命名区别于 usage-map 的 ZERO_USAGE(LlmUsage 形状):此处是 fake-fetch
 * 适配器的回复 usage 形状,同名异物易混。
 */
export const ZERO_FAKE_USAGE = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;

/**
 * 读回本门重放审计的 wireBody 序列(对照面输入)。
 * 形状损坏 fail fast——审计是本门自产投影,损坏即上游 bug,
 * 不给比较器喂 undefined 制造二次噪声。
 */
export function readAuditWireBodies(auditPath: string): string[] {
  const audit = JSON.parse(readFileSync(auditPath, "utf8")) as { requests?: unknown };
  if (
    !Array.isArray(audit.requests) ||
    audit.requests.some(
      (request) => typeof (request as { wireBody?: unknown } | null)?.wireBody !== "string",
    )
  ) {
    throw new Error(`audit has no requests[].wireBody strings: ${auditPath}`);
  }
  return (audit.requests as { wireBody: string }[]).map((request) => request.wireBody);
}

export interface ExperimentGateOptions {
  /** 只对照该实验的真源记录(如 "phase2-dsh-t1") */
  readonly experimentId: string;
}

/** 单实验门:发现 → 逐记录重放对照(A 零预取;B 预取按案缓存跨 rep 复用) */
export function runExperimentGate(options: ExperimentGateOptions): void {
  const refs = discoverGateRecords(RUNS_ROOT).filter(
    (ref) => ref.experimentId === options.experimentId,
  );
  const caseInputs = loadCaseInputs(REPO_ROOT);

  // 预取缓存(按案):同案 3 rep 共享一次确定性预取——同一仓库 + 同一
  // diff → 字节级相同注入内容,rep 间复用不破坏单记录独立性。
  // 预取整体在 beforeAll 完成(专用 hook 超时):t 系列预取是墙钟大头
  //(真仓快照逐文件扫描,千至万文件级,冷缓存每案分钟至十数分钟),
  // 不吃单测超时预算——单测超时回归纯重放语义(挂死 15 分钟兜底)。
  // 并发上限 = 文件数 × 池深:实测 5 文件 × 池 3(15 路并发扫描)会把
  // 本机磁盘打饱和(Defender 实时扫描放大),池深钉 1——5 文件级并行
  // 已提供 5 路扫描并发,单实验内串行换机器可响应性。
  // 瞬态韧性:rg 单搜 30s 超时在盘争用下可瞬时复发(实测两例)——
  // retryTransientSearch 仅对该特征错误退避重试一次,重试在缓存 promise
  // 内附着(同案所有等待者共享同一次重试);预取确定性保证重试产物与
  // 一次成功字节相同,不进对照面噪声。
  const PREFETCH_POOL_SIZE = 1;
  const PREFETCH_HOOK_TIMEOUT = 90 * 60_000;
  const prefetchCache = new Map<string, Promise<PrefetchContext>>();
  function prefetchOf(input: GateCaseInput): Promise<PrefetchContext> {
    const cached = prefetchCache.get(input.caseId);
    if (cached !== undefined) {
      return cached;
    }
    const promise = retryTransientSearch(() =>
      buildPrefetchContext({
        repoPath: path.resolve(REPO_ROOT, input.repoPath),
        diff: input.diff,
        budgets: DEFAULT_PREFETCH_BUDGETS,
      }),
    );
    prefetchCache.set(input.caseId, promise);
    return promise;
  }

  // 重放落盘根:单实验一棵临时树,结束后清理(对照只读 pi 内存产出,
  // 落盘仅为复用 runReview 的真实审计投影路径)。命名区别于导出的
  // RUNS_ROOT(真源树):此处是重放产物的临时落盘树。
  // 真源缺席(如 CI:runs/ gitignored)→ 注册显式跳过占位后返回——
  // vitest 对匹配 include 却零测试的文件判败(No test suite found in
  // file),静默空转会让 CI 必红;显式 skip 留痕,发现面完整性由
  // coverage 档把口(runs/ 在场时实验集/记录数全核对)。
  if (refs.length === 0) {
    test.skip(
      `字节纪律:${options.experimentId} 真源缺席(runs/ gitignored),全量对照跳过`,
      () => {},
    );
    return;
  }
  const replayRoot = mkdtempSync(path.join(tmpdir(), "byte-gate-"));
  afterAll(() => {
    rmSync(replayRoot, { recursive: true, force: true });
  });

  // 预取阶段:本实验全部 B 案按 POOL_SIZE 并发,全部完成后才开测试
  //(文件内测试本就串行,前置等待不损墙钟;失败即文件级红,如实上抛)。
  const bInputs = [
    ...new Map(
      refs
        .filter((ref) => ref.configId === "B")
        .map((ref) => [ref.caseId, caseInputs.get(ref.caseId)] as const),
    ).entries(),
  ];
  const pending = bInputs.filter(
    (entry): entry is [string, GateCaseInput] => entry[1] !== undefined,
  );
  let cursor = 0;
  beforeAll(async () => {
    await Promise.all(
      Array.from({ length: Math.min(PREFETCH_POOL_SIZE, pending.length) }, async () => {
        while (cursor < pending.length) {
          const [, input] = pending[cursor];
          cursor += 1;
          await prefetchOf(input);
        }
      }),
    );
  }, PREFETCH_HOOK_TIMEOUT);

  for (const ref of refs) {
    test(
      `字节纪律:${ref.experimentId} ${ref.caseId} × ${ref.configId} × rep-${ref.rep}`,
      async () => {
        const truth = loadWireTruth(ref.auditPath);
        const input = caseInputs.get(ref.caseId);
        if (input === undefined) {
          throw new Error(`case input not found in target-cases.json: ${ref.caseId}`);
        }
        if (ref.configId === "B" && !existsSync(path.resolve(REPO_ROOT, input.repoPath))) {
          throw new Error(`config B requires the repo snapshot: ${input.repoPath}`);
        }
        const script = fakeFetch(
          truth.replies.map((text): FakeReply => ({ text, usage: { ...ZERO_FAKE_USAGE } })),
        );
        const prefetch = ref.configId === "B" ? await prefetchOf(input) : undefined;
        const { auditPath } = await runReview({
          caseId: ref.caseId,
          repoPath: path.resolve(REPO_ROOT, input.repoPath),
          diff: input.diff,
          issueDescription: input.issueDescription,
          apiKey: "byte-gate-offline",
          fetch: script.fetch,
          runsRoot: replayRoot,
          ...(prefetch !== undefined ? { prefetch } : {}),
          experimentId: "byte-gate",
          rep: ref.rep,
          configId: ref.configId,
          startedAt: FIXED_STARTED_AT,
        });
        const result = compareRecordParity(
          truth.wireBodies,
          readAuditWireBodies(auditPath),
        );
        expect(
          result.parity,
          result.parity ? undefined : `${ref.experimentId} ${ref.caseId}/${ref.configId}/rep-${ref.rep}: ${result.reason}`,
        ).toBe(true);
      },
      15 * 60_000,
    );
  }
}
