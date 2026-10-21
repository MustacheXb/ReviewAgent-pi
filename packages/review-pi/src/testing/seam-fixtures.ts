import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect } from "vitest";
import type { FakeReply } from "../provider/fake-fetch.js";

// 内核缝测试（run/review-run-seams.test.ts）与 rpc 真适配器测试
// （rpc/executor.test.ts）共享的最小离线语料与临时目录助手（#23 S2）。
//
// 与 testing/vul4j1-script.ts 的分工：那边是 t-series 黄金字节语料（锁真源
// 形态，逐字节复刻 DSH 审计原文）；这边刻意保持形状最小（零 usage、六阶段
// 零工具 / config D 单工具轮）——只驱动缝行为（取消止步点、进度边界），
// 不掺入黄金语料的字节负担。

const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;

/** 样例 MR diff（repoFixturePath("sample") 仓库的可解析最小形态） */
export const SAMPLE_DIFF = [
  "diff --git a/src/main/java/com/example/Alpha.java b/src/main/java/com/example/Alpha.java",
  "--- a/src/main/java/com/example/Alpha.java",
  "+++ b/src/main/java/com/example/Alpha.java",
  "@@ -5,4 +5,4 @@",
  " context",
  "+changed",
].join("\n");

/** 六阶段零工具脚本（phase-5 候选 / phase-6 complete） */
export function sixPhaseNoToolCorpus(): FakeReply[] {
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: '{"candidates":[]}', usage: ZERO },
    { text: '{"verdicts":[],"complete":true}', usage: ZERO },
  ];
}

/** config D 七回复脚本：phase-3 带一次 get_diff 工具轮 */
export function configDToolCorpus(): FakeReply[] {
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    {
      text: "Let me check the diff first.",
      toolCalls: [{ id: "call-diff-1", name: "review_get_diff", arguments: {} }],
      usage: ZERO,
    },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: '{"candidates":[]}', usage: ZERO },
    { text: '{"verdicts":[],"complete":true}', usage: ZERO },
  ];
}

const tempDirs: string[] = [];

/** 临时 runsRoot（模块级 afterAll 统一清理；prefix 区分调用方） */
export function tempRunsRoot(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 零落盘断言：runsRoot 仍是空目录（半途中止/失败——审计与 RunRecord 均未写） */
export function expectEmptyTree(runsRoot: string): void {
  expect(readdirSync(runsRoot)).toEqual([]);
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
