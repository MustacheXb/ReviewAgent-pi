# Claude Code harness 同模型能力上限：10 case × 2 reps 试点

> 口径：**Agent harness 同模型能力上限对照**——Claude Code CLI 使用与
> ReviewAgent-pi 相同的 `deepseek-v4-flash`，**不设 turn 上界**（ceiling，
> 30m 安全超时），测量通用 Agent harness 的质量 / token / 时延上限与代价。
> 单列，不进 S/A/B；10×2 为试点，不作统计显著性结论或对外宣称。

## 1. 配置

| 项 | 值 |
|---|---|
| cases | 数据集前 10 案（VUL4J-1/12/15/16/21/22/25/29/30/33） |
| reps | 2（每案 2 次，共 20 runs） |
| 模型 | `deepseek-v4-flash`（请求与 `modelUsage` 硬校验一致） |
| 模式 | **ceiling**：不传 `--max-turns`，30m 超时；工具仅 Read/Grep/Glob |
| judge | `glm-5.2`，同一 judge 链 |
| 覆盖 | 20/20 runs 完成；19/20 judged（`VUL4J-25/rep-2` judge `max_tokens` 截断，留痕，不插补） |
| 入口 | `CAMPAIGN_REAL=1 pnpm reference-smoke -- --kind claude-code --case-count 10 --reps 2 --claude-mode ceiling` |

## 2. 聚合结果（Claude ceiling）

| 指标 | 值 |
|---|---:|
| runs / cases | 20 / 10 |
| findings | 27（1.35/run） |
| zero-finding rate（case 内跨 rep 再等权） | **0.200** |
| truncated runs | **0/20** |
| judge（case 等权，19 judged） | **Recall 0.318 / Precision 0.492** |
| judge 汇总计数（按 run） | TP 13 / FP 11 / FN 52 |
| turns（均值/run） | **22.15**（范围 9–45） |
| duration（均值/run） | 436.8s（总 8,736.4s ≈ **145.6 min**） |
| CLI cost（总） | **$34.72** |
| token（均值/run） | input 78,038 / cacheRead 654,131 / output 40,758 |
| CARC 近似（均值/run） | **118,796** |
| totalTokens 近似（均值/run） | **772,927** |
| permission denials | 0 |

> CARC 近似 = input + cacheWrite + output；totalTokens 近似 = input + cacheRead
> + output；均由 CLI `usage` 计算。CLI cost 为 CLI 价目 USD，不必然等于网关账单。

## 3. 与 E 同案对比（E baseline warm，rep≥2）

| 条件 | Recall | Precision | findings/run | zero-finding | CARC/run | totalTokens/run | requests | 时延 | CLI cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **E（5 轮 / 6 工具）** | **0.463** | 0.454 | 2.65 | 0.000 | **47,393** | **100,346** | 9.70 | — | — |
| **Claude ceiling（无轮次上界）** | 0.318 | **0.492** | 1.35 | 0.200 | 118,796 | 772,927 | — | 7.3 min/run | $34.72 总 |
| 相对 | **−31%** | +8% | −49% | +20pp | **2.5×** | **7.7×** | — | — | — |

### 逐案（case 等权）

| case | E R / P | Claude R / P | Claude findings | turns（均值） | Claude cost | Claude duration |
|---|---|---:|---:|---:|---:|---:|
| VUL4J-1 | 1.000 / 0.333 | 1.000 / 0.500 | 4 | 30 | $4.278 | 18.1 min |
| VUL4J-12 | 1.000 / 0.417 | 0.500 / 0.500 | 1 | 11 | $1.506 | 6.3 min |
| VUL4J-15 | 0.250 / 0.417 | 0.000 / 0.000 | 0 | 26 | $2.801 | 10.3 min |
| VUL4J-16 | 0.400 / 1.000 | 0.200 / 1.000 | 2 | 13 | $2.301 | 13.0 min |
| VUL4J-21 | 0.333 / 0.667 | 0.167 / 1.000 | 2 | 34 | $5.754 | 21.5 min |
| VUL4J-22 | 0.167 / 0.167 | 0.167 / 0.250 | 2 | 9 | $0.851 | 3.5 min |
| VUL4J-25 | 0.333 / 0.250 | 0.333 / 0.250（仅 1 rep judged） | 7 | 13 | $3.127 | 17.8 min |
| VUL4J-29 | 0.143 / 0.417 | 0.143 / 0.750 | 3 | 20 | $2.931 | 12.7 min |
| VUL4J-30 | 0.500 / 0.125 | 0.500 / 0.500 | 2 | 22 | $3.777 | 15.4 min |
| VUL4J-33 | 0.500 / 0.750 | 0.167 / 0.167 | 4 | 45 | $7.397 | 27.0 min |

## 4. 解读

- **能力上限没有更高**：Claude ceiling 的 case 等权 Recall **0.318** 低于 E 的
  **0.463**；Precision 略高（0.492 vs 0.454），主要是少报（findings/run 1.35 vs
  2.65；zero-finding 20% vs 0%）。
- **token / 时延代价显著**：totalTokens 约 **7.7×**、CARC 约 **2.5×**；20 runs
  总时延 145.6 min、CLI cost $34.72。VUL4J-33 单案 45 turns / $7.40；VUL4J-21
  34 turns / $5.75，而 E 同案 CARC 约 5.7 万。
- **harness 行为差异**：Claude Code 倾向于多轮工具探索（平均 22 turns），
  在部分案件（VUL4J-15）即使给足轮次也零 finding；E 在 5 轮 / 6 工具内更高召回。
- **bounded 5 轮**：此前 3 案 3/3 截断、0 finding；ceiling 才能观察到「给足
  轮次后的质量」，但本 10×2 显示其上限并不优于 E。
- 10×2 仍是试点；要做显著性 / 分案结论应扩到 30×3，并考虑 holdout。

## 5. 建议

1. **暂不扩 30×3**：先决定是否接受「Claude Code harness 在 token/时延上显著
   更贵、召回更低」这一试点结论，或调整提示词 / turn 预算后再测。
2. 若进入 #45 L3 三列报告，建议三列口径：
   - E：有界（5 轮 / 6 工具）质量 + CARC / totalTokens；
   - C_ref：信息给满参照（单案已跑通）；
   - Claude Code：ceiling 质量上限 + turns / tokens / 时延 / CLI USD；
   - bounded 5 轮截断率单列，不混入质量排名。
3. `VUL4J-25/rep-2` judge 失败已留痕；若需完整 20/20 judged，可在报告阶段
   单独重判该 record（不重跑 Claude）。

## 6. 工件

原始（gitignored）：`runs/eval/claude-code-ceiling-10x2-2026-11-13/`
（records / judge / column.json / COLUMN.md / failures.json）。

本目录副本：20 份 record、19 份 judge、`column.json`、`COLUMN.md`、
`failures.json`。
