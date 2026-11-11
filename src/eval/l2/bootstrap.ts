/**
 * 配对 bootstrap（#41）：固定种子的确定性重采样，供 L2 配对统计使用。
 *
 * 口径（评测方案 §6.3）：分析单位 = case（先 case 内跨 rep 均值，再配对），
 * 10,000 次重采样、固定种子、95% 分位区间；比率用几何均值（正数域），
 * 差值用算术均值。结果只作区间估计——小样本（冒烟 10 case）不得据此夸大
 * 显著性（§6.3 样本量纪律）。
 */

/** bootstrap 参数（写入 L2 报告，保证复算口径可追溯） */
export interface BootstrapOptions {
  readonly iterations: number;
  readonly seed: number;
  /** 置信水平（0–1；95% → 0.95） */
  readonly confidence: number;
}

/** 缺省：10,000 次、固定种子、95%（评测方案 §6.3） */
export const DEFAULT_BOOTSTRAP_OPTIONS: BootstrapOptions = {
  iterations: 10_000,
  seed: 20_261_111,
  confidence: 0.95,
};

/**
 * 算术均值的百分位 CI；空输入 / 非有限值被忽略后为空 → null（N/A）。
 */
export function bootstrapMeanCI(
  values: readonly number[],
  options: BootstrapOptions = DEFAULT_BOOTSTRAP_OPTIONS,
): readonly [number, number] | null {
  return bootstrapCI(values, options, arithmeticMean);
}

/**
 * 几何均值的百分位 CI（比率域）；非正 / 非有限比率不参与（比率仅在正数域
 * 有定义）——全部被排除 → null（N/A）。
 */
export function bootstrapGeometricMeanCI(
  values: readonly number[],
  options: BootstrapOptions = DEFAULT_BOOTSTRAP_OPTIONS,
): readonly [number, number] | null {
  const positive = values.filter((value) => Number.isFinite(value) && value > 0);
  if (positive.length === 0) {
    return null;
  }
  return bootstrapCI(positive, options, geometricMean);
}

function bootstrapCI(
  values: readonly number[],
  options: BootstrapOptions,
  statistic: (sample: readonly number[]) => number,
): readonly [number, number] | null {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return null;
  }
  validateOptions(options);
  const random = mulberry32(options.seed);
  const estimates: number[] = [];
  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const sample: number[] = [];
    for (let index = 0; index < finite.length; index += 1) {
      sample.push(finite[Math.floor(random() * finite.length)] as number);
    }
    estimates.push(statistic(sample));
  }
  estimates.sort((left, right) => left - right);
  const tail = (1 - options.confidence) / 2;
  return [percentile(estimates, tail), percentile(estimates, 1 - tail)];
}

function validateOptions(options: BootstrapOptions): void {
  if (!Number.isInteger(options.iterations) || options.iterations <= 0) {
    throw new Error("bootstrap: iterations must be a positive integer");
  }
  if (!Number.isInteger(options.seed)) {
    throw new Error("bootstrap: seed must be an integer");
  }
  if (!(options.confidence > 0 && options.confidence < 1)) {
    throw new Error("bootstrap: confidence must be between 0 and 1 (exclusive)");
  }
}

function arithmeticMean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function geometricMean(values: readonly number[]): number {
  const logSum = values.reduce((sum, value) => sum + Math.log(value), 0);
  return Math.exp(logSum / values.length);
}

/** 线性插值百分位（q ∈ [0,1]；输入已排序） */
function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) {
    return sorted[0] as number;
  }
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sorted[lower] as number;
  }
  const weight = position - lower;
  return (sorted[lower] as number) * (1 - weight) + (sorted[upper] as number) * weight;
}

/**
 * mulberry32：小而确定的 32 位 PRNG。固定种子 → 同进程 / 跨平台一致
 * （不使用 Math.random，保证报告可复算）。
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
