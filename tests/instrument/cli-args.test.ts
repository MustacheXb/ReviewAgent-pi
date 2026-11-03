import { describe, expect, it } from "vitest";
import {
  applyListFlag,
  errorMessage,
  flagFail,
  flagOk,
  nextValue,
  parseCliArgs,
  parseList,
  splitFlag,
  type CliArgSpec,
  type ValueFlagParser,
} from "../../src/instrument/cli-args.js";

/**
 * CLI 参数解析共享骨架单测（experiment / reference 双 CLI 去重产物；两消费
 * CLI 已随研究线退役，#32 / ADR-0014——现存唯一值级消费者是
 * scripts/run-migration-gate.ts，框架行为在此直接锁定）。
 *
 * 锁定面（接缝 = parseCliArgs 公开解析协议 + 各导出纯函数）：
 * - 取值形式：--flag value 与 --flag=value 两形态等价；裸 --（pnpm 透传）
 *   跳过；布尔 flag 内联 =value 忽略（文档化历史行为）；
 * - 错误语义：--help requested / flag requires a value / unknown flag +
 *   usage 附文，消息跨 CLI 一致；
 * - 解析器与收尾错误原样透传（框架不做二次包装）；
 * - parseList 词表校验：空列表 / 未知项 / 重复项逐一报错（消息含允许清单）。
 */

interface GateValues {
  readonly model?: string;
  readonly reps: number;
  readonly verbose: boolean;
}

interface GateOptions {
  readonly model: string;
  readonly reps: number;
  readonly verbose: boolean;
}

const USAGE = "usage: gate --model <id> [--reps <n>] [--verbose]";

const parseReps: ValueFlagParser<GateValues> = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1
    ? flagOk({ reps: parsed })
    : flagFail(`--reps must be a positive integer (got ${JSON.stringify(value)})`);
};

const GATE_SPEC: CliArgSpec<GateValues, GateOptions> = {
  usage: USAGE,
  defaultValues: () => ({ reps: 1, verbose: false }),
  booleanFlags: { "--verbose": { verbose: true } },
  valueFlags: {
    "--model": (value) => flagOk({ model: value }),
    "--reps": parseReps,
  },
  finalize: (values, fail) =>
    values.model === undefined
      ? fail("--model is required")
      : { ok: true, options: { model: values.model, reps: values.reps, verbose: values.verbose } },
};

describe("CLI 参数解析共享骨架", () => {
  it("空格取值形态：--flag value 逐 flag 合并，缺省值兜底", () => {
    const result = parseCliArgs(["--model", "glm-5.3-flash", "--reps", "3"], GATE_SPEC);
    expect(result).toEqual({ ok: true, options: { model: "glm-5.3-flash", reps: 3, verbose: false } });
  });

  it("内联取值形态：--flag=value 与空格形态等价", () => {
    const result = parseCliArgs(["--model=glm-5.3-flash", "--reps=2"], GATE_SPEC);
    expect(result).toEqual({ ok: true, options: { model: "glm-5.3-flash", reps: 2, verbose: false } });
  });

  it("布尔 flag：命中即合并补丁，与值参数顺序无关", () => {
    const result = parseCliArgs(["--verbose", "--model", "glm-5.3-flash"], GATE_SPEC);
    expect(result).toEqual({ ok: true, options: { model: "glm-5.3-flash", reps: 1, verbose: true } });
  });

  it("布尔 flag 内联 =value 忽略不校验（文档化历史行为）", () => {
    const result = parseCliArgs(["--verbose=yes", "--model", "glm-5.3-flash"], GATE_SPEC);
    expect(result).toEqual({ ok: true, options: { model: "glm-5.3-flash", reps: 1, verbose: true } });
  });

  it("裸 --（pnpm run 透传形态）跳过：后续 flag 照常解析", () => {
    const result = parseCliArgs(["--", "--model", "glm-5.3-flash"], GATE_SPEC);
    expect(result).toEqual({ ok: true, options: { model: "glm-5.3-flash", reps: 1, verbose: false } });
  });

  it("--help / -h：--help requested + usage 附文", () => {
    for (const token of ["--help", "-h"]) {
      const result = parseCliArgs([token], GATE_SPEC);
      expect(result).toEqual({ ok: false, message: "--help requested", usage: USAGE });
    }
  });

  it("值参数缺值（argv 结尾）：flag requires a value", () => {
    const result = parseCliArgs(["--model"], GATE_SPEC);
    expect(result).toEqual({ ok: false, message: "flag --model requires a value", usage: USAGE });
  });

  it("值参数缺值（下一个 token 是 flag）：flag requires a value", () => {
    const result = parseCliArgs(["--model", "--verbose"], GATE_SPEC);
    expect(result).toEqual({ ok: false, message: "flag --model requires a value", usage: USAGE });
  });

  it("未知 flag：unknown flag 消息 + usage 附文", () => {
    const result = parseCliArgs(["--model", "m", "--bogus"], GATE_SPEC);
    expect(result).toEqual({
      ok: false,
      message: `unknown flag "--bogus"\n${USAGE}`,
      usage: USAGE,
    });
  });

  it("解析器报错原样透传（框架不二次包装）", () => {
    const result = parseCliArgs(["--reps", "0"], GATE_SPEC);
    expect(result).toEqual({
      ok: false,
      message: '--reps must be a positive integer (got "0")',
      usage: USAGE,
    });
  });

  it("收尾必填校验：finalize 的 fail 路径透传消息", () => {
    const result = parseCliArgs([], GATE_SPEC);
    expect(result).toEqual({ ok: false, message: "--model is required", usage: USAGE });
  });

  describe("nextValue / splitFlag 纯函数", () => {
    it("nextValue：内联值原样返回、只消费当前 token", () => {
      expect(nextValue(["--model=x", "--reps"], 0, "--model", "x")).toEqual({
        ok: true,
        value: "x",
        nextIndex: 1,
      });
    });

    it("nextValue：空格形式消费下一个 token", () => {
      expect(nextValue(["--model", "glm-5.3-flash", "--reps"], 0, "--model", undefined)).toEqual({
        ok: true,
        value: "glm-5.3-flash",
        nextIndex: 2,
      });
    });

    it("splitFlag：--name=value 拆双段；无 = 或非 -- 前缀整段为名", () => {
      expect(splitFlag("--model=x")).toEqual(["--model", "x"]);
      expect(splitFlag("--model")).toEqual(["--model", undefined]);
      expect(splitFlag("positional=x")).toEqual(["positional=x", undefined]);
    });
  });

  describe("parseList / applyListFlag 词表校验", () => {
    const SOURCES = ["defects4j", "vul4j", "msb-java", "clean-mr"] as const;

    it("合法逗号列表：trim 后收集，序保持", () => {
      expect(parseList(" vul4j , defects4j ", SOURCES, "source")).toEqual({
        ok: true,
        value: ["vul4j", "defects4j"],
      });
    });

    it("空列表（全空段）报错并回显原值", () => {
      const result = parseList(" , ", SOURCES, "source");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toBe('expected a comma list of source names (got " , ")');
      }
    });

    it("未知项报错且消息含允许清单", () => {
      const result = parseList("vul4j,bogus", SOURCES, "source");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toBe("unknown source name(s): bogus (allowed: defects4j, vul4j, msb-java, clean-mr)");
      }
    });

    it("重复项报错并回显原值", () => {
      const result = parseList("vul4j,vul4j", SOURCES, "source");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toBe('source list must not contain duplicates (got "vul4j,vul4j")');
      }
    });

    it("applyListFlag：合法列表经 assign 落补丁；错误消息原样透传", () => {
      const ok = applyListFlag("vul4j,defects4j", SOURCES, "source", (list) => ({ sources: list }));
      expect(ok).toEqual({ ok: true, patch: { sources: ["vul4j", "defects4j"] } });

      const bad = applyListFlag("bogus", SOURCES, "source", (list) => ({ sources: list }));
      expect(bad).toEqual({
        ok: false,
        message: "unknown source name(s): bogus (allowed: defects4j, vul4j, msb-java, clean-mr)",
      });
    });
  });

  it("errorMessage：Error 取 message，非 Error 字符串化", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});
