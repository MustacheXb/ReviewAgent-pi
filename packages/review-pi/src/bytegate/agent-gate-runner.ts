// P3a C/D/E 语义等价门 runner（#6）——t-series 剧本重放。
//
// 与 A/B 字节门（gate-runner.ts）的分工：A/B 断「归一化后逐字节相等」；
// 本门断「归一化后语义等价」（工具 wire 序列化方言按内核效应单列，
// 见 tool-dialect.ts）+ 循环驱动面全量对照：
// wire 消息序（语义）→ tools 投影 → phaseLog → toolCallLog（argumentsJson
// 解析值口径）→ findings / rejections → rounds / toolCalls / truncated /
// truncationReasons / cacheBreaks → config E ledger。
// Zone A 稳定前缀纪律单列断言：wireBody.tools 段跨请求字节恒定 + pi 侧
// 消息前缀 append-only（多轮下保持）。
//
// 重放不含真仓库扫描（工具输出脚本注入——执行器字节面由 tool-outputs
// 门把守），单条 run 秒级；15 分钟超时仅兜底。

import { expect, test } from "vitest";
import { runAgentReviewLoop } from "../loop/agent-review-loop.js";
import { fakeFetch } from "../provider/fake-fetch.js";
import { createContextLedger, createInertContextLedger } from "../tools/ledger.js";
import { reviewToolSchemas } from "../tools/registry.js";
import type { ReviewToolkit } from "../tools/toolkit.js";
import { loadAgentTruth, parsedJsonEqual, type AgentGateTruth } from "./agent-truth.js";
import { compareSemanticRecord } from "./semantic-parity.js";
import { deepEqualJson } from "./json-equal.js";
import { discoverGateRecords, type GateRecordRef } from "./ground-truth.js";
import { RUNS_ROOT } from "./gate-runner.js";

/** 单实验 C/D/E 门：发现 → 逐记录剧本重放对照 */
export function runAgentGate(options: { readonly experimentId: string }): void {
  const refs = discoverGateRecords(RUNS_ROOT, ["C", "D", "E"]).filter(
    (ref) => ref.experimentId === options.experimentId,
  );
  if (refs.length === 0) {
    test.skip(
      `语义等价:${options.experimentId} 真源缺席(runs/ gitignored),全量对照跳过`,
      () => {},
    );
    return;
  }
  for (const ref of refs) {
    test(
      `语义等价:${ref.experimentId} ${ref.caseId} × ${ref.configId} × rep-${ref.rep}`,
      async () => {
        await assertAgentSemanticParity(ref);
      },
      15 * 60_000,
    );
  }
}

async function assertAgentSemanticParity(ref: GateRecordRef): Promise<void> {
  const truth = loadAgentTruth(ref.auditPath, ref.configId as AgentGateTruth["configId"]);
  const script = fakeFetch([...truth.replies]);
  const outcome = await runAgentReviewLoop({
    systemPrompt: truth.systemPrompt,
    initialContextMessages: truth.initialContextMessages,
    toolkit: replayToolkit(truth),
    apiKey: "agent-gate-offline",
    fetch: script.fetch,
    includeLedgerAudit: truth.configId === "E",
  });
  const audit = outcome.audit;
  const label = `${ref.experimentId} ${ref.caseId}/${ref.configId}/rep-${ref.rep}`;

  // 1. wire 消息序语义等价（含工具调用 / 应答 / 指令内容 / 方言归一化）
  const parity = compareSemanticRecord(
    truth.wireBodies,
    audit.requests.map((request) => request.wireBody),
  );
  expect(parity.parity, parity.parity ? undefined : `${label}: ${parity.reason}`).toBe(true);

  // 2. Zone A 稳定前缀纪律（多轮保持）：tools 段字节跨请求恒定 + append-only
  const toolBodies = audit.requests.map((request) =>
    JSON.stringify((JSON.parse(request.wireBody) as { tools: unknown }).tools),
  );
  expect(
    new Set(toolBodies).size,
    `${label}: wireBody.tools is not byte-stable across requests`,
  ).toBe(1);
  for (let index = 1; index < audit.requests.length; index++) {
    const previous = audit.requests[index - 1]?.messages ?? [];
    const current = audit.requests[index]?.messages ?? [];
    expect(current.length, `${label}: request ${index} shrank`).toBeGreaterThanOrEqual(previous.length);
    expect(
      deepEqualJson(current.slice(0, previous.length), previous),
      `${label}: request ${index} is not append-only over request ${index - 1}`,
    ).toBe(true);
  }

  // 3. tools 投影（审计口径点分名；恒定面对照首请求即可）
  const expectedTools = truth.expectation.tools;
  const actualTools = audit.requests[0]?.tools ?? [];
  expect(
    deepEqualJson(actualTools as unknown[], expectedTools),
    `${label}: tools projection differs from truth`,
  ).toBe(true);

  // 4. phaseLog 逐条（round / phase / requestCount / note）
  const expectedPhases = truth.expectation.phaseLog;
  expect(audit.phaseLog, `${label}: phaseLog length`).toHaveLength(expectedPhases.length);
  for (let index = 0; index < expectedPhases.length; index++) {
    expect(
      deepEqualJson(audit.phaseLog[index] as unknown, expectedPhases[index] as unknown),
      `${label}: phaseLog[${index}] differs`,
    ).toBe(true);
  }

  // 5. toolCallLog 逐条（name / resultSummary 字节；argumentsJson 解析值口径）
  const expectedCalls = truth.expectation.toolCallLog;
  expect(audit.toolCallLog, `${label}: toolCallLog length`).toHaveLength(expectedCalls.length);
  for (let index = 0; index < expectedCalls.length; index++) {
    const actual = audit.toolCallLog[index];
    const expected = expectedCalls[index];
    if (actual === undefined || expected === undefined) {
      throw new Error(`${label}: unreachable toolCallLog entry ${index}`);
    }
    expect(actual.name, `${label}: toolCallLog[${index}].name`).toBe(expected.name);
    expect(actual.resultSummary, `${label}: toolCallLog[${index}].resultSummary`).toBe(expected.resultSummary);
    expect(
      parsedJsonEqual(actual.argumentsJson, expected.argumentsJson),
      `${label}: toolCallLog[${index}].argumentsJson differs beyond reserialization dialect`,
    ).toBe(true);
  }

  // 6. findings / rejections 逐条
  expect(
    deepEqualJson(outcome.findings as unknown[], truth.expectation.findings as unknown[]),
    `${label}: findings differ`,
  ).toBe(true);
  expect(
    deepEqualJson(audit.rejections as unknown[], truth.expectation.rejections as unknown[]),
    `${label}: rejections differ`,
  ).toBe(true);

  // 7. run 级语义面
  expect(outcome.rounds, `${label}: rounds`).toBe(truth.expectation.rounds);
  expect(outcome.toolCalls, `${label}: toolCalls`).toBe(truth.expectation.toolCalls);
  expect(outcome.complete, `${label}: complete`).toBe(!truth.expectation.truncated);
  expect(audit.truncated, `${label}: truncated`).toBe(truth.expectation.truncated);
  expect(audit.truncationReasons, `${label}: truncationReasons`).toEqual(truth.expectation.truncationReasons);
  expect(
    deepEqualJson(audit.cacheBreaks as unknown[], []),
    `${label}: cacheBreaks must stay empty on a stable prefix`,
  ).toBe(true);

  // 8. config E：Context Ledger 快照逐条（副作用回放对照）
  if (truth.configId === "E") {
    const ledger = audit.ledger ?? [];
    expect(ledger, `${label}: ledger length`).toHaveLength(truth.expectation.ledger.length);
    for (let index = 0; index < truth.expectation.ledger.length; index++) {
      expect(
        deepEqualJson(ledger[index] as unknown, truth.expectation.ledger[index] as unknown),
        `${label}: ledger[${index}] differs`,
      ).toBe(true);
    }
  } else {
    expect(audit.ledger, `${label}: non-E config must not project a ledger key`).toBeUndefined();
  }
}

/**
 * 脚本回放 toolkit：schema 面用真实注册表（Zone A 字节稳定），执行面按
 * 真源 resultSummary 队列注入（执行器字节面由 tool-outputs 门把守），
 * ledger 副作用按真源条目回放（失败执行与引用命中不登记）。
 * 队列耗尽再被调用即抛错——预算纪律漂移的 fail-fast 哨兵。
 */
function replayToolkit(truth: AgentGateTruth): ReviewToolkit {
  const schemas = reviewToolSchemas();
  const ledger = truth.configId === "E" ? createContextLedger() : createInertContextLedger();
  let resultCursor = 0;
  let ledgerCursor = 0;
  return {
    schemas,
    ledger,
    executeTool: async (): Promise<string> => {
      const result = truth.toolResults[resultCursor];
      if (result === undefined) {
        throw new Error(
          "replay script exhausted: pi executed more tools than the truth run did (budget discipline drift)",
        );
      }
      resultCursor += 1;
      if (!result.startsWith("Error: ") && !result.startsWith("Already loaded: ")) {
        const entry = truth.ledgerEntries[ledgerCursor];
        if (entry !== undefined) {
          ledger.register(entry.kind, entry.description);
          ledgerCursor += 1;
        }
      }
      return result;
    },
  };
}
