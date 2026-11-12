import path from "node:path";
import { describe, expect, it } from "vitest";
import { portableRepoPath } from "../../src/eval/campaign/paths.js";

/** 工件路径入库纪律（#42）：工作目录内绝对路径投影为相对路径。 */
describe("portableRepoPath", () => {
  it("工作目录内绝对路径 → 正斜杠相对路径", () => {
    expect(portableRepoPath(path.join(process.cwd(), "runs", "eval", "p1"))).toBe(
      "runs/eval/p1",
    );
  });

  it("工作目录外绝对路径 / 已是相对路径 → 原样保留", () => {
    const outside = path.join(process.cwd(), "..", "outside", "cases.json");
    expect(portableRepoPath(outside)).toBe(outside);
    expect(portableRepoPath("runs/eval/p1")).toBe("runs/eval/p1");
  });
});
