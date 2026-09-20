import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { goldenFixture } from "../testing/golden.js";
import { VUL4J_1_SNAPSHOT } from "../testing/vul4j1-script.js";
import { buildReviewToolkit } from "../tools/toolkit.js";

// 七工具执行输出真源对齐门(#6 P3a,gate 档):t-series C/rep-1 审计
// toolCallLog 的真实执行条目(get_file / get_symbol / search_rule /
// search_history)在 pi 侧全仓扫描下逐字节复现——「schema 字节一致 +
// 执行输出字节一致」的执行面证据(语义等价的最强形态)。
//
// 重量级:VUL4J-1 快照 2035 Java 文件的符号索引扫描是墙钟大头(本机
// 分钟级),故入 gate 档(15 分钟超时)而非默认套件。快照缺席时显式
// skip 占位(vitest 对零测试文件判败);快照就位的本地实跑为准。

interface GoldenToolOutput {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly resultSummary: string;
}

const GOLDEN = JSON.parse(goldenFixture("tool-outputs-vul4j-1.json")) as GoldenToolOutput[];

test.skipIf(!existsSync(VUL4J_1_SNAPSHOT))(
  "VUL4J-1 真源对齐:四工具执行输出与 t-series 审计逐字节一致",
  async () => {
    const diff = goldenFixture("vul4j-1.diff");
    const tk = buildReviewToolkit({ repoPath: VUL4J_1_SNAPSHOT, diff });
    expect(GOLDEN).toHaveLength(4);
    for (const entry of GOLDEN) {
      const result = await tk.executeTool(entry.name, entry.arguments);
      // 逐字节对齐(含头部计数行——2035 Java files 的全仓扫描规模一致)
      expect(result, `tool ${entry.name} output must match t-series truth byte-for-byte`).toBe(
        entry.resultSummary,
      );
    }
  },
  15 * 60_000,
);
