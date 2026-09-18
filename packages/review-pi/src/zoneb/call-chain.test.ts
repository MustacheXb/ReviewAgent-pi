import { expect, test } from "vitest";
import { repoFixturePath } from "../testing/repos.js";
import { loadRepoContext } from "./repo-context.js";
import { buildCallChainBlocks } from "./call-chain.js";
import type { ChangedSymbolRef } from "./changed-symbols.js";
import type { JavaSymbol } from "./symbols.js";

// Call Chain 层（测量常量面）：名字级引用链降级形态——
// hop 1 变更方法的引用点、hop 2 引用者方法的引用点、callee hop 1 方法体内调用点。

const SAMPLE = repoFixturePath("sample");
const BETA_FILE = "src/main/java/com/example/Beta.java";

function methodRef(name: string, line: number, endLine: number, typeName: string): ChangedSymbolRef {
  return {
    file: BETA_FILE,
    typeName,
    symbol: {
      kind: "method",
      name,
      line,
      endLine,
      modifiers: ["public"],
      returnType: "int",
      params: "()",
      members: [],
    } as JavaSymbol,
  };
}

test("buildCallChainBlocks：无引用者的方法（combine）——callers 为空、callee 列体内调用", async () => {
  const repo = await loadRepoContext(SAMPLE);
  const blocks = await buildCallChainBlocks(repo, [methodRef("combine", 5, 8, "Beta")]);
  expect(blocks).toEqual([
    [
      "Beta.combine - method at src/main/java/com/example/Beta.java:5",
      "  Callers (hop 1):",
      "    (none)",
      "  Callers (hop 2):",
      "    (no method-level callers identified at hop 1)",
      "  Callees (hop 1):",
      "    getBase - src/main/java/com/example/Beta.java:6",
      "    scale - src/main/java/com/example/Beta.java:7",
    ],
  ]);
});

test("buildCallChainBlocks：有引用者的方法（scale）——hop 1 引用者、hop 2 引用者的引用者", async () => {
  const repo = await loadRepoContext(SAMPLE);
  const blocks = await buildCallChainBlocks(repo, [methodRef("scale", 10, 13, "Beta")]);
  expect(blocks).toEqual([
    [
      "Beta.scale - method at src/main/java/com/example/Beta.java:10",
      "  Callers (hop 1):",
      "    Beta.combine - src/main/java/com/example/Beta.java:7",
      '  Callers of "combine" (hop 2):',
      "    (none)",
      "  Callees (hop 1):",
      "    Alpha - src/main/java/com/example/Beta.java:11",
      "    doubled - src/main/java/com/example/Beta.java:12",
    ],
  ]);
});

test("buildCallChainBlocks：多方法主体按入参顺序各产一块", async () => {
  const repo = await loadRepoContext(SAMPLE);
  const blocks = await buildCallChainBlocks(repo, [
    methodRef("combine", 5, 8, "Beta"),
    methodRef("scale", 10, 13, "Beta"),
  ]);
  expect(blocks).toHaveLength(2);
  expect(blocks[0]?.[0]).toBe("Beta.combine - method at src/main/java/com/example/Beta.java:5");
  expect(blocks[1]?.[0]).toBe("Beta.scale - method at src/main/java/com/example/Beta.java:10");
});
