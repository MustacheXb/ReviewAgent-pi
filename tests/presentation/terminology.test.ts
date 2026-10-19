import { describe, expect, it } from "vitest";
import { TERMINOLOGY, TERMINOLOGY_VERSION } from "../../src/presentation/terminology.js";

/**
 * 术语表单源测试（#13 / ADR-0010）：v1 最小集的不变量——版本号（进投影留痕）、
 * 条目形状（en/zh 非空）、en 侧无重复（引擎参考上下文的查表单源性）、骨架条目
 * 在场（CONTEXT.md Language 节域词的回归锚：Finding→检视结论、Evidence→证据、
 * severity 档位说明——票面指定的 v1 最小集形态）。
 *
 * 术语表是翻译引擎的参考上下文（非硬替换器，ADR-0010 Considered Options）；
 * 域词口径变更时递增 TERMINOLOGY_VERSION（投影留痕可追溯代际）。
 */

describe("terminology — 单源术语表（v1 最小集，CONTEXT.md Language 节域词）", () => {
  it("版本号为正整数（投影留痕携带；域词口径变更时递增）", () => {
    expect(Number.isInteger(TERMINOLOGY_VERSION)).toBe(true);
    expect(TERMINOLOGY_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("条目非空且 en/zh 均为非空字符串（note 可选，但在场必须非空）", () => {
    expect(TERMINOLOGY.length).toBeGreaterThan(0);
    for (const entry of TERMINOLOGY) {
      expect(entry.en.trim().length, `entry en must be non-empty: ${JSON.stringify(entry)}`).toBeGreaterThan(0);
      expect(entry.zh.trim().length, `entry zh must be non-empty: ${JSON.stringify(entry)}`).toBeGreaterThan(0);
      if (entry.note !== undefined) {
        expect(entry.note.trim().length, `entry note must be non-empty when present: ${JSON.stringify(entry)}`)
          .toBeGreaterThan(0);
      }
    }
  });

  it("en 侧键无重复（大小写归一——引擎参考上下文的查表单源性）", () => {
    const enKeys = TERMINOLOGY.map((entry) => entry.en.toLowerCase());
    expect(new Set(enKeys).size).toBe(enKeys.length);
  });

  it("v1 骨架条目在场：Finding→检视结论 / Evidence→证据 / Severity 严重级（含 P0–P3 档位说明）", () => {
    const byEn = new Map(TERMINOLOGY.map((entry) => [entry.en, entry]));
    expect(byEn.get("Finding")?.zh).toBe("检视结论");
    expect(byEn.get("Evidence")?.zh).toBe("证据");
    const severity = byEn.get("Severity");
    expect(severity?.zh).toBe("严重级");
    // 档位说明：P0–P3 代码属结构化字段不译 + 档位口径（票面指定的最小集内容）
    expect(severity?.note).toContain("P0");
    expect(severity?.note).toContain("P3");
  });
});
