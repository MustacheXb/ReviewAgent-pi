# Claude Code harness 同模型能力上限试点（3 案 ceiling）

> 口径：**Agent harness 同模型能力上限对照**——Claude Code CLI 使用与
> ReviewAgent-pi 相同的 `deepseek-v4-flash`，**不设 turn 上界**（`--claude-mode
> ceiling`，30 分钟安全超时兜底），测量通用 Agent harness 在质量 / token /
> 时延上的上限与代价。单列，不进 S/A/B；3 案仅为试点，不作统计结论或对外宣称。

## 1. 配置

| 项 | 值 |
|---|---|
| cases | `VUL4J-1` / `VUL4J-12` / `VUL4J-15`（各 1 rep） |
| 模型 | `deepseek-v4-flash`（请求与 `modelUsage` 硬校验一致） |
| 模式 | **ceiling**：不传 `--max-turns`；30m 超时 |
| 工具 | `--tools` + `--allowedTools` 仅 `Read / Grep / Glob` |
| CLI | Claude Code `2.1.241` |
| judge | `glm-5.2`，同一 judge 链 |
| 入口 | `CAMPAIGN_REAL=1 pnpm reference-smoke -- --kind claude-code --case-count 3 --claude-mode ceiling` |

## 2. 单案结果（ceiling）

| case | turns | duration | findings | judge | CLI cost | input | cacheRead | output | truncated |
|---|---:|---:|---:|---|---:|---:|---:|---:|---|
| VUL4J-1 | 36 | 426.4s | 1 | TP 1 / FP 0 / FN 0 | $2.0047 | 82,459 | 1,066,752 | 42,362 | no |
| VUL4J-12 | 14 | 196.7s | 1 | TP 1 / FP 0 / FN 0 | $0.7800 | 36,990 | 175,104 | 20,300 | no |
| VUL4J-15 | 9 | 117.8s | 0 | TP 0 / FP 0 / FN 4 | $0.5048 | 33,401 | 75,776 | 11,995 | no |
| **合计 / 均值** | **59 / 19.7** | **740.9s** | **2** | **R 0.333 / P 1.000 / F1 0.500** | **$3.2895** | 152,850 | 1,317,632 | 74,657 | 0/3 |

## 3. 与 E / C_ref 的同案对比

同 3 案、同模型、同 judge 下：

| 条件 | findings | judge Recall | judge Precision | CARC（均值） | totalTokens（均值/案） | turns / requests | 时延 | CLI cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **E baseline**（warm rep2+，5 轮 / 6 工具上界） | 2.67 | **0.750** | 0.389 | **44,713** | **93,801** | 10.5 requests | — | — |
| **Claude Code bounded**（5 轮） | 0 | 0.000 | N/A | 53,938* | 126,471* | 6 turns | 567.8s | $2.015 |
| **Claude Code ceiling**（无轮次上界） | 2 | 0.333 | **1.000** | 75,836* | **515,046** | 19.7 turns | 740.9s | $3.289 |
| C_ref（仅 VUL4J-1，80k 全仓） | 3 | 1.000 | 0.333 | 81,989* | 290,501* | — | — | — |

\* Claude Code 的 CARC / totalTokens 由 CLI `usage` 近似：CARC = input + cacheWrite
+ output（cacheRead 不计），totalTokens = input + cacheRead + output；E/C_ref
按同一口径从记录计算。CLI cost 为 CLI 价目 USD，不必然等于网关账单。

**同案观察（试点，不作统计结论）**：

- **质量上限没有更高**：Claude Code ceiling Recall 0.333 < E 0.750；Precision
  1.000 高于 E 0.389，但只输出 2 条 finding（VUL4J-15 为 0），是「少报换高精度」。
- **成本显著更高**：ceiling 总 token 约为 E 的 **5.5×**，时延 740.9s；CLI cost
  $3.29。VUL4J-1 单案 36 turns、1.07M cacheRead，才找到 1 条命中。
- **bounded vs ceiling**：5 轮下 3/3 截断、0 finding；放开轮次后能产出 finding，
  说明截断确实是原因，但也暴露 harness 的 turn / token 开销。
- **C_ref**：仅 VUL4J-1，质量与 E 同为 Recall 1 / Precision 0.333，但 CARC
  约 1.8×、totalTokens 约 3×，是「信息给满」的代价参照。

## 4. 结论与下一步

- 本试点支持「ceiling 模式用于能力上限」的用法：它确实让 Claude Code 完成
  并输出 findings，同时量化了 token / 时延代价。
- 但 3 案不足以判断质量上限：VUL4J-15 零 finding、VUL4J-1 用了 36 turns，
  方差很大；要做「全方位对比」应扩到 **10 case × 2 reps** 起步，再按
  30×3 主跑。
- 报告三列口径建议：
  - E：有界（5 轮 / 6 工具）质量 + CARC / totalTokens；
  - C_ref：信息给满的质量 / 成本参照（L3 单列）；
  - Claude Code：ceiling 质量上限 + turns / tokens / 时延 / CLI USD；
  - 另列 bounded 5 轮截断率，不混入质量排名。

## 5. 工件

原始（gitignored）：`runs/eval/claude-code-ceiling-2026-11-13/`（records / judge /
column.json / COLUMN.md）。本目录副本：3 份 record、3 份 judge、`column.json`、
`COLUMN.md`。

C_ref 对照：`docs/report/token-eval/c-ref-smoke-2026-11-13/`。
E 同案基线来自 `p1-calibration-2026-11-12` 的 baseline warm 记录（rep2+）。
