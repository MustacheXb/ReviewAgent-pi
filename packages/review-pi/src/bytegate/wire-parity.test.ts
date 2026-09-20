import { expect, test } from "vitest";
import {
  compareRecordParity,
  compareWireParity,
  REGISTERED_WIRE_DIFFERENCE_CATEGORIES,
  STRUCTURAL_WIRE_DIFFERENCE_CATEGORIES,
} from "./wire-parity.js";

// P2 字节纪律门(#5)——wire-parity 比较器单元测试(纯函数缝)。
//
// 基准对构造自 t-series 侦查结论(VUL4J-1/B 逐字节对照的经验差异全集):
// DSH 线 deepseek 客户端 = 非流式、无 stream_options、assistant 无
// reasoning_content、键序 model,messages,thinking,reasoning_effort,stream;
// pi 内核 openai-completions = 恒流式 + stream_options.include_usage、
// deepseek 兼容层给 assistant 补 reasoning_content:"" 、键序
// model,messages,stream,stream_options,thinking,reasoning_effort。
// 消息内容(role+content)两侧零漂移——这是本门守护的对象。
// 空回复例外(t2/VUL4J-79/B/rep-2 实证,180 条中 1 条):DSH 以
// {role:"assistant",content:null} 入 wire;pi 序列化器对无内容 assistant
// 消息整条省略——登记为 EMPTY_ASSISTANT_REPLY(数据条件触发)。

test("字节相等:零差异,零触发", () => {
  const wire = JSON.stringify({
    model: "deepseek-v4-flash",
    messages: [
      { role: "system", content: "S" },
      { role: "user", content: "U" },
    ],
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    stream: false,
  });
  const result = compareWireParity(wire, wire);
  expect(result).toEqual({ parity: true, firedCategories: [] });
});

/** DSH 侧基准(键序 + 非流式 + assistant 无 reasoning_content) */
function dshWireOf(messages: unknown[]): string {
  return JSON.stringify({
    model: "deepseek-v4-flash",
    messages,
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    stream: false,
  });
}

/** pi 侧基准(键序方言 + 恒流式 + stream_options + assistant reasoning_content:"") */
function piWireOf(messages: unknown[]): string {
  return JSON.stringify({
    model: "deepseek-v4-flash",
    messages,
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  });
}

test("登记面全触发:四类内核身份差异归一化后逐字节相等", () => {
  const dshMessages = [
    { role: "system", content: "S" },
    { role: "user", content: "U" },
    { role: "assistant", content: "R1" },
    { role: "user", content: "P2" },
  ];
  const piMessages = [
    { role: "system", content: "S" },
    { role: "user", content: "U" },
    { role: "assistant", content: "R1", reasoning_content: "" },
    { role: "user", content: "P2" },
  ];
  const result = compareWireParity(dshWireOf(dshMessages), piWireOf(piMessages));
  expect(result).toEqual({
    parity: true,
    firedCategories: [
      "STREAM_FLAG",
      "STREAM_OPTIONS",
      "ASSISTANT_REASONING_CONTENT",
      "KEY_ORDER",
    ],
  });
});

test("登记面:空回复——DSH content:null 的 assistant 在 pi 侧无对应消息,补形后逐字节相等", () => {
  const result = compareWireParity(
    dshWireOf([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
      { role: "assistant", content: null },
      { role: "user", content: "P2" },
    ]),
    piWireOf([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
      { role: "user", content: "P2" },
    ]),
  );
  expect(result).toEqual({
    parity: true,
    firedCategories: ["STREAM_FLAG", "STREAM_OPTIONS", "EMPTY_ASSISTANT_REPLY", "KEY_ORDER"],
  });
});

// ---- 白名单外零容忍:各类未登记漂移必须红 ----

test("负面对照:system 消息一字节漂移 → 红,定位到 messages[0]", () => {
  const piMessages = [
    { role: "system", content: "S " },
    { role: "user", content: "U" },
  ];
  const result = compareWireParity(
    dshWireOf([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
    ]),
    piWireOf(piMessages),
  );
  expect(result).toMatchObject({ parity: false });
  expect((result as { reason: string }).reason).toContain('messages[0] differs');
});

test("负面对照:assistant 回复内容漂移 → 红,定位到消息下标", () => {
  const result = compareWireParity(
    dshWireOf([
      { role: "system", content: "S" },
      { role: "assistant", content: "R1" },
    ]),
    piWireOf([
      { role: "system", content: "S" },
      { role: "assistant", content: "R1!", reasoning_content: "" },
    ]),
  );
  expect(result).toMatchObject({ parity: false });
  expect((result as { reason: string }).reason).toContain("messages[1] differs");
});

test("负面对照:reasoning_content 非空(思考泄漏)→ 红,不归一化", () => {
  const result = compareWireParity(
    dshWireOf([
      { role: "system", content: "S" },
      { role: "assistant", content: "R1" },
    ]),
    piWireOf([
      { role: "system", content: "S" },
      { role: "assistant", content: "R1", reasoning_content: "thinking leaked" },
    ]),
  );
  expect(result).toMatchObject({ parity: false });
  expect((result as { reason: string }).reason).toContain("messages[1] differs");
});

test("负面对照:DSH 侧带 reasoning_content 而 pi 不带 → 红(反向不可归一化)", () => {
  const result = compareWireParity(
    dshWireOf([
      { role: "system", content: "S" },
      { role: "assistant", content: "R1", reasoning_content: "" },
    ]),
    piWireOf([
      { role: "system", content: "S" },
      { role: "assistant", content: "R1" },
    ]),
  );
  expect(result).toMatchObject({ parity: false });
});

test("负面对照:DSH 空回复而 pi 保留非空 assistant → 红(不可归一化)", () => {
  const result = compareWireParity(
    dshWireOf([
      { role: "system", content: "S" },
      { role: "assistant", content: null },
      { role: "user", content: "P2" },
    ]),
    piWireOf([
      { role: "system", content: "S" },
      { role: "assistant", content: "R1", reasoning_content: "" },
      { role: "user", content: "P2" },
    ]),
  );
  expect(result).toMatchObject({ parity: false });
  expect((result as { reason: string }).reason).toContain("message count differs");
});

test("负面对照:DSH 空回复而 pi 发空串 content:\"\" → 红(形态漂移须重新登记)", () => {
  const result = compareWireParity(
    dshWireOf([
      { role: "system", content: "S" },
      { role: "assistant", content: null },
    ]),
    piWireOf([
      { role: "system", content: "S" },
      { role: "assistant", content: "", reasoning_content: "" },
    ]),
  );
  expect(result).toMatchObject({ parity: false });
  expect((result as { reason: string }).reason).toContain("message count differs");
});

test("负面对照:未登记新键(max_tokens)→ 红", () => {
  const wire = JSON.parse(piWireOf([{ role: "system", content: "S" }])) as Record<
    string,
    unknown
  >;
  wire["max_tokens"] = 1000;
  const result = compareWireParity(
    dshWireOf([{ role: "system", content: "S" }]),
    JSON.stringify(wire),
  );
  expect(result).toMatchObject({ parity: false });
  expect((result as { reason: string }).reason).toContain("key set differs");
  expect((result as { reason: string }).reason).toContain("max_tokens");
});

test("负面对照:stream 值型漂移(字符串 \"true\")→ 红,不接受登记形态外取值", () => {
  const wire = JSON.parse(piWireOf([{ role: "system", content: "S" }])) as Record<
    string,
    unknown
  >;
  wire["stream"] = "true";
  const result = compareWireParity(
    dshWireOf([{ role: "system", content: "S" }]),
    JSON.stringify(wire),
  );
  expect(result).toMatchObject({ parity: false });
  expect((result as { reason: string }).reason).toContain('"stream" differs');
});

test("负面对照:stream_options 形态漂移 → 红", () => {
  const wire = JSON.parse(piWireOf([{ role: "system", content: "S" }])) as Record<
    string,
    unknown
  >;
  wire["stream_options"] = {};
  const result = compareWireParity(
    dshWireOf([{ role: "system", content: "S" }]),
    JSON.stringify(wire),
  );
  expect(result).toMatchObject({ parity: false });
  expect((result as { reason: string }).reason).toContain("stream_options");
});

test("负面对照:测量常量漂移(model / thinking / reasoning_effort)→ 红", () => {
  for (const key of ["model", "thinking", "reasoning_effort"] as const) {
    const wire = JSON.parse(piWireOf([{ role: "system", content: "S" }])) as Record<
      string,
      unknown
    >;
    wire[key] = key === "model" ? "other-model" : { type: "disabled" };
    if (key === "reasoning_effort") {
      wire[key] = "low";
    }
    const result = compareWireParity(
      dshWireOf([{ role: "system", content: "S" }]),
      JSON.stringify(wire),
    );
    expect(result, key).toMatchObject({ parity: false });
    expect((result as { reason: string }).reason).toContain(`"${key}" differs`);
  }
});

test("负面对照:消息数漂移 → 红", () => {
  const result = compareWireParity(
    dshWireOf([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
    ]),
    piWireOf([{ role: "system", content: "S" }]),
  );
  expect(result).toMatchObject({ parity: false });
  expect((result as { reason: string }).reason).toContain("message count differs");
});

test("负面对照:非 JSON / 顶层数组 → 红", () => {
  expect(compareWireParity("not json", "also not json")).toMatchObject({ parity: false });
  expect(compareWireParity("[1,2]", "[1,2]")).toMatchObject({ parity: true });
  expect(compareWireParity("[1,2]", "[1,3]")).toMatchObject({ parity: false });
  expect(compareWireParity(dshWireOf([{ role: "system", content: "S" }]), "[]")).toMatchObject({
    parity: false,
  });
});

// ---- 记录级:计算差异 = 登记差异强制相等 ----

test("记录级:请求计数不一致 → 红", () => {
  const dsh = [dshWireOf([{ role: "system", content: "S" }])];
  const result = compareRecordParity(dsh, [...dsh, ...dsh]);
  expect(result).toMatchObject({ parity: false });
  expect((result as { reason: string }).reason).toContain("request count differs");
});

test("记录级:单请求漂移透传(带请求下标)→ 红", () => {
  const pair = (
    messages: unknown[],
  ): [string, string] => [
    dshWireOf(messages),
    piWireOf(
      messages.map((m) =>
        m && typeof m === "object" && (m as { role: string }).role === "assistant"
          ? { ...(m as object), reasoning_content: "" }
          : m,
      ),
    ),
  ];
  const [d0, p0] = pair([{ role: "system", content: "S" }]);
  const [d1] = pair([
    { role: "system", content: "S" },
    { role: "assistant", content: "R" },
  ]);
  const drifted = piWireOf([
    { role: "system", content: "DRIFT" },
    { role: "assistant", content: "R" },
  ]);
  const result = compareRecordParity([d0, d1], [p0, drifted]);
  expect(result).toMatchObject({ parity: false });
  expect((result as { reason: string }).reason).toContain("request 1:");
});

test("记录级:登记类别停摆(零差异记录)→ 红,登记集强制全触发", () => {
  const wire = dshWireOf([{ role: "system", content: "S" }]);
  const result = compareRecordParity([wire, wire], [wire, wire]);
  expect(result).toMatchObject({ parity: false });
  expect((result as { reason: string }).reason).toContain("did not fire");
});

test("记录级:结构性全触发 → 绿,fired 按登记序返回(数据条件类不构成死登记)", () => {
  const dsh = dshWireOf([
    { role: "system", content: "S" },
    { role: "assistant", content: "R" },
  ]);
  const pi = piWireOf([
    { role: "system", content: "S" },
    { role: "assistant", content: "R", reasoning_content: "" },
  ]);
  const result = compareRecordParity([dsh, dsh], [pi, pi]);
  expect(result).toEqual({
    parity: true,
    firedCategories: [...STRUCTURAL_WIRE_DIFFERENCE_CATEGORIES],
  });
  // 无空回复的记录:EMPTY_ASSISTANT_REPLY 不触发,但不得误判为死登记
  expect(result.parity && result.firedCategories).not.toContain("EMPTY_ASSISTANT_REPLY");
});

test("记录级:含空回复记录 → 全五类触发(含数据条件类,按登记序)", () => {
  const dsh = dshWireOf([
    { role: "system", content: "S" },
    { role: "assistant", content: "R1" },
    { role: "user", content: "P2" },
    { role: "assistant", content: null },
    { role: "user", content: "P3" },
  ]);
  const pi = piWireOf([
    { role: "system", content: "S" },
    { role: "assistant", content: "R1", reasoning_content: "" },
    { role: "user", content: "P2" },
    { role: "user", content: "P3" },
  ]);
  const result = compareRecordParity([dsh], [pi]);
  expect(result).toEqual({
    parity: true,
    firedCategories: [...REGISTERED_WIRE_DIFFERENCE_CATEGORIES],
  });
});

