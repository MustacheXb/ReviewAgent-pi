# 分项消融报告：Token 控制面（ablation-2026-11-15）

> **状态：underpowered / diagnostic · 不作为 L2 合并门或对外宣称证据**
>
> 三项消融均为 10 case × 2 reps × 2 arms，固定 seed `20261115`，同一模型 / judge / 数据集，
> baseline 臂为单个机制的“变体”，candidate 臂为当前 Token 控制面实现（`e61e43c`）。
> 10 案样本功效不足，CIs 很宽；本报告用于**定位成本/质量变化来源**，不是正式判定。

## 1. 消融矩阵

| 消融 | baseline 臂（变体） | candidate 臂（当前） | 变体 commit |
|---|---|---|---|
| **profile** | 强制 `extended-7` | `core-5` + 当前其余机制 | `d9e6f8e` |
| **budget** | 旧式宽松预算（requests/attempts/output 不收紧） | 当前预算（24/12/48k + 强制收尾） | `1d8beea` |
| **trunc/Ledger** | 原始顺序截断 + 禁用 Ledger 去重 | 当前排序截断 + Ledger 送达感知 | `332438e` |

candidate 参考：`e61e43c`（PR #61 merge commit；运行时 = `1d6a228`）。
评测执行工作树：`98658ce`（eval/bench + main 候选合并）；repo 缓存已修复，30/30 case 可读。

## 2. 结果（warm rep2+，candidate / baseline 配对）

| 消融 | CARC ratio | uncached | output | attempts | requests | Recall 差 | Precision 差 | coverage / failures |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| profile | **1.059** [0.901, 1.258] | 1.061 | 1.054 | 0.824 | 1.023 | +0.8pp [−7.5, +10.0] | **−10.8pp** [−25.0, +6.7] | 40/40 · 0 |
| budget | **1.111** [0.855, 1.457] | 1.078 | 1.202 | 0.922 | 0.877 | +7.5pp [−23.3, +36.7] | −2.1pp [−17.7, +12.5] | 40/40 · 0 |
| trunc/Ledger | **1.001** [0.823, 1.206] | 1.004 | 1.005 | 1.036 | 1.021 | +3.7pp [−7.4, +14.8] | +7.3pp [−11.5, +27.1] | 39/40 · 1 (judge) |

绝对 CARC（warm）：

| 消融 | baseline 均值 | candidate 均值 |
|---|---:|---:|
| profile（extended-7 → core-5） | 51,438.1 | 53,075.2 |
| budget（宽松 → 当前收紧） | 50,946.1 | 53,373.9 |
| trunc/Ledger（legacy → 当前） | 49,527.5 | 47,801.9 |

## 3. 结论

1. **成本回归主要由预算收紧 / forced finalization 贡献**：宽松预算变体比当前 candidate 便宜约 11.1%（配对），
   且 uncached/output 都更高。这是三项中最大的成本效应。
2. **core-5 是第二个成本来源**：extended-7 变体比 core-5 便宜约 5.9%；precision 点估计也更低。
   两项叠加可解释 30×3 诊断中 candidate 的 CARC 上升。
3. **trunc/Ledger 不是成本来源**：CARC ratio 1.001，uncached/output 基本不变；当前排序截断与
   Ledger 去重在该样本下没有成本影响（Ledger 实际 hits≈0）。
4. **质量归因仍不干净**：10×2 的 CIs 很宽；profile 的 Precision 方向较差，budget/trunc 的
   Recall/Precision 点估计甚至互有胜负。原 30×3 诊断（`p0-l2-diagnostic2`）显示 candidate
   Recall/Precision 的 CI 下界越过 −3pp，但单项消融不足以把质量回归唯一归因到某一个机制。
5. 因此下一步不是直接改代码，而是验证**组合修复**：宽松预算 + extended-7（保留当前 trunc/Ledger），
   与原始 baseline `e724958` 做 10×2 对照；若 CARC 回到基线且质量门不再失败，再按组合方案修复。

## 4. 失败与限制

- budget 首轮 3 个 judge `finish_reason=length`；`--resume` 补判后 40/40、0 failure。
- trunc 1 个 judge 失败（`VUL4J-15/candidate/rep-2`，`finish_reason=length`），coverage 0.975。
- 所有消融的 variants 仍保留其余 Token 机制（例如 profile 对照仍使用当前预算/截断/Ledger），
  因此只能做“单机制相对贡献”解释，不能把变体当作原始 baseline e724958。
- 10 案功效不足；成本方向可作诊断，质量差异必须用更大样本或 30×3 复核。

## 5. 机读产物

- `profile/l2-report.json` / `environment.json` / `plan.json` / `failures.json`
- `budget/l2-report.json` / `environment.json` / `plan.json` / `failures.json`
- `trunc/l2-report.json` / `environment.json` / `plan.json` / `failures.json`

原始 `runs/` / `audit/` / `wireBody` / judge 响应外置，不入库（ADR-0016 §6）。
