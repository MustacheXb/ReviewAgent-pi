import { expect, test } from "vitest";
import type { ToolSchema } from "../contracts/llm.js";
import type { ToolProfile } from "../contracts/tool-profile.js";
import { goldenFixture } from "../testing/golden.js";
import {
  REVIEW_TOOL_ORDER,
  deriveToolProfile,
  fromWireToolName,
  reviewToolSchemas,
  reviewToolSchemasForProfile,
  toWireToolName,
  toolNamesForProfile,
} from "./registry.js";

// 七工具 schema 注册表（#6 P3a）：与 DSH 线逐字节一致（schema 字节一致口径）。
// 真源 = t-series C/rep-1 审计 requests[0].tools（点分名 + parametersJson
// canonical 键序字节串）；wire 真源 = requests[0].wireBody 的 tools 数组
//（下划线名 + parameters 对象）。
//
// canonical 键序（DSH 线 toCanonicalJson）：type → properties → required →
// additionalProperties；properties 子键字典序。pi 侧以字面键序构造达成同字节，
// 本测试对真源逐字节把守——字面序写错即红。

const DSH_TOOLS = JSON.parse(goldenFixture("review-tools-dsh.json")) as ToolSchema[];
const DSH_WIRE_TOOLS = (
  JSON.parse(goldenFixture("review-tools-wire-dsh.json")) as {
    function: { name: string; description: string; parameters: object };
  }[]
).map((tool) => tool.function);

// #52：core-5 真源 = extended-7 DSH 真源的共享子集（单工具字节不变）
const CORE5_TOOLS = JSON.parse(goldenFixture("review-tools-core5.json")) as ToolSchema[];
const CORE5_WIRE_TOOLS = (
  JSON.parse(goldenFixture("review-tools-wire-core5.json")) as {
    function: { name: string; description: string; parameters: object };
  }[]
).map((tool) => tool.function);

const RULE_ENTRY = { id: "R-1", title: "Rule", text: "rule body" } as const;
const HISTORY_ENTRY = { id: "H-1", title: "History", text: "history body" } as const;

test("REVIEW_TOOL_ORDER = DSH 审计工具序（七工具固定顺序）", () => {
  expect([...REVIEW_TOOL_ORDER]).toEqual(DSH_TOOLS.map((tool) => tool.name));
});

test("七工具 schema 与 DSH 真源逐字节一致（name/description/parametersJson）", () => {
  const schemas = reviewToolSchemas();
  expect(schemas).toHaveLength(7);
  for (let index = 0; index < DSH_TOOLS.length; index++) {
    const truth = DSH_TOOLS[index] as ToolSchema;
    const schema = schemas[index] as ToolSchema;
    expect(schema.name).toBe(truth.name);
    expect(schema.description).toBe(truth.description);
    // parametersJson 逐字节（canonical 键序 + 紧凑序列化）
    expect(schema.parametersJson).toBe(truth.parametersJson);
  }
});

test("parametersJson 为 canonical 键序（type 首位、additionalProperties 末位、properties 字典序）", () => {
  for (const schema of reviewToolSchemas()) {
    const parsed = JSON.parse(schema.parametersJson) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    expect(keys).toEqual(["type", "properties", "required", "additionalProperties"]);
    expect(keys[0]).toBe("type");
    const properties = Object.keys(parsed["properties"] as object);
    expect([...properties].sort()).toEqual(properties);
    // 字节串与再序列化往返一致（无转义/空格残留）
    expect(JSON.stringify(parsed)).toBe(schema.parametersJson);
  }
});

test("wire 名映射：点分（审计口径）↔ 下划线（pi-ai/wire 口径）双向一致", () => {
  for (const schema of reviewToolSchemas()) {
    const wireName = toWireToolName(schema.name);
    expect(wireName).toBe(schema.name.replaceAll(".", "_"));
    expect(fromWireToolName(wireName)).toBe(schema.name);
  }
  // 与 wire 真源名序对齐
  expect(reviewToolSchemas().map((tool) => toWireToolName(tool.name))).toEqual(
    DSH_WIRE_TOOLS.map((tool) => tool.name),
  );
});

test("pi-ai Tool 定义（name/description/parameters）与 wire 真源 function 值字节一致", () => {
  const definitions = reviewToolSchemas().map((schema) => ({
    name: toWireToolName(schema.name),
    description: schema.description,
    parameters: JSON.parse(schema.parametersJson) as object,
  }));
  for (let index = 0; index < DSH_WIRE_TOOLS.length; index++) {
    const truth = DSH_WIRE_TOOLS[index] as { name: string; description: string; parameters: object };
    const definition = definitions[index] as { name: string; description: string; parameters: object };
    expect(definition.name).toBe(truth.name);
    expect(definition.description).toBe(truth.description);
    // parameters 对象序列化字节一致（键序保留 → pi-ai convertTools 原样上 wire）
    expect(JSON.stringify(definition.parameters)).toBe(JSON.stringify(truth.parameters));
  }
});

// #52 / ADR-0018 §3：Tool Profile 派生与注册表投影

test("profile 派生：无语料 / 仅 rule / 仅 history / 两者皆有", () => {
  expect(deriveToolProfile(undefined)).toBe("core-5");
  expect(deriveToolProfile({})).toBe("core-5");
  expect(deriveToolProfile({ rules: [] })).toBe("core-5");
  expect(deriveToolProfile({ history: [] })).toBe("core-5");
  expect(deriveToolProfile({ rules: [RULE_ENTRY] })).toBe("core-5+rule");
  expect(deriveToolProfile({ history: [HISTORY_ENTRY] })).toBe("core-5+history");
  expect(deriveToolProfile({ rules: [RULE_ENTRY], history: [HISTORY_ENTRY] })).toBe("extended-7");
});

test("profile 工具集：四档映射为注册表序的子序列", () => {
  const expected: Readonly<Record<ToolProfile, readonly string[]>> = {
    "core-5": [
      "review.get_diff",
      "review.get_symbol",
      "review.get_file",
      "review.find_references",
      "review.get_call_chain",
    ],
    "core-5+rule": [
      "review.get_diff",
      "review.get_symbol",
      "review.get_file",
      "review.find_references",
      "review.get_call_chain",
      "review.search_rule",
    ],
    "core-5+history": [
      "review.get_diff",
      "review.get_symbol",
      "review.get_file",
      "review.find_references",
      "review.get_call_chain",
      "review.search_history",
    ],
    "extended-7": [...REVIEW_TOOL_ORDER],
  };
  for (const profile of Object.keys(expected) as ToolProfile[]) {
    const names = toolNamesForProfile(profile);
    expect(names).toEqual(expected[profile]);
    // 子序列：按注册表序推进可达
    let cursor = 0;
    for (const name of names) {
      while (cursor < REVIEW_TOOL_ORDER.length && REVIEW_TOOL_ORDER[cursor] !== name) {
        cursor += 1;
      }
      expect(cursor).toBeLessThan(REVIEW_TOOL_ORDER.length);
      cursor += 1;
    }
  }
});

test("core-5 golden：与 extended-7 真源的共享子集逐字节一致（单工具字节不变）", () => {
  const schemas = reviewToolSchemasForProfile("core-5");
  expect(schemas).toEqual(CORE5_TOOLS);
  const extended = new Map(DSH_TOOLS.map((tool) => [tool.name, tool]));
  for (const schema of schemas) {
    expect(schema).toEqual(extended.get(schema.name));
  }
  const wireDefinitions = schemas.map((schema) => ({
    name: toWireToolName(schema.name),
    description: schema.description,
    parameters: JSON.parse(schema.parametersJson) as object,
  }));
  for (let index = 0; index < CORE5_WIRE_TOOLS.length; index++) {
    expect(JSON.stringify(wireDefinitions[index])).toBe(JSON.stringify(CORE5_WIRE_TOOLS[index]));
  }
});

test("repeated assembly：同一 profile 重复组装字节稳定，extended-7 = 七工具真源", () => {
  for (const profile of [
    "core-5",
    "core-5+rule",
    "core-5+history",
    "extended-7",
  ] as const) {
    const first = JSON.stringify(reviewToolSchemasForProfile(profile));
    const second = JSON.stringify(reviewToolSchemasForProfile(profile));
    expect(second).toBe(first);
    expect(reviewToolSchemasForProfile(profile).map((tool) => tool.name)).toEqual([
      ...toolNamesForProfile(profile),
    ]);
  }
  expect(JSON.stringify(reviewToolSchemasForProfile("extended-7"))).toBe(
    JSON.stringify(reviewToolSchemas()),
  );
});
