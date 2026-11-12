# P1 空对照校准噪声底报告（30 case × 3 reps × 2 arms）

> 状态：**校准完成，仅用于复核 L2 provisional 阈值**。空对照不判定优化收益
> （`claimsAllowed = false`），不得据此宣称任何 token / 质量收益。
>
> campaign：`p1-calibration-2026-11-12` · calibrationRef：`p1-calibration-2026-11-12`
> 日期：2026-11-11 → 2026-11-12 · 分支：`eval/bench` · 代码：`c4e5e5f`

## 1. 身份与环境

| 项 | 值 |
|---|---|
| baseline ref | `eval-e-baseline-2026-11-11` |
| candidate ref | `eval-e-baseline-2026-11-11`（同代码空对照） |
| baseline / candidate commit | `c4e5e5f8f595079b26738ac788163496fd32853d`（两臂同一 checkout；运行期内核代码 = `d1f9831`，`c4e5e5f` 仅文档重构，无运行时差异） |

> 空对照双臂都使用当前 `eval/bench` checkout；ref 标签沿用 baseline 以标识
> 同一代码谱系。核对 `e724958`（`eval-e-baseline-2026-11-11`）→ `c4e5e5f`
> 的 `packages/` + `src/gate` + `src/instrument`：仅
> `packages/reviewagent/THIRD-PARTY-NOTICES.md` 1 行变化，pi 内核运行时
> 字节一致。
| 被测模型 | `deepseek-v4-flash` |
| 网关 | `volcengine` / `gateway-endpoint` |
| judge | `glm-5.2` · prompt `mcr-bench-llm-hit-judge-2026-09-03+poc1-ext-1` · temperature 0.2 / top_p 0.95 |
| 时间窗 | 2026-11-11T23:42:45.782Z → 2026-11-12T12:26:11.950Z（Asia/Shanghai，约 12h43m，含中断续跑） |
| 数据集 | `data/vul4j/target-cases.json`，30 案，sha256 `fd752f54082c87ad704d0463b18e7e8bf1a28ed2342138800b3289fba1315d36` |
| 阴性对照 | N/A（当前数据集无 clean MR） |
| 样本量 | 30 case × 3 reps × 2 arms = 180 单元 |
| coverage | 180/180 executed，179/180 judged，1 failed（`VUL4J-75/baseline/rep-1` judge 非法 JSON，已重试一次仍失败）；ratio 0.994 |
| bootstrap | 10,000 次 · seed 20261111 · 95% CI |
| 审计 | 180 份 audit，0 cache break；`VUL4J-72/candidate/rep-2` 为预算截断（原因显式） |

环境完整字段见 [`environment.json`](environment.json)；机读指标见
[`l2-report.json`](l2-report.json) 与 [`noise-floor.json`](noise-floor.json)。
本目录 JSON 中的本机路径已投影为仓库相对路径（`runs/eval/<campaign-id>`）。

## 2. 执行与中断留痕

最终工件由同一 campaign 的三段运行合并（`--resume`）：

1. 首跑（另存 `runs/eval/p1-calibration-2026-11-12-attempt1/`，**未进入最终工件**）
   因主机睡眠，60 分钟无进度被看门狗中止；保留 35 条单元记录作为过程证据。
2. 最终批次重启后又遇一次主机睡眠；恢复后内核链路进入 terminated 状态，
   已终止孤儿进程并用 `--resume` 续跑（跳过已完成单元，只跑缺失单元）。
3. 主跑完成后 7 个 judge 失败，再以 `--resume` 补判 7 个单元；6 个恢复，
   仅 `VUL4J-75/baseline/rep-1` 持续返回非法 JSON。

续跑保留原批次时间窗起点，plan / cases hash 不变；`progress.log` 与
`run.log` 留在原始 campaign 目录（gitignored）。主机保活与 `--resume`
已写入 RUNBOOK。

## 3. 噪声底（warm = rep2+ 主口径，按 case 配对）

| 指标 | warm mean | warm ci95 | cold mean | cold ci95 |
|---|---:|---|---:|---|
| CARC ratio | 1.045 | [0.937, 1.174] | 0.956 | [0.829, 1.102] |
| uncached ratio | 1.063 | [0.951, 1.199] | 0.945 | [0.817, 1.095] |
| output ratio | 1.001 | [0.888, 1.136] | 0.976 | [0.832, 1.143] |
| totalTokens ratio | 1.088 | [0.966, 1.239] | 0.986 | [0.855, 1.134] |
| cachedInput ratio | 1.114 | [0.969, 1.295] | 0.994 | [0.803, 1.225] |
| attempts ratio | 1.026 | [0.957, 1.105] | 0.974 | [0.907, 1.045] |
| requests ratio | 1.052 | [0.993, 1.129] | 0.960 | [0.916, 1.008] |
| cacheHitRate diff | +0.008 | [-0.013, 0.028] | +0.010 | [-0.043, 0.062] |
| judgeRecall diff | -0.036 | [-0.118, 0.050] | -0.177 | [-0.321, -0.044] |
| judgePrecision diff | -0.076 | [-0.158, 0.004] | -0.146 | [-0.269, -0.025] |
| zero-finding rate diff | +0.017 | [-0.067, 0.100] | -0.033 | [-0.100, 0.000] |
| negative-control FP diff | N/A | N/A | N/A | N/A |

两臂绝对指标（warm）：

| 指标 | baseline | candidate |
|---|---:|---:|
| CARC | 49,909.1 | 53,780.0 |
| cachedInputTokens | 60,377.6 | 82,118.4 |
| uncachedInputTokens | 34,223.4 | 37,786.1 |
| outputTokens | 15,685.7 | 15,993.9 |
| totalTokens | 110,286.7 | 135,898.4 |
| cacheHitRate | 0.625 | 0.633 |
| judgeRecall | 0.535 | 0.499 |
| judgePrecision | 0.569 | 0.496 |
| attemptedToolCalls | 11.23 | 11.58 |
| requests | 9.57 | 10.28 |

观测上界（两臂冷热全查）：attemptedToolCalls 21、requests 41、outputTokens
59,491、truncated runs 1。

**解读**：空对照中心并非严格 1.0——candidate 臂 CARC 高约 4.5%、judge
Recall/Precision 低约 3.6pp / 7.6pp。两臂同代码，这不是优化收益；方向一致
提示存在**臂序 / 时间漂移**（当前 plan 固定 baseline → candidate，无臂序
随机化）。该偏差计入噪声底，正式比较前建议按 case 随机化臂序。

## 4. 阈值复核与 ADR-0017 补记决定

校准生成时的噪声包线建议见
[`NOISE-FLOOR.calibration-time.md`](NOISE-FLOOR.calibration-time.md)。本轮
**只采纳有确凿数据支撑、且不削弱政策门的更新（有界性安全上界）**；成本 /
质量 / 分解守卫保留，因为空对照数据说明的是**样本功效不足**，不是阈值定错：

| 阈值 | 校准前 | 校准后 | 决定 | 依据 |
|---|---:|---:|---|---|
| `maxCarcRatio` | 0.90 | 0.90 | **保留** | ci95 半宽 11.8pp；需约 43 案才能让真实 0.90 通过 CI 上界门 |
| `maxCarcRatioCiUpper` | 1.00 | 1.00 | **保留** | 同上；30 案下 L2 成本硬门统计功效不足 |
| `maxUncachedRatio` | 1.00 | 1.00 | 保留（建议 1.20，不采纳） | 放宽会削弱「缓存吃掉成本」防护；先扩样 / 随机化臂序 |
| `maxOutputRatio` | 1.05 | 1.05 | 保留（建议 1.12，不采纳） | 同上 |
| `maxAttemptsRatio` | 1.00 | 1.00 | 保留（建议 1.10，不采纳） | 同上 |
| `maxRequestsRatio` | 1.00 | 1.00 | 保留（建议 1.13，不采纳） | 同上 |
| `qualityNonInferiorityPp` | 0.03 | 0.03 | **保留**（建议 0.16，不采纳） | ADR-0017 §3 质量非劣不可豁免；30 案 CI 下界 −15.8pp 说明需约 220 案，不能靠放宽 5 倍代替 |
| `maxZeroFindingRateIncreasePp` | 0.02 | 0.02 | 保留 | 空对照 +1.7pp ≤ 2pp（门按均值判定） |
| `maxNegativeControlFpSigma` | 1 | 1 | 保留（N/A） | 数据集无 clean MR，本次不可校准；需补数 |
| `minCoverage` | 0.95 | 0.95 | 保留 | 实测 0.994 |
| `maxAttemptedToolCalls` | 12 | **24** | 调整 | 实测最大 21（+ ~10% 余量） |
| `maxRequests` | 24 | **46** | 调整 | 实测最大 41（+ ~10% 余量） |
| `maxOutputTokens` | 48,000 | **65,441** | 调整 | 实测最大 59,491（+ ~10% 余量） |

**样本功效（按空对照 CI 宽度近似）**：

- CARC 0.90 + CI 上界 <1.00：半宽 11.8pp → 约 **43 案**；
- 质量 3pp 非劣：precision 半宽 8.1pp → 约 **220 案**（recall 约 235 案）；
- 因此 **30 案不是 L2 硬门的可用样本量**；在扩样与臂序随机化之前，L2 成本 /
  质量门只能作为「已知功效不足」的诊断，不能作为合并放行依据。

**更新后空对照复核**（以最终代码在记录副本上 `--report-only` 重建）：

```text
L2 gates: cost=FAIL quality=FAIL boundedness=PASS reproducibility=PASS
coverage=180/180 executed，179/180 judged（0.994）；claimsAllowed=false
cost FAIL: CARC ratio 1.045 > 0.900; CARC ci95 upper 1.174 not < 1.000
quality FAIL: judgeRecall ci95 lower -11.8pp < -3.0pp；
              judgePrecision ci95 lower -15.8pp < -3.0pp
```

即：有界性上界修正后不再误杀基线、可复现门通过；成本 / 质量门仍失败，
这是**校准应有的结论**——空对照没有优化收益，且 30 案无法支撑 3pp 质量
非劣 / 10pp CARC 目标。同一副本连续两次 `--report-only` 重建
`l2-report.json` / `noise-floor.json` / `NOISE-FLOOR.md`，sha256 逐字节一致；
本目录 JSON 的 `outputDir` / `dataset.casesFile` 由代码投影为仓库相对路径。

## 5. 限制与后续

- **统计功效**：30 案无法支持「CARC ≤0.90 且 CI 上界 <1.00」（约需 43 案），
  更无法支持 3pp 质量非劣（约需 220 案）。必须扩样 / holdout 后才能把 L2
  作为硬门；不得用放宽质量阈值替代。
- **臂序**：固定 baseline → candidate 可能引入顺序 / 时段偏差；本次空对照
  的 +4.5% CARC、−7.6pp Precision 方向一致，提示该偏差已进入噪声底。下次
  校准与 L2 主跑应随机化同 case × rep 的臂序。
- **阴性对照**：ADR-0017 §6 的首版数据集要求含 clean-MR；当前 30 案数据集
  无 clean MR，`maxNegativeControlFpSigma` 本次 N/A。这是对 §6 的显式偏差，
  需恢复 clean-MR 数据集并重校准，不能视为已通过。
- **judge 失败**：1/180 持久非法 JSON（`VUL4J-75/baseline/rep-1`）；coverage
  0.994 通过门槛，但质量对缺失单元不做插补。
- **judge 版本**：`glm-5.2` 为当前可用 judge；模型 / provider / judge /
  提示词 / 工具 schema 任一变更后，按 ADR-0017 §5 重做校准。

## 6. 复算与工件

原始工件（gitignored）：`runs/eval/p1-calibration-2026-11-12/`

```text
plan.json / cases.json / environment.json / failures.json
runs/vul4j/<case>/<arm>/rep-<n>.json        # 180
judge/vul4j/<case>/<arm>/rep-<n>.json       # 180
audit/vul4j/<case>/E/rep-<n>/audit/*.json   # 180
report.json / l2-report.json / noise-floor.json / NOISE-FLOOR.md
progress.log / run.log
```

零网络复算：

```bash
pnpm campaign -- --report-only --out runs/eval/p1-calibration-2026-11-12
```

本目录 `l2-report.json` / `noise-floor.json` / `NOISE-FLOOR.md` 是**最终阈值下**
的机读工件（路径已由代码投影为仓库相对路径）；`*.calibration-time.*` 保留
校准生成时的阈值快照与「调整建议」原文。噪声指标与 CI 两者一致；门判定差异
只来自阈值更新。正式 campaign 引用本次校准时写：

```text
--calibration-ref p1-calibration-2026-11-12
```
