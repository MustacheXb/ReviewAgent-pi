import type { ContextLedger, LedgerEntry, LedgerEntryKind } from "../instrument/contracts/ledger.js";
import { boundedEcho } from "./registry.js";

/**
 * Context Ledger 实现（工单 #8，契约见 contracts/ledger.ts）。
 *
 * - createContextLedger()：功能态（config E）——run 私有，读取成功后登记，
 *   同一规范化请求的重复调用命中并返回引用；
 * - createInertContextLedger()：惰性态（A/B/C/D 与未启用 ledger 的 toolkit
 *   缺省注入）——永不命中、快照恒空，工具行为与 T05/T06 完全一致；
 * - 引用格式集中在此（工具不各自拼装，保证字节一致）：
 *   Already loaded: ctx#001 (review.get_file src/…/Foo.java:100-180)
 */

/** 引用文本中 description 的回显上限（与检索工具的 query 回显上限一致） */
export const LEDGER_REFERENCE_ECHO_MAX_CHARS = 120;

/** 命中键：kind 与 description 联合（description 含工具名前缀，kind 兜底防碰撞） */
function ledgerKey(kind: LedgerEntryKind, description: string): string {
  return `${kind}\u0000${description}`;
}

/** 引用文本：id + 有界回显的请求标识（确定性，同一命中永远同字节） */
function formatReference(entry: LedgerEntry): string {
  const echo = boundedEcho(entry.description, LEDGER_REFERENCE_ECHO_MAX_CHARS);
  return `Already loaded: ${entry.id} (${echo})`;
}

/** 功能态账本：内部累积登记，对外只暴露防御性快照 */
export function createContextLedger(): ContextLedger {
  const entries: LedgerEntry[] = [];
  const byKey = new Map<string, LedgerEntry>();
  return {
    referenceIfLoaded: (kind, description): string | undefined => {
      const entry = byKey.get(ledgerKey(kind, description));
      return entry === undefined ? undefined : formatReference(entry);
    },
    register: (kind, description): void => {
      const entry: LedgerEntry = {
        id: `ctx#${String(entries.length + 1).padStart(3, "0")}`,
        kind,
        description,
      };
      entries.push(entry);
      byKey.set(ledgerKey(kind, description), entry);
    },
    snapshot: (): readonly LedgerEntry[] => entries.map((entry) => ({ ...entry })),
  };
}

/** 惰性态账本：永不登记、永不命中（非 ledger 配置的工具行为零变化） */
export function createInertContextLedger(): ContextLedger {
  return {
    referenceIfLoaded: (): undefined => undefined,
    register: (): void => {},
    snapshot: (): readonly LedgerEntry[] => [],
  };
}

/**
 * 工具入口的统一接入模式：命中直接返回引用（不触碰数据源）；
 * 未命中执行真实读取，成功后登记并返回原文（read 抛错则不登记，
 * 错误原样上抛——失败不是上下文，重试仍走真实读取路径）。
 */
export async function readThroughLedger(
  ledger: ContextLedger,
  kind: LedgerEntryKind,
  description: string,
  read: () => Promise<string>,
): Promise<string> {
  const cached = ledger.referenceIfLoaded(kind, description);
  if (cached !== undefined) {
    return cached;
  }
  const content = await read();
  ledger.register(kind, description);
  return content;
}
