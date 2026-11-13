# Claude Code harness 同模型参照冒烟（3 案）

> 口径（2026-11-13 用户澄清）：比较的是 **Agent harness 差异**，Claude Code
> CLI 使用与 ReviewAgent-pi 评测相同的模型 `deepseek-v4-flash`，**不是**
> Claude 模型跨模型参照。单列报告，不进 S/A/B；结果只作 harness 链路 / 行为
> 冒烟，不作质量排名或对外宣称。

## 1. 配置

| 项 | 值 |
|---|---|
| cases | `VUL4J-1` / `VUL4J-12` / `VUL4J-15`（各 1 rep） |
| 模型 | `deepseek-v4-flash`（请求与 `modelUsage` 均为该 id，硬校验通过） |
| CLI | Claude Code `2.1.241` |
| 硬上界 | `--max-turns 5`；`--tools` + `--allowedTools` 仅 `Read / Grep / Glob` |
| judge | `glm-5.2`，prompt `mcr-bench-llm-hit-judge-2026-09-03+poc1-ext-1` |
| 入口 | `CAMPAIGN_REAL=1 pnpm reference-smoke -- --kind claude-code --case-count 3` |

## 2. 结果

| case | turns | findings | cost USD | input | cacheRead | output | stop / error | denials | judge |
|---|---:|---:|---:|---:|---:|---:|---|---:|---|
| VUL4J-1 | 6 | 0 | 0.399309 | 24,831 | 62,208 | 9,762 | `error_max_turns` | 0 | FN 1 |
| VUL4J-12 | 6 | 0 | 0.910230 | 45,251 | 76,800 | 25,823 | `error_max_turns` | 0 | FN 1 |
| VUL4J-15 | 6 | 0 | 0.705331 | 36,882 | 78,592 | 19,265 | `error_max_turns` | 0 | FN 4 |
| **合计** | — | **0** | **2.014870** | 106,964 | 217,600 | 54,850 | 3/3 truncated | 0 | **FN 6** |

- zero-finding rate = 1.0；judge Recall = 0，Precision = N/A（无 TP/FP）。
- 3/3 都在 `--max-turns 5` 处截断，未产出最终 JSON findings；
  `anomalies` 记录了 `error_max_turns`，未伪装成零质量。
- `total_cost_usd` 为 **CLI 报告值（按 CLI 价目）**，不必然等于网关实际账单。

## 3. 解读（harness 差异，不是模型差异）

同一模型、同一 5 轮上界、同一只读工具集下：

- Claude Code harness 把 5 个 turn 全部用于工具探索，未能在截断前输出最终
  finding JSON；因此 3/3 为 0 finding、judge FN。
- ReviewAgent-pi E 内核在同一模型、5 轮 / 6 次工具调用上界下能产出 findings
  （见历史 L1 报告）。这是 **loop / turn 语义与收敛策略差异**，不能归因于模型。
- 该结果**不是**「Claude Code 检视质量差」的结论：截断使质量列不可比；若要
  做有意义的质量对照，需要先固定公平的 turn / 输出预算（例如要求第 N 轮前
  输出最终 JSON，或单独诊断 `--max-turns > 5`），并在报告中区分「预算截断」
  与「模型能力」。

## 4. 工件与后续

原始工件（gitignored）：`runs/eval/claude-code-smoke-2026-11-13-deepseek/`
（`records/`、`judge/`、`column.json`、`COLUMN.md`、`failures.json`）。

本目录副本：3 份 record、3 份 judge、`column.json`、`COLUMN.md`。

建议下一步（独立于本冒烟）：

1. 做一次 `--max-turns > 5` 的**诊断**（不进主口径），确认截断是否为唯一原因；
2. 若要做 harness 质量对照，先定义公平的输出预算 / 提示词收口规则，再按
   ≥30 案 × 3 reps 运行；
3. 该列始终单列，不进入 S/A/B 或 L3 跨模型宣称。
