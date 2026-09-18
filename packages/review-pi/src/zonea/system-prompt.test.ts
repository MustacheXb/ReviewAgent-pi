import { expect, test } from "vitest";
import { goldenFixture } from "../testing/golden.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";

// Zone A 测量常量：与 DSH 线审计真源（testdata/golden/system-prompt.txt，
// 提取自 t-series requests[0].messages[0].content）逐字节一致。
// 该常量跨 MR 字节稳定，是对照实验两侧可比性的地基。
test("SYSTEM_PROMPT 与 DSH 审计真源逐字节一致", () => {
  expect(SYSTEM_PROMPT).toBe(goldenFixture("system-prompt.txt"));
});
