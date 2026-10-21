/**
 * #22 S1 protocol：JSON-RPC 2.0 信封、错误码、参数校验（spec #21 §4/§5、
 * ADR-0012 决策 1）。与 pi 的 `{type,id,command,...}` 信封不同——本仓用标准
 * JSON-RPC 2.0 以与 HTTP 线共享方法契约（stdio v1 为其子集）。
 */

import { expect, test } from "vitest";

import {
  errorResponse,
  eventNotification,
  parseIncomingLine,
  successResponse,
  validateCancelParams,
  validateGetParams,
  validateListParams,
  validateSubmitParams,
  type ParsedIncomingError,
  type JsonRpcId,
} from "./protocol.js";

const invalidRequest = (id: JsonRpcId): ParsedIncomingError => ({
  kind: "error",
  id,
  error: { code: -32600, message: "Invalid Request" },
});

test("parseIncomingLine：合法请求行 → request（id/method/params 原样保留）", () => {
  expect(
    parseIncomingLine('{"jsonrpc":"2.0","id":"2","method":"review.get","params":{"jobId":"job-1"}}'),
  ).toEqual({
    kind: "request",
    id: "2",
    method: "review.get",
    params: { jobId: "job-1" },
  });
});

test("parseIncomingLine：非法 JSON → -32700 且 id:null（无 id 可提取）", () => {
  expect(parseIncomingLine("{not json")).toEqual({
    kind: "error",
    id: null,
    error: { code: -32700, message: "Parse error" },
  });
});

test("parseIncomingLine：信封违例族 → -32600（id 可提取则回显，否则 null）", () => {
  // batch（数组信封）→ 无 id 可提取
  expect(parseIncomingLine('[{"jsonrpc":"2.0","id":1,"method":"review.get"}]')).toEqual(
    invalidRequest(null),
  );
  // 标量 / null / 非对象
  expect(parseIncomingLine('"ping"')).toEqual(invalidRequest(null));
  expect(parseIncomingLine("123")).toEqual(invalidRequest(null));
  expect(parseIncomingLine("null")).toEqual(invalidRequest(null));
  // 版本错（id 可提取 → 回显）
  expect(parseIncomingLine('{"jsonrpc":"1.0","id":7,"method":"review.get"}')).toEqual(
    invalidRequest(7),
  );
  // method 缺失 / 非 string
  expect(parseIncomingLine('{"jsonrpc":"2.0","id":7}')).toEqual(invalidRequest(7));
  expect(parseIncomingLine('{"jsonrpc":"2.0","id":7,"method":123}')).toEqual(invalidRequest(7));
  // 缺 id：本方法集不支持通知，全部请求必须带 id
  expect(parseIncomingLine('{"jsonrpc":"2.0","method":"review.get"}')).toEqual(
    invalidRequest(null),
  );
  // id 类型非法（非 string/number/null）
  expect(parseIncomingLine('{"jsonrpc":"2.0","id":{"x":1},"method":"review.get"}')).toEqual(
    invalidRequest(null),
  );
  expect(parseIncomingLine('{"jsonrpc":"2.0","id":true,"method":"review.get"}')).toEqual(
    invalidRequest(null),
  );
  // params 形态非法（JSON-RPC 规范：params 必须为 object/array；数组放行由方法层校验）
  expect(parseIncomingLine('{"jsonrpc":"2.0","id":7,"method":"review.get","params":"x"}')).toEqual(
    invalidRequest(7),
  );
});

test("validateSubmitParams：合法参数 → ok（issueDescription/modelId 可选，configId A–E）", () => {
  expect(
    validateSubmitParams({
      caseId: "VUL4J-1",
      repoPath: ".cache/datasets/vul4j-repos/VUL4J-1-f5903fa564",
      diff: "--- a\n+++ b\n",
      configId: "E",
    }),
  ).toEqual({
    ok: true,
    value: {
      caseId: "VUL4J-1",
      repoPath: ".cache/datasets/vul4j-repos/VUL4J-1-f5903fa564",
      diff: "--- a\n+++ b\n",
      configId: "E",
    },
  });
  expect(
    validateSubmitParams({
      caseId: "VUL4J-1",
      repoPath: "repo",
      diff: "d",
      issueDescription: "内存安全",
      modelId: "deepseek-v4-flash",
      configId: "A",
    }),
  ).toEqual({
    ok: true,
    value: {
      caseId: "VUL4J-1",
      repoPath: "repo",
      diff: "d",
      issueDescription: "内存安全",
      modelId: "deepseek-v4-flash",
      configId: "A",
    },
  });
});

test("validateSubmitParams：违例族 → -32602（缺字段/空串/类型错/configId 越界/params 非对象）", () => {
  const valid = {
    caseId: "VUL4J-1",
    repoPath: "repo",
    diff: "d",
    configId: "E",
  };
  const violations: readonly (readonly [string, unknown])[] = [
    ["params 非对象", "not an object"],
    ["params 为数组", [valid]],
    ["缺 caseId", { ...valid, caseId: undefined }],
    ["caseId 空串", { ...valid, caseId: "" }],
    ["caseId 非 string", { ...valid, caseId: 1 }],
    ["缺 repoPath", { ...valid, repoPath: undefined }],
    ["缺 diff", { ...valid, diff: undefined }],
    ["diff 空 string", { ...valid, diff: "" }],
    ["缺 configId", { ...valid, configId: undefined }],
    ["configId 越界", { ...valid, configId: "F" }],
    ["configId 非 string", { ...valid, configId: 3 }],
    ["configId 原型链成员 toString", { ...valid, configId: "toString" }],
    ["configId 原型链成员 constructor", { ...valid, configId: "constructor" }],
    ["caseId 超 256 字符", { ...valid, caseId: "a".repeat(257) }],
    ["caseId 含路径分隔符", { ...valid, caseId: "VUL4J/1" }],
    ["caseId 含反斜杠转义序列", { ...valid, caseId: "VUL4J\\1" }],
    ["caseId 为路径穿越段", { ...valid, caseId: ".." }],
    ["issueDescription 非 string", { ...valid, issueDescription: 7 }],
    ["modelId 非 string", { ...valid, modelId: true }],
  ];
  for (const [label, params] of violations) {
    const result = validateSubmitParams(params);
    expect(result.ok, label).toBe(false);
    if (!result.ok) {
      expect(result.error.code, label).toBe(-32602);
    }
  }
});

test("validateGetParams/validateCancelParams：jobId 必填非空 string → 否则 -32602", () => {
  expect(validateGetParams({ jobId: "job-1761020800000-1" })).toEqual({
    ok: true,
    value: { jobId: "job-1761020800000-1" },
  });
  expect(validateCancelParams({ jobId: "job-1" })).toEqual({
    ok: true,
    value: { jobId: "job-1" },
  });
  for (const [label, params] of [
    ["非对象", "x"],
    ["数组", ["job-1"]],
    ["缺 jobId", {}],
    ["jobId 空串", { jobId: "" }],
    ["jobId 非 string", { jobId: 9 }],
  ] as const) {
    expect(validateGetParams(params).ok, `get ${label}`).toBe(false);
    expect(validateCancelParams(params).ok, `cancel ${label}`).toBe(false);
    const result = validateGetParams(params);
    if (!result.ok) {
      expect(result.error.code).toBe(-32602);
    }
  }
});

test("validateListParams：无参/合法 status → ok；非法 status → -32602", () => {
  expect(validateListParams(undefined)).toEqual({ ok: true, value: {} });
  expect(validateListParams({})).toEqual({ ok: true, value: {} });
  expect(validateListParams({ status: "running" })).toEqual({
    ok: true,
    value: { status: "running" },
  });
  for (const [label, params] of [
    ["非对象", "x"],
    ["status 非法值", { status: "exploded" }],
    ["status 非 string", { status: 1 }],
  ] as const) {
    const result = validateListParams(params);
    expect(result.ok, label).toBe(false);
    if (!result.ok) {
      expect(result.error.code, label).toBe(-32602);
    }
  }
});

test("响应构造器：success/error/event 形状（data 缺席省键、id 原样回显）", () => {
  expect(successResponse("req-1", { status: "queued" })).toEqual({
    jsonrpc: "2.0",
    id: "req-1",
    result: { status: "queued" },
  });
  // 无 data：error 对象不含 data 键（缺席省键，与内核审计纪律同款）
  expect(errorResponse(7, -32001, "Unknown job: job-x")).toEqual({
    jsonrpc: "2.0",
    id: 7,
    error: { code: -32001, message: "Unknown job: job-x" },
  });
  // 有 data：安全细节随行（jobId/limit 类，不放路径与 key）
  expect(errorResponse(7, -32004, "diff too large", { maxDiffBytes: 8_388_608 })).toEqual({
    jsonrpc: "2.0",
    id: 7,
    error: { code: -32004, message: "diff too large", data: { maxDiffBytes: 8_388_608 } },
  });
  expect(eventNotification({ seq: 3, job: { jobId: "job-1" } })).toEqual({
    jsonrpc: "2.0",
    method: "review.event",
    params: { seq: 3, job: { jobId: "job-1" } },
  });
});
