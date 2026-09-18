import { expect, test } from "vitest";
import { goldenFixture } from "../testing/golden.js";
import { PHASE_INSTRUCTIONS, PHASE_ORDER } from "./phases.js";

// 六阶段指令（测量常量）：与 DSH 线审计真源逐字节一致。
// 黄金文件提取自 t-series requests 各阶段 user 消息 content
// （phase-1 = messages[6]，phase-N = 上一请求 messages + assistant 回复 + 阶段 N 消息）。
test("PHASE_INSTRUCTIONS 共六阶段且与 DSH 审计真源逐字节一致", () => {
  expect(PHASE_INSTRUCTIONS).toHaveLength(6);
  for (let n = 1; n <= 6; n++) {
    expect(PHASE_INSTRUCTIONS[n - 1]).toBe(goldenFixture(`phase-${n}.txt`));
  }
});

test("PHASE_ORDER 与指令前缀一致（Phase N of 6 - <name>.）", () => {
  expect(PHASE_ORDER).toEqual([
    "Change Understanding",
    "Risk Classification",
    "Context Decision",
    "Context Retrieval",
    "Deep Reasoning",
    "Evidence Verification",
  ]);
  PHASE_INSTRUCTIONS.forEach((instruction, index) => {
    expect(instruction.startsWith(`Phase ${index + 1} of 6 - ${PHASE_ORDER[index]}.\n`)).toBe(true);
  });
});
