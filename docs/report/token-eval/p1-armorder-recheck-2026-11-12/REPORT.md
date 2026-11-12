# 臂序随机化复核（10 case × 3 reps × 2 arms）

> 状态：**方法学复核，不用于阈值更新 / 优化收益判定**（`claimsAllowed = false`）。
> 目的：验证固定臂序（baseline → candidate）是否给空对照带来顺序 / 时段偏差；
> 10 案样本量不足，结论只作方法学参考。

## 1. 身份与环境

| 项 | 值 |
|---|---|
| campaign | `p1-armorder-recheck-2026-11-12` |
| baseline / candidate ref | `eval-e-baseline-2026-11-11`（同代码空对照） |
| 臂序 | **randomized**（每 case×rep 确定性洗牌，seed `20261112`，已写入 `plan.json`） |
| 样本量 | 10 case × 3 reps × 2 arms = 60 单元 |
| 被测模型 / 网关 | `deepseek-v4-flash` / volcengine |
| judge | `glm-5.2`，prompt `mcr-bench-llm-hit-judge-2026-09-03+poc1-ext-1` |
| 时间窗 | 2026-11-12T14:36:26Z → 2026-11-12T18:23:56Z（Asia/Shanghai；含一次网关故障 `--resume`） |
| 数据集 | `data/vul4j/p1-smoke-cases.json`（10 案，sha256 见 `environment.json`） |
| coverage | 60/60 executed，59/60 judged（ratio 0.983）；1 条 judge `max_tokens` 截断（`VUL4J-25/baseline/rep-1`，已重试仍失败） |

## 2. 噪声底（warm = rep2+，按 case 配对）

| 指标 | mean | ci95 |
|---|---:|---|
| CARC ratio | **1.058** | [0.845, 1.305] |
| uncached ratio | 1.063 | [0.872, 1.298] |
| output ratio | 1.035 | [0.735, 1.351] |
| attempts ratio | 0.998 | [0.898, 1.113] |
| requests ratio | 1.045 | [0.960, 1.141] |
| judgeRecall diff | **+14.8pp** | [+1.3, +29.0] |
| judgePrecision diff | +9.6pp | [−8.8, +25.8] |
| zero-finding rate diff | −5.0pp | [−15.0, 0.0] |

## 3. 与固定臂序 30×3 校准对比

| 指标 | 固定臂序 30×3 | 随机臂序 10×3 |
|---|---:|---:|
| CARC ratio | 1.045 [0.937, 1.174]（n=30） | 1.058 [0.845, 1.305]（n=10） |
| judgeRecall diff | −3.6pp [−11.8, +5.0] | **+14.8pp [+1.3, +29.0]** |
| judgePrecision diff | −7.6pp [−15.8, +0.4] | +9.6pp [−8.8, +25.8] |
| zero-finding diff | +1.7pp | −5.0pp |

**解读**：

- 固定臂序下 candidate 质量略低（Recall −3.6pp / Precision −7.6pp）的方向，
  在随机臂序下**未复现**（Recall 反为正、CI 不含 0 以下）。更可能是固定臂序 /
  时段漂移或 30 案噪声，而非稳定的臂序缺陷。
- CARC 在两个口径下都略高于 1（+4.5% / +5.8%），但 10 案 CI 极宽
  （半宽约 23pp，30 案约 12pp），不能据此判定「第二臂更贵」。
- 10×3 的统计功效远不足以复核阈值；**不修改 ADR-0017 阈值**。方法学结论是：
  后续 L2 主跑 / 校准应使用随机臂序；下一次正式校准仍应跑 30×3（且按噪声底
  建议扩到 ≥43 案），而不是用本次 10 案下结论。

## 4. 工件与复算

原始工件（gitignored）：`runs/eval/p1-armorder-recheck-2026-11-12/`

```text
plan.json（armOrder=randomized / armOrderSeed=20261112）/ cases.json
environment.json / failures.json
runs/vul4j/<case>/<arm>/rep-<n>.json        # 60
judge/vul4j/<case>/<arm>/rep-<n>.json       # 60
audit/...
l2-report.json / noise-floor.json / NOISE-FLOOR.md
progress.log / run.log / resume*.log
```

零网络复算：

```bash
pnpm campaign -- --report-only --out runs/eval/p1-armorder-recheck-2026-11-12
```

本目录机读工件中的路径已由代码投影为仓库相对路径；真实 CLI 单案 / 正式
L2 主跑不在本次复核范围。
