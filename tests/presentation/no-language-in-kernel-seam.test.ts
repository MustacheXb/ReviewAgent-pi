import { describe, expect, expectTypeOf, it } from "vitest";
import type { UnitReviewRequest } from "../../src/gate/review-kernel.js";

/**
 * 评测面语言回归断言（#13 AC3 / ADR-0010；#32 随评测装置删除修剪）：语言不进
 * 内核执行缝。检视产物恒英文由「无语言参数化缝」结构性保证——语言是呈现配置
 * （核外翻译投影，src/presentation/translate-projection.ts），不是检视输入
 * （与 ADR-0008 被测模型参数化同构的降级：模型该进请求参数，语言不该）。
 *
 * 双形态断言（形态互补，各执法一面）：
 * - 类型级守卫（expectTypeOf + pnpm typecheck 执法）：契约键面无 "language" /
 *   "lang"——有人往契约开语言缝时 typecheck 红；
 * - 实例级深键扫描（运行时执法）：真实形状的内核执行缝请求实例（含嵌套
 *   unit / mrCase / labels）JSON 化后递归收集全部键，/lang(uage)?/i 零命中
 *   ——防类型面之外的原始 JSON 旁路。
 *
 * 原 plan 半面（ExperimentPlan 无语言键）已随 experiment/plan.ts 删除
 * （#32 / ADR-0014）；缝半面保留——UnitReviewRequest 契约在生产线存续
 * （src/gate/review-kernel.ts，migration-gate 消费面）。
 */

/** 深键收集（数组穿透、对象递归；只判键不判值——语言参数化的形态是键） */
function collectKeysDeep(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeysDeep(item, into);
    }
    return into;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeysDeep(child, into);
    }
  }
  return into;
}

/** 语言参数化键判定（大小写不敏感；lang / language 两形） */
function languageKeys(keys: ReadonlySet<string>): string[] {
  return [...keys].filter((key) => /^lang(uage)?$/i.test(key));
}

/** 内核执行缝代表请求（#8 执行缝契约：装配侧 → 内核的全部输入，含嵌套 mrCase/labels） */
const KERNEL_SEAM_REQUEST: UnitReviewRequest = {
  unit: { source: "vul4j", caseId: "VUL4J-38", configId: "E", rep: 1 },
  mrCase: {
    caseId: "VUL4J-38",
    repoPath: "D:/fixtures/vul4j-repos/VUL4J-38",
    diff: "--- a/x.java\n+++ b/x.java\n@@ -1 +1 @@\n-old\n+new\n",
    issueDescription: "Vulnerability CVE-2014-4172 (CWE-74) in jasig/cas-client.",
    truth: null,
    labels: { source: "vul4j", riskClass: "Medium", allowedConfigs: ["A", "B", "C", "D", "E"] },
  },
  model: "deepseek-v4-flash",
  experimentRoot: "D:/fixtures/runs/lang-regression",
};

describe("内核执行缝无语言参数（检视面无缝——语言不进请求）", () => {
  it("类型级守卫：UnitReviewRequest 键面无 language / lang", () => {
    expectTypeOf<Extract<keyof UnitReviewRequest, "language" | "lang">>().toBeNever();
  });

  it("实例级深键扫描：代表请求（unit / mrCase / labels 全嵌套）无语言键", () => {
    const keys = collectKeysDeep(KERNEL_SEAM_REQUEST);
    // 扫描器健全性：嵌套对象确实被收集（mrCase / labels / unit）
    expect(keys.has("mrCase")).toBe(true);
    expect(keys.has("labels")).toBe(true);
    expect(keys.has("unit")).toBe(true);
    expect(languageKeys(keys)).toEqual([]);
  });
});
