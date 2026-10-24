/**
 * #22 S1 protocol：JSON-RPC 2.0 信封、错误码、参数校验（spec #21 §4/§5、
 * ADR-0012 决策 1）。与 pi 的 `{type,id,command,...}` 信封不同——本仓用标准
 * JSON-RPC 2.0 以与 HTTP 线共享方法契约（stdio 为其子集）。
 * #27 v2：submit 参数切统一 ReviewRequest（ADR-0013 决策 3——diff 判别联合、
 * repoPath 可省、clientRequestId/metadata 可选、无 v1 旧扁平形 alias）。
 */

import { expect, test } from "vitest";

import {
  JSON_RPC_ERROR,
  errorResponse,
  eventNotification,
  parseIncomingLine,
  successResponse,
  validateCancelParams,
  validateGetParams,
  validateListParams,
  validateReviewRequest,
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

test("validateReviewRequest：合法参数 → ok（统一形：diff 判别联合、repoPath 可省、clientRequestId/metadata 可选）", () => {
  // repoPath 省略 + inline diff（最小统一形；repoPath 缺省由形态面承担：stdio=--cwd、HTTP=必填）
  expect(
    validateReviewRequest({
      caseId: "VUL4J-1",
      diff: { kind: "inline", text: "--- a\n+++ b\n" },
      configId: "E",
    }),
  ).toEqual({
    ok: true,
    value: {
      caseId: "VUL4J-1",
      diff: { kind: "inline", text: "--- a\n+++ b\n" },
      configId: "E",
    },
  });
  // 全字段形态：repoPath 扁平字符串 + file diff + 可选四件
  expect(
    validateReviewRequest({
      clientRequestId: "mr-12345-rev-1",
      caseId: "VUL4J-1",
      repoPath: ".cache/datasets/vul4j-repos/VUL4J-1-f5903fa564",
      diff: { kind: "file", path: "/srv/diffs/VUL4J-1.diff" },
      issueDescription: "内存安全",
      configId: "A",
      modelId: "deepseek-v4-flash",
      metadata: { project: "platform-x", mr: 12345 },
    }),
  ).toEqual({
    ok: true,
    value: {
      clientRequestId: "mr-12345-rev-1",
      caseId: "VUL4J-1",
      repoPath: ".cache/datasets/vul4j-repos/VUL4J-1-f5903fa564",
      diff: { kind: "file", path: "/srv/diffs/VUL4J-1.diff" },
      issueDescription: "内存安全",
      configId: "A",
      modelId: "deepseek-v4-flash",
      metadata: { project: "platform-x", mr: 12345 },
    },
  });
});

test("validateReviewRequest：违例族 → -32602（v1 旧扁平形拒绝、diff 联合违例、caseId/configId 越界）", () => {
  const valid = {
    caseId: "VUL4J-1",
    repoPath: "repo",
    diff: { kind: "inline", text: "d" },
    configId: "E",
  } as const;
  const violations: readonly (readonly [string, unknown])[] = [
    ["params 非对象", "not an object"],
    ["params 为数组", [valid]],
    ["缺 caseId", { ...valid, caseId: undefined }],
    ["caseId 空串", { ...valid, caseId: "" }],
    ["caseId 非 string", { ...valid, caseId: 1 }],
    ["caseId 超 256 字符", { ...valid, caseId: "a".repeat(257) }],
    ["caseId 含路径分隔符", { ...valid, caseId: "VUL4J/1" }],
    ["caseId 含反斜杠转义序列", { ...valid, caseId: "VUL4J\\1" }],
    ["caseId 为路径穿越段", { ...valid, caseId: ".." }],
    ["repoPath 空串（在场即必须非空）", { ...valid, repoPath: "" }],
    ["repoPath 非 string", { ...valid, repoPath: 5 }],
    ["缺 diff", { ...valid, diff: undefined }],
    ["v1 旧扁平形：diff 纯字符串（无 legacy alias，ADR-0013 决策 3）", { ...valid, diff: "--- a\n+++ b\n" }],
    ["diff 非 object", { ...valid, diff: 42 }],
    ["diff 缺 kind", { ...valid, diff: { text: "d" } }],
    ["diff kind 越界", { ...valid, diff: { kind: "url", url: "https://x" } }],
    ["inline 缺 text", { ...valid, diff: { kind: "inline" } }],
    ["inline text 空串", { ...valid, diff: { kind: "inline", text: "" } }],
    ["inline text 非 string", { ...valid, diff: { kind: "inline", text: 7 } }],
    ["file 缺 path", { ...valid, diff: { kind: "file" } }],
    ["file path 空串", { ...valid, diff: { kind: "file", path: "" } }],
    ["file path 非 string", { ...valid, diff: { kind: "file", path: false } }],
    ["缺 configId", { ...valid, configId: undefined }],
    ["configId 越界", { ...valid, configId: "F" }],
    ["configId 非 string", { ...valid, configId: 3 }],
    ["configId 原型链成员 toString", { ...valid, configId: "toString" }],
    ["configId 原型链成员 constructor", { ...valid, configId: "constructor" }],
    ["issueDescription 非 string", { ...valid, issueDescription: 7 }],
    ["modelId 非 string", { ...valid, modelId: true }],
    ["clientRequestId 空串", { ...valid, clientRequestId: "" }],
    ["clientRequestId 非 string", { ...valid, clientRequestId: 11 }],
    ["metadata 非 object", { ...valid, metadata: "x" }],
    ["metadata 为数组", { ...valid, metadata: [1, 2] }],
    ["metadata 为 null", { ...valid, metadata: null }],
  ];
  for (const [label, params] of violations) {
    const result = validateReviewRequest(params);
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

test("错误码表：-32012 repo_not_found 在场；-32003 保留不发射（ADR-0013 决策 9）", () => {
  expect(JSON_RPC_ERROR.REPO_NOT_FOUND).toBe(-32012);
  // -32003 repo_not_allowed：allowlist 随 --repo-root 移除而亡，常量保留防复用
  expect(JSON_RPC_ERROR.REPO_NOT_ALLOWED).toBe(-32003);
});
