# 修复验证：窄回滚 core-5（fix-profile-2026-11-16）

> **状态：underpowered / diagnostic · claimsAllowed = false**
>
> 10 case × 2 reps × 2 arms，seed `20261118`，baseline `eval-e-baseline-2026-11-11`（`e724958`），
> candidate 为修复运行时（derived extended-7，等价 PR #65 / `7a9ac71`）。本报告用于确认回归是否收口，
> 不作为正式 L2 通过或对外收益/质量宣称证据。

## 1. 修复内容

`deriveToolProfile(无语料)` 由 `core-5` 恢复为 **`extended-7`**（PR #65，merge `7a9ac71`）：

- 生产 wire tools 恢复七件；
- `core-5` / `core-5+rule` / `core-5+history` 仅作评测内部 `toolProfileOverride` 消融档；
- 预算、Ledger、截断、缓存合同、重试等其余 Token 机制保持不变。

## 2. 结果（warm rep2+）

| 指标 | baseline | 修复候选 | 比率 / 差 |
|---|---:|---:|---:|
| CARC | 52,604 | 49,605 | **1.007** [0.804, 1.296] |
| uncached | — | — | 1.008 [0.769, 1.348] |
| output | — | — | 1.015 [0.837, 1.284] |
| attempts | 11.5 | 12.3 | 1.017 [0.905, 1.150] |
| requests | 9.8 | 9.6 | 0.940 [0.858, 1.009] |
| judge Recall | 0.332 | 0.426 | +9.4pp [−18.7, +40.5] |
| judge Precision | 0.344 | 0.287 | −8.1pp [−25.9, +6.7] |
| zero-finding | 10% | 0% | −10pp [−30, 0] |

coverage 40/40、0 failures；boundedness / reproducibility PASS；cost / quality 门因样本功效与 CI 仍 FAIL（diagnostic）。

对照此前单机制结果：

- `extended-7 + 当前默认预算` vs baseline（seed 20261117）：CARC 0.970、Recall −2.2pp、Precision +1.9pp；
- `core-5 + 宽松预算` vs baseline：CARC 1.282、Recall +11.1pp、Precision +7.3pp；
- combined（extended-7 + 宽松预算）：CARC 0.955，但 Recall −14.6pp / Precision −27.4pp。

## 3. 结论

1. 窄回滚后，CARC 回到 baseline 附近（0.97–1.01 两个独立 seed），此前 core-5 默认的 +7.2% 回归消失。
2. 质量 CIs 很宽、点估计互有胜负；**不能宣称质量提升，也不能宣称稳定非劣**——只能说未观察到稳定的劣化。
3. Token 成本目标（相对 C 的 20–30%）**没有达成**；控制面机制（预算、Ledger、截断、缓存合同、分析器）已落地，但当前默认路径没有收益证据。
4. #49 按“机制交付、收益未达成”收口；后续优化（工具画像重做、预算中间档、正式扩样 L2）另行立项，不沿用本报告的 diagnostic 数字做对外宣称。

## 4. 产物

- `l2-report.json` / `environment.json` / `plan.json` / `failures.json`
- 关联报告：`p0-l2-diagnostic2-2026-11-14/`（有效 30×3 诊断）、`ablation-2026-11-15/`（三项分项消融）
- 代码：PR #65（merge `7a9ac71`）；机制交付见 #50–#60

原始 `runs/` / `audit/` / `wireBody` 外置，不入库（ADR-0016 §6）。
