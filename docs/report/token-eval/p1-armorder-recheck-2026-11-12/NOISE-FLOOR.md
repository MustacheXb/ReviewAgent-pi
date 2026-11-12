# L2 空对照校准噪声底报告 p1-armorder-recheck-2026-11-12

> 本报告只用于确认 / 调整 L2 provisional 阈值，**不得据此宣称优化收益**（claimsAllowed = false）。
> calibrationRef: `p1-armorder-recheck-2026-11-12` · campaignType: `calibration`

## 1. 身份与环境

| 项 | 值 |
|---|---|
| baseline ref | `eval-e-baseline-2026-11-11` |
| candidate ref | `eval-e-baseline-2026-11-11` |
| 被测模型 | `deepseek-v4-flash` |
| provider | volcengine |
| judge | `glm-5.2` · prompt `mcr-bench-llm-hit-judge-2026-09-03+poc1-ext-1` · temperature 0.200 · top_p 0.950 |
| git | branch eval/bench · commit f30c35f4ddedbf211885d582aab9ad67fca1e4a3 · tag N/A |
| 时间窗 | 2026-11-12T14:36:26.628Z → 2026-11-12T18:23:56.047Z（Asia/Shanghai） |
| 数据集 | 10 案 · clean MR N/A（无 clean MR） · sha256 `31a326bd1722042a1790d4bffbc05c02086098a212bedd785e6f51dbb4fcd8ba` |
| 样本量 | 10 case × 3 reps × 2 arms = 60 单元 · 臂序 randomized（seed 20261112） |
| coverage | 0.983（executed 60 / planned 60，judged 59，failed 1） |
| bootstrap | 10000 次 · seed 20261111 · confidence 0.95 |

## 2. 配对统计（warm = rep2+ 主口径；cold = rep1 单列）

| 指标 | warm mean | warm ci95 | cold mean | cold ci95 |
|---|---:|---|---:|---|
| CARC ratio | 1.058 | [0.845, 1.305] | 1.034 | [0.917, 1.137] |
| uncached ratio | 1.063 | [0.872, 1.298] | 0.989 | [0.889, 1.091] |
| output ratio | 1.035 | [0.735, 1.351] | 1.145 | [0.957, 1.347] |
| totalTokens ratio | 1.129 | [0.898, 1.454] | 1.065 | [0.948, 1.202] |
| cachedInput ratio | 1.199 | [0.906, 1.645] | 1.089 | [0.916, 1.320] |
| attempts ratio | 0.998 | [0.898, 1.113] | 1.073 | [0.908, 1.287] |
| requests ratio | 1.045 | [0.960, 1.141] | 1.014 | [0.940, 1.106] |
| cacheHitRate diff | 0.032 | [-0.011, 0.078] | 0.022 | [-0.020, 0.067] |
| judgeRecall diff | 0.148 | [0.013, 0.290] | 0.053 | [-0.148, 0.313] |
| judgePrecision diff | 0.096 | [-0.087, 0.258] | -0.083 | [-0.296, 0.111] |
| zero-finding rate diff | -0.050 | [-0.150, 0.000] | 0.000 | [0.000, 0.000] |
| negative-control FP diff | N/A | N/A | N/A | N/A |

## 3. 两臂绝对指标（warm = rep2+）

| 指标 | baseline | candidate |
|---|---:|---:|
| CARC | 45057.550 | 48400.050 |
| cachedInputTokens | 49996.800 | 60800.000 |
| uncachedInputTokens | 31214.100 | 33491.500 |
| outputTokens | 13843.450 | 14908.550 |
| totalTokens | 95054.350 | 109200.050 |
| cacheHitRate | 0.599 | 0.631 |
| judgeRecall | 0.341 | 0.489 |
| judgePrecision | 0.396 | 0.492 |
| attemptedToolCalls | 10.800 | 10.750 |
| requests | 9.400 | 9.800 |

## 4. 观测上界（两臂冷热全查）

| 指标 | 实测最大 | provisional |
|---|---:|---:|
| attemptedToolCalls | 16.000 | 24 |
| requests | 12.000 | 46 |
| outputTokens | 29555.000 | 65441 |
| truncated runs | 0 | truncated => truncationReasons non-empty |

## 5. 阈值复核建议

| 门 | 阈值 | provisional | observed | 建议 | suggested | 依据 |
|---|---|---:|---:|---|---:|---|
| cost | maxCarcRatio | 0.900 | 1.058 | gather-more | — | 空对照 CARC 比率 ci95 半宽 0.230 ≥ 10pp：0.900 目标 + 半宽 ≥ 1.00，当前样本量无法让真实 0.900 通过 CI 上界门；建议扩样到约 53 案（或明确降低主门目标） |
| cost | maxUncachedRatio | 1.000 | 1.063 | adjust | 1.270 | 空对照单侧 95% 上界 1.265 > 1.000：空对照本身会触发假失败；建议放宽到 1.270（仍拦回归，只在噪声带内） |
| cost | maxOutputRatio | 1.050 | 1.035 | adjust | 1.280 | 空对照单侧 95% 上界 1.273 > 1.050：空对照本身会触发假失败；建议放宽到 1.280（仍拦回归，只在噪声带内） |
| cost | maxAttemptsRatio | 1.000 | 0.998 | adjust | 1.100 | 空对照单侧 95% 上界 1.097 > 1.000：空对照本身会触发假失败；建议放宽到 1.100（仍拦回归，只在噪声带内） |
| cost | maxRequestsRatio | 1.000 | 1.045 | adjust | 1.130 | 空对照单侧 95% 上界 1.126 > 1.000：空对照本身会触发假失败；建议放宽到 1.130（仍拦回归，只在噪声带内） |
| quality | qualityNonInferiorityPp | 0.030 | -0.087 | adjust | 0.090 | 空对照噪声超出 −3.0pp（CI 下界 -8.8pp）：无质量变化的 candidate 也会假失败；建议放宽到 9.0pp 覆盖噪声 |
| quality | maxZeroFindingRateIncreasePp | 0.020 | -0.050 | keep | — | 空对照零 finding 率上升 -5.0pp ≤ 2.0pp |
| quality | maxNegativeControlFpSigma | 1.000 | N/A | n/a | — | 数据集无 clean MR 阴性对照，本阈值本次不可校准 |
| quality | minCoverage | 0.950 | 0.983 | keep | — | coverage 0.983 ≥ 0.950 |
| boundedness | maxAttemptedToolCalls | 24.000 | 16.000 | keep | — | 空对照实测最大 16 ≤ provisional 24 |
| boundedness | maxRequests | 46.000 | 12.000 | keep | — | 空对照实测最大 12 ≤ provisional 46 |
| boundedness | maxOutputTokens | 65441.000 | 29555.000 | keep | — | 空对照实测最大 29555 ≤ provisional 65441 |

## 6. 结论与复算

- 噪声底已测量；本报告**不是**优化收益判定，claimsAllowed 恒 false。
- 阈值变更须按 ADR-0017 §5 以补记固化；模型 / provider / judge / 提示词 / 工具 schema 变更后重做校准。
- 复算（零网络）：`pnpm campaign -- --report-only --out runs/eval/p1-armorder-recheck-2026-11-12`
