import { expect, test } from "vitest";
import { REVIEW_MODEL_ID } from "../provider/pi-client.js";
import { parseCliArgs, USAGE_TEXT } from "./args.js";

// CLI 参数解析契约（#7 P3b，进程内主缝的第一层）：`review-pi review` 与
// `review-pi smoke` 两个子命令的 argv 用法面。形态对齐 DSH 线 args.ts
// （union 结果、不抛异常——用户输入错误是预期路径），pi 线差异：
// - 缺省 config = B（生产形态：零工具 + 确定性预取；DSH 线缺省 A）；
// - 无 --language 旗标（输出语言是 DSH 线后分家决策，pi 线自立 ADR 前不实装）；
// - smoke = P1b 双探针（无工具调用探针——config B 零工具，检视链不需要）。

test("空 argv 与未知子命令 → 用法错误（不抛异常）", () => {
  expect(parseCliArgs([])).toEqual({
    ok: false,
    message: "missing command (expected `review` or `smoke`)",
  });
  expect(parseCliArgs(["deploy"])).toEqual({
    ok: false,
    message: 'unknown command "deploy" (expected `review` or `smoke`)',
  });
});

test("review 最小 argv：必填旗标 + 全缺省（config B / out / model / issue）", () => {
  const parsed = parseCliArgs(["review", "--repo", "repo", "--mr", "case.diff"]);
  expect(parsed).toEqual({
    ok: true,
    command: "review",
    args: {
      repo: "repo",
      mr: "case.diff",
      caseId: "case",
      config: "B",
      issue: "",
      out: "review-pi-output",
      model: REVIEW_MODEL_ID,
    },
  });
});

test("caseId 派生：--mr 文件名去扩展名（含路径与无扩展名形态）", () => {
  const withPath = parseCliArgs(["review", "--repo", "r", "--mr", "a/b/VUL4J-1.diff"]);
  expect(withPath.ok && withPath.command === "review" && withPath.args.caseId).toBe("VUL4J-1");
  const noExtension = parseCliArgs(["review", "--repo", "r", "--mr", "diffs/mr-7"]);
  expect(noExtension.ok && noExtension.command === "review" && noExtension.args.caseId).toBe("mr-7");
  const doubleDot = parseCliArgs(["review", "--repo", "r", "--mr", "x/case.old.diff"]);
  expect(doubleDot.ok && doubleDot.command === "review" && doubleDot.args.caseId).toBe("case.old");
});

test("--config：A-E 全矩阵合法；非法值 → 用法错误并列出合法集", () => {
  for (const configId of ["A", "B", "C", "D", "E"] as const) {
    const parsed = parseCliArgs(["review", "--repo", "r", "--mr", "m.diff", "--config", configId]);
    expect(parsed.ok && parsed.command === "review" && parsed.args.config).toBe(configId);
  }
  const bad = parseCliArgs(["review", "--repo", "r", "--mr", "m.diff", "--config", "F"]);
  expect(bad).toEqual({
    ok: false,
    message: 'invalid --config "F": expected one of A, B, C, D, E',
  });
});

test("未知旗标 / 重复旗标 / 值缺席（含值吞旗标）→ 用法错误", () => {
  expect(parseCliArgs(["review", "--repo", "r", "--mr", "m", "--language", "zh"])).toEqual({
    ok: false,
    message: 'unknown flag "--language"',
  });
  expect(parseCliArgs(["review", "--repo", "r", "--repo", "r2", "--mr", "m"])).toEqual({
    ok: false,
    message: "duplicate flag --repo",
  });
  expect(parseCliArgs(["review", "--repo"])).toEqual({
    ok: false,
    message: "flag --repo requires a value",
  });
  // 值以 -- 开头 = 相邻旗标被吞（如 `--issue --out x`）——fail fast 不静默
  expect(parseCliArgs(["review", "--repo", "r", "--mr", "m", "--issue", "--out", "x"])).toEqual({
    ok: false,
    message: "flag --issue requires a value",
  });
});

test("--model：缺省钉住的评审模型；自由 id 透传；空白 id 拒绝", () => {
  const free = parseCliArgs(["review", "--repo", "r", "--mr", "m", "--model", "custom-gateway-model"]);
  expect(free.ok && free.args.model).toBe("custom-gateway-model");
  const blank = parseCliArgs(["review", "--repo", "r", "--mr", "m", "--model", "  "]);
  expect(blank).toEqual({
    ok: false,
    message: 'invalid --model "  ": must be a non-empty model id (free ids accepted)',
  });
});

test("缺必填旗标：--repo / --mr", () => {
  expect(parseCliArgs(["review", "--mr", "m.diff"])).toEqual({
    ok: false,
    message: "missing required flag --repo",
  });
  expect(parseCliArgs(["review", "--repo", "r"])).toEqual({
    ok: false,
    message: "missing required flag --mr",
  });
});

test("smoke：窄旗标面（仅 --model）；review 专属旗标对 smoke 是未知旗标", () => {
  const smoke = parseCliArgs(["smoke"]);
  expect(smoke).toEqual({ ok: true, command: "smoke", args: { model: REVIEW_MODEL_ID } });
  const withModel = parseCliArgs(["smoke", "--model", "probe-model"]);
  expect(withModel).toEqual({ ok: true, command: "smoke", args: { model: "probe-model" } });
  expect(parseCliArgs(["smoke", "--repo", "r"])).toEqual({
    ok: false,
    message: 'unknown flag "--repo"',
  });
});

test("USAGE_TEXT：宣告两个子命令（stderr 错误路径同款文案，单一来源）", () => {
  expect(USAGE_TEXT).toContain("review-pi review --repo");
  expect(USAGE_TEXT).toContain("review-pi smoke");
});
