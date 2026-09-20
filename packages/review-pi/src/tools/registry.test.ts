import { expect, test } from "vitest";
import type { ToolSchema } from "../contracts/llm.js";
import { goldenFixture } from "../testing/golden.js";
import { REVIEW_TOOL_ORDER, fromWireToolName, reviewToolSchemas, toWireToolName } from "./registry.js";

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
