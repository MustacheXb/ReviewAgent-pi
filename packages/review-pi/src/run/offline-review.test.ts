import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { PHASE_INSTRUCTIONS } from "../loop/phases.js";
import { fakeFetch } from "../provider/fake-fetch.js";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";
import { VUL4J_1_ISSUE, VUL4J_1_SNAPSHOT, vul4j1Corpus } from "../testing/vul4j1-script.js";
import { SYSTEM_PROMPT } from "../zonea/system-prompt.js";
import { runOfflineReview } from "./offline-review.js";

// P1a 全链离线 E2E（单案 VUL4J-1 × config B × fake 适配器）：
// 组装（Zone A/B/C + 预取）→ pi-ai 序列化 → fake 适配器 → findings 解析 →
// 候选拦截 → 审计投影（AuditFileContent + RunRecord）。
//
// 黄金真源：t-series 审计（DSH 线 VUL4J-1/B/rep-1）——
// 回复 1-5 原文、req0 wireBody、findings/rejections/phaseLog/prefetch 记账
// （脚本 fixture 见 ../testing/vul4j1-script.ts）。
//
// 全链只观测 RunRecord / 审计文件的外部行为（不窥探内核内部状态）。

const EXPECTED = JSON.parse(goldenFixture("expected-baseline-vul4j-1-b.json")) as {
  findings: unknown[];
  rejections: unknown[];
  phaseLog: unknown[];
  prefetch: unknown[];
};
const REQ0 = JSON.parse(goldenFixture("wire-req0-vul4j-1.json")) as {
  model: string;
  messages: { role: string; content: string }[];
  [extra: string]: unknown;
};

const tempDirs: string[] = [];

function tempRunsRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-e2e-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!existsSync(VUL4J_1_SNAPSHOT))(
  "全链离线：VUL4J-1 × config B 与 t-series 审计同构，零网络",
  async () => {
    // 零网络纪律：globalThis.fetch 换成抛错探针，全链仍可跑通
    const originalFetch = globalThis.fetch;
    const networkProbe = vi.fn(() => {
      throw new Error("network access is disabled in offline tests");
    });
    globalThis.fetch = networkProbe as unknown as typeof globalThis.fetch;

    const script = fakeFetch(vul4j1Corpus());
    const runsRoot = tempRunsRoot();
    let firstAudit: Record<string, unknown>;
    try {
      const { record, recordPath, auditPath } = await runOfflineReview({
        caseId: "VUL4J-1",
        repoPath: VUL4J_1_SNAPSHOT,
        diff: goldenFixture("vul4j-1.diff"),
        issueDescription: VUL4J_1_ISSUE,
        apiKey: "offline-test",
        fetch: script.fetch,
        runsRoot,
        experimentId: "phase2-smoke",
        rep: 1,
      });

      // fake 适配器恰好消耗六条脚本（六阶段各一请求，零工具）
      expect(script.requests).toHaveLength(6);

      // 落盘布局与 DSH 线一致
      expect(recordPath).toBe(
        path.join(runsRoot, "phase2-smoke", "runs", "vul4j", "VUL4J-1", "B", "rep-1.json"),
      );
      expect(path.dirname(auditPath)).toBe(
        path.join(runsRoot, "phase2-smoke", "audit", "vul4j", "VUL4J-1", "B", "rep-1", "audit"),
      );

      // RunRecord 与 t-series 记录同构（findings / 拦截 / phaseLog / 预取记账 / usage 聚合）
      expect(record.source).toBe("vul4j");
      expect(record.model).toBe("deepseek-v4-flash");
      expect(record.verifier).toBe("off");
      expect(Number.isNaN(Date.parse(record.completedAt))).toBe(false);
      expect(record.effective).toBeNull();
      expect(record.verifierPass).toBeNull();
      expect(record.baseline.findings).toEqual(EXPECTED.findings);
      expect(record.baseline.audit.rejections).toEqual(EXPECTED.rejections);
      expect(record.baseline.audit.phaseLog).toEqual(EXPECTED.phaseLog);
      expect(record.baseline.audit.prefetch).toEqual(EXPECTED.prefetch);
      expect(record.baseline.usage).toEqual({
        inputTokens: 9579,
        outputTokens: 14484,
        cacheReadTokens: 24064,
      });
      expect(record.baseline.rounds).toBe(1);
      expect(record.baseline.toolCalls).toBe(0);
      expect(record.baseline.audit.truncated).toBe(false);
      expect(record.baseline.audit.truncationReasons).toEqual([]);
      expect(record.baseline.auditPath).toBe(auditPath);

      // 审计文件：requests[].wireBody + 元数据
      firstAudit = JSON.parse(readFileSync(auditPath, "utf8")) as Record<string, unknown>;
      expect(firstAudit["rounds"]).toBe(1);
      expect(firstAudit["usage"]).toEqual({
        inputTokens: 9579,
        outputTokens: 14484,
        cacheReadTokens: 24064,
      });
      expect(firstAudit["truncated"]).toBe(false);
      expect(firstAudit["effort"]).toBe("default");
      const requests = firstAudit["requests"] as {
        wireBody: string;
        messages: { role: string; content: string; reasoning_content?: string }[];
      }[];
      expect(requests).toHaveLength(6);

      // req0 序列化语义面与 t-series 一致（Zone A/B/C 组装 + pi-ai 序列化同构）。
      // 内核身份差异（审计如实记录、P2 字节门再议）：DSH 非流式（stream: false）；
      // pi 内核 openai-completions 恒流式（stream: true + stream_options.include_usage）。
      const wire0 = JSON.parse(requests[0].wireBody) as Record<string, unknown>;
      expect(wire0["model"]).toBe(REQ0.model);
      expect(wire0["messages"]).toEqual(REQ0.messages);
      expect(wire0["thinking"]).toEqual(REQ0.thinking);
      expect(wire0["reasoning_effort"]).toBe(REQ0.reasoning_effort);
      expect(wire0["stream"]).toBe(true);
      expect(wire0["stream_options"]).toEqual({ include_usage: true });
      expect("max_tokens" in wire0).toBe(false);
      expect("tools" in wire0).toBe(false);

      // append-only（compaction 显式禁用）：每请求 = 上一请求 + assistant 回复 + 下一阶段指令
      expect(requests[0].messages).toHaveLength(7);
      const replies = [
        goldenFixture("reply-1-vul4j-1.txt"),
        goldenFixture("reply-2-vul4j-1.txt"),
        goldenFixture("reply-3-vul4j-1.txt"),
        goldenFixture("reply-4-vul4j-1.txt"),
        goldenFixture("reply-5-vul4j-1.txt"),
      ];
      for (let index = 1; index < requests.length; index++) {
        expect(requests[index].messages.slice(0, -2)).toEqual(requests[index - 1].messages);
        expect(requests[index].messages.at(-2)).toEqual({
          role: "assistant",
          content: replies[index - 1],
          reasoning_content: "",
        });
        expect(requests[index].messages.at(-1)).toEqual({
          role: "user",
          content: PHASE_INSTRUCTIONS[index],
        });
      }

      // Zone A：恒为首位 system，且与 t-series 逐字节一致
      for (const request of requests) {
        expect(request.messages[0]).toEqual(REQ0.messages[0]);
      }
      expect(REQ0.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(networkProbe).not.toHaveBeenCalled();

    // Zone A 跨 MR 字节稳定：另一案（不同 caseId / 仓库 / diff / issue）全链重跑，
    // system 逐字节不变（systemPrompt 与 MR 无关；用样本小仓库控制耗时）
    const betaDiff = [
      "diff --git a/src/main/java/com/example/Beta.java b/src/main/java/com/example/Beta.java",
      "--- a/src/main/java/com/example/Beta.java",
      "+++ b/src/main/java/com/example/Beta.java",
      "@@ -5,4 +5,4 @@",
      " context",
      "+changed",
    ].join("\n");
    const secondScript = fakeFetch(vul4j1Corpus());
    const { auditPath: secondAuditPath } = await runOfflineReview({
      caseId: "SAMPLE-2",
      repoPath: repoFixturePath("sample"),
      diff: betaDiff,
      issueDescription: "Another MR under review.",
      apiKey: "offline-test",
      fetch: secondScript.fetch,
      runsRoot: tempRunsRoot(),
      experimentId: "phase2-smoke",
      rep: 1,
    });
    const secondAudit = JSON.parse(readFileSync(secondAuditPath, "utf8")) as {
      requests: { messages: { role: string; content: string }[] }[];
    };
    const firstRequests = firstAudit["requests"] as { messages: { role: string; content: string }[] }[];
    expect(secondAudit.requests[0].messages[0]).toEqual(firstRequests[0].messages[0]);
    expect(secondAudit.requests[0].messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
  },
  480_000,
);
