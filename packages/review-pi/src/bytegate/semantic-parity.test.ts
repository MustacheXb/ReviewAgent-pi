import { expect, test } from "vitest";
import { compareSemanticRecord, compareSemanticWire } from "./semantic-parity.js";
import { REGISTERED_TOOL_DIFFERENCES } from "./tool-dialect.js";

// 语义等价比较器(#6):C/D/E 口径「语义一致而非字节一致」——归一化登记
// 方言(继承面 + 工具面)后 JSON 值域深相等。以下用人工构造的最小 wire
// 对覆盖各归一化分支与死登记检查(离线,不依赖 runs/ 真源)。

/** DSH 形 wire(键序 model→messages→thinking→reasoning_effort→tools→tool_choice→stream) */
function dshWire(overrides: {
  messages?: unknown[];
  tools?: unknown[];
  extra?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    model: "deepseek-v4-flash",
    messages: overrides.messages ?? [{ role: "system", content: "sys" }, { role: "user", content: "u" }],
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    ...(overrides.tools !== undefined ? { tools: overrides.tools } : {}),
    tool_choice: "auto",
    stream: false,
    ...(overrides.extra ?? {}),
  });
}

/** pi 形 wire(键序 model→messages→stream→stream_options→thinking→reasoning_effort→tools) */
function piWire(overrides: {
  messages?: unknown[];
  tools?: unknown[];
  extra?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    model: "deepseek-v4-flash",
    messages: overrides.messages ?? [{ role: "system", content: "sys" }, { role: "user", content: "u" }],
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    ...(overrides.tools !== undefined ? { tools: overrides.tools } : {}),
    ...(overrides.extra ?? {}),
  });
}

const TOOL_DSH = {
  type: "function",
  function: {
    name: "review_get_diff",
    description: "Return the unified diff.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
};

const TOOL_PI = {
  type: "function",
  function: {
    name: "review_get_diff",
    description: "Return the unified diff.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    strict: false,
  },
};

test("工具方言全归一:strict 剥除 + tool_choice 剥除 + arguments 解析值口径 → parity", () => {
  const dsh = dshWire({
    tools: [TOOL_DSH],
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "review_get_file", arguments: '{"path": "Foo.java", "startLine": 1}' } }] },
      { role: "tool", tool_call_id: "c1", content: "file body" },
    ],
  });
  const pi = piWire({
    tools: [TOOL_PI],
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
      { role: "assistant", content: null, reasoning_content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "review_get_file", arguments: '{"path":"Foo.java","startLine":1}' } }] },
      { role: "tool", tool_call_id: "c1", content: "file body" },
    ],
  });
  const result = compareSemanticWire(dsh, pi);
  expect(result.parity, result.parity ? undefined : result.reason).toBe(true);
  if (result.parity) {
    expect(result.firedCategories).toEqual([
      "STREAM_FLAG",
      "STREAM_OPTIONS",
      "ASSISTANT_REASONING_CONTENT",
      "TOOL_STRICT_FLAG",
      "TOOL_CHOICE_ABSENT",
      "TOOL_CALL_ARGUMENTS_RESERIALIZATION",
    ]);
  }
});

test("空回复方言:DSH null-content assistant 在 pi 侧缺席 → 剥除后 parity", () => {
  const dsh = dshWire({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: null },
      { role: "user", content: "u2" },
    ],
  });
  const pi = piWire({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "user", content: "u2" },
    ],
  });
  const result = compareSemanticWire(dsh, pi);
  expect(result.parity, result.parity ? undefined : result.reason).toBe(true);
  if (result.parity) {
    expect(result.firedCategories).toContain("EMPTY_ASSISTANT_REPLY");
  }
});

test("键序方言天然归一(语义门不做字节比较):仅键序不同 → parity", () => {
  const body = {
    model: "m",
    messages: [{ role: "user", content: "x" }],
    stream: false,
  };
  const dsh = JSON.stringify(body);
  const pi = JSON.stringify({ messages: body.messages, stream: false, model: "m" });
  // 无 tools → 工具面结构性类别不触发 → 单请求 parity 但记录级死登记会红(见下)
  const result = compareSemanticWire(dsh, pi);
  expect(result.parity).toBe(true);
});

test("未登记差异零容忍:工具 description 漂移 → drift 定位", () => {
  const dsh = dshWire({ tools: [TOOL_DSH] });
  const pi = piWire({
    tools: [{ type: "function", function: { ...TOOL_PI.function, description: "DIFFERENT" } }],
  });
  const result = compareSemanticWire(dsh, pi);
  expect(result.parity).toBe(false);
  if (!result.parity) {
    expect(result.reason).toContain('top-level "tools" differs');
  }
});

test("继承面形态守卫:pi 缺 stream 键(登记形态外)→ drift,不因剥除静默放行", () => {
  const pi = JSON.stringify({
    model: "deepseek-v4-flash",
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "u" }],
    // stream 键缺席——「pi 恒 stream:true」的登记形态被打破
    stream_options: { include_usage: true },
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  });
  const result = compareSemanticWire(dshWire({}), pi);
  expect(result.parity).toBe(false);
  if (!result.parity) {
    expect(result.reason).toContain("differs outside the registered STREAM_FLAG shape");
  }
});

test("继承面形态守卫:pi stream_options 形态漂移 → drift", () => {
  const pi = piWire({ extra: { stream_options: { include_usage: false } } });
  const result = compareSemanticWire(dshWire({}), pi);
  expect(result.parity).toBe(false);
  if (!result.parity) {
    expect(result.reason).toContain("differs outside the registered STREAM_OPTIONS shape");
  }
});

test("继承面形态守卫:DSH tool_choice 非 auto(语义实质不同)→ drift", () => {
  const dsh = dshWire({ extra: { tool_choice: "required" } });
  const result = compareSemanticWire(dsh, piWire({}));
  expect(result.parity).toBe(false);
  if (!result.parity) {
    expect(result.reason).toContain("differs outside the registered TOOL_CHOICE_ABSENT shape");
  }
});

test("未登记差异零容忍:arguments 解析值不同 → drift", () => {
  const dsh = dshWire({
    tools: [TOOL_DSH],
    messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: '{"a": 1}' } }] },
    ],
  });
  const pi = piWire({
    tools: [TOOL_PI],
    messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: '{"a": 2}' } }] },
    ],
  });
  const result = compareSemanticWire(dsh, pi);
  expect(result.parity).toBe(false);
});

test("arguments 字节恰同(紧凑)→ 不触发 RESERIALIZATION(数据条件口径)", () => {
  const dsh = dshWire({
    tools: [TOOL_DSH],
    messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: '{"a":1}' } }] },
    ],
  });
  const pi = piWire({
    tools: [TOOL_PI],
    messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: '{"a":1}' } }] },
    ],
  });
  const result = compareSemanticWire(dsh, pi);
  expect(result.parity, result.parity ? undefined : result.reason).toBe(true);
  if (result.parity) {
    expect(result.firedCategories).not.toContain("TOOL_CALL_ARGUMENTS_RESERIALIZATION");
  }
});

test("记录级死登记:带工具记录全类别触齐 → parity;缺工具面 → 死登记红", () => {
  const ok = compareSemanticRecord(
    [dshWire({ tools: [TOOL_DSH], messages: [{ role: "assistant", content: "x" }, { role: "user", content: "u" }] })],
    [piWire({ tools: [TOOL_PI], messages: [{ role: "assistant", content: "x", reasoning_content: "" }, { role: "user", content: "u" }] })],
  );
  expect(ok.parity, ok.parity ? undefined : ok.reason).toBe(true);
  if (ok.parity) {
    // C/D/E 恒带七工具:工具面结构性 + 继承传输面结构性全触齐
    expect(ok.firedCategories).toEqual([
      "STREAM_FLAG",
      "STREAM_OPTIONS",
      "ASSISTANT_REASONING_CONTENT",
      "TOOL_STRICT_FLAG",
      "TOOL_CHOICE_ABSENT",
    ]);
  }

  // 无工具请求(结构性工具类别无触发面)→ 死登记检查红:强制登记项「必须」在场
  const noTool = compareSemanticRecord(
    [dshWire({ messages: [{ role: "assistant", content: "x" }, { role: "user", content: "u" }] })],
    [piWire({ messages: [{ role: "assistant", content: "x", reasoning_content: "" }, { role: "user", content: "u" }] })],
  );
  expect(noTool.parity).toBe(false);
  if (!noTool.parity) {
    expect(noTool.reason).toContain("dead registration");
  }
});

test("请求计数不等 → drift", () => {
  const result = compareSemanticRecord([dshWire({}), dshWire({})], [piWire({})]);
  expect(result.parity).toBe(false);
  if (!result.parity) {
    expect(result.reason).toContain("request count differs");
  }
});

test("工具方言登记清单冻结:四类别 + 触发面口径", () => {
  expect(REGISTERED_TOOL_DIFFERENCES.map((entry) => entry.category)).toEqual([
    "TOOL_STRICT_FLAG",
    "TOOL_CHOICE_ABSENT",
    "TOOL_CALL_ARGUMENTS_RESERIALIZATION",
    "TOOL_ARGUMENT_VALIDATION",
  ]);
  const byScope = new Map(REGISTERED_TOOL_DIFFERENCES.map((entry) => [entry.category, entry.firingScope] as const));
  expect(byScope.get("TOOL_STRICT_FLAG")).toBe("wire-structural");
  expect(byScope.get("TOOL_CHOICE_ABSENT")).toBe("wire-structural");
  expect(byScope.get("TOOL_CALL_ARGUMENTS_RESERIALIZATION")).toBe("wire-data-conditional");
  expect(byScope.get("TOOL_ARGUMENT_VALIDATION")).toBe("behavioral");
  // 登记依据非空(显式决策记录)
  for (const entry of REGISTERED_TOOL_DIFFERENCES) {
    expect(entry.rationale.length).toBeGreaterThan(20);
  }
});
