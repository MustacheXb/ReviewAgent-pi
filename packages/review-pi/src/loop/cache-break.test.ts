import { describe, expect, test } from "vitest";
import type { ToolSchema, WireMessage } from "../contracts/llm.js";
import { classifyCacheBreaks } from "./cache-break.js";

// Cache Break 分类器（纯观测）：对相邻 wire 请求做字节前缀分歧检测。
// 语义与 DSH 线 src/loop/cache-break.ts 一致（测量常量面）：
// - 规范字节布局 model 段 → messages 段（逐条）→ tools 段；
// - 前缀关系（append-only 增长 / 收缩）不构成 break；
// - messages[0]（system 头部分歧）→ SYSTEM_PROMPT_CHANGED（Zone A）；
// - 中段分歧 → CONTEXT_REORDERED（Zone B/C）；
// - 消息一致而 tools 分歧 → TOOL_SCHEMA_CHANGED（Zone A）。

const SYSTEM_A: WireMessage = { role: "system", content: "A" };
const SYSTEM_B: WireMessage = { role: "system", content: "B" };
const USER_X: WireMessage = { role: "user", content: "X" };
const USER_Y: WireMessage = { role: "user", content: "Y" };

function mkWire(
  messages: readonly WireMessage[],
  options?: { readonly model?: string; readonly tools?: readonly ToolSchema[] },
):
  import("../provider/pi-client.js").WireCapture {
  return {
    model: options?.model ?? "m",
    effort: "default",
    messages: [...messages],
    tools: options?.tools ?? [],
    wireBody: JSON.stringify({ model: options?.model ?? "m", messages }),
  };
}

describe("classifyCacheBreaks：前缀语义（append-only / 收缩不构成 break）", () => {
  test("下一请求 = 上一请求 + 追加消息（append-only）→ 无 break", () => {
    const first = mkWire([SYSTEM_A, USER_X]);
    const second = mkWire([SYSTEM_A, USER_X, USER_Y]);
    expect(classifyCacheBreaks([first, second])).toEqual([]);
  });

  test("下一请求是上一请求的前缀（收缩）→ 无 break", () => {
    const first = mkWire([SYSTEM_A, USER_X, USER_Y]);
    const second = mkWire([SYSTEM_A, USER_X]);
    expect(classifyCacheBreaks([first, second])).toEqual([]);
  });
});

describe("classifyCacheBreaks：分歧定位与原因分类", () => {
  test("messages[0]（system 头部）分歧 → SYSTEM_PROMPT_CHANGED，Zone A", () => {
    const records = classifyCacheBreaks([mkWire([SYSTEM_A]), mkWire([SYSTEM_B])]);
    // model "m" 序列化 3 字节（messagesStart=3）+ "[" 前缀 1 + 消息内首分歧位 28
    expect(records).toEqual([
      { requestIndex: 1, reason: "SYSTEM_PROMPT_CHANGED", zone: "A", divergeByteOffset: 32 },
    ]);
  });

  test("中段消息分歧 → CONTEXT_REORDERED，Zone B/C", () => {
    const records = classifyCacheBreaks([
      mkWire([SYSTEM_A, USER_X]),
      mkWire([SYSTEM_A, USER_Y]),
    ]);
    // 3（messagesStart）+ 1 + 31（system 消息字节 + 逗号）+ 26（user 消息内首分歧位）
    expect(records).toEqual([
      { requestIndex: 1, reason: "CONTEXT_REORDERED", zone: "B/C", divergeByteOffset: 62 },
    ]);
  });

  test("model 段分歧 → MODEL_CHANGED，Zone MODEL", () => {
    const records = classifyCacheBreaks([
      mkWire([SYSTEM_A], { model: "m" }),
      mkWire([SYSTEM_A], { model: "n" }),
    ]);
    expect(records).toEqual([
      { requestIndex: 1, reason: "MODEL_CHANGED", zone: "MODEL", divergeByteOffset: 1 },
    ]);
  });

  test("消息一致而 tools 段分歧 → TOOL_SCHEMA_CHANGED，Zone A", () => {
    const tool: ToolSchema = { name: "t", description: "d", parametersJson: "{}" };
    const records = classifyCacheBreaks([
      mkWire([SYSTEM_A], { tools: [] }),
      mkWire([SYSTEM_A], { tools: [tool] }),
    ]);
    // toolsStart = 3（model 段）+ 33（messages 段 "[" + 31 + "]"）= 36；tools 内首分歧位 1
    expect(records).toEqual([
      { requestIndex: 1, reason: "TOOL_SCHEMA_CHANGED", zone: "A", divergeByteOffset: 37 },
    ]);
  });

  test("多对请求逐对分类，requestIndex 随请求序递增", () => {
    const records = classifyCacheBreaks([
      mkWire([SYSTEM_A]),
      mkWire([SYSTEM_A, USER_X]), // append-only：无 break
      mkWire([SYSTEM_B, USER_X]), // system 分歧
    ]);
    expect(records).toEqual([
      { requestIndex: 2, reason: "SYSTEM_PROMPT_CHANGED", zone: "A", divergeByteOffset: 32 },
    ]);
  });
});

describe("classifyCacheBreaks：边界输入", () => {
  test("空数组 / 单请求 → 无相邻对，无记录", () => {
    expect(classifyCacheBreaks([])).toEqual([]);
    expect(classifyCacheBreaks([mkWire([SYSTEM_A])])).toEqual([]);
  });
});
