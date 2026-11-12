# L2 空对照校准噪声底报告 p1-calibration-2026-11-12

> 本报告只用于确认 / 调整 L2 provisional 阈值，**不得据此宣称优化收益**（claimsAllowed = false）。
> calibrationRef: `p1-calibration-2026-11-12` · campaignType: `calibration`

## 1. 身份与环境

| 项 | 值 |
|---|---|
| baseline ref | `eval-e-baseline-2026-11-11` |
| candidate ref | `eval-e-baseline-2026-11-11` |
| 被测模型 | `deepseek-v4-flash` |
| provider | volcengine |
| judge | `glm-5.2` · prompt `mcr-bench-llm-hit-judge-2026-09-03+poc1-ext-1` · temperature 0.200 · top_p 0.950 |
| git | branch eval/bench · commit c4e5e5f8f595079b26738ac788163496fd32853d · tag N/A |
| 时间窗 | 2026-11-11T23:42:45.782Z → 2026-11-12T12:26:11.950Z（Asia/Shanghai） |
| 数据集 | 30 案 · clean MR N/A（无 clean MR） · sha256 `fd752f54082c87ad704d0463b18e7e8bf1a28ed2342138800b3289fba1315d36` |
| 样本量 | 30 case × 3 reps × 2 arms = 180 单元 |
| coverage | 0.994（executed 180 / planned 180，judged 179，failed 1） |
| bootstrap | 10000 次 · seed 20261111 · confidence 0.95 |

## 2. 配对统计（warm = rep2+ 主口径；cold = rep1 单列）

| 指标 | warm mean | warm ci95 | cold mean | cold ci95 |
|---|---:|---|---:|---|
| CARC ratio | 1.045 | [0.937, 1.174] | 0.956 | [0.829, 1.102] |
| uncached ratio | 1.063 | [0.951, 1.199] | 0.945 | [0.817, 1.095] |
| output ratio | 1.001 | [0.888, 1.136] | 0.976 | [0.832, 1.143] |
| totalTokens ratio | 1.088 | [0.966, 1.239] | 0.986 | [0.855, 1.134] |
| cachedInput ratio | 1.114 | [0.969, 1.295] | 0.994 | [0.803, 1.225] |
| attempts ratio | 1.026 | [0.957, 1.105] | 0.974 | [0.907, 1.045] |
| requests ratio | 1.052 | [0.993, 1.129] | 0.960 | [0.916, 1.008] |
| cacheHitRate diff | 0.008 | [-0.013, 0.028] | 0.010 | [-0.043, 0.062] |
| judgeRecall diff | -0.036 | [-0.118, 0.050] | -0.177 | [-0.321, -0.044] |
| judgePrecision diff | -0.076 | [-0.158, 0.004] | -0.146 | [-0.269, -0.025] |
| zero-finding rate diff | 0.017 | [-0.067, 0.100] | -0.033 | [-0.100, 0.000] |
| negative-control FP diff | N/A | N/A | N/A | N/A |

## 3. 两臂绝对指标（warm = rep2+）

| 指标 | baseline | candidate |
|---|---:|---:|
| CARC | 49909.100 | 53779.983 |
| cachedInputTokens | 60377.600 | 82118.400 |
| uncachedInputTokens | 34223.400 | 37786.050 |
| outputTokens | 15685.700 | 15993.933 |
| totalTokens | 110286.700 | 135898.383 |
| cacheHitRate | 0.625 | 0.633 |
| judgeRecall | 0.535 | 0.499 |
| judgePrecision | 0.569 | 0.496 |
| attemptedToolCalls | 11.233 | 11.583 |
| requests | 9.567 | 10.283 |

## 4. 观测上界（两臂冷热全查）

| 指标 | 实测最大 | provisional |
|---|---:|---:|
| attemptedToolCalls | 21.000 | 12 |
| requests | 41.000 | 24 |
| outputTokens | 59491.000 | 48000 |
| truncated runs | 1 | truncated => truncationReasons non-empty |

## 5. 阈值复核建议

| 门 | 阈值 | provisional | observed | 建议 | suggested | 依据 |
|---|---|---:|---:|---|---:|---|
| cost | maxCarcRatio | 0.900 | 1.045 | gather-more | — | 空对照 CARC 比率 ci95 半宽 0.118 ≥ 10pp：0.900 目标 + 半宽 ≥ 1.00，当前样本量无法让真实 0.900 通过 CI 上界门；建议扩样到约 42 案（或明确降低主门目标） |
| cost | maxUncachedRatio | 1.000 | 1.063 | adjust | 1.200 | 空对照单侧 95% 上界 1.191 > 1.000：空对照本身会触发假失败；建议放宽到 1.200（仍拦回归，只在噪声带内） |
| cost | maxOutputRatio | 1.050 | 1.001 | adjust | 1.120 | 空对照单侧 95% 上界 1.118 > 1.050：空对照本身会触发假失败；建议放宽到 1.120（仍拦回归，只在噪声带内） |
| cost | maxAttemptsRatio | 1.000 | 1.026 | adjust | 1.100 | 空对照单侧 95% 上界 1.095 > 1.000：空对照本身会触发假失败；建议放宽到 1.100（仍拦回归，只在噪声带内） |
| cost | maxRequestsRatio | 1.000 | 1.052 | adjust | 1.130 | 空对照单侧 95% 上界 1.129 > 1.000：空对照本身会触发假失败；建议放宽到 1.130（仍拦回归，只在噪声带内） |
| quality | qualityNonInferiorityPp | 0.030 | -0.158 | adjust | 0.160 | 空对照噪声超出 −3.0pp（CI 下界 -15.8pp）：无质量变化的 candidate 也会假失败；建议放宽到 16.0pp 覆盖噪声 |
| quality | maxZeroFindingRateIncreasePp | 0.020 | 0.017 | keep | — | 空对照零 finding 率上升 1.7pp ≤ 2.0pp |
| quality | maxNegativeControlFpSigma | 1.000 | N/A | n/a | — | 数据集无 clean MR 阴性对照，本阈值本次不可校准 |
| quality | minCoverage | 0.950 | 0.994 | keep | — | coverage 0.994 ≥ 0.950 |
| boundedness | maxAttemptedToolCalls | 12.000 | 21.000 | adjust | 24.000 | 空对照实测最大 21 > provisional 12：现阈值会让基线自身失败；建议上界 24（实测 + ~10% 余量，放宽为安全上限，不取消检查） |
| boundedness | maxRequests | 24.000 | 41.000 | adjust | 46.000 | 空对照实测最大 41 > provisional 24：现阈值会让基线自身失败；建议上界 46（实测 + ~10% 余量，放宽为安全上限，不取消检查） |
| boundedness | maxOutputTokens | 48000.000 | 59491.000 | adjust | 65441.000 | 空对照实测最大 59491 > provisional 48000：现阈值会让基线自身失败；建议上界 65441（实测 + ~10% 余量，放宽为安全上限，不取消检查） |

## 6. 结论与复算

- 噪声底已测量；本报告**不是**优化收益判定，claimsAllowed 恒 false。
- 阈值变更须按 ADR-0017 §5 以补记固化；模型 / provider / judge / 提示词 / 工具 schema 变更后重做校准。
- 复算（零网络）：`pnpm campaign -- --report-only --out runs/eval/p1-calibration-2026-11-12`
