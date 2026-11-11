import { describe, expect, it } from "vitest";
import {
  DEFAULT_BOOTSTRAP_OPTIONS,
  bootstrapGeometricMeanCI,
  bootstrapMeanCI,
} from "../../src/eval/l2/bootstrap.js";

/**
 * 配对 bootstrap seam（#41）：固定种子、确定性、常数序列退化到点区间。
 * 不测抽样分布细节——只测「可复现 + 不变量」契约。
 */

const options = DEFAULT_BOOTSTRAP_OPTIONS;

describe("bootstrapMeanCI", () => {
  it("常数序列退化到点区间", () => {
    expect(bootstrapMeanCI([5, 5, 5, 5], options)).toEqual([5, 5]);
  });

  it("同一输入 + 同一种子 → 逐位一致（可复现）", () => {
    const values = [1, 2, 3, 4, 5, 6];
    expect(bootstrapMeanCI(values, options)).toEqual(bootstrapMeanCI(values, options));
  });

  it("CI 包含观测均值，且下界 ≤ 上界", () => {
    const ci = bootstrapMeanCI([1, 2, 3, 4, 5], options);
    expect(ci).not.toBeNull();
    const [lower, upper] = ci as readonly [number, number];
    expect(lower).toBeLessThan(3);
    expect(upper).toBeGreaterThan(3);
    expect(lower).toBeLessThanOrEqual(upper);
  });

  it("空输入 → null（N/A，不写 0）", () => {
    expect(bootstrapMeanCI([], options)).toBeNull();
  });
});

describe("bootstrapGeometricMeanCI", () => {
  it("比率全 1 时退化为 [1, 1]（相同臂不变量）", () => {
    expect(bootstrapGeometricMeanCI([1, 1, 1], options)).toEqual([1, 1]);
  });

  it("忽略非正 / 非有限值（比率只在正数域定义）", () => {
    expect(bootstrapGeometricMeanCI([0, -2, Number.NaN], options)).toBeNull();
    expect(bootstrapGeometricMeanCI([2, 2, 0], options)).toEqual([2, 2]);
  });

  it("[0.5, 2] 的 CI 落在正数比率域内", () => {
    const ci = bootstrapGeometricMeanCI([0.5, 2], options);
    expect(ci).not.toBeNull();
    const [lower, upper] = ci as readonly [number, number];
    expect(lower).toBeGreaterThan(0);
    expect(lower).toBeLessThanOrEqual(upper);
    expect(upper).toBeLessThanOrEqual(2);
  });
});
