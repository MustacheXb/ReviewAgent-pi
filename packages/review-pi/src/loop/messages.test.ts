import { expect, test } from "vitest";
import { goldenFixture } from "../testing/golden.js";
import { buildInitialContextMessages, buildInitialUserMessage } from "./messages.js";

// VUL4J-1 案例输入与黄金审计记录同源：issue 描述逐字取自审计消息内嵌文本
// （单行）；diff 取独立 fixture vul4j-1.diff（从审计消息 ```diff 围栏内按字节
// 提取——注意其中空上下文行是单个空格，git diff 的原生形态）。
const VUL4J_1_CASE_ID = "VUL4J-1";
const VUL4J_1_ISSUE =
  "Vulnerability CVE-2017-18349 (CWE-20: Improper Input Validation) in alibaba/fastjson. Fixed by https://github.com/alibaba/fastjson/commit/f5903fa56497c00ed0703ac875b511f9bd5f1d8e.";
const VUL4J_1_DIFF = goldenFixture("vul4j-1.diff");

test("buildInitialUserMessage 与 VUL4J-1 审计真源逐字节一致", () => {
  expect(buildInitialUserMessage(VUL4J_1_CASE_ID, VUL4J_1_ISSUE, VUL4J_1_DIFF)).toBe(
    goldenFixture("mr-message-vul4j-1.txt"),
  );
});

test("issue 描述纯空白时与 DSH 同语义回落 (none)，非空时保留原文不 trim", () => {
  // DSH 线语义：issueDescription.trim().length > 0 ? issueDescription : "(none)"
  // —— 判空看 trim，注入看原文（前后空白保留）。
  expect(buildInitialUserMessage("X-1", "   ", "+ a\n")).toContain("Issue description:\n(none)");
  expect(buildInitialUserMessage("X-1", "  fastjson deserialization  ", "+ a\n")).toContain(
    "Issue description:\n  fastjson deserialization  ",
  );
});

test("issue 描述缺省时回落到 (none)", () => {
  expect(buildInitialUserMessage("X-1", "", "+ a\n")).toBe(
    [
      "Merge request under review.",
      "",
      "Case ID: X-1",
      "Issue description:",
      "(none)",
      "",
      "Unified diff:",
      "```diff",
      "+ a\n",
      "```",
    ].join("\n"),
  );
});

test("buildInitialContextMessages：消息序与 t-series req0 逐条一致（Zone B → MR → 预取×3）", () => {
  // t-series req0 = [system, zoneB, MR, prefetch 1-3, phase-1]；
  // 本函数产出 system 之外的全部初始消息（system 经 pi-ai Context.systemPrompt 通道）。
  const req0 = JSON.parse(goldenFixture("wire-req0-vul4j-1.json")) as {
    messages: { role: string; content: string }[];
  };
  const messages = buildInitialContextMessages({
    zoneB: { role: "user", content: goldenFixture("zone-b-vul4j-1.txt") },
    mrUserContent: goldenFixture("mr-message-vul4j-1.txt"),
    prefetch: [
      { role: "user", content: goldenFixture("prefetch-1-vul4j-1.txt") },
      { role: "user", content: goldenFixture("prefetch-2-vul4j-1.txt") },
      { role: "user", content: goldenFixture("prefetch-3-vul4j-1.txt") },
    ],
  });
  expect(messages).toEqual(req0.messages.slice(1, 6));
  expect(messages.map((message) => message.role)).toEqual(["user", "user", "user", "user", "user"]);
});
