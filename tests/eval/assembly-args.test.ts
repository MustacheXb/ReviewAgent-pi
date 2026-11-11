import { describe, expect, it } from "vitest";
import { extractValueFlag } from "../../src/eval/assembly/args.js";

describe("extractValueFlag — 入口局部 flag", () => {
  it("支持 --name value 形式并从 argv 摘除", () => {
    expect(extractValueFlag(["--campaign-id", "x", "--judge-model", "glm-5-3", "--reps", "2"], "--judge-model")).toEqual({
      argv: ["--campaign-id", "x", "--reps", "2"],
      value: "glm-5-3",
    });
  });

  it("支持 --name=value 形式", () => {
    expect(extractValueFlag(["--judge-model=glm-5-3", "--reps", "2"], "--judge-model")).toEqual({
      argv: ["--reps", "2"],
      value: "glm-5-3",
    });
  });

  it("未出现时 value = null，argv 原样", () => {
    expect(extractValueFlag(["--reps", "2"], "--judge-model")).toEqual({
      argv: ["--reps", "2"],
      value: null,
    });
  });

  it("缺值 / 重复给值 / 空内联值一律报错", () => {
    expect(() => extractValueFlag(["--judge-model"], "--judge-model")).toThrowError(/requires a value/);
    expect(() => extractValueFlag(["--judge-model", "--reps", "2"], "--judge-model")).toThrowError(
      /requires a value/,
    );
    expect(() =>
      extractValueFlag(["--judge-model", "a", "--judge-model=a"], "--judge-model"),
    ).toThrowError(/more than once/);
    expect(() => extractValueFlag(["--judge-model="], "--judge-model")).toThrowError(
      /requires a value/,
    );
    expect(() => extractValueFlag(["--judge-model", "  "], "--judge-model")).toThrowError(
      /non-empty/,
    );
  });
});
