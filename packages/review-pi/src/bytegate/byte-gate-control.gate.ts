import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { runReview } from "../run/review-run.js";
import { fakeFetch, type FakeReply } from "../provider/fake-fetch.js";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";
import { VUL4J_1_ISSUE } from "../testing/vul4j1-script.js";
import { FIXED_STARTED_AT, readAuditWireBodies, ZERO_FAKE_USAGE } from "./gate-runner.js";
import { SYNTHESIZED_TERMINAL_REPLY } from "./ground-truth.js";
import {
  compareRecordParity,
  REGISTERED_WIRE_DIFFERENCE_CATEGORIES,
  STRUCTURAL_WIRE_DIFFERENCE_CATEGORIES,
} from "./wire-parity.js";

// P2 字节纪律门(#5)——CI 常开对照(不依赖 gitignored 真源/快照)。
//
// 全量对照(byte-gate.t*.gate.ts)需要 runs/ 真源 + .cache/ 快照,均
// gitignored——CI 上空转。本档用已入库黄金真源(t1 VUL4J-1/A/rep-1)
// 做同一条链的最小闭环,保证门在无数据环境下仍然「活着」:
// - 正对照:config A × VUL4J-1 重放,pi 请求体与 DSH 真源逐字节 parity
//   (config A 零预取零工具,不需要仓库快照);
// - 方言对照:空回复路径(reply-5 置空 + wire-5 最小字节手术)——DSH
//   content:null ↔ pi 省略该消息,EMPTY_ASSISTANT_REPLY 在 CI 常开行使;
// - 负对照:注入一字节测量常量漂移(issue 文案),同一链必须红——
//   证明对照链对未登记漂移敏感,不是恒绿摆设。

const REQ_COUNT = 6;
const DSH_WIRES = Array.from({ length: REQ_COUNT }, (_, index) =>
  goldenFixture(`wire-a-req${index}-vul4j-1.json`),
);
const REPLIES = [
  ...Array.from({ length: REQ_COUNT - 1 }, (_, index) =>
    goldenFixture(`reply-a-${index + 1}-vul4j-1.txt`),
  ),
  SYNTHESIZED_TERMINAL_REPLY,
];

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** config A × VUL4J-1 重放(黄金真源输入;可覆写回放脚本),返回 pi 侧请求体列表 */
async function replayConfigA(
  issueDescription: string,
  replies: readonly string[] = REPLIES,
): Promise<string[]> {
  const script = fakeFetch(
    replies.map((text): FakeReply => ({ text, usage: { ...ZERO_FAKE_USAGE } })),
  );
  const replayRoot = mkdtempSync(path.join(tmpdir(), "byte-gate-ctl-"));
  tempDirs.push(replayRoot);
  const { auditPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"), // config A 不读仓库
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription,
    apiKey: "byte-gate-control",
    fetch: script.fetch,
    runsRoot: replayRoot,
    experimentId: "byte-gate-ctl",
    rep: 1,
    configId: "A",
    startedAt: FIXED_STARTED_AT,
  });
  return readAuditWireBodies(auditPath);
}

/**
 * 黄金 wire-5 的空回复变体:reply-5 的 assistant content → null(最小字节
 * 手术,needle 必须恰好命中一次——黄金真源序列化形状的硬断言)。
 */
function dshWiresWithEmptyReply(): string[] {
  const reply5 = REPLIES[4];
  const wire5 = DSH_WIRES[5];
  if (reply5 === undefined || wire5 === undefined) {
    throw new Error("dialect control: golden reply-5/wire-5 fixture missing");
  }
  const needle = `{"role":"assistant","content":${JSON.stringify(reply5)}}`;
  const occurrences = wire5.split(needle).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `dialect control surgery needle expected exactly once in golden wire-5, found ${occurrences}`,
    );
  }
  return [
    ...DSH_WIRES.slice(0, 5),
    wire5.replace(needle, '{"role":"assistant","content":null}'),
  ];
}

test("正对照:config A × VUL4J-1 黄金重放——pi 请求体与 DSH 真源逐字节 parity", async () => {
  const piWires = await replayConfigA(VUL4J_1_ISSUE);
  const result = compareRecordParity(DSH_WIRES, piWires);
  expect(
    result.parity,
    result.parity ? undefined : result.reason,
  ).toBe(true);
  // 结构性登记差异在真实重放中全部触发(计算差异 = 登记差异,双向收口);
  // 数据条件类 EMPTY_ASSISTANT_REPLY 见下方方言对照
  expect(result).toEqual({
    parity: true,
    firedCategories: [...STRUCTURAL_WIRE_DIFFERENCE_CATEGORIES],
  });
}, 300_000);

test("方言对照:空回复重放——DSH content:null ↔ pi 省略该消息,全链仍 parity", async () => {
  // 语料构造:黄金 A 语料的 reply-5 置空(pi 侧重放空串,pi-ai 序列化后
  // 该 assistant 消息整条不入 wire),DSH 侧 wire-5 做最小字节手术
  // (reply-5 的 assistant content → null)——镜像 t2/VUL4J-79/B/rep-2
  // 的真源形状。该真源记录是 B 配置(需 gitignored 快照),CI 无法行使;
  // 此处以同形状构造行使同一条链,保证空回复路径在无数据环境下「活着」。
  const piWires = await replayConfigA(
    VUL4J_1_ISSUE,
    REPLIES.map((text, index) => (index === 4 ? "" : text)),
  );
  const result = compareRecordParity(dshWiresWithEmptyReply(), piWires);
  expect(
    result.parity,
    result.parity ? undefined : result.reason,
  ).toBe(true);
  // 五类登记差异(含数据条件类 EMPTY_ASSISTANT_REPLY)在构造重放中全部触发
  expect(result).toEqual({
    parity: true,
    firedCategories: [...REGISTERED_WIRE_DIFFERENCE_CATEGORIES],
  });
}, 300_000);

test("负对照:注入一字节 issue 漂移 → 门红(定位到请求内消息坐标)", async () => {
  const piWires = await replayConfigA(`${VUL4J_1_ISSUE}X`);
  const result = compareRecordParity(DSH_WIRES, piWires);
  expect(result.parity).toBe(false);
  expect((result as { reason: string }).reason).toContain("request 0:");
  expect((result as { reason: string }).reason).toContain("messages[1] differs");
}, 300_000);
