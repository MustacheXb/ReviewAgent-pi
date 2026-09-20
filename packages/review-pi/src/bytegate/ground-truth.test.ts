import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  discoverGateRecords,
  loadCaseInputs,
  loadWireTruth,
  SYNTHESIZED_TERMINAL_REPLY,
} from "./ground-truth.js";

// P2 字节纪律门(#5)——真源发现/加载缝单元测试(合成 fixture 树,CI 可跑;
// 真数据全量对照在 byte-gate.gate.ts,skipIf 数据缺席)。

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "bytegate-gt-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** DSH 线序列化方言基准 wireBody */
function dshWire(messages: unknown[]): string {
  return JSON.stringify({
    model: "deepseek-v4-flash",
    messages,
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    stream: false,
  });
}

/** 合成六请求审计(单轮;+2 不变量成立) */
function syntheticAudit(): { rounds: number; requests: { wireBody: string }[] } {
  const phase = (n: number) => `Phase ${n} instruction.`;
  let messages: unknown[] = [
    { role: "system", content: "SYS" },
    { role: "user", content: "MR" },
    { role: "user", content: phase(1) },
  ];
  const requests = [{ wireBody: dshWire(messages) }];
  for (let i = 2; i <= 6; i++) {
    messages = [
      ...messages,
      { role: "assistant", content: `REPLY-${i - 1}` },
      { role: "user", content: phase(i) },
    ];
    requests.push({ wireBody: dshWire(messages) });
  }
  return { rounds: 1, requests };
}

/** 合成一个实验树:runs/<exp>/runs/vul4j/<case>/{A,B}/rep-N.json + audit 真源 */
function buildTree(root: string): void {
  const audit = syntheticAudit();
  const auditDir = path.join(root, "phase2-dsh-t9", "audit", "vul4j", "CASE-1", "A", "rep-1", "audit");
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(path.join(auditDir, "run.json"), JSON.stringify(audit));

  const recordDir = path.join(root, "phase2-dsh-t9", "runs", "vul4j", "CASE-1", "A");
  mkdirSync(recordDir, { recursive: true });
  writeFileSync(
    path.join(recordDir, "rep-1.json"),
    JSON.stringify({
      source: "vul4j",
      caseId: "CASE-1",
      configId: "A",
      rep: 1,
      baseline: {
        // 记录体内是「别的仓库」的绝对路径——重定位按尾部锚定本树
        auditPath: path.join("D:", "elsewhere", "runs", "phase2-dsh-t9", "audit", "vul4j", "CASE-1", "A", "rep-1", "audit", "run.json"),
      },
    }),
  );
}

test("发现:实验树扫描 + auditPath 重定位 + 目录/记录字段交叉校验", () => {
  const root = tempRoot();
  buildTree(root);
  const refs = discoverGateRecords(root);
  expect(refs).toHaveLength(1);
  const ref = refs[0];
  expect(ref).toMatchObject({
    experimentId: "phase2-dsh-t9",
    caseId: "CASE-1",
    configId: "A",
    rep: 1,
  });
  expect(ref.auditPath).toBe(
    path.join(root, "phase2-dsh-t9", "audit", "vul4j", "CASE-1", "A", "rep-1", "audit", "run.json"),
  );
  expect(existsSync(ref.auditPath)).toBe(true);
});

test("发现:只认 phase2-dsh-t<N> 实验、A/B 配置、rep-N 记录(其余目录忽略)", () => {
  const root = tempRoot();
  buildTree(root);
  // 非实验目录(phase2-main 等)与 C/D/E 配置不进真源集
  mkdirSync(path.join(root, "phase2-main", "runs", "vul4j", "CASE-1", "A"), { recursive: true });
  writeFileSync(path.join(root, "phase2-main", "runs", "vul4j", "CASE-1", "A", "rep-1.json"), "{}");
  mkdirSync(path.join(root, "phase2-dsh-t9", "runs", "vul4j", "CASE-1", "C"), { recursive: true });
  writeFileSync(path.join(root, "phase2-dsh-t9", "runs", "vul4j", "CASE-1", "C", "rep-1.json"), "{}");
  const refs = discoverGateRecords(root);
  expect(refs.map((r) => r.configId)).toEqual(["A"]);
});

test("发现:记录字段与目录错位(caseId/configId/rep)→ 抛", () => {
  const root = tempRoot();
  const recordDir = path.join(root, "phase2-dsh-t1", "runs", "vul4j", "CASE-X", "B");
  mkdirSync(recordDir, { recursive: true });
  writeFileSync(
    path.join(recordDir, "rep-2.json"),
    JSON.stringify({
      caseId: "CASE-X",
      configId: "A", // 目录是 B
      rep: 2,
      baseline: { auditPath: "D:\\x\\runs\\phase2-dsh-t1\\audit\\x.json" },
    }),
  );
  expect(() => discoverGateRecords(root)).toThrow(/configId/);
});

test("发现:记录缺 baseline.auditPath → 抛(真源损坏 fail fast)", () => {
  const root = tempRoot();
  const recordDir = path.join(root, "phase2-dsh-t1", "runs", "vul4j", "CASE-X", "A");
  mkdirSync(recordDir, { recursive: true });
  writeFileSync(
    path.join(recordDir, "rep-1.json"),
    JSON.stringify({ caseId: "CASE-X", configId: "A", rep: 1, baseline: {} }),
  );
  expect(() => discoverGateRecords(root)).toThrow(/auditPath/);
});

test("案输入:target-cases.json → Map(caseId → repoPath/diff/issueDescription)", () => {
  const root = tempRoot();
  mkdirSync(path.join(root, "data", "vul4j"), { recursive: true });
  writeFileSync(
    path.join(root, "data", "vul4j", "target-cases.json"),
    JSON.stringify([
      {
        caseId: "CASE-1",
        repoPath: ".cache/datasets/vul4j-repos/CASE-1-abc",
        diff: "--- a\n+++ b\n",
        issueDescription: "issue text",
      },
      { caseId: "CASE-2", repoPath: "r", diff: "d", issueDescription: "i", truth: {} },
    ]),
  );
  const inputs = loadCaseInputs(root);
  expect(inputs.size).toBe(2);
  expect(inputs.get("CASE-1")).toEqual({
    caseId: "CASE-1",
    repoPath: ".cache/datasets/vul4j-repos/CASE-1-abc",
    diff: "--- a\n+++ b\n",
    issueDescription: "issue text",
  });
  // 缺字段 → 抛
  writeFileSync(
    path.join(root, "data", "vul4j", "target-cases.json"),
    JSON.stringify([{ caseId: "CASE-3" }]),
  );
  expect(() => loadCaseInputs(root)).toThrow(/CASE-3/);
});

test("真源加载:wireBodies + 回放协议(5 真回复 + 合成终局)", () => {
  const root = tempRoot();
  const auditDir = path.join(root, "audit");
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(path.join(auditDir, "run.json"), JSON.stringify(syntheticAudit()));
  const truth = loadWireTruth(path.join(auditDir, "run.json"));
  expect(truth.wireBodies).toHaveLength(6);
  expect(truth.replies).toEqual([
    "REPLY-1",
    "REPLY-2",
    "REPLY-3",
    "REPLY-4",
    "REPLY-5",
    SYNTHESIZED_TERMINAL_REPLY,
  ]);
});

test("真源加载:请求数 ≠ rounds×6 → 抛", () => {
  const root = tempRoot();
  const audit = syntheticAudit();
  audit.requests = audit.requests.slice(0, 4);
  const auditDir = path.join(root, "audit");
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(path.join(auditDir, "run.json"), JSON.stringify(audit));
  expect(() => loadWireTruth(path.join(auditDir, "run.json"))).toThrow(/rounds/);
});

test("真源加载:+2 不变量破坏(assistant 不在 -2 位)→ 抛", () => {
  const root = tempRoot();
  const audit = syntheticAudit();
  const wire1 = JSON.parse(audit.requests[1].wireBody);
  wire1.messages.splice(-2, 1, { role: "user", content: "not assistant" });
  audit.requests[1].wireBody = JSON.stringify(wire1);
  const auditDir = path.join(root, "audit");
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(path.join(auditDir, "run.json"), JSON.stringify(audit));
  expect(() => loadWireTruth(path.join(auditDir, "run.json"))).toThrow(/assistant/);
});

test("真源加载:DSH 空回复(content:null)→ 重放脚本以空串占位(append-only 保持)", () => {
  const root = tempRoot();
  const audit = syntheticAudit();
  // 第 4 条回复置空:DSH 序列化为 content:null;后续请求按 append-only
  // 携带同一 null 形状(t2/VUL4J-79/B/rep-2 实证形态)
  for (const request of audit.requests.slice(4)) {
    const wire = JSON.parse(request.wireBody) as { messages: { role: string; content: unknown }[] };
    for (const message of wire.messages) {
      if (message.role === "assistant" && message.content === "REPLY-4") {
        message.content = null;
      }
    }
    request.wireBody = JSON.stringify(wire);
  }
  const auditDir = path.join(root, "audit");
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(path.join(auditDir, "run.json"), JSON.stringify(audit));
  const truth = loadWireTruth(path.join(auditDir, "run.json"));
  expect(truth.replies).toEqual([
    "REPLY-1",
    "REPLY-2",
    "REPLY-3",
    "",
    "REPLY-5",
    SYNTHESIZED_TERMINAL_REPLY,
  ]);
});

test("真源加载:assistant content 非 string 非 null(如数组)→ 抛(方言外形状 fail fast)", () => {
  const root = tempRoot();
  const audit = syntheticAudit();
  const wire1 = JSON.parse(audit.requests[1].wireBody) as { messages: { role: string; content: unknown }[] };
  wire1.messages[wire1.messages.length - 2].content = [{ type: "text", text: "R" }];
  audit.requests[1].wireBody = JSON.stringify(wire1);
  const auditDir = path.join(root, "audit");
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(path.join(auditDir, "run.json"), JSON.stringify(audit));
  expect(() => loadWireTruth(path.join(auditDir, "run.json"))).toThrow(/content/);
});

test("合成终局回复:verdicts 空 + complete true(循环终止,不进任何请求)", () => {
  expect(SYNTHESIZED_TERMINAL_REPLY).toBe('{"verdicts":[],"complete":true}');
  const parsed = JSON.parse(SYNTHESIZED_TERMINAL_REPLY) as { verdicts: unknown[]; complete: boolean };
  expect(parsed.verdicts).toEqual([]);
  expect(parsed.complete).toBe(true);
});
